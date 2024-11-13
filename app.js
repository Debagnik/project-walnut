require('dotenv').config();

const express = require('express');
const expressLayout = require('express-ejs-layouts');
const connectDB = require('./server/config/db');
const cookieParser = require('cookie-parser');
const mongoStore = require('connect-mongo');
const session = require('express-session');


const app = express();
const PORT = process.env.PORT || 5000;

//connect Database
connectDB();

app.use(express.urlencoded({extended: true}));
app.use(express.json());
app.use(express.static('./public'));
app.use(cookieParser());
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    store: mongoStore.create({
        mongoUrl: process.env.MONGO_DB_URI,
        ttl: 60 * 60,
        autoRemove: 'native',
        touchAfter: 24 * 60 * 60
    }),
    cookie:{
        maxAge: 3600000,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict'
    }
}));

// Middleware to protect routes
app.use(function (err, req, res, next) {
    if (err.code !== 'EBADCSRFTOKEN') return next(err)
  
    // handle CSRF token errors here
    res.status(403)
    res.send('Form tampered with')
});

//templating Engine
app.use(expressLayout);
app.set('layout', './layouts/main');
app.set('view engine', 'ejs');

app.use('/', require('./server/routes/main.js'));

app.use('/', require('./server/routes/admin.js'));

app.listen(PORT , () => {
    console.log(`App is listening to PORT ${PORT}`);
});