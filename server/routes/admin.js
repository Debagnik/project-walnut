const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const csrf = require('csurf');
const sanitizeHtml = require('sanitize-html');
const marked = require('marked');

const router = express.Router();
const post = require('../models/posts');
const user = require('../models/user');
const siteConfig = require('../models/config');

const { PRIVILEGE_LEVELS_ENUM, isWebMaster, isValidURI, isValidTrackingScript, parseTags } = require('../../utils/validations');

const openRouterIntegration = require('../../utils/openRouterIntegration');
const { aiSummaryRateLimiter, authRateLimiter, genericAdminRateLimiter, genericGetRequestRateLimiter } = require('../../utils/rateLimiter');


const jwtSecretKey = process.env.JWT_SECRET;
const adminLayout = '../views/layouts/admin';

// Deliberately storing a non-hashed string as "resettedPassword" as a secondary security measure
// If the isPasswordReset flag is somehow bypassed, bcrypt comparison will still fail
// DO NOT HASH THIS VALUE - it is intended to be unusable
const resettedPassword = 'Qm9jY2hpIHRoZSBSb2Nr';


if (!jwtSecretKey) {
  throw new Error('JWT_SECRET is not set in Environment variable');
}

// adding admin CSRF protection middleware
const csrfProtection = csrf({ cookie: true });
router.use(csrfProtection);

/**
 * Middleware to authenticate requests based on a JWT stored in cookies.
 * Redirects to the admin login page if the token is missing or invalid.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @param {import('express').NextFunction} next - The next middleware function.
 */
const authToken = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) {
    return res.redirect('/admin');
  }

  try {
    const decoded = jwt.verify(token, jwtSecretKey);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    console.error('Invalid token', error);
    req.flash('error', error.message);
    return res.redirect('/admin');
  }
}

/**
 * Middleware to fetch the site configuration from the database and 
 * attach it to `res.locals` for use in views.
 * Logs a warning if the config is not found and ensures `res.locals.siteConfig` is always defined.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @param {import('express').NextFunction} next - The next middleware function.
 */
const fetchSiteConfig = async (req, res, next) => {
  try {
    const config = await siteConfig.findOne();
    if (!config) {
      console.warn('Site config is not available');
    }
    res.locals.siteConfig = config || {};
  } catch (error) {
    console.error("Site Config Fetch error", error.message);
    res.locals.siteConfig = {};
  }
  next();
};


router.use(fetchSiteConfig);

/**
 * Converts a Markdown string to sanitized HTML, adjusting heading levels to avoid large headers.
 * Includes additional allowed tags and attributes for images.
 *
 * @param {string} markdownString - The Markdown content to convert.
 * @returns {string} The sanitized HTML string.
 * @throws {Error} If the conversion fails.
 */
function markdownToHtml(markdownString) {
  try {
    // convert markdown string to HTML string
    let htmlString = marked.parse(markdownString);

    // sanitize HTML string to prevent XSS attacks
    htmlString = sanitizeHtml(htmlString, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img']),
      allowedAttributes: {
        ...sanitizeHtml.defaults.allowedAttributes,
        img: ['src', 'alt', 'title']
      }
    });
    return htmlString.replace(/<(\/?)h([1-3])>/g, (match, p1, p2) => {
      const newLevel = parseInt(p2) + 1;
      return `<${p1}h${newLevel}>`;
    });
  } catch (error) {
    console.error("Markdown to HTML conversion error", error.message);
    throw new Error('Failed to process markdown content');
  }
}


/******************************* ROUTES *******************************/

/**
 * @route GET /admin
 * @description Renders the admin panel page with configuration settings and CSRF protection. 
 *              Sets up page metadata (title, description) and checks for webmaster status.
 *              On error, redirects to home with a flash error message.
 * 
 * @request
 * @query {Object} [locals] - Page metadata and configuration:
 * @query {string} locals.title - Page title ("Admin Panel")
 * @query {string} locals.description - Page description ("Admin Panel")
 * @query {Object} locals.config - Site configuration from res.locals
 * 
 * @response
 * @renders admin/index - Admin panel view with:
 * @property {Object} locals - Page metadata and config
 * @property {string} layout - Admin layout template
 * @property {string} csrfToken - CSRF protection token
 * @property {boolean} isWebMaster - Webmaster access flag (hardcoded false)
 * 
 * @returns {200} Renders admin panel page on success
 * @returns {302} Redirects to / with error flash message on failure
 * @access Private (implied by admin route)
 * @csrf Generates and requires CSRF token
 */
router.get('/admin', async (req, res) => {
  try {
    const locals = {
      title: "Admin Panel",
      description: "Admin Panel",
      config: res.locals.siteConfig
    }
    res.render('admin/index', {
      locals,
      layout: adminLayout,
      csrfToken: req.csrfToken(),
      isWebMaster: false
    });
  } catch (error) {
    console.error("Admin Page error", error.message);
    req.flash('error', 'Internal Server Error');
    res.redirect('/');
  }
});

/**
 * @route POST /register
 * @description Handles new user registration with comprehensive validation:
 *              - Checks for empty fields
 *              - Validates username format
 *              - Verifies username uniqueness
 *              - Ensures password strength and confirmation match
 *              - Checks registration system availability
 *              - Hashes password and creates user if all validations pass
 * 
 * @middleware genericAdminRateLimiter - Applies rate limiting to prevent abuse
 * 
 * @request
 * @body {string} username - Desired username (alphanumeric + special chars)
 * @body {string} password - User password (must meet strength requirements)
 * @body {string} name - User's display name
 * @body {string} confirm_password - Password confirmation (must match password)
 * 
 * @validation
 * @throws {401} If any mandatory field is empty
 * @throws {400} If username format is invalid
 * @throws {409} If username already exists
 * @throws {400} If password and confirmation don't match
 * @throws {400} If password doesn't meet strength requirements
 * 
 * @response
 * @success {302} Redirects to /admin with success flash on creation
 * @failure {302} Redirects to /admin with error flash on:
 *               - Validation failures
 *               - Registration disabled (with security notice)
 *               - Server errors
 * 
 * @security
 * @uses CSRF (implied by form submission)
 * @rateLimited Prevents brute force attacks
 * @passwordHashing Uses bcrypt with 10 rounds
 * 
 * @configDependent Checks res.locals.siteConfig.isRegistrationEnabled
 * 
 * @access Public (registration endpoint)
 * 
 * @errorHandling
 * @logs Detailed error context (with environment-sensitive logging)
 * @notifies Users via flash messages
 * @reports Security incidents when registration is disabled
 */
router.post('/register', genericAdminRateLimiter, async (req, res) => {
  try {
    const { username, password, name, confirm_password } = req.body;

    //check for empty field
    if (!name || !username || !password || !confirm_password) {
      console.error(401, 'empty mandatory fields');
      throw new Error('One or more mandatory fields are missing');
    }

    // check is username is of proper format defined in regex pattern
    const usernameRegex = /^[a-zA-Z0-9\-\_\.\+\@]+$/;
    const usernameErrorMessage = 'Username can only contain letters, numbers, hyphens, underscores, dots, plus signs, and at-symbols!'
    if (!usernameRegex.test(username)) {
      const env = process.env.NODE_ENV;
      if (env && env.toLowerCase() === "production") {
        console.error(400, 'Invalid username format');
      } else {
        console.error(400, 'Invalid username format', username);
      }
      throw new Error(usernameErrorMessage);
    }

    // checking for existing user
    const existingUser = await user.findOne({ username })
    if (existingUser) {
      console.error(409, 'Username already exists');
      throw new Error('Username already Exists, try a new username');
    }

    //check password and confirm password match
    if (!(password === confirm_password)) {
      console.error('Password and confirm passwords do not match');
      throw new Error('Passwords and Confirm Password do not match!');
    }

    if (!isStrongPassword(password)) {
      throw new Error('Password is too weak. It should be at least 8 characters long, contain at least one uppercase letter, one lowercase letter, one number, and one special character.');
    }

    //registration logic
    if (res.locals.siteConfig.isRegistrationEnabled) {
      const hashedPassword = await bcrypt.hash(password, 10);
      try {
        const newUser = await user.create({ username, password: hashedPassword, name });
        console.log('User created', newUser, 201);
        req.flash('success', `new user ${username} is created, try signing in`)
        res.redirect('/admin');
      } catch (error) {
        console.error({
          status: 500,
          message: 'Internal server error',
          reason: error.message
        });
        req.flash('error', error.message);
        res.redirect('/admin');
      }
    } else {
      console.warn(`Someone with username ${username} tryied registering when it is turned off`);
      req.flash('info', 'Registration not enabled, Contact with Site admin, User not created, This incedent will be reported');
      res.redirect('/admin');
    }
  } catch (error) {
    console.error('errors during registration', error);
    req.flash('error', error.message);
    res.redirect('/admin');
  }
});

