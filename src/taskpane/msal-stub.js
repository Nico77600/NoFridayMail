'use strict';

/*
 * Replaces @azure/msal-browser in the task pane bundle when the environment does not require the MFA step
 * (webpack.config.js, resolve.alias), which keeps the pane light. The calling code is reached only when
 * bypass.mfa.required is set, so never with this module.
 */
function createNestablePublicClientApplication() {
  return Promise.reject(new Error('MSAL is not part of this build (bypass.mfa.required is false).'));
}

module.exports = { createNestablePublicClientApplication: createNestablePublicClientApplication };
