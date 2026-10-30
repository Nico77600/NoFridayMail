'use strict';

/*
 * Entra authentication for the task pane (MFA step of the exceptional send): Nested App Authentication (NAA) with
 * @azure/msal-browser. Task pane module ONLY: never imported by src/launchevent/ (check-bundle.js refuses
 * MSAL in launchevent.js). When the environment does not require the MFA step, webpack replaces @azure/msal-browser
 * with src/taskpane/msal-stub.js.
 *
 * Browser constraint: a popup window is only allowed as a SYNCHRONOUS continuation of a click
 * (user activation). The Conditional Access policy of the authentication context requires MFA "every
 * time": a silent token with the acrs claim always fails, and a window opened after an asynchronous
 * round trip would be blocked (popup_window_error). Hence:
 *   - the MSAL client is created and initialised BEFORE the click (init), and its Promise is cached;
 *   - with claims (acrs), acquireToken calls acquireTokenPopup DIRECTLY, without acquireTokenSilent and without
 *     awaiting anything first; it returns null if the client is not ready yet (the click never waits).
 *
 *   isSupported()                    NestedAppAuth 1.1 requirement set available?
 *   mode()                           'naa' or 'browser': MSAL silently falls back to browser mode when NAA is absent
 *   init(mfa)                        starts (once) the client creation; returns its Promise
 *   status(mfa)                      'none' | 'pending' | 'ready' | 'failed'; lastError(mfa): the initialisation error
 *   acquireToken(mfa, claimsJson)    Promise of an access token for the site API (api://<clientId>/access_as_user),
 *                                    or null if the client is not ready
 *   classify(error)                  'cancelled' | 'blocked' | 'other'
 *   setFactory(fn)                   injection (tests) of createNestablePublicClientApplication.
 */
var injected = null;
var clients = {};

function setFactory(factory) {
  injected = factory;
  clients = {};
}

function factory() {
  // Loaded at call time (not at import time): tests inject a factory without loading MSAL.
  return injected || require('@azure/msal-browser').createNestablePublicClientApplication;
}

/** Nested App Authentication requirement set 1.1, read at call time. */
function isSupported() {
  try {
    return !!(
      Office.context &&
      Office.context.requirements &&
      Office.context.requirements.isSetSupported('NestedAppAuth', '1.1')
    );
  } catch (e) {
    return false;
  }
}

/** Effective MSAL mode: createNestablePublicClientApplication falls back to browser mode without NAA. */
function mode() {
  return isSupported() ? 'naa' : 'browser';
}

function scopesFor(mfa) {
  return ['api://' + mfa.clientId + '/access_as_user'];
}

function keyOf(mfa) {
  return mfa.tenantId + '/' + mfa.clientId;
}

/** Starts the client creation if not already started; returns the Promise (never rejected). */
function init(mfa) {
  var key = keyOf(mfa);
  var entry = clients[key];
  if (entry && entry.status !== 'failed') {
    return entry.promise;
  }
  entry = { status: 'pending', client: null, error: null, promise: null };
  var created;
  try {
    created = Promise.resolve(
      factory()({
        auth: {
          clientId: mfa.clientId,
          authority: 'https://login.microsoftonline.com/' + mfa.tenantId
        }
      })
    );
  } catch (e) {
    created = Promise.reject(e);
  }
  entry.promise = created.then(
    function (client) {
      entry.status = 'ready';
      entry.client = client;
      return client;
    },
    function (error) {
      entry.status = 'failed';
      entry.error = error;
      return null;
    }
  );
  clients[key] = entry;
  return entry.promise;
}

function status(mfa) {
  var entry = clients[keyOf(mfa)];
  return entry ? entry.status : 'none';
}

function lastError(mfa) {
  var entry = clients[keyOf(mfa)];
  return entry ? entry.error : null;
}

function classify(error) {
  var code = error && (error.errorCode || error.code);
  var text = typeof code === 'string' ? code : '';
  if (/user_cancel|cancel/i.test(text)) {
    return 'cancelled';
  }
  // popup_window_error: window blocked; empty_window_error: window closed / empty; popup_blocked.
  if (/popup_window_error|empty_window_error|popup_blocked|block/i.test(text) || /popup_window_error|empty_window_error/.test((error && error.message) || '')) {
    return 'blocked';
  }
  return 'other';
}

/** Cancelled by the user (window closed): no retry. */
function isCancellation(error) {
  return classify(error) === 'cancelled';
}

function accessTokenOf(result) {
  if (!result || typeof result.accessToken !== 'string' || result.accessToken === '') {
    throw new Error('No token in the response.');
  }
  return result.accessToken;
}

/**
 * Access token for the site API. Returns null if the client is not ready (nothing is called, nothing is awaited).
 *   - with claimsJson (acrs): acquireTokenPopup is called IMMEDIATELY (synchronous call, first asynchronous call
 *     of the click handler), without acquireTokenSilent: "every time" MFA would always make it fail;
 *   - without claims: silent token, then a window if interaction is required.
 */
function acquireToken(mfa, claimsJson) {
  var entry = clients[keyOf(mfa)];
  if (!entry || entry.status !== 'ready') {
    return null;
  }
  var client = entry.client;
  var request = { scopes: scopesFor(mfa) };
  var pending;
  try {
    if (claimsJson) {
      request.claims = claimsJson;
      pending = client.acquireTokenPopup(request);
    } else {
      pending = client.acquireTokenSilent(request).then(null, function (silentError) {
        if (isCancellation(silentError)) {
          throw silentError;
        }
        return client.acquireTokenPopup(request);
      });
    }
  } catch (e) {
    pending = Promise.reject(e);
  }
  return Promise.resolve(pending).then(function (result) {
    return accessTokenOf(result);
  });
}

module.exports = {
  isSupported: isSupported,
  mode: mode,
  init: init,
  status: status,
  lastError: lastError,
  acquireToken: acquireToken,
  classify: classify,
  scopesFor: scopesFor,
  setFactory: setFactory,
  isCancellation: isCancellation
};