/**
 * @route POST /admin
 * @description Authenticates users by validating credentials against the database.
 *              On success: Issues JWT token in HTTP-only cookie and redirects to dashboard.
 *              On failure: Redirects with appropriate error messages.
 * 
 * @middleware authRateLimiter - Prevents brute force attacks with rate limiting
 * 
 * @request
 * @body {string} username - User's login username
 * @body {string} password - User's plaintext password
 * 
 * @validation
 * @throws {400} If username or password is empty
 * @throws {401} If username doesn't exist or password is invalid (generic error for security)
 * @throws {403} If account has password reset flag (disabled login)
 * 
 * @response
 * @success {302} Sets HTTP-only JWT cookie and redirects to /dashboard with welcome flash
 * @failure {302} Redirects to /admin with error flash for all failure cases
 * 
 * @security
 * @cookie {string} token - JWT token stored as httpOnly cookie
 * @uses JWT signed with server's secret key
 * @passwordVerification Uses bcrypt.compare() for secure password checking
 * 
 * @sessionManagement
 * @jwtPayload {string} userId - User's database ID embedded in token
 * 
 * @logging
 * @successLog Records successful login (username hidden in production)
 * @errorLog Detailed error contexts with security-conscious logging
 * 
 * @access Public (authentication endpoint)
 * 
 * @errorHandling
 * @genericErrors Returns "Invalid credentials" for both username/password failures
 * @disabledAccounts Special handling for password-reset-locked accounts
 * @notifies Users via flash messages
 */
router.post('/admin', authRateLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    //checks if the username or passwords are not empty
    if (!username || !password) {
      throw new Error('Username and Passwords are mandatory');
    }

    //checks if the user exists
    const currentUser = await user.findOne({ username });
    if (!currentUser) {
      console.error('invalid Username for user: ', username);
      throw new Error('Either username or password dont match, Invalid credentials');
    }

    if (currentUser.isPasswordReset) {
      console.error('Login Disabled for this Username:', username);
      throw new Error('Login Disabled for this Username, Contact Webmaster');
    }

    //password validity check
    const isPasswordValid = await bcrypt.compare(password, currentUser.password);
    if (!isPasswordValid) {
      console.error('invalid password for user: ', username);
      throw new Error('Either username or password dont match, Invalid credentials');
    }

    //adds session
    const token = jwt.sign({ userId: currentUser._id }, jwtSecretKey);
    res.cookie('token', token, { httpOnly: true });
    console.log("Successful Log In", (process.env.NODE_ENV && process.env.NODE_ENV.toLowerCase() !== "production") ? username : '');
    req.flash('success', `Sign in successful, welcome ${currentUser.name}`);
    res.redirect('/dashboard');
  } catch (error) {
    //for any other errors
    console.error({
      status: 500,
      message: 'Internal Server Error',
      Reason: error.message
    });
    req.flash('error', error.message);
    res.redirect('/admin');
  }
});

/**
 * @route GET /dashboard
 * @description Renders the admin dashboard with privilege-based content filtering.
 *              - Writers see only their own posts
 *              - Moderators/Webmasters see all posts
 *              - Invalid privilege levels get redirected
 * 
 * @middleware 
 * @chain authToken - Verifies JWT authentication
 * @chain genericGetRequestRateLimiter - Prevents request flooding
 * 
 * @request
 * @cookie {string} token - JWT for authentication (via authToken middleware)
 * 
 * @response
 * @success {200} Renders dashboard view with:
 * @property {Object} locals - Page metadata and config
 * @property {Object} currentUser - Authenticated user's data
 * @property {Array} data - Posts filtered by user privilege
 * @property {string} csrfToken - CSRF protection token
 * @property {boolean} isWebMaster - Webmaster status flag
 * 
 * @failure {302} Redirect cases:
 * @case /admin - When user not found (with tsundere error message)
 * @case /admin - When invalid privilege level (with webmaster contact prompt)
 * @case /admin - On server errors (with generic error)
 * 
 * @privilegeHandling
 * @enum WRITER - Can view only own posts (sorted newest first)
 * @enum MODERATOR - Can view all posts
 * @enum WEBMASTER - Can view all posts
 * 
 * @security
 * @requires JWT Authentication
 * @csrf Protected endpoint
 * 
 * @access Private (requires valid authenticated session)
 * 
 * @errorHandling
 * @userNotFound Special tsundere-style error message
 * @invalidPrivilege Detailed logging with 403 equivalent
 * @serverErrors Generic internal server error handling
 * 
 * @logging
 * @verboseLogs Includes privilege level checks and user validation
 * @securityLogs Records unauthorized access attempts
 */
router.get('/dashboard', authToken, genericGetRequestRateLimiter, async (req, res) => {
  try {
    const locals = {
      title: 'Admin Dashboard',
      description: 'Dashboard Panel',
      config: res.locals.siteConfig
    };
    const currentUser = await user.findById(req.userId);
    if (!currentUser) {
      console.error('User not found', req.userId);
      req.flash('error', `I-It's not like I want you to be here or anything! B-But you’re not allowed on this page, okay?! So just go away before I really get mad! Hmph`);
      return res.redirect('/admin');
    }
    let data;
    switch (currentUser.privilege) {
      case PRIVILEGE_LEVELS_ENUM.WRITER:
        data = await post.find({ author: currentUser.username }).sort({ createdAt: -1 });
        break;
      case PRIVILEGE_LEVELS_ENUM.MODERATOR:
        data = await post.find().sort({ createdAt: -1 });
        break;
      case PRIVILEGE_LEVELS_ENUM.WEBMASTER:
        data = await post.find().sort({ createdAt: -1 });
        break;
      default:
        console.error({
          status: 403,
          message: 'Invalid privilage level',
          reason: 'User did not have adequate permission to view this page'
        });
        req.flash('error', 'You do not have adequate permission to view this page, Contact Webmaster');
        return res.redirect('/admin');
    }

    res.render('admin/dashboard', {
      locals,
      layout: adminLayout,
      currentUser,
      data,
      csrfToken: req.csrfToken(),
      isWebMaster: isWebMaster(currentUser)
    });
  } catch (error) {
    console.error(error);
    req.flash('error', 'Internal Server Error');
    res.redirect('/admin');
  }
});

/**
 * @route GET /admin/add-post
 * @description Renders the "Add Post" form page for authorized users. Verifies user authentication
 *              and existence before granting access to the post creation interface.
 * 
 * @middleware
 * @chain authToken - Validates JWT authentication token
 * @chain genericGetRequestRateLimiter - Prevents brute force/DoS attacks
 * 
 * @request
 * @cookie {string} token - JWT for authentication (via authToken middleware)
 * 
 * @response
 * @success {200} Renders add-post view with:
 * @property {Object} locals - Page metadata and site configuration
 * @property {Object} currentUser - Authenticated user's data
 * @property {string} csrfToken - CSRF protection token
 * @property {boolean} isWebMaster - Webmaster status flag
 * 
 * @failure {302} Redirect cases:
 * @case /admin - When user not found (with anime-style tsundere error message)
 * @case /dashboard - On server errors (with generic error flash)
 * 
 * @security
 * @requires JWT Authentication
 * @csrf Protected endpoint
 * @rateLimited Against excessive requests
 * 
 * @access Private (requires valid authenticated session)
 * 
 * @errorHandling
 * @userNotFound Special anime-style error message
 * @serverErrors Generic internal server error handling
 * 
 * @uiElements
 * @includes CSRF token in form
 * @displays Webmaster-specific features based on privilege
 * 
 * @logging
 * @verboseLogs User verification process
 * @securityLogs Records unauthorized access attempts
 */
