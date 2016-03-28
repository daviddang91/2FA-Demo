var http = require('http');
var express = require('express');
var u2f = require('node-u2f');
var session = require('express-session');
var bodyParser = require('body-parser');
var passport = require('passport');
var TOTPStrategy = require('passport-totp').Strategy;
var LocalStrategy = require('passport-local').Strategy;
var morgan = require('morgan');
var path = require('path');
var cookieParser = require('cookie-parser');
var mongoose = require('mongoose');
var base32 = require('thirty-two');
var flash = require('connect-flash');

var Account = require('./models/account');
var G2FA = require('./models/g2fa');
var U2F_Reg = require('./modles/u2f');

var port = (process.env.VCAP_APP_PORT || 3000);
var host = (process.env.VCAP_APP_HOST || 'localhost');
var mongo_url = 'mongodb://localhost/users';

if (process.env.VCAP_SERVICES) {
	var services = JSON.parse(process.env.VCAP_SERVICES);

	for (serviceName in services) {
		if (serviceName.match('^mongo')) {
			var creds = services[serviceName][0]['credentials'];
			mongo_url = creds.url;
		} else {
			console.log("no database found");
		}
	}
}

var app = express();

app.set('view engine', 'ejs');

app.use(morgan("default"));
app.use(cookieParser());
app.use(session({
  // genid: function(req) {
  //   return genuuid() // use UUIDs for session IDs
  // },
  secret: 'zsemjy',
  resave: false,
  saveUninitialized: false
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
//app.use(flash);
app.use(passport.initialize());
app.use(passport.session());
app.use('/',express.static('static'));


passport.use(new LocalStrategy(Account.authenticate()));
passport.use(new TOTPStrategy(function(user, done){
	G2FA.findOne({'username': user.username}, function(err, user){
		if (err) {
			return done(err);
		}
		return done(null, user.secret, 30);
	});
}));
passport.serializeUser(Account.serializeUser());
passport.deserializeUser(Account.deserializeUser());

mongoose.connect(mongo_url);

app.get('/', function(req,res){
	res.render('index');
});

app.get('/login', function(req,res){
	res.render('login');
});

app.post('/login', passport.authenticate('local', { failureRedirect: '/login', failureFlash: true }), function(req,res){
	res.redirect('/2faCheck');
});

app.get('/newUser', function(req,res){
	res.render('register');
});

app.post('/newUser', function(req,res){
	Account.register(new Account({ username : req.body.username }), req.body.password, function(err, account) {
		if (err) {
			console.log(err);
			return res.status(400).send(err.message);
		}

		passport.authenticate('local')(req, res, function () {
			console.log("created new user %s", req.body.username);
            res.status(201).send();
        });

	});
});

app.get('/setup2FA', ensureAuthenticated, function(req,res){
	res.render('setup2fa');
});

app.get('/2faCheck', function(req,res){
	res.render('check2fa');
});

app.get('/setupG2FA', ensureAuthenticated, function(req,res){
	G2FA.findOne({'username': req.user.username}, function(err,user){
		if (err) {
			res.status(400).send(err);
		} else {
			var secret;
			if (user !== null) {
				secret = user.secret;
			} else {
				//generate random key
				secret = genSecret(10);
				var newToken = new G2FA({username: req.user.username, secret: secret});
				newToken.save(function(err,tok){

				});
			}
			var encodedKey = base32.encode(secret);
			var otpUrl = 'otpauth://totp/2FADemo:' + req.user.username + '?secret=' + encodedKey + '&period=30&issuer=2FADemo';
			var qrImage = 'https://chart.googleapis.com/chart?chs=166x166&chld=L|0&cht=qr&chl=' + encodeURIComponent(otpUrl);
			res.send(qrImage);
		}
	});
});

app.post('/loginG2FA', ensureAuthenticated, passport.authenticate('totp'), function(req, res){
	req.session.secondFactor = 'g2fa';
});

app.get('/registerU2F', ensureAuthenticated, function(req,res){
	var registerRequest = u2f.startRegistration('http://localhost:3000');
	req.session.registerRequest = registerRequest;
	send(registerRequest);
});

app.post('/registerU2F', ensureAuthenticated, function(req,res){
	var registerResponse = req.body;
	var registerRequest = req.session.registerRequest;
	var user = req.user.username;
	var registration = u2f.finishRegistration(registerRequest,registerResponse);
	var reg = new U2F_Reg({username: user, deviceRegistration: registration });
	reg.save(function(err,r){

	});
});

app.get('/authenticateU2F', ensureAuthenticated, function(req,res){
	U2F_Reg.findOne({username: req.user.username}, function(err, reg){
		if (err) {
			res.status(400).send(err);
		} else {
			if (reg !== null) {
				var signRequest = u2f.startAuthentication(appId, reg.deviceRegistration);
				req.session.signrequest = signRequest;
				res.send(signRequest);
			}
		}
	});
});

app.post('/authenticateU2F', ensureAuthenticated, function(req,res){

});

function ensureAuthenticated(req,res,next) {
	if (req.isAuthenticated()) {
    	return next();
	} else {
		res.redirect('/login');
	}
}

function ensure2fa(req, res, next) {
	if (req.session.secondFactor) {
		return next();
	}
	res.redirect('/2faCheck');
}

function genSecret(len) {
	var buf = []
	, chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
	, charlen = chars.length;

	for (var i = 0; i < len; ++i) {
		buf.push(chars[getRandomInt(0, charlen - 1)]);
	}

	return buf.join('');
};

function getRandomInt(min, max) {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}


var server = http.Server(app);
server.listen(port, host, function(){
	console.log('Example app listening on  %s:%d!', host, port);
});
