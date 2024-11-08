const mongoose = require('mongoose');

const schema = mongoose.Schema;
const postSchema = new schema({
    title: {
        type: String,
        require: true
    },
    body: {
        type: String,
        require: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    modifiedAt: {
        type: Date,
        default: Date.now
    },
    tags: {
        type: String,
        require: true
    }
});

module.exports = mongoose.model('Posts', postSchema);