const express = require("express");
const {google} = require('googleapis');
const crypto = require('crypto');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
require('dotenv').config()
const url = require('url');

// We're using YouTube API directly for comments, no need for local models


const oauth2client = new google.auth.OAuth2({
    clientId:process.env.GOOGLE_CLIENT_ID,
    clientSecret:process.env.GOOGLE_CLIENT_SECRET,
    redirectUri:process.env.REDIRECT_URI,
})

const scopes = [
    'https://www.googleapis.com/auth/youtube.force-ssl',
    'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/youtube.readonly'
  ];


// Store user credentials and channel info
let userCredential = null;
let userChannelId = null;
let userChannelName = null;

// Using YouTube API for comments instead of local storage

const PORT = 8080;

// Connect to MongoDB
mongoose.connect(process.env.DB_URI,{dbName:'youtube_db'})
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

const app = express();

app.use(express.json())
app.use(cookieParser());
app.use(express.static(__dirname + '/public'));
app.use(session({
    secret:'secret',
    resave:true,
    saveUninitialized:true,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        httpOnly: true
    }
}))

app.get("/", (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.get('/auth/google', async (req,res) => {
 // Generate a secure random state value.
 const state = crypto.randomBytes(32).toString('hex');
 // Store state in the session
 req.session.state = state;
 // Also store in a cookie as a backup
 res.cookie('oauth_state', state, {
    maxAge: 3600000, // 1 hour
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
 });

 console.log('Generated state:', state);

 const authorizationUrl = oauth2client.generateAuthUrl({
    access_type:'offline',
    scope:scopes,
    include_granted_scopes:true,
    state:state
 })

 res.redirect(authorizationUrl)

})

app.get('/auth/google/callback', async (req,res) => {
    let q = url.parse(req.url, true).query;

    // Get state from session or cookie
    const sessionState = req.session.state;
    const cookieState = req.cookies.oauth_state;

    console.log('Session state:', sessionState);
    console.log('Cookie state:', cookieState);
    console.log('Query state:', q.state);

    if (q.error) { // An error response e.g. error=access_denied
      console.log('Error:' + q.error);
    } else if ((!sessionState && !cookieState) || (q.state !== sessionState && q.state !== cookieState)) { //check state value
      console.log('State mismatch. Possible CSRF attack');
      console.log('Session state:', sessionState);
      console.log('Cookie state:', cookieState);
      console.log('Query state:', q.state);
      res.end('State mismatch. Possible CSRF attack');
    } else { // Get access and refresh tokens (if access_type is offline)
      try {
        oauth2client.getToken(q.code, (err, tokens) => {
          if (err) {
            console.error('Error getting tokens:', err);
            return res.status(500).send('Authentication failed: ' + err.message);
          }

          oauth2client.setCredentials(tokens);

      /** Save credential to the global variable in case access token was refreshed.
        * ACTION ITEM: In a production app, you likely want to save the refresh token
        *              in a secure persistent database instead. */
          userCredential = tokens;
          console.log('Saved user credentials:', JSON.stringify(tokens, null, 2));

          // Example of using YouTube API to list channels.
          var service = google.youtube('v3');
          service.channels.list({
            auth: oauth2client,
            part: 'snippet,contentDetails,statistics',
            mine: true, // Get the authenticated user's channel
          }, function (err, response) {
            if (err) {
              console.log('The API returned an error: ' + err);
              return res.status(500).send('API error: ' + err.message);
            }
            console.log('YouTube API Response:', response.data);

            // Check if response.data and response.data.items exist
            if (!response.data || !response.data.items) {
              console.log('Invalid response structure:', response.data);
              return res.send('Authentication successful, but received unexpected response format from YouTube API.');
            }

            var channels = response.data.items;
            console.log('Channels:', channels);

            if (channels.length == 0) {
              console.log('No channel found.');
              res.send('Authentication successful, but no channel found.');
            } else {
              // Save the channel info for later use
              userChannelId = channels[0].id;
              userChannelName = channels[0].snippet.title;

              console.log('This channel\'s ID is %s. Its title is \'%s\', and ' +
                'it has %s views.',
                channels[0].id,
                channels[0].snippet.title,
                channels[0].statistics.viewCount);

              // Redirect to dashboard after successful authentication
              res.redirect('/dashboard');
            }
          });
        });
      } catch (error) {
        console.error('Error in Google callback:', error);
        return res.status(500).send('Authentication failed: ' + error.message);
      }
    }
})



// Route to fetch unlisted videos
app.get('/unlisted', async (req, res) => {
  // Check if user is authenticated
  if (!userCredential) {
    return res.status(401).json({ error: 'Not authenticated. Please authenticate with Google first.' });
  }

  try {
    // Make sure OAuth client has the credentials
    oauth2client.setCredentials(userCredential);

    // Create YouTube service
    const youtube = google.youtube('v3');

    // Get the user's uploads playlist ID
    const channelsResponse = await new Promise((resolve, reject) => {
      youtube.channels.list({
        auth: oauth2client,
        part: 'contentDetails',
        mine: true
      }, (err, response) => {
        if (err) return reject(err);
        resolve(response);
      });
    });

    if (!channelsResponse.data.items || channelsResponse.data.items.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const uploadsPlaylistId = channelsResponse.data.items[0].contentDetails.relatedPlaylists.uploads;
    console.log('Uploads playlist ID:', uploadsPlaylistId);

    // Get videos from the uploads playlist
    const playlistItemsResponse = await new Promise((resolve, reject) => {
      youtube.playlistItems.list({
        auth: oauth2client,
        part: 'snippet,status',
        playlistId: uploadsPlaylistId,
        maxResults: 50 // Adjust as needed
      }, (err, response) => {
        if (err) return reject(err);
        resolve(response);
      });
    });

    if (!playlistItemsResponse.data.items) {
      return res.status(404).json({ error: 'No videos found' });
    }

    // Get the video IDs from playlist items
    const videoIds = playlistItemsResponse.data.items.map(item => item.snippet.resourceId.videoId);

    if (videoIds.length === 0) {
      return res.json({ message: 'No videos found in channel', videos: [] });
    }

    // Get detailed video information including privacy status
    const videosResponse = await new Promise((resolve, reject) => {
      youtube.videos.list({
        auth: oauth2client,
        part: 'snippet,status',
        id: videoIds.join(',')
      }, (err, response) => {
        if (err) return reject(err);
        resolve(response);
      });
    });

    // Filter for unlisted videos
    const unlistedVideos = videosResponse.data.items.filter(video =>
      video.status.privacyStatus === 'unlisted'
    );

    // Format the response
    const formattedVideos = unlistedVideos.map(video => ({
      id: video.id,
      title: video.snippet.title,
      description: video.snippet.description,
      publishedAt: video.snippet.publishedAt,
      thumbnails: video.snippet.thumbnails,
      privacyStatus: video.status.privacyStatus,
      url: `https://www.youtube.com/watch?v=${video.id}`
    }));

    res.json({
      message: `Found ${formattedVideos.length} unlisted videos`,
      videos: formattedVideos
    });

  } catch (error) {
    console.error('Error fetching unlisted videos:', error);
    res.status(500).json({
      error: 'Failed to fetch unlisted videos',
      message: error.message,
      details: error.response ? error.response.data : null
    });
  }
});

// Route to serve the dashboard page
app.get('/dashboard', (req, res) => {
  // Check if user is authenticated
  if (!userCredential) {
    return res.redirect('/');
  }
  res.sendFile(__dirname + '/public/dashboard.html');
});

// Route to serve the video page
app.get('/video.html', (req, res) => {
  // Check if user is authenticated
  if (!userCredential) {
    return res.redirect('/');
  }
  res.sendFile(__dirname + '/public/video.html');
});

// Route to get channel information
app.get('/channel-info', (req, res) => {
  // Check if user is authenticated
  if (!userCredential) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  res.json({
    channelId: userChannelId,
    channelName: userChannelName
  });
});

// YouTube Comment routes

// Get all comments for a video
app.get('/api/comments/:videoId', async (req, res) => {
  // Check if user is authenticated
  if (!userCredential) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    // Make sure OAuth client has the credentials
    oauth2client.setCredentials(userCredential);

    // Create YouTube service
    const youtube = google.youtube('v3');

    // Get comments from YouTube API
    const commentsResponse = await new Promise((resolve, reject) => {
      youtube.commentThreads.list({
        auth: oauth2client,
        part: 'snippet,replies',
        videoId: req.params.videoId,
        maxResults: 100
      }, (err, response) => {
        if (err) return reject(err);
        resolve(response);
      });
    });

    // Format the comments for our frontend
    const formattedComments = [];

    if (commentsResponse.data.items && commentsResponse.data.items.length > 0) {
      commentsResponse.data.items.forEach(item => {
        const comment = {
          _id: item.id,
          videoId: req.params.videoId,
          text: item.snippet.topLevelComment.snippet.textDisplay,
          author: item.snippet.topLevelComment.snippet.authorDisplayName,
          authorChannelId: item.snippet.topLevelComment.snippet.authorChannelId.value,
          createdAt: item.snippet.topLevelComment.snippet.publishedAt,
          replies: []
        };

        // Add replies if they exist
        if (item.replies && item.replies.comments) {
          item.replies.comments.forEach(reply => {
            comment.replies.push({
              _id: reply.id,
              text: reply.snippet.textDisplay,
              author: reply.snippet.authorDisplayName,
              authorChannelId: reply.snippet.authorChannelId.value,
              createdAt: reply.snippet.publishedAt
            });
          });
        }

        formattedComments.push(comment);
      });
    }

    res.json(formattedComments);
  } catch (error) {
    console.error('Error fetching comments from YouTube API:', error);
    res.status(500).json({
      error: 'Failed to fetch comments',
      message: error.message,
      details: error.response ? error.response.data : null
    });
  }
});

// Add a new comment to a video
app.post('/api/comments', async (req, res) => {
  // Check if user is authenticated
  if (!userCredential) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const { videoId, text } = req.body;

    if (!videoId || !text) {
      return res.status(400).json({ error: 'VideoId and text are required' });
    }

    // Make sure OAuth client has the credentials
    oauth2client.setCredentials(userCredential);

    // Create YouTube service
    const youtube = google.youtube('v3');

    // Add comment to YouTube API
    const commentResponse = await new Promise((resolve, reject) => {
      youtube.commentThreads.insert({
        auth: oauth2client,
        part: 'snippet',
        requestBody: {
          snippet: {
            videoId: videoId,
            topLevelComment: {
              snippet: {
                textOriginal: text
              }
            }
          }
        }
      }, (err, response) => {
        if (err) return reject(err);
        resolve(response);
      });
    });

    // Format the response for our frontend
    const item = commentResponse.data;
    const newComment = {
      _id: item.id,
      videoId: videoId,
      text: item.snippet.topLevelComment.snippet.textDisplay,
      author: item.snippet.topLevelComment.snippet.authorDisplayName,
      authorChannelId: item.snippet.topLevelComment.snippet.authorChannelId.value,
      createdAt: item.snippet.topLevelComment.snippet.publishedAt,
      replies: []
    };

    res.status(201).json(newComment);
  } catch (error) {
    console.error('Error adding comment via YouTube API:', error);
    res.status(500).json({
      error: 'Failed to add comment',
      message: error.message,
      details: error.response ? error.response.data : null
    });
  }
});

// Add a reply to a comment
app.post('/api/comments/:commentId/replies', async (req, res) => {
  // Check if user is authenticated
  if (!userCredential) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const { text } = req.body;
    const { commentId } = req.params;

    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    // Make sure OAuth client has the credentials
    oauth2client.setCredentials(userCredential);

    // Create YouTube service
    const youtube = google.youtube('v3');

    // Add reply to YouTube API
    await new Promise((resolve, reject) => {
      youtube.comments.insert({
        auth: oauth2client,
        part: 'snippet',
        requestBody: {
          snippet: {
            parentId: commentId,
            textOriginal: text
          }
        }
      }, (err, response) => {
        if (err) return reject(err);
        resolve(response);
      });
    });

    // Get the updated comment thread to return the full comment with all replies
    const commentResponse = await new Promise((resolve, reject) => {
      youtube.commentThreads.list({
        auth: oauth2client,
        part: 'snippet,replies',
        id: commentId
      }, (err, response) => {
        if (err) return reject(err);
        resolve(response);
      });
    });

    // Format the response for our frontend
    let updatedComment = {};

    if (commentResponse.data.items && commentResponse.data.items.length > 0) {
      const item = commentResponse.data.items[0];
      updatedComment = {
        _id: item.id,
        videoId: item.snippet.videoId,
        text: item.snippet.topLevelComment.snippet.textDisplay,
        author: item.snippet.topLevelComment.snippet.authorDisplayName,
        authorChannelId: item.snippet.topLevelComment.snippet.authorChannelId.value,
        createdAt: item.snippet.topLevelComment.snippet.publishedAt,
        replies: []
      };

      // Add replies if they exist
      if (item.replies && item.replies.comments) {
        item.replies.comments.forEach(reply => {
          updatedComment.replies.push({
            _id: reply.id,
            text: reply.snippet.textDisplay,
            author: reply.snippet.authorDisplayName,
            authorChannelId: reply.snippet.authorChannelId.value,
            createdAt: reply.snippet.publishedAt
          });
        });
      }
    }

    res.status(201).json(updatedComment);
  } catch (error) {
    console.error('Error adding reply via YouTube API:', error);
    res.status(500).json({
      error: 'Failed to add reply',
      message: error.message,
      details: error.response ? error.response.data : null
    });
  }
});

