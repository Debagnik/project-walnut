const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const post = require('../models/posts');
const siteConfig = require('../models/config');
const user = require('../models/user');
const comment = require('../models/comments');
const csrf = require('csurf');

const jwtSecretKey = process.env.JWT_SECRET;
const { PRIVILEGE_LEVELS_ENUM, isWebMaster } = require('../../utils/validations');
/**
 * Site config Middleware
 */

const fetchSiteConfig = async (req, res, next) => {
    try {
        const config = await siteConfig.findOne();
        if (!config) {
            console.warn('Site config is not available in database');
            res.locals.siteConfig = {};
        } else {
            res.locals.siteConfig = config;
        }
        next();
    } catch (error) {
        console.error("Critical: Site Config Fetch error", error.message);
        return res.status(500).render('error', {
            locals: {
                title: 'Configuration Error',
                description: 'Unable to load site configuration'
            }
        });
    }
}

router.use(fetchSiteConfig);

if (!jwtSecretKey) {
    console.error('JWT_SECRET is not defined. Please set it in your environment variables.');
    // You might want to exit the process gracefully
    process.exit(1);
}

// adding admin CSRF protection middleware
const csrfProtection = csrf({ cookie: true });
router.use(csrfProtection);

//Routes
/**
 * GET /
 * HOME
 */
router.get('', async (req, res) => {

    try {
        const locals = {
            title: res.locals.siteConfig.siteName || "Project Walnut",
            description: res.locals.siteConfig.siteMetaDataDescription || "A blogging site created with Node, express and MongoDB",
            config: res.locals.siteConfig,
        }

        let perPage = res.locals.siteConfig.defaultPaginationLimit || 1;
        let page = req.query.page || 1;

        const data = await post.aggregate([
            { $match: { isApproved: true } },
            { $sort: { createdAt: -1 } }
        ]).skip(perPage * page - perPage).limit(perPage).exec();

        const count = await post.countDocuments({ isApproved: true });
        const nextPage = parseInt(page) + 1;
        const hasNextPage = nextPage <= Math.ceil(count / perPage);


        res.render('index', {
            locals,
            data,
            current: page,
            nextPage: hasNextPage ? nextPage : null
        });
        console.log(`DB Posts Data fetched`);
    } catch (error) {
        console.log(error);
    }
});

/**
 * GET /about
 * About
 */
router.get('/about', (req, res) => {
    const locals = {
        title: 'About Us Section' + ' - ' + (res.locals.siteConfig.siteName || 'Project Walnut'),
        description: "A blogging site created with Node, express and MongoDB",
        config: res.locals.siteConfig
    }
    res.render('about', {
        locals
    });
});

/**
 * GET /contact
 * Contact
 */
router.get('/contact', (req, res) => {
    const locals = {
        title: "Contacts us" + ' - ' + (res.locals.siteConfig.siteName || 'Project Walnut'),
        description: "A blogging site created with Node, express and MongoDB",
        config: res.locals.siteConfig
    }
    res.render('contact', {
        locals
    });
});

/**
 * GET /
 * Posts :id
 */
router.get('/post/:id', async (req, res) => {
    try {
        const currentUser = await getUserFromCookieToken(req);

        let slug = req.params.id;
        const data = await post.findById({ _id: slug });
        if (!data) {
            throw new Error('404 - No such post found');
        }
        const locals = {
            title: data.title,
            description: data.desc,
            keywords: data.tags,
            config: res.locals.siteConfig
        }
        const postAuthor = await user.findOne({ username: data.author });
        if (!postAuthor) {
            data.author = 'Anonymous'
        } else {
            data.author = postAuthor.name;
        }

        const isCommentsEnabled = res.locals.siteConfig.isCommentsEnabled && !!res.locals.siteConfig.cloudflareSiteKey && !!res.locals.siteConfig.cloudflareServerKey;
        const isCurrentUserAModOrAdmin = currentUser && (currentUser.privilegeLevel === PRIVILEGE_LEVELS_ENUM.ADMIN || currentUser.privilegeLevel === PRIVILEGE_LEVELS_ENUM.MODERATOR);
        if (currentUser || data.isApproved) {
            res.render('posts', {
                locals,
                data,
                csrfToken: req.csrfToken(),
                isCommentsEnabled,
                commentsData: await getCommentsFromPostId(data._id),
                currentUser: isCurrentUserAModOrAdmin
            });
        } else {
            res.redirect('/404');
        }

    } catch (error) {
        console.error('Post Fetch error', error);
        res.status(404).render('404', {
            locals: {
                title: "404 - Page Not Found",
                description: "The page you're looking for doesn't exist.",
                config: res.locals.siteConfig
            }
        });
    }
});

const getUserFromCookieToken = async (req) => {
    let currentUser = null;
    const token = req.cookies.token;
    let userId = null;
    if (token) {
        try {
            const decoded = jwt.verify(token, jwtSecretKey);
            // Check if token is expired
            if (decoded.exp && Date.now() >= decoded.exp * 1000) {
                console.error('Token expired');
                return null;
            }
            userId = decoded.userId;
        } catch (err) {
            console.error('Invalid token:', err.message);
        }
    }
    if (userId) {
        currentUser = await user.findById(userId);
    }
    return currentUser;
}