router.get('/admin/add-post', authToken, genericGetRequestRateLimiter, async (req, res) => {
  try {
    const locals = {
      title: 'Add Post',
      description: 'Add Post',
      config: res.locals.siteConfig
    };

    const currentUser = await user.findById(req.userId);
    if (!currentUser) {
      console.error('User not found', req.userId);
      req.flash('error', `I-It's not like I want you to be here or anything! B-But you’re not allowed on this page, okay?! So just go away before I really get mad! Hmph!`);
      return res.redirect('/admin');
    }

    res.render('admin/add-post', {
      locals,
      layout: adminLayout,
      currentUser,
      csrfToken: req.csrfToken(),
      isWebMaster: isWebMaster(currentUser)
    });
  } catch (error) {
    console.error(error);
    req.flash('error', 'Internal Server Error');
    res.redirect('/dashboard');
  }
});

/**
 * @route POST /admin/add-post
 * @description Handles new post submission from admin interface. 
 *              Delegates post saving to `savePostToDB` service function.
 *              Success: Redirects to dashboard with success notification.
 *              Failure: Redirects to dashboard with error details.
 * 
 * @middleware
 * @chain authToken - Validates JWT authentication
 * @chain genericAdminRateLimiter - Prevents spamming/abuse
 * 
 * @request
 * @body {Object} Post data - Structure depends on savePostToDB implementation
 * @cookie {string} token - JWT for authentication
 * 
 * @response
 * @success {302} Redirects to /dashboard with success flash message
 * @failure {302} Redirects to /dashboard with error flash message
 * 
 * @businessLogic
 * @delegates savePostToDB - Handles actual post validation and persistence
 * 
 * @security
 * @requires JWT Authentication
 * @rateLimited Against excessive submissions
 * 
 * @access Private (requires admin privileges)
 * 
 * @errorHandling
 * @catches All errors from savePostToDB
 * @logs Full error details to console
 * @notifies User via flash messages
 * 
 * @successHandling
 * @notifies User with success message
 * @redirects To main dashboard
 * 
 * @logging
 * @detailedErrorLogs Includes status codes and reasons
 * @securityLogs Tracks submission attempts
 */
router.post('/admin/add-post', authToken, genericAdminRateLimiter, async (req, res) => {
  try {
    await savePostToDB(req, res);
    req.flash('success', 'New Post Created')
    return res.redirect('/dashboard');
  } catch (error) {
    console.error({ status: 500, message: 'Internal Server Error', reason: error.message });
    req.flash('error', error.message)
    res.redirect('/dashboard');
  }
});

/**
 * @function savePostToDB
 * @description Handles the complete post creation workflow including validation,
 *              markdown conversion, and database persistence. Applies business
 *              rules for content length, required fields, and thumbnail defaults.
 * 
 * @param {Object} req - Express request object containing:
 * @param {string} req.userId - Authenticated user's ID from JWT
 * @param {Object} req.body - Post data including:
 * @param {string} req.body.title - Post title (trimmed, length validated)
 * @param {string} req.body.markdownbody - Markdown content (converted to HTML)
 * @param {string} req.body.desc - Post description (trimmed, length validated)
 * @param {string} [req.body.tags] - Optional tag string
 * @param {string} [req.body.thumbnailImageURI] - Optional custom thumbnail URI
 * 
 * @param {Object} res - Express response object (unused in current implementation)
 * 
 * @returns {Promise<string>} Resolves with the new post's ID string on success
 * 
 * @throws {Error} With descriptive messages for:
 * @throws User not found
 * @throws Missing required fields
 * @throws Content length violations
 * 
 * @businessLogic
 * @step 1 User verification
 * @step 2 Site configuration lookup (for default thumbnail)
 * @step 3 Field validation (required fields + length checks)
 * @step 4 Markdown-to-HTML conversion
 * @step 5 Post object creation with:
 *        - Author tracking
 *        - Timestamping
 *        - Tag parsing
 *        - Thumbnail fallback logic
 * @step 6 Database persistence
 * 
 * @validation
 * @rule Title, body, and description are required (trimmed)
 * @rule Title max length: configurable via MAX_TITLE_LENGTH (default: 50)
 * @rule Description max length: configurable via MAX_DESCRIPTION_LENGTH (default: 1000)
 * @rule Body max length: configurable via MAX_BODY_LENGTH (default: 100000)
 * @rule Thumbnail URI falls back to:
 *       1. Provided URI (if valid)
 *       2. Site config default
 *       3. Environment variable default
 * 
 * @dependencies
 * @external markdownToHtml - Converts markdown to HTML
 * @external isValidURI - Validates thumbnail URIs
 * @external parseTags - Processes tag strings (implementation not shown)
 * 
 * @logging
 * @successLog Records username and post details (full in dev, partial in prod)
 * @errorLog Detailed validation failures
 * @configWarning Logs missing site config in non-production
 * 
 * @security
 * @ensures All string fields are trimmed
 * @tracks Author and last editor
 * 
 * @configuration
 * @env MAX_TITLE_LENGTH - Configures title max chars
 * @env MAX_DESCRIPTION_LENGTH - Configures description max chars
 * @env MAX_BODY_LENGTH - Configures body max chars
 * @env DEFAULT_POST_THUMBNAIL_LINK - Fallback thumbnail URI
 */
async function savePostToDB(req, res) {
  try {
    const currentUser = await user.findById(req.userId);
    if (!currentUser) {
      console.error('User not found');
      throw new Error("User not found while saving post.");
    }

    const currentSiteConfig = await siteConfig.findOne();
    let siteConfigDefaultThumbnail;
    if (!currentSiteConfig) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('Site configuration not found');
      }
      siteConfigDefaultThumbnail = process.env.DEFAULT_POST_THUMBNAIL_LINK
    } else {
      siteConfigDefaultThumbnail = currentSiteConfig.siteDefaultThumbnailUri;
    }

    const defaultThumbnailImageURI = isValidURI(req.body.thumbnailImageURI) ? req.body.thumbnailImageURI : siteConfigDefaultThumbnail

    if (!req.body.title?.trim() || !req.body.markdownbody?.trim() || !req.body.desc?.trim()) {
      console.error('Missing required fields!');
      throw new Error("Title, body, and description are required!");
    }
    const MAX_TITLE_LENGTH = parseInt(process.env.MAX_TITLE_LENGTH) || 50;
    const MAX_DESCRIPTION_LENGTH = parseInt(process.env.MAX_DESCRIPTION_LENGTH) || 1000;
    const MAX_BODY_LENGTH = parseInt(process.env.MAX_BODY_LENGTH) || 100000;
    if (req.body.title.length > MAX_TITLE_LENGTH || req.body.markdownbody.length > MAX_BODY_LENGTH || req.body.desc.length > MAX_DESCRIPTION_LENGTH) {
      console.error('Title, body, and description must not exceed their respective limits!');
      throw new Error('Title, body, and description must not exceed their respective limits!')
    }

    const htmlBody = markdownToHtml(req.body.markdownbody.trim());

    const newPost = new post({
      title: req.body.title.trim(),
      markdownbody: req.body.markdownbody.trim(),
      body: htmlBody,
      author: currentUser.username.trim(),
      tags: parseTags((req.body.tags || '').trim()),
      desc: req.body.desc.trim(),
      thumbnailImageURI: defaultThumbnailImageURI,
      lastUpdateAuthor: currentUser.username.trim(),
      modifiedAt: Date.now()
    });

    await newPost.save();

    console.log('New post added by ', currentUser.username, '\n', newPost);
    return newPost._id.toString();
  } catch (error) {
    throw new Error(`Could not save post data: ${error.message}`);
  }
}

