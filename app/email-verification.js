'use strict';

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const pug = require('pug');
const url = require('url');
const async = require('async');
const _ = require('lodash');
const uuid = require('uuid');
const utils = require('./utils');

const conf = require('./conf');
const log = require('log4js').addLogger('email-verification');

const EmailVerification = require('./models/email-verification');

// update nodemailer
const transporter = nodemailer.createTransport(conf.email.smtp);

const simpleCallback = (err) => {
  if (err) {
    log.error(err);
  }
};

// create a verification and send emails
/* begin({
 *   addr,          (required) string of email address to send to
 *   subject,       (required) subject of email sent
 *   templatePath,  (required) absolute path to template file
 *   category,      category of this verification
 *   username,      username related to this request
 *   callback,      callback url
 *   locals,        extra locals for rendering or other additional infos
 * },callback)      receives errors
 */
exports.begin = (settings, callback) => {
  // parse arguments
  const addr = settings.addr;
  const subject = settings.subject;
  const templatePath = settings.templatePath;
  const category = settings.category || '';
  const username = settings.username || '';
  const description = settings.description || '';
  const callbackPath = settings.callback || null;
  const locals = settings.locals || {};

  if (!callback) { // if callback is not provided
    callback = simpleCallback;
  }

  // create verification instance and store in DB
  function storeInfo(cb) {
    const veriInfo = {
      uuid: uuid.v4(),
      addr,
      category,
      username,
      description,
      settings,
      locals,
    };
    const verification = new EmailVerification(veriInfo);
    log.trace('verification prepared for DB entry');

    verification.save((err) => {
      if (err) {
        return cb(err);
      }
      log.trace('verification stored in DB');
      return cb(null, veriInfo.uuid);
    });
  }

  function sendMail(uuid, cb) {
    uuid = utils.urlEncode64(uuid);
    _.merge(locals, {
      addr,
      siteURL: conf.site.url,
      imgURL: url.resolve(conf.site.url, '/resource/images/logo.png'),
      verifyURL: url.resolve(conf.site.url, path.join(callbackPath, uuid)),
    });
    const rendered = pug.renderFile(templatePath, locals);

    try {
      transporter.sendMail({
        from: "'OpenMRS ID Dashboard' <id-noreply@openmrs.org>",
        to: addr,
        subject,
        html: rendered,
      }, (e, success) => {
        if (e) {
          return cb(e);
        }
        log.info(`[${category}]: email verification sent to ${addr}`);
        return cb();
      });
    } catch (ex) {
      return cb(ex);
    }
  }

  async.waterfall([
    storeInfo,
    sendMail,
  ], callback);
};

// re-send verification email
// callback return error and the address sent to
exports.resend = (uuid, callback) => {
  // get the verification instance
  EmailVerification.findOne({
    uuid,
  }, (err, verification) => {
    if (err) {
      return callback(err);
    }
    if (_.isEmpty(verification)) {
      const msg = 'Email verification record is not found, maybe expired';
      log.error(msg);
      return callback(new Error(msg));
    }
    log.debug('found verification instance.');
    verification.remove((err) => {
      if (err) {
        return callback(err);
      }
      log.debug('verification cleared, now resending');
    });

    // begin new verification with settings of the first one
    exports.begin(verification.settings, callback);
  });
};

// verifies a validation request, callback returns error,
// boolean on whether request is valid, and any locals
exports.check = (uuid, callback) => {
  if (!_.isFunction(callback)) {
    throw new Error('callback must be a function');
  }

  EmailVerification.findOne({
    uuid,
  }, (err, verification) => {
    if (err) {
      return callback(err);
    }
    if (_.isEmpty(verification)) {
      log.debug('verification record not found');
      return callback(null, false);
    }

    const locals = verification.locals || {};
    callback(null, true, locals);
  });
};

// drops a verification (called on completion)
exports.clear = (uuid, callback) => {
  if (!callback) {
    callback = simpleCallback;
  }
  EmailVerification.findOneAndRemove({
    uuid,
  }, callback);
};

// helper functions to search for a verification,
// based on username or email address
exports.search = (credential, category, callback) => {
  // determine whether credential is email, username, or verifyId
  let terms;
  if (conf.user.usernameRegex.test(credential)) {
    terms = {
      username: credential,
    }; // is a user id
  } else if (conf.email.validation.emailRegex.test(credential)) {
    terms = {
      addr: credential, // is an email address
    };
  } else {
    return callback(new Error('invalid credential')); // return no matches
  }
  terms.category = category;
  EmailVerification.find(terms, callback);
};