const getCommentsFromPostId = async (postId) => {
    try {
        const comments = await comment.find({ postId }).sort({ commentTimestamp: -1 });
        return comments;
    } catch (error) {
        console.error('Comment Fetch error', postId, error.message);
        return [];
    }
}

/**
 * POST /
 * Search: Search term
 */
router.post('/search', async (req, res) => {
    try {

        let searchLimit = res.locals.siteConfig.searchLimit;
        let searchTerm = req.body.searchTerm;
        searchTerm = searchTerm.trim().replace(/[<>]/g, '');
        if (!searchTerm || typeof searchTerm !== 'string') {
            return res.status(400).json({ error: 'Invalid search term' });
        }
        if (searchTerm.trim().length == 0) {
            return res.status(400).json({ error: 'Search term cannot be empty' });
        }
        if (searchTerm.trim().length > 100) {
            return res.status(400).json({ error: 'Search term is too long' });
        }
        const searchNoSpecialChar = searchTerm.replace(/[^a-zA-Z0-9 ]/g, "");
        console.log(new Date(), " - Simple Search - ", searchTerm, " - regex search: ", searchNoSpecialChar);

        const locals = {
            title: "Search - " + searchTerm,
            description: "Simple Search Page",
            config: res.locals.siteConfig
        }

        const data = await post.find(
            {
                $and: [
                    { $text: { $search: searchNoSpecialChar } },
                    { isApproved: true }
                ]
            },
            { score: { $meta: 'textScore' } }
        )
            .sort({ score: { $meta: 'textScore' } })
            .limit(searchLimit);

        res.render('search', { data, locals, searchTerm: searchTerm });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).render('error', {
            locals: {
                title: 'Error'
            },
            error: 'Unable to perform search at this time',
            config: res.locals.siteConfig
        });
    }
});

/**
 * POST
 * /posts/post-comments
 * Add comments to a post
 */
router.post('/post/:id/post-comments', async (req, res) => {
    const { postId, commenterName, commentBody } = req.body;
    const siteConfig = res.locals.siteConfig;
    if (!siteConfig.isCommentsEnabled || !siteConfig.cloudflareSiteKey || !siteConfig.cloudflareServerKey) {
        console.error(403, 'Comments are disabled or Cloudflare keys are not set');
        return res.status(403).json({ "status": "403", "message": "Comments are disabled or Cloudflare keys are not set" });
    }

    if (!commenterName || !commentBody) {
        console.error(400, 'Invalid comment data');
        return res.redirect(`/post/${postId}`);
    }
    if (commentBody.length > 500 || commenterName.length > 50 || commenterName.length < 3 || commentBody.length < 1) {
        console.error(400, 'Invalid comment data', 'Size mismatch');
        return res.redirect(`/post/${postId}`);
    }

    try {

        //verify if post exists before adding comment. If not, return 404. 404 status code indicates the requested resource was not found on the server. 401 status code
        const existingPost = await post.findById(postId);
        if (!existingPost) {
            console.error(404, 'No post found');
            return res.status(404).json({ "status": "404", "message": "No post found", "postId": postId });
        }

        const newComment = new comment({
            postId: postId,
            commenterName: commenterName,
            commentBody: commentBody,
            commentTimestamp: Date.now()
        });
        await newComment.save();
        if (process.env.NODE_ENV === 'production') {
            console.log({ "status": "200", "message": "Comment added successfully" });
        } else {
            console.log({ "status": "200", "message": "Comment added successfully", "comment": newComment });
        }
        res.redirect(`/post/${postId}`);
    } catch (error) {
        console.error('Error adding comment:', error);
        if (process.env.NODE_ENV === 'production') {
            res.status(500).json({ "status": "500", "message": "Unable to add comment at this time" });
        } else {
            res.status(500).json({ "status": "500", "message": "Error adding comment at this time", "error": error.message });
        }
    }

});

/**
 * DELETE
 * /posts/post-comments/:commentId
 * Delete a comment from a post if the User is Authorized (Only Admin or Moderator)
 */
router.post('/post/delete-comment/:commentId', async (req, res) => {
    const { commentId } = req.params;
    try {
        // verify if the comment exists before deleting. If not, redirect to the post page. 404 status to be logged in console
        const thisComment = await comment.findById(commentId);
        if (!thisComment) {
            console.error(404, 'No comment found');
            return res.status(404).json({ "status": "404", "message": "No comment found", "commentid": commentId });
        }
        // check if user is authorized to delete the comment
        const currentUser = await getUserFromCookieToken(req);
        const isCurrentUserAModOrAdmin = currentUser && (currentUser.privilegeLevel === PRIVILEGE_LEVELS_ENUM.ADMIN || currentUser.privilegeLevel === PRIVILEGE_LEVELS_ENUM.MODERATOR);
        if (!isCurrentUserAModOrAdmin) {
            console.error(403, 'Unauthorized to delete comment');
            return res.status(403).json({ "status": "403", "message": "Unauthorized to delete comment" });
        }

        await thisComment.deleteOne()
        console.log({ "status": "200", "message": "Comment deleted successfully", user: currentUser.username });
        res.redirect(`/post/${thisComment.postId}`);

    } catch (err) {
        console.error(500, 'Error deleting comment:', err);
        return res.status(500).json({ "status": "500", "message": "Error deleting comment" });
    }

})


module.exports = router;