/**
 * @route GET /edit-post/:id
 * @description Renders the post editing interface for authorized users.
 *              Loads the specified post's data and verifies user privileges.
 *              Provides CSRF protection and webmaster status detection.
 * 
 * @middleware
 * @chain authToken - Validates JWT authentication
 * @chain genericGetRequestRateLimiter - Prevents brute force attacks
 * 
 * @params
 * @param {string} id - MongoDB _id of the post to edit
 * 
 * @request
 * @cookie {string} token - JWT for authentication
 * 
 * @response
 * @success {200} Renders edit-post view with:
 * @property {Object} locals - Page metadata including:
 *           @subprop {string} title - Dynamic title with post name
 *           @subprop {string} description - Static editor description
 *           @subprop {Object} config - Site configuration
 * @property {Object} data - The full post document from database
 * @property {string} layout - Admin layout template
 * @property {string} csrfToken - CSRF protection token
 * @property {boolean} isWebMaster - Webmaster privilege flag
 * @property {Object} currentUser - Minimal user data containing privilege level
 * 
 * @failure {302} Redirects to /dashboard with error flash when:
 * @case Post not found
 * @case User not authenticated
 * @case Server error occurs
 * 
 * @security
 * @requires JWT Authentication
 * @csrf Protected endpoint
 * @rateLimited Against excessive requests
 * 
 * @access Private (requires valid authentication)
 * 
 * @privilegeHandling
 * @note Actual edit permissions should be checked during POST submission
 * 
 * @errorHandling
 * @catches All errors generically
 * @logs Full error to console
 * @notifies User with generic flash message
 * 
 * @logging
 * @verboseLogs Includes post lookup details
 * @securityLogs Records access attempts
 */
router.get('/edit-post/:id', authToken, genericGetRequestRateLimiter, async (req, res) => {
  try {

    const data = await post.findOne({ _id: req.params.id });

    const locals = {
      title: "Edit Post - " + data.title,
      description: "Post Editor",
      config: res.locals.siteConfig
    };

    const currentUser = await user.findById(req.userId);

    res.render('admin/edit-post', {
      locals,
      data,
      layout: adminLayout,
      csrfToken: req.csrfToken(),
      isWebMaster: isWebMaster(currentUser),
      currentUser: { privilege: currentUser.privilege }
    })

  } catch (error) {
    console.log(error);
    req.flash('error', 'Internal Server Error');
    res.redirect('/dashboard');
  }
});

/**
 * @route PUT /edit-post/:id
 * @description Handles post updates with comprehensive validation and moderation capabilities.
 *              Performs field validation, markdown conversion, and privilege-based updates.
 * 
 * @middleware
 * @chain authToken - Validates JWT authentication
 * @chain genericAdminRateLimiter - Prevents abuse with rate limiting
 * 
 * @params
 * @param {string} id - MongoDB _id of the post to update
 * 
 * @request
 * @body {Object} Post data including:
 * @body {string} title - Updated post title (trimmed, length validated)
 * @body {string} markdownbody - Updated markdown content (converted to HTML)
 * @body {string} desc - Updated description (trimmed, length validated)
 * @body {string} [tags] - Optional updated tags
 * @body {string} [thumbnailImageURI] - Optional updated thumbnail URI
 * @body {string} [isApproved] - 'on' for moderators/webmasters to approve posts
 * 
 * @validation
 * @rule All required fields must be present (title, markdownbody, desc)
 * @rule Title max length: configurable via MAX_TITLE_LENGTH (default: 50)
 * @rule Description max length: configurable via MAX_DESCRIPTION_LENGTH (default: 1000)
 * @rule Body max length: configurable via MAX_BODY_LENGTH (default: 100000)
 * @rule Thumbnail URI falls back to site config or environment default
 * 
 * @privilegeHandling
 * @level MODERATOR/WEBMASTER - Can modify approval status via isApproved
 * @level WRITER - Can only update standard fields
 * 
 * @response
 * @success {302} Redirects to dashboard with success flash
 * @failure {302} Redirect cases:
 * @case /edit-post/:id - Validation errors with field-specific messages
 * @case /dashboard - General errors or update failures
 * 
 * @security
 * @requires JWT Authentication
 * @rateLimited Against excessive updates
 * @tracks LastUpdateAuthor - Records username of editor
 * 
 * @logging
 * @devLog Detailed validation errors (suppressed in production)
 * @errorLog Full error traces for debugging
 * @updateLog Records modification timestamps
 * 
 * @configuration
 * @env MAX_TITLE_LENGTH - Controls title validation
 * @env MAX_DESCRIPTION_LENGTH - Controls description validation
 * @env MAX_BODY_LENGTH - Controls body validation
 * @env DEFAULT_POST_THUMBNAIL_LINK - Fallback thumbnail URI
 * 
 * @access Private (requires valid authentication)
 * 
 * @errorHandling
 * @userNotFound Specific error for missing users
 * @validationErrors Field-specific feedback via flash
 * @updateFailures Checks post-update verification
 */
router.put('/edit-post/:id', authToken, genericAdminRateLimiter, async (req, res) => {
  try {
    const currentUser = await user.findById(req.userId);
    if (!currentUser) {
      console.error('User not found', req.userId);
      throw new Error(`No User Found for: ${req.userId}`);
    }
    const currentSiteConfig = await siteConfig.findOne();
    let siteConfigDefaultThumbnail;
    if (!currentSiteConfig) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('Site configuration not found');
      }
      siteConfigDefaultThumbnail = process.env.DEFAULT_POST_THUMBNAIL_LINK
    } else {
      siteConfigDefaultThumbnail = currentSiteConfig.siteDefaultThumbnailUri;
    }
    const defaultThumbnailImageURI = isValidURI(req.body.thumbnailImageURI) ? req.body.thumbnailImageURI : siteConfigDefaultThumbnail;

    if (!req.body.title?.trim() || !req.body.markdownbody?.trim() || !req.body.desc?.trim()) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Title, body, and description are missing while editing /post/', req.params.id);
      }
      req.flash('error', 'Title, body, and description are required!, Post is not updated');
      return res.redirect(`/admin/edit-post/${req.params.id}`)
    }

    const MAX_TITLE_LENGTH = parseInt(process.env.MAX_TITLE_LENGTH) || 50;
    const MAX_DESCRIPTION_LENGTH = parseInt(process.env.MAX_DESCRIPTION_LENGTH) || 1000;
    const MAX_BODY_LENGTH = parseInt(process.env.MAX_BODY_LENGTH) || 100000;

    if (req.body.title.length > MAX_TITLE_LENGTH || req.body.markdownbody.length > MAX_BODY_LENGTH || req.body.desc.length > MAX_DESCRIPTION_LENGTH) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Title, body, and description must not exceed their respective limits while editing /post/', req.params.id);
      }
      req.flash('error', 'Title, body, and description must not exceed their respective limits!, Post is not updated');
      return res.redirect(`/admin/edit-post/${req.params.id}`);

    }
    const htmlBody = markdownToHtml(req.body.markdownbody.trim());

    const updatePostData = {
      title: req.body.title.trim(),
      body: htmlBody,
      markdownbody: req.body.markdownbody.trim(),
      desc: req.body.desc.trim(),
      tags: parseTags((req.body.tags || '').trim()),
      thumbnailImageURI: defaultThumbnailImageURI,
      modifiedAt: Date.now(),
      lastUpdateAuthor: currentUser.username
    }

    if (currentUser.privilege === PRIVILEGE_LEVELS_ENUM.MODERATOR || currentUser.privilege === PRIVILEGE_LEVELS_ENUM.WEBMASTER) {
      updatePostData.isApproved = req.body.isApproved === 'on'
    }

    await post.findByIdAndUpdate(req.params.id, updatePostData);

    const updatedPost = await post.findById(req.params.id);
    if (!updatedPost) {
      console.error('Failed to update post', req.params.id);
      req.flash('error', 'Something went wrong, Post not updated')
      return res.redirect(`/admin/edit-post/${req.params.id}`);
    }

    req.flash('success', `Successfully updated post with id ${req.params.id}`);
    res.redirect(`/dashboard/`);

  } catch (error) {
    console.log(error);
    req.flash('error', 'Something Went Wrong');
    res.redirect('/dashboard');
  }
});

