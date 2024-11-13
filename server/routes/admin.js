const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const csrf = require('csurf');

const router = express.Router();
const post = require('../models/posts');
const user = require('../models/user');

const jwtSecretKey = process.env.JWT_SECRET;
const adminLayout = '../views/layouts/admin';

if(!jwtSecretKey){
  throw new Error('JWT_SECRET is not set in Environment variable');
}

const authLimiter  = rateLimit({
  windowMs: 15 * 60 * 1000, //15 mins
  max: 5 // limit each IP to 5 requests per windowMs
});

// adding admin CSRF protection middleware
const csrfProtection = csrf({ cookie: true });
router.use(csrfProtection);

/**
 * Checks login middleware
 */
const authToken = (req, res, next) => {
  const token = req.cookies.token;
  if(!token){
    return res.redirect('/admin');
  }

  try{
    const decoded = jwt.verify(token, jwtSecretKey);
    req.userId = decoded.userId;
    next();
  } catch (error){
    console.error(401 ,error);
    return res.redirect('/admin');
  }
}


//Routes
/**
 * GET /
 * ADMIN - Login
 */

router.get('/admin', async (req, res) => {
  try {

    const locals = {
      title: "Admin Panel",
      description: "Admin Panel"
    }
    res.render('admin/index', { locals, layout: adminLayout, isRegistrationEnabled: process.env.ENABLE_REGISTRATION, errors: [], errors_login: [], csrfToken: req.csrfToken() });
  } catch (error) {
    console.error("Admin Page error", error.message);
    res.status(500).send('Internal Server Error');
  }
});

/**
 * POST /
 * ADMIN - Register
 */
router.post('/register', async (req, res) => {
  try {
    const { username, password, name } = req.body;

    //check for empty field
    if (!name || !username || !password) {
      console.log(401, 'empty mandatory fields');
      return res.render('admin/index', {
        errors: [{ msg: 'Name, Username or Passwords are empty' }],
        isRegistrationEnabled: process.env.ENABLE_REGISTRATION
      });
    }

    // checking for existing user
    const existingUser = await user.findOne({ username })
    if (existingUser) {
      console.error(409, 'Username already exists');
      return res.render('admin/index', {
        errors: [{ msg: 'Username already exists!' }],
        isRegistrationEnabled: process.env.ENABLE_REGISTRATION
      });
    }

    //registration logic
    if (process.env.ENABLE_REGISTRATION === 'true') {
      const hashedPassword = await bcrypt.hash(password, 10);
      try {
        const newUser = await user.create({ username, password: hashedPassword, name });
        console.log('User created', newUser, 201);
        res.redirect('/admin/registration');
      } catch (error) {
        if (error.code === 11000) {
          console.error(409, 'Username already exists 2');
        }
        else {
          console.error(500, 'Internal Server Error');
          return res.render('admin/index', {
            errors: [{
              msg: 'We are facing some difficulty. Please hang back while we resolve this issue.'
            }],
            isRegistrationEnabled: process.env.ENABLE_REGISTRATION
          });
        }
      }
    } else {
      return res.render('admin/index', {
        errors: [{
          msg: 'Registration not enabled, Contact with Site admin or God-father'
        }],
        isRegistrationEnabled: process.env.ENABLE_REGISTRATION
      });
    }
  } catch (error) {
    console.error('error in post', error);
  }
});

/**
 * POST
 * Admin - Check Login
 */
router.post('/admin', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    //checks if the username or passwords are not empty
    if (!username || !password) {
      return res.render('admin/index', {
        errors_login: [{
          msg: 'Username and Passwords are mandatory'
        }],
        isRegistrationEnabled: process.env.ENABLE_REGISTRATION,
        errors:[]
      });
    }

    //checks if the user exists
    const currentUser = await user.findOne({ username });
    if (!currentUser) {
      console.error(401, 'invalid credentials for user: ', username);
      return res.render('admin/index', {
        errors_login: [{ msg: 'Invalid login credentials!' }],
        isRegistrationEnabled: process.env.ENABLE_REGISTRATION,
        errors:[]
      });
    }

    //password validity check
    const isPasswordValid = await bcrypt.compare(password, currentUser.password);
    if (!isPasswordValid) {
      console.error(401, 'invalid credentials for user: ', username);
      return res.render('admin/index', {
        errors_login: [{ msg: 'Invalid login credentials!' }],
        isRegistrationEnabled: process.env.ENABLE_REGISTRATION,
        errors:[]
      });
    }

    //adds session
    const token = jwt.sign({ userId: currentUser._id }, jwtSecretKey);
    res.cookie('token', token, { httpOnly: true });
    res.redirect('/dashboard');
  } catch (error) {
    //for any other errors
    console.error(error);
    return res.render('admin/index', {
      errors_login: [{ msg: 'We are facing some difficulty. Please hang back while we resolve this issue.' }],
      isRegistrationEnabled: process.env.ENABLE_REGISTRATION,
      errors:[]
    });
  }
});