// Update video details (title and description)
app.put('/api/videos/:videoId', async (req, res) => {
  // Check if user is authenticated
  if (!userCredential) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const { videoId } = req.params;
    const { title, description } = req.body;

    if (!videoId || !title) {
      return res.status(400).json({ error: 'VideoId and title are required' });
    }

    // Make sure OAuth client has the credentials
    oauth2client.setCredentials(userCredential);

    // Create YouTube service
    const youtube = google.youtube('v3');

    // Update video details using YouTube API
    const updateResponse = await new Promise((resolve, reject) => {
      youtube.videos.update({
        auth: oauth2client,
        part: 'snippet',
        requestBody: {
          id: videoId,
          snippet: {
            title: title,
            description: description || '',
            categoryId: '22' // Keep the same category (22 is 'People & Blogs')
          }
        }
      }, (err, response) => {
        if (err) return reject(err);
        resolve(response);
      });
    });

    // Return the updated video details
    const updatedVideo = {
      id: updateResponse.data.id,
      title: updateResponse.data.snippet.title,
      description: updateResponse.data.snippet.description,
      publishedAt: updateResponse.data.snippet.publishedAt
    };

    res.json(updatedVideo);
  } catch (error) {
    console.error('Error updating video:', error);
    res.status(500).json({
      error: 'Failed to update video',
      message: error.message,
      details: error.response ? error.response.data : null
    });
  }
});

app.listen(PORT, () => {
  console.log(`server is running on http://localhost:${PORT}`);
});