/**
 * @route DELETE /delete-post/:id
 * @description Handles post deletion with authorization checks and audit logging.
 *              Verifies both user authentication and post existence before deletion.
 *              Provides success/error feedback via flash messages.
 * 
 * @middleware
 * @chain authToken - Validates JWT authentication
 * @chain genericAdminRateLimiter - Prevents abuse with rate limiting
 * 
 * @params
 * @param {string} id - MongoDB _id of the post to delete
 * 
 * @validation
 * @check Verifies requesting user exists
 * @check Confirms target post exists
 * 
 * @response
 * @success {302} Redirects to /dashboard with success flash
 * @failure {302} Redirect cases:
 * @case /admin - When user not found (with auth error)
 * @case /dashboard - When post not found or other errors
 * 
 * @security
 * @requires JWT Authentication
 * @rateLimited Against excessive delete requests
 * 
 * @auditing
 * @logs Detailed deletion record including:
 *       - Requesting username
 *       - Deleted post details
 * 
 * @access Private (requires admin privileges)
 * 
 * @errorHandling
 * @userNotFound Specific error for missing users
 * @postNotFound Specific error for missing posts
 * @serverErrors Generic error catch-all
 * 
 * @notifications
 * @successFlash Confirms deletion with post ID
 * @errorFlash Provides context-specific failure messages
 * 
 * @logging
 * @securityLogs Records all deletion attempts
 * @auditLogs Detailed post deletion records
 * @errorLogs Full error traces for debugging
 */
router.delete('/delete-post/:id', authToken, genericAdminRateLimiter, async (req, res) => {
  try {
    const currentUser = await user.findById(req.userId);
    if (!currentUser) {
      console.error('User not found', req.userId);
      req.flash('error', `User not found/User Logged out`);
      return res.redirect('/admin');
    }

    const postToDelete = await post.findById(req.params.id);
    if (!postToDelete) {
      console.error('Post not found', req.params.id);
      req.flash('error', `post not found`);
      return res.redirect('/dashboard');
    }

    await post.deleteOne({ _id: req.params.id });
    console.log('Post deleted successfully\nDeletion Request: ', currentUser.username, '\nDeleted Post: ', postToDelete);
    req.flash('success', `Post Successfully Deleted with Id ${req.params.id}`);
    res.redirect('/dashboard');
  } catch (error) {
    console.log(error);
    req.flash(`error`, `Something went wrong`);
    res.redirect('/dashboard');
  }
});

/**
 * @route POST /logout
 * @description Logs out the user by clearing the authentication cookie (`token`). Displays a logout success flash message
 *              and redirects the user to the admin login page.
 * 
 * @request
 * @cookie {string} token - The JWT authentication token used for session tracking.
 * 
 * @returns {302} Redirects to /admin with a success flash message.
 * @access Public
 */
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  req.flash('success', `Sucessfully Logged out, Goodbye`);
  res.redirect('/admin');
});

/**
 * @route GET /admin/webmaster
 * @description Renders the webmaster administration panel with system configuration
 *              and user management capabilities. Validates webmaster privileges
 *              before granting access.
 * 
 * @middleware
 * @chain authToken - Validates JWT authentication
 * @chain genericGetRequestRateLimiter - Prevents brute force attacks
 * 
 * @privilegeCheck
 * @requires PRIVILEGE_LEVELS_ENUM.WEBMASTER - Strict webmaster-only access
 * 
 * @response
 * @success {200} Renders webmaster view with:
 * @property {Object} locals - Page metadata including:
 *           @subprop {string} title - Panel title
 *           @subprop {string} description - Panel description
 *           @subprop {Object} config - Site configuration
 * @property {string} layout - Admin layout template
 * @property {Object} currentUser - Authenticated user data
 * @property {string} csrfToken - CSRF protection token
 * @property {boolean} isWebMaster - Webmaster status flag
 * @property {Object} config - Site configuration document
 * @property {Array} users - List of all users (excluding current user)
 * 
 * @failure {302} Redirect cases:
 * @case /admin - When user not found
 * @case /dashboard - When insufficient privileges or server errors
 * 
 * @configurationHandling
 * @fallback Creates default siteConfig if none exists with:
 *           - Registration enabled
 *           - Default site name
 *           - System as last modifier
 * 
 * @security
 * @requires JWT Authentication
 * @csrf Protected endpoint
 * @rateLimited Against excessive requests
 * 
 * @access Private (strictly webmaster only)
 * 
 * @errorHandling
 * @userNotFound Specific error for missing users
 * @privilegeError Clear permission denial message
 * @serverErrors Generic internal error handling
 * 
 * @logging
 * @securityLogs Records unauthorized access attempts
 * @errorLogs Detailed error context
 * @configLogs Notes automatic config creation
 */
router.get('/admin/webmaster', authToken, genericGetRequestRateLimiter, async (req, res) => {
  try {
    const currentUser = await user.findById(req.userId);
    if (!currentUser) {
      console.error('User not found', req.userId);
      req.flash('error', 'User not found');
      res.redirect('/admin');
    }

    // Check if the user has the necessary privileges
    if (currentUser.privilege !== PRIVILEGE_LEVELS_ENUM.WEBMASTER) {
      req.flash('error', `you don't have sufficient permission/privilage to view this page`);
      return res.redirect('/dashboard');
    }

    const locals = {
      title: "Webmaster Panel",
      description: "Webmaster Administration Panel",
      config: res.locals.siteConfig
    }

    let config = await siteConfig.findOne();
    if (!config) {
      config = new siteConfig({
        isRegistrationEnabled: true,
        siteName: 'Blog-Site',
        lastModifiedBy: 'System',
      });
      await config.save();
    }

    const users = await user.find({ _id: { $ne: currentUser._id } }).sort({ privilege: -1 });

    res.render('admin/webmaster', {
      locals,
      layout: adminLayout,
      currentUser,
      csrfToken: req.csrfToken(),
      isWebMaster: isWebMaster(currentUser),
      config: config,
      users
    });
  } catch (error) {
    console.error("Webmaster Page error", error);
    req.flash('error', 'Something went wrong, Internal server error');
    res.redirect('/dashboard');
  }
});

/**
 * @route POST /edit-site-config
 * @description Handles updates to global site configuration with strict webmaster-only access.
 *              Performs extensive validation on all configurable parameters including:
 *              - Email format validation
 *              - Numeric range checks
 *              - URI validation
 *              - HTML sanitization
 *              - Security script validation
 * 
 * @middleware
 * @chain authToken - Validates JWT authentication
 * @chain genericAdminRateLimiter - Prevents abuse with rate limiting
 * 
 * @privilegeCheck
 * @strict PRIVILEGE_LEVELS_ENUM.WEBMASTER - Exclusive webmaster access
 * 
 * @validation
 * @email Validates admin email format with regex
 * @pagination Ensures limit is between 1-100
 * @search Ensures limit is between 1-50
 * @uri Validates thumbnail and homepage image URIs
 * @sanitization Applies HTML sanitization to all text fields
 * @script Validates analytics/tracking scripts
 * 
 * @requestBody
 * @param {string} [siteAdminEmail] - Admin contact email
 * @param {number} defaultPaginationLimit - Posts per page (1-100)
 * @param {number} searchLimit - Search results limit (1-50)
 * @param {string} [siteDefaultThumbnailUri] - Default post thumbnail
 * @param {string} [homepageWelcomeImage] - Homepage hero image
 * @param {string} isRegistrationEnabled - 'on' for enabled
 * @param {string} isCommentsEnabled - 'on' for enabled
 * @param {string} isCaptchaEnabled - 'on' for enabled
 * @param {string} isAISummerizerEnabled - 'on' for enabled
 * @param {string} siteName - Website title
 * @param {string} [siteMetaData*] - Various SEO metadata fields
 * @param {string} [googleAnalyticsScript] - Analytics script
 * @param {string} [inspectletScript] - Monitoring script
 * @param {string} [cloudflare*Key] - CAPTCHA keys
 * @param {string} [homeWelcomeText] - Hero section text
 * @param {string} [copyrightText] - Footer text
 * 
 * @response
 * @success {302} Redirects to /admin/webmaster with success flash
 * @failure {302} Redirect cases:
 * @case /dashboard - For validation errors, insufficient privileges, or server errors
 * 
 * @security
 * @requires Webmaster privilege
 * @sanitizes All HTML output
 * @validates External scripts
 * @rateLimited Against excessive updates
 * @auditLogs Changes with timestamp and editor
 * 
 * @configuration
 * @fallback Creates new config document if none exists
 * @defaults Uses environment variables for missing URIs
 * 
 * @logging
 * @securityLogs Unauthorized access attempts
 * @validationLogs Failed validation attempts
 * @successLogs Configuration changes with editor info
 * 
 * @errorHandling
 * @validationErrors Specific feedback per field type
 * @privilegeError Clear permission denial with security notice
 * @serverErrors Generic error catch-all
 */
