'use strict';

/*
 * Entry point of the launchevent.js bundle.
 *
 * Pattern from the official Office-Add-in-samples/outlook-check-item-categories (commands.js):
 * `Office.onReady();` at top level, BEFORE the `Office.actions.associate` calls.
 * Without it, browser runtimes (Outlook on the web, new Outlook, Mac) never invoke the
 * handler. In the JavaScript-only runtime of classic Outlook on Windows, onReady/initialize
 * code does not run, so the call is harmless; it is guarded by typeof.
 * The associate calls stay at top level, outside any callback.
 *
 * The names below must match the LaunchEvent FunctionName values in manifest.xml.
 * Office.actions.associate is required: without it, with SoftBlock, sending would be blocked.
 */

var handlers = require('./handlers');

if (typeof Office.onReady === 'function') {
  Office.onReady();
}

Office.actions.associate('onMessageSendHandler', handlers.onMessageSendHandler);
Office.actions.associate('onAppointmentSendHandler', handlers.onAppointmentSendHandler);
