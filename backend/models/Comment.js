const mongoose = require('mongoose');

// Reply schema (embedded in comments)
const replySchema = new mongoose.Schema({
  text: {
    type: String,
    required: true,
    trim: true
  },
  author: {
    type: String,
    required: true
  },
  authorChannelId: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Comment schema
const commentSchema = new mongoose.Schema({
  videoId: {
    type: String,
    required: true,
    index: true
  },
  text: {
    type: String,
    required: true,
    trim: true
  },
  author: {
    type: String,
    required: true
  },
  authorChannelId: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  replies: [replySchema]
});

module.exports = mongoose.model('Comment', commentSchema);