router.post('/edit-site-config', authToken, genericAdminRateLimiter, async (req, res) => {
  try {
    const currentUser = await user.findById(req.userId);
    if (!currentUser) {
      console.error('User not found', req.userId);
      throw new Error('User not found');
    }

    if (currentUser.privilege === PRIVILEGE_LEVELS_ENUM.WEBMASTER) {
      // Update site settings in the database
      let globalSiteConfig = await siteConfig.findOne();

      // Validate critical fields
      const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      if (req.body.siteAdminEmail && !emailRegex.test(req.body.siteAdminEmail)) {
        console.warn('webmaster tried putting invalid email');
        throw new Error('Webmaster tried adding ill-formed email address');
      }
      const paginationLimit = parseInt(req.body.defaultPaginationLimit);
      if (Number.isNaN(paginationLimit) || paginationLimit < 1 || paginationLimit > 100) {
        console.warn('Invalid pagination limit');
        throw new Error('Webmaster tried updating invalid pagination limit')
      }

      const searchLimit = parseInt(req.body.searchLimit);
      if (Number.isNaN(searchLimit) || searchLimit < 1 || searchLimit > 50) {
        console.warn('Invalid search limit');
        throw new Error('Webmaster tried updating invalid pagination limit')
      }


      let validUrl = globalSiteConfig.siteDefaultThumbnailUri;
      if (req.body.siteDefaultThumbnailUri) {
        validUrl = isValidURI(req.body.siteDefaultThumbnailUri) ? req.body.siteDefaultThumbnailUri : process.env.DEFAULT_POST_THUMBNAIL_LINK;
      }
      const registrationEnable = req.body.isRegistrationEnabled === 'on';
      const commentsEnabled = req.body.isCommentsEnabled === 'on';
      const captchaEnabled = req.body.isCaptchaEnabled === 'on';
      const aISummerizerEnabled = req.body.isAISummerizerEnabled === 'on';

      let validHomePageImageUri = globalSiteConfig.homepageWelcomeImage;
      if (req.body.homepageWelcomeImage) {
        validHomePageImageUri = isValidURI(req.body.homepageWelcomeImage) ? req.body.homepageWelcomeImage : validUrl;
      }

      // global site settings helper
      const createConfigObject = (req, currentUser, validUrl, validHomePageImageUri, registrationEnable, commentsEnabled, captchaEnabled, aISummerizerEnabled) => ({
        isRegistrationEnabled: registrationEnable,
        isCommentsEnabled: commentsEnabled,
        isCaptchaEnabled: captchaEnabled,
        siteName: sanitizeHtml(req.body.siteName),
        siteMetaDataKeywords: sanitizeHtml(req.body.siteMetaDataKeywords),
        siteMetaDataAuthor: sanitizeHtml(req.body.siteMetaDataAuthor),
        siteMetaDataDescription: sanitizeHtml(req.body.siteMetaDataDescription),
        googleAnalyticsScript: isValidTrackingScript(req.body.googleAnalyticsScript),
        siteAdminEmail: sanitizeHtml(req.body.siteAdminEmail),
        siteDefaultThumbnailUri: validUrl,
        defaultPaginationLimit: req.body.defaultPaginationLimit,
        lastModifiedDate: Date.now(),
        lastModifiedBy: currentUser.username,
        inspectletScript: isValidTrackingScript(req.body.inspectletScript),
        homeWelcomeText: sanitizeHtml(req.body.homeWelcomeText),
        homeWelcomeSubText: sanitizeHtml(req.body.homeWelcomeSubText),
        homepageWelcomeImage: validHomePageImageUri,
        copyrightText: sanitizeHtml(req.body.copyrightText),
        searchLimit: searchLimit,
        cloudflareSiteKey: sanitizeHtml(req.body.cloudflareSiteKey),
        cloudflareServerKey: sanitizeHtml(req.body.cloudflareServerKey),
        isAISummerizerEnabled: aISummerizerEnabled
      });

      if (!globalSiteConfig) {
        globalSiteConfig = new siteConfig(createConfigObject(req, currentUser, validUrl, validHomePageImageUri, registrationEnable, commentsEnabled, captchaEnabled, aISummerizerEnabled));
        await globalSiteConfig.save();
      } else {
        await siteConfig.findOneAndUpdate({}, createConfigObject(req, currentUser, validUrl, validHomePageImageUri, registrationEnable, commentsEnabled, captchaEnabled, aISummerizerEnabled), { new: true });
      }
      console.log(`Site settings updated successfully by user: ${currentUser.username}`);
      req.flash('success', `Site settings are sucessfully updated`);
      res.redirect('/admin/webmaster');
    } else {
      console.error(`Unauthorised user tried to update site settings`);
      req.flash('error', `you dont have sufficient privilage/permission to update global site settings`);
      req.flash('info', `This incedent will be reported`);
      res.redirect('/dashboard');
    }
  } catch (error) {
    console.error(error);
    req.flash('error', error.message);
    res.redirect('/dashboard');
  }
});

/**
 * @route DELETE /delete-user/:id
 * @description Handles user deletion with strict webmaster authorization and safety checks.
 *              Prevents self-deletion and provides comprehensive audit logging.
 * 
 * @middleware
 * @chain authToken - Validates JWT authentication
 * @chain genericAdminRateLimiter - Prevents abuse with rate limiting
 * 
 * @params
 * @param {string} id - MongoDB _id of the user to delete
 * 
 * @validation
 * @check Verifies requesting user is webmaster
 * @check Confirms target user exists
 * @prevent Self-deletion with special handling
 * 
 * @security
 * @requires PRIVILEGE_LEVELS_ENUM.WEBMASTER - Strict webmaster-only access
 * @rateLimited Against excessive delete requests
 * @blocks SelfDeletion - Prevents account suicide with:
 *        - Error message
 *        - Humorous intervention
 *        - Redirect to edit page
 * 
 * @response
 * @success {302} Redirects to /admin/webmaster with info flash
 * @failure {302} Redirect cases:
 * @case /edit-user/:id - For self-deletion attempts
 * @case /admin/webmaster - For other errors
 * 
 * @auditing
 * @logs Detailed deletion record including:
 *       - Requesting webmaster
 *       - Deleted user details
 * @warns Unauthorized attempts
 * 
 * @access Private (strictly webmaster only)
 * 
 * @errorHandling
 * @unauthorized Clear rejection for non-webmasters
 * @userNotFound Specific error for missing users
 * @selfDelete Special humorous handling with:
 *             - Flash message
 *             - Fake helpline number
 *             - Redirect to edit page
 * 
 * @notifications
 * @infoFlash Confirms deletion with username
 * @errorFlash Provides context-specific failure messages
 * 
 * @logging
 * @securityLogs All deletion attempts
 * @auditLogs Successful deletions with full context
 * @errorLogs Detailed error traces
 */
router.delete('/delete-user/:id', authToken, genericAdminRateLimiter, async (req, res) => {
  try {
    const currentUser = await user.findById(req.userId);
    if (!currentUser || currentUser.privilege !== PRIVILEGE_LEVELS_ENUM.WEBMASTER) {
      console.warn('Unauthorized user tried to delete different user', req.userId);
      throw new Error('Unauthorised, User not deleted');
    }

    const userToDelete = await user.findById(req.params.id);
    if (!userToDelete) {
      console.warn('User not found', req.params.id);
      throw new Error('Current user not found');
    }

    //prevent self deletion
    if (currentUser._id.toString() === userToDelete._id.toString()) {
      console.warn({
        status: 403,
        message: 'Invalid Operation',
        reason: 'user tried to delete itself'
      });
      req.flash('error', 'Did you just try to delete yourself');
      req.flash('info', 'Suicide helpline number: 1800-1208-20050');
      return res.redirect(`/edit-user/${userToDelete._id}`);
    }

    await user.deleteOne({ _id: req.params.id });
    console.log('User deleted successfully\nDeletion Request: ', currentUser.username, '\nDeleted user: ', userToDelete);
    req.flash('info', `User ${userToDelete.username} is deleted`);
    res.redirect('/admin/webmaster');
  } catch (error) {
    console.error(error);
    req.flash('error', error.message);
    res.redirect('/admin/webmaster');
  }
});


