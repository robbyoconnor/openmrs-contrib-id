'use strict';

const async = require('async');
const q = require('q');
const log = require('log4js').addLogger('db-admin');
const formage = require('formage');
const utils = require('../utils');
const _ = require('lodash');

/**
 * Mongoose models. Will be assigned when init() is called.
 */
let FormageUser;
let User;

/**
 * Create or update a Formage user that corresponds to this Dashboard admin.
 * @param  {User}     user     ID Dashboard user document
 * @param  {Function} callback Optional callback that receives error and create
 *                             Formage user
 * @return {Promise}           Promise resolved after Formage user is saved
 */
function syncFormageUser(user, callback) {
  return FormageUser.findOne({
    username: user.username,
  }).exec()
    .then(formageUser => (formageUser) ? updatePassword(formageUser, user) :
      createFormageUser(user))
    .then((formageUser) => {
      const deferred = q.defer();

      if (formageUser.isModified()) {
        return formageUser.save((err, fu) => {
          if (err) {
            deferred.reject(err);
          } else {
            deferred.resolve(fu);
          }
        });
      }
      deferred.resolve(formageUser);


      return deferred.promise;
    })
    .then((formageUser) => {
      log.debug(`formage user ${formageUser.username} saved`);

      return (callback) ? callback(null, formageUser) : formageUser;
    }, (err) => {
      callback(err);
    });
}


/**
 * Create a Formage user document for the given Dashboard user
 * @param  {User}         user Dashboard user document
 * @return {FormageUser}       Formage user document
 */
function createFormageUser(user) {
  const fu = new FormageUser({
    username: user.username,
    passwordHash: user.password,
    is_superuser: true,
  });

  updatePassword(fu, user);

  return fu;
}

/**
 * Update the password hash on a formage user to match the given dashboard user
 * @param  {FormageUser}  fu   Formage user to update
 * @param  {User}         user Dashboard user to get the password hash from
 * @return {FormageUser}  the updated Formage user
 */
function updatePassword(fu, user) {
  fu.passwordHash = user.password;
  return fu;
}

/**
 * Handles what to do when a Dashboard user doc is saved
 * @param  {User} user Dashboard user that was just saved
 * @return {undefined}
 */
function onSave(user) {
  if (_.includes(user.groups, 'dashboard-administrators')) {
    syncFormageUser(user);
  }
}

/**
 * Handles errors that occur during user sync.
 * @param  {Error} err the error that occured
 * @return {Error}     the (same) error that occured
 */
function onError(err) {
  log.error(err);
  return err;
}

/**
 * Called by db-admin/index.js to bootstrap the sync. Establishes the relevant
 * models, binds to the User save event, and syncs all current dashboard
 * administrators at startup.
 * @param  {Model} _FormageUser_ FormageUser mongoose model
 * @param  {Model} _User_        Dashboard User mongoose model
 * @return {Promise}             Promise resolved once admin users have been
 *                                       synced
 */
module.exports = function init(_FormageUser_, _User_) {
  FormageUser = _FormageUser_;
  User = _User_;

  User.schema.post('save', onSave);

  const deferred = q.defer();

  User.find({
    groups: 'dashboard-administrators',
  }).exec()
    .then((users) => {
      log.debug(`found ${users.length} dashboard administrator(s)`);

      async.each(users, syncFormageUser, (err) => {
        if (err) {
          onError(err);
          return deferred.reject(err);
        }

        log.info('Synced all dashboard admin users to Formage user models.');
        deferred.resolve();
      });
    }, onError);

  return deferred.promise;
};


/**
 * Formage uses two functions, encryptSync and compareSync, to create and
 * validate password hashes. Because we want to sync dashboard administators
 * with Formage users, we need to replace their hashing functions with our
 * own.
 */
const salt = 'wherestheninja'; // same salt formage uses internally
formage.UserForm.encryptSync = _.partialRight(utils.getSSHA, salt);
formage.UserForm.compareSync = utils.checkSSHA;