/**
 * GET
 * Admin - Registration success
 */

router.get('/admin/registration', async (req, res) => {
  const locals = {
    title: 'Registration successful',
    description: 'Registration successful'
  };
  res.render('admin/registration', { locals, layout: adminLayout });
});

/**
 * GET
 * Admin - Dashboard
 */
router.get('/dashboard', authToken, async (req, res) => {
  try{
    const locals = {
      title: 'Admin Dashboard',
      description: 'dashboard'
    };

    const currentUser = await user.findById(req.userId);
    if(!currentUser){
      console.error('User not found', req.userId);
      return res.redirect('/admin');
    }
    let data;
    switch (currentUser.privilege){
      case 3:
        data = await post.find({ author: currentUser.name}).sort({ createdAt: -1 });
        break;
      case 2:
        data = await post.find();
        break;
      case 1:
        data = await post.find();
        break;
      default:
        return res.status(403).send('Unauthorized');
    }
    res.render('admin/dashboard', { locals, layout: adminLayout, currentUser, data, csrfToken: req.csrfToken()});
  } catch (error){
    console.error(error);
    res.status(500).send('Internal Server Error');
  }
});

/**
 * GET
 * Admin - new post
 */
router.get('/admin/add-post', authToken, async (req, res) => {
  try{
    const locals = {
      title: 'Add Post',
      description: 'Add Post'
    };

    const currentUser = await user.findById(req.userId);
    if(!currentUser){
      console.error('User not found', req.userId);
      return res.redirect('/admin');
    }

    res.render('admin/add-post', { locals, layout: adminLayout, currentUser, csrfToken: req.csrfToken()});
  } catch (error){
    console.error(error);
    res.status(500).send('Internal Server Error');
  }
});

/**
 * POST
 * Admin - new post
 */
router.post('/admin/add-post', authToken, async (req, res) => {
  try{
    const currentUser = await user.findById(req.userId);
    if(!currentUser){
      console.error('User not found', req.userId);
      return res.redirect('/admin');
    }

    const isValidURI = (string) => {
      if(req.body.thumbnailImageURI || !req.body.thumbnailImageURI.trim() === ''){
        try{
          new URL(string);
          return true;
        }catch(_){
          return false;
        }
      } else {
        return false;
      }
    }

    //const thumbnailImageURI = req.body.thumbnailImageURI?.trim() ? (isValidURI(req.body.thumbnailImageURI) ? req.body.thumbnailImageURI.trim() : process.env.DEFAULT_POST_THUMBNAIL_LINK) : process.env.DEFAULT_POST_THUMBNAIL_LINK;
    let defaultThumbnailImageURI;
    if(isValidURI(req.body.thumbnailImageURI)){
      defaultThumbnailImageURI = req.body.thumbnailImageURI;
    } else {
      defaultThumbnailImageURI = process.env.DEFAULT_POST_THUMBNAIL_LINK;
    }

    if (!req.body.title?.trim() || !req.body.body?.trim() || !req.body.desc?.trim()) {
      return res.status(400).send('Title, body, and description are required!');
    }

    const newPost = new post({
      title: req.body.title.trim(),
      body: req.body.body.trim(),
      author: currentUser.name.trim(),
      tags: req.body.tags,
      desc: req.body.desc.trim(),
      thumbnailImageURI: defaultThumbnailImageURI
    });

    await newPost.save();

    console.log('New post added by ', currentUser.username, '\n' , newPost);

    res.redirect('/dashboard');

  } catch (error){
    console.error(error);
    res.status(500).send('Internal Server Error');
  }
});

module.exports = router;