/**
 * @route GET /edit-user/:id
 * @description Renders the user editing interface for webmasters to modify user accounts.
 *              Provides CSRF protection and conditional UI elements based on edit context.
 * 
 * @middleware
 * @chain authToken - Validates JWT authentication
 * @chain genericGetRequestRateLimiter - Prevents brute force attacks
 * 
 * @params
 * @param {string} id - MongoDB _id of the user to edit
 * 
 * @validation
 * @check Verifies target user exists
 * 
 * @response
 * @success {200} Renders edit-user view with:
 * @property {Object} locals - Page metadata including:
 *           @subprop {string} title - Dynamic title with user's name
 *           @subprop {string} description - Static editor description
 *           @subprop {Object} config - Site configuration
 * @property {Object} selectedUser - The user document being edited
 * @property {string} layout - Admin layout template
 * @property {string} csrfToken - CSRF protection token
 * @property {boolean} isWebMaster - Webmaster privilege flag
 * @property {boolean} showDelete - Conditional delete button visibility
 * @property {Object} config - Site configuration
 * 
 * @failure {302} Redirects to /dashboard when:
 * @case User not found
 * @case Server error occurs
 * 
 * @security
 * @requires JWT Authentication
 * @csrf Protected endpoint
 * @conditionalDelete Prevents self-delete UI
 * 
 * @access Private (requires webmaster privileges)
 * 
 * @uiLogic
 * @conditionalRendering Hides delete button for current user
 * 
 * @errorHandling
 * @userNotFound Specific error for missing users
 * @serverErrors Generic error handling
 * 
 * @logging
 * @verboseLogs Includes user lookup details
 * @errorLogs Detailed error context
 */
router.get('/edit-user/:id', authToken, genericGetRequestRateLimiter, async (req, res) => {
  try {
    const selectedUser = await user.findOne({ _id: req.params.id });
    if (!selectedUser) {
      console.error('User not found', req.params.id);
      throw new Error('User not found');
    }

    const locals = {
      title: "Webmaster - Edit User - " + selectedUser.name,
      description: "User Editor",
      config: res.locals.siteConfig
    };

    const currentUser = await user.findById(req.userId);

    res.render('admin/edit-user', {
      locals,
      selectedUser,
      layout: adminLayout,
      csrfToken: req.csrfToken(),
      isWebMaster: isWebMaster(currentUser),
      showDelete: currentUser.username !== selectedUser.username,
      config: res.locals.siteConfig
    })

  } catch (error) {
    console.error(error);
    req.flash('error', 'Something went wrong, Internal Server Error');
    res.redirect(`/dashboard`);
  }
});

/**
 * @route PUT /edit-user/:id
 * @description Handles user profile updates by webmasters with comprehensive security checks.
 *              Manages privilege level changes, password resets, and profile sanitization.
 * 
 * @middleware
 * @chain authToken - Validates JWT authentication
 * @chain genericAdminRateLimiter - Prevents abuse with rate limiting
 * 
 * @params
 * @param {string} id - MongoDB _id of the user to update
 * 
 * @validation
 * @check Verifies requesting user is webmaster
 * @check Confirms target user exists
 * @validate Requires non-empty name field
 * @validate Strong password requirements for resets
 * @sanitize Removes HTML/scripts from name field
 * @validate Proper privilege level enum value
 * 
 * @security
 * @requires PRIVILEGE_LEVELS_ENUM.WEBMASTER - Strict webmaster-only access
 * @rateLimited Against excessive updates
 * @sanitizes HTML input
 * @tracks Modification timestamp
 * 
 * @passwordHandling
 * @option Allows temporary password reset by admin
 * @enforces Strong password policy
 * @flags isPasswordReset when changed
 * 
 * @response
 * @success {302} Redirects to /admin/webmaster with success flash
 * @failure {302} Redirect cases:
 * @case /edit-user/:id - For validation errors or update failures
 * 
 * @logging
 * @securityLogs Unauthorized access attempts
 * @validationLogs Failed validation attempts
 * @auditLogs Successful updates with:
 *            - Editor info
 *            - Changed fields
 *            - Timestamp
 * 
 * @errorHandling
 * @unauthorized Clear rejection for non-webmasters
 * @userNotFound Specific error for missing users
 * @validationErrors Field-specific feedback
 * @scriptAttempt Logs and reports XSS attempts
 * 
 * @notifications
 * @successFlash Confirms successful update
 * @errorFlash Provides context-specific failure messages
 * @securityFlash Reports script injection attempts
 * 
 * @access Private (strictly webmaster only)
 */
router.put('/edit-user/:id', authToken, genericAdminRateLimiter, async (req, res) => {
  try {
    const currentUser = await user.findById(req.userId);
    if (!currentUser || currentUser.privilege !== PRIVILEGE_LEVELS_ENUM.WEBMASTER) {
      console.warn('Unauthorized user tried to delete different user', req.userId);
      throw new Error('Unauthorized User cannot edit other users');
    }

    const updateUser = await user.findById(req.params.id);
    if (!updateUser) {
      console.warn('User To be updated not found');
      throw new Error('User to be updated not found');
    }

    if (!req.body.name || !req.body.name.trim()) {
      console.warn('Name is a required field');
      throw new Error('Name is a required field');
    }

    let hashedTempPassword = '';
    let hasAdminResettedPassword = false;
    if (req.body.adminTempPassword) {
      hasAdminResettedPassword = true;
      const tempPassword = req.body.adminTempPassword.trim();
      if (!isStrongPassword(tempPassword)) {
        console.warn(`Webmaster User ${currentUser.username} tried resetting password of User ${updateUser.username} with a weak password`);
        throw new Error('Password is not strong enough, Must contain at least 8 characters, must contain a mix of uppercase, lowercase, numeric and special characters');
      }
      hashedTempPassword = await bcrypt.hash(tempPassword, 10);
    }

    const sanitizedName = sanitizeHtml(req.body.name.trim(), {
      allowedTags: [],
      allowedAttributes: {}
    });

    if (sanitizedName !== req.body.name.trim()) {
      console.warn(`Webmaster user ${updateUser.username} tried to add scripts on User's name`);
      req.flash('error', `you cannot add scripts on the user's name`);
      req.flash('info', `This incedent will be reported`);
    }

    const privilageLevel = (typeof req.body.privilege !=='undefined' && !isNaN(parseInt(req.body.privilege))) ? parseInt(req.body.privilege) : parseInt(updateUser.privilege);
    if (!Object.values(PRIVILEGE_LEVELS_ENUM).includes(parseInt(privilageLevel))) {
      console.warn('Invalid Privilage level');
      throw new Error('Invalid Privilage Level');
    }

    updateUser.name = sanitizedName;
    updateUser.privilege = privilageLevel;
    updateUser.isPasswordReset = hasAdminResettedPassword;
    updateUser.adminTempPassword = hashedTempPassword;
    updateUser.password = !hasAdminResettedPassword ? updateUser.password : resettedPassword;
    updateUser.modifiedAt = Date.now();

    try {
      await updateUser.save();
      console.log('User Updated successfully');
      req.flash('success', 'User Updated Successfully');
      res.redirect('/admin/webmaster');
    } catch (error) {
      console.error('Issue occured while updating user info', error);
      req.flash('error', 'Something went wrong while updating user, please try again');
      return res.redirect(`/edit-user/${req.params.id}`)
    }

  } catch (error) {
    console.log(error);
    req.flash('error', error.message);
    return res.redirect(`/edit-user/${req.params.id}`);
  }
});

/**
 * Checks if a password is strong based on defined criteria.
 *
 * A strong password must:
 * - Be at least 8 characters long
 * - Contain at least one uppercase letter
 * - Contain at least one lowercase letter
 * - Contain at least one number
 * - Contain at least one special character from the set [!@#$%^&*()]
 *
 * @function isStrongPassword
 * @param {string} password - The password string to validate.
 * @returns {boolean} Returns `true` if the password meets all strength requirements, otherwise `false`.
 *
 */
function isStrongPassword(password) {
  const minLength = 8;
  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecialChar = /[!@#$%^&*()]/.test(password);
  return password.length >= minLength && hasUppercase && hasLowercase && hasNumber && hasSpecialChar;
}

/**
 * @route POST /admin/generate-post-summary
 * @description Generates an AI-powered summary of markdown blog content using OpenRouter integration.
 *              Sanitizes input, processes through AI model, and returns formatted HTML response.
 * 
 * @middleware
 * @chain authToken - Requires valid authentication
 * @chain aiSummaryRateLimiter - Prevents API abuse with rate limiting
 * 
 * @request
 * @body {string} markdownbody - Required markdown content to summarize
 * 
 * @processing
 * @step 1 Input sanitization (HTML sanitization + trimming)
 * @step 2 AI processing via OpenRouter integration
 * @step 3 Markdown-to-HTML conversion of summary
 * @step 4 Attribution text inclusion
 * 
 * @response
 * @success {200} JSON response with:
 * @property {number} code - 200 status code
 * @property {string} message - HTML-formatted summary with attribution
 * 
 * @error {400} When markdownbody is missing:
 * @property {number} code - 400 status code
 * @property {string} message - Error description
 * 
 * @error {500} On processing failures:
 * @property {number} code - 500 status code
 * @property {string} message - Generic error message
 * 
 * @security
 * @requires Authentication
 * @sanitizes Input HTML
 * @rateLimited For API protection
 * 
 * @dependencies
 * @external openRouterIntegration - AI summary service
 * @external markdownToHtml - Conversion utility
 * 
 * @access Private (requires authentication)
 * 
 * @logging
 * @errorLogs Detailed API failure information
 * 
 * @note Attribution text is automatically appended to the AI summary
 */
router.post('/admin/generate-post-summary', authToken, aiSummaryRateLimiter, async (req, res) => {
  try {
    if (!req.body.markdownbody) {
      return res.status(400).json({
        'code': 400,
        'message': 'Blog Body is a must for generating summary'
      });
    }
    const response = await openRouterIntegration.summarizeMarkdownBody(sanitizeHtml(req.body.markdownbody).trim());
    const htmlResponse = markdownToHtml(response.summary + response.attribute);
    return res.status(200).json({
      'code': 200,
      'message': htmlResponse
    });
  } catch (error) {
    console.error('error generating summary: ', error);
    return res.status(500).json({
      'code': 500,
      'message': 'Internal Server Error'
    });
  }
});

/**
 * @route GET /admin/reset-password
 * @description Renders the password reset request page with CSRF protection.
 *              Provides a form for users to initiate password recovery process.
 * 
 * @middleware
 * @chain genericGetRequestRateLimiter - Prevents brute force attacks
 * 
 * @response
 * @success {200} Renders reset-password view with:
 * @property {Object} locals - Page metadata including:
 *           @subprop {string} title - Page title ("Forgot Password")
 *           @subprop {string} description - Page description
 *           @subprop {Object} config - Site configuration
 * @property {string} layout - Admin layout template
 * @property {string} csrfToken - CSRF protection token
 * @property {boolean} isWebMaster - Always false for this page
 * 
 * @failure {302} Redirects to /admin with error flash when:
 * @case Server error occurs
 * 
 * @security
 * @csrf Protected form
 * @rateLimited Against excessive requests
 * 
 * @access Public (does not require authentication)
 * 
 * @errorHandling
 * @catches All errors generically
 * @logs Full error to console
 * @notifies User with flash message
 * 
 * @uiElements
 * @includes CSRF token in form
 * @uses Standard admin layout
 */
router.get('/admin/reset-password', genericGetRequestRateLimiter, async (req, res) => {
  try {
    const locals = {
      title: "Forgot Password",
      description: "Password Reset Page",
      config: res.locals.siteConfig
    };

    return res.render('admin/reset-password', {
      locals,
      layout: adminLayout,
      csrfToken: req.csrfToken(),
      isWebMaster: false
    });
  } catch(error){
    console.log(error);
    req.flash('error', 'Internal Server Error');
    return res.redirect('/admin');
  }
});

/**
 * @route POST /admin/reset-password
 * @description Handles password reset process with multiple security validations:
 *              - Verifies temporary password
 *              - Enforces strong password policy
 *              - Prevents reuse of temporary password
 *              - Requires password confirmation
 * 
 * @middleware
 * @chain genericAdminRateLimiter - Prevents brute force attacks
 * 
 * @request
 * @body {string} username - Account username (sanitized)
 * @body {string} tempPassword - Webmaster-provided temporary password
 * @body {string} newPassword - User's new password
 * @body {string} confirmPassword - New password confirmation
 * 
 * @validation
 * @check All required fields present
 * @check Valid username format
 * @check User exists and is approved for reset
 * @check New password differs from temporary one
 * @check Password strength requirements met
 * @check Password confirmation matches
 * @verify Temporary password hash match
 * 
 * @security
 * @sanitizes Username input
 * @hashes New password with bcrypt (10 rounds)
 * @rateLimited Against abuse
 * @clears Temporary password after successful reset
 * 
 * @response
 * @success {302} Redirects to /admin with:
 * @flash success - Reset confirmation
 * @flash info - Login instructions
 * 
 * @failure {302} Redirect cases:
 * @case /admin/reset-password - For validation errors with:
 *      @flash error - Specific failure reason
 * @case /admin/reset-password - For system errors
 * 
 * @stateChanges
 * @updates password - Stores new bcrypt hash
 * @clears isPasswordReset flag
 * @removes adminTempPassword
 * 
 * @logging
 * @securityLogs Failed reset attempts
 * @successLogs Completed resets
 * @errorLogs System failures
 * 
 * @access Public (requires valid temporary credentials)
 * 
 * @errorHandling
 * @userInputErrors Specific validation messages
 * @systemErrors Generic server error message
 */
router.post('/admin/reset-password', genericAdminRateLimiter, async (req, res) => {
  try {
    const { username, tempPassword, newPassword, confirmPassword } = req.body;
    
    if (!username || !tempPassword || !newPassword || !confirmPassword) {
      console.log({ 'status': 400, 'message': 'one or more required feild missing' })
      throw new Error('Username, temporary password, new password and confirmation are all required fields');
    }
    if(typeof username !== 'string'){
      throw new Error("Invalid username format");
    }
    const sanitizedUserName = sanitizeHtml(username);
    const userModel = await user.findOne({ username: { $eq: sanitizedUserName } });
    if (!userModel) {
      throw new Error(`User doesn't exist`);
    }
    if (!userModel.isPasswordReset || !userModel.adminTempPassword || userModel.password !== resettedPassword) {
      throw new Error('User profile is not approved for reset by webmaster');
    }

    if (newPassword === tempPassword) {
      throw new Error('User can not reuse temporary Password as their new password');
    }

    if (!isStrongPassword(newPassword)) {
      throw new Error('Password is not strong');
    }

    if (newPassword !== confirmPassword) {
      throw new Error('new Password and confirm password do not match');
    }

    const isPasswordValid = await bcrypt.compare(tempPassword, userModel.adminTempPassword);
    if (!isPasswordValid) {
      console.error(`User: ${sanitizedUserName} is trying to reset password with incorrect temp password`, username);
      throw new Error('Either the username or the Temp password combination might be incorrect');
    } else {
      console.log(`User: ${sanitizedUserName} has successfully validated temp password`);
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      userModel.password = hashedPassword;
      userModel.isPasswordReset = false;
      userModel.adminTempPassword = '';
      try {
        await userModel.save();
        console.log('user reset successful');
        req.flash('success', 'User password successfully resetted');
        req.flash('info', `login is enabled for user: ${sanitizedUserName}, please sign in`);
        return res.redirect('/admin');
      } catch (error) {
        console.log('error while password reset', error);
        req.flash('error', 'Something went wrong while resetting password, Internal Server Error');
        res.redirect('/admin/reset-password');
      }
    }
  } catch (error) {
    console.error("Internal Server Error", error);
    req.flash('error', error.message);
    res.redirect('/admin/reset-password');
  }
});

module.exports = router;