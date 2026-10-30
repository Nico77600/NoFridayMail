'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/shared/config');

const root = path.join(__dirname, '..');
const at = (month, day, hour = 12, minute = 0) => new Date(2026, month - 1, day, hour, minute, 0, 0);

/**
 * Installs a fake global Office object.
 * opts.sets: supported Mailbox requirement sets; opts.delay: getAsync value (0, Date)
 * or 'error'; opts.noDelayApi: item without delayDeliveryTime; opts.headers: item.internetHeaders (absent if
 * undefined) = { name: value } object returned by getAsync, or 'error' (failure), 'throw' (synchronous exception),
 * 'nodata' (success without a value); opts.headerCalls: array that records the requested names.
 */
function installOffice(opts) {
  const sets = opts.sets || ['1.8', '1.11', '1.12', '1.13', '1.14', '1.15'];
  const item = {};
  // opts.headersRaw: object returned as-is by getAsync (names in another case); opts.session: item.sessionData
  // (absent if undefined) = { name: value } object, 'error' or 'throw'; opts.sessionCalls: requested names.
  if (opts.session !== undefined) {
    item.sessionData = {
      getAsync(name, callback) {
        if (opts.sessionCalls) {
          opts.sessionCalls.push(name);
        }
        if (opts.session === 'throw') {
          throw new Error('Sys.Boom');
        }
        if (opts.session === 'error') {
          callback({ status: 'failed', error: { message: 'boom' } });
        } else {
          callback({ status: 'succeeded', value: opts.session[name] === undefined ? null : opts.session[name] });
        }
      }
    };
  }
  if (opts.headers !== undefined) {
    item.internetHeaders = {
      getAsync(names, options, callback) {
        const cb = typeof options === 'function' ? options : callback;
        if (opts.headerCalls) {
          opts.headerCalls.push(names);
        }
        if (opts.headers === 'throw') {
          throw new Error('Sys.Boom');
        }
        if (opts.headers === 'error') {
          cb({ status: 'failed', error: { message: 'boom' } });
        } else if (opts.headers === 'nodata') {
          cb({ status: 'succeeded' });
        } else if (opts.headersRaw) {
          cb({ status: 'succeeded', value: opts.headersRaw });
        } else {
          const value = {};
          names.forEach((n) => { if (opts.headers[n] !== undefined) value[n] = opts.headers[n]; });
          cb({ status: 'succeeded', value });
        }
      }
    };
  }
  if (!opts.noDelayApi) {
    item.delayDeliveryTime = {
      getAsync(options, callback) {
        const cb = typeof options === 'function' ? options : callback;
        const asyncContext = typeof options === 'function' ? undefined : options.asyncContext;
        if (opts.delay === 'error') {
          cb({ status: 'failed', error: { message: 'boom' }, asyncContext });
        } else {
          cb({ status: 'succeeded', value: opts.delay === undefined ? 0 : opts.delay, asyncContext });
        }
      }
    };
  }
  const actions = {};
  global.Office = {
    context: {
      displayLanguage: opts.lang,
      mailbox: { item },
      requirements: { isSetSupported: (name, version) => name === 'Mailbox' && sets.indexOf(version) !== -1 }
    },
    AsyncResultStatus: { Succeeded: 'succeeded', Failed: 'failed' },
    actions: { associate: (name, fn) => { actions[name] = fn; } }
  };
  return actions;
}

function loadHandlers() {
  delete require.cache[require.resolve('../src/launchevent/handlers')];
  return require('../src/launchevent/handlers');
}

function runMessage(t, now, opts) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  installOffice(opts);
  const handlers = loadHandlers();
  let completed = null;
  handlers.onMessageSendHandler({ completed: (o) => { completed = o; } });
  assert.ok(completed, 'event.completed must be called');
  return completed;
}

function runAppointment(t, now, opts) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  installOffice(opts || {});
  const handlers = loadHandlers();
  let completed = null;
  handlers.onAppointmentSendHandler({ completed: (o) => { completed = o; } });
  assert.ok(completed);
  return completed;
}

test('message on a Friday with no delay: blocked with message, button and markdown', (t) => {
  const r = runMessage(t, at(10, 30, 10, 0), { delay: 0 });
  assert.equal(r.allowEvent, false);
  assert.match(r.errorMessage, /interdit le vendredi/);
  assert.match(r.errorMessage, /lundi ou mardi/);
  assert.match(r.errorMessage, /08:00/);
  assert.equal(r.cancelLabel, "Planifier l'envoi");
  assert.ok(r.cancelLabel.length <= 20);
  assert.equal(r.commandId, config.taskPaneCommandId);
  assert.match(r.errorMessageMarkdown, /\*\*interdit le vendredi\*\*/);
  assert.ok(r.errorMessage.length <= 500);
  assert.ok(r.errorMessageMarkdown.length <= 500);
});

test('message on Friday 00:00 and 23:59: blocked', (t) => {
  assert.equal(runMessage(t, at(10, 30, 0, 0), { delay: 0 }).allowEvent, false);
  assert.equal(runMessage(t, at(10, 30, 23, 59), { delay: 0 }).allowEvent, false);
});

test('message on a Thursday with no delay or on a Saturday: allowed', (t) => {
  assert.deepEqual(runMessage(t, at(10, 29, 19, 0), { delay: 0 }), { allowEvent: true });
  assert.deepEqual(runMessage(t, at(10, 31, 9, 0), { delay: 0 }), { allowEvent: true });
});

test('message Thursday evening deferred to Friday: blocked (message about the scheduled date)', (t) => {
  const r = runMessage(t, at(10, 29, 19, 0), { delay: at(10, 30, 8, 0) });
  assert.equal(r.allowEvent, false);
  assert.match(r.errorMessage, /vendredi 30 octobre 2026 à 08:00/);
  assert.equal(r.commandId, config.taskPaneCommandId);
  assert.ok(r.errorMessage.length <= 500);
  assert.ok(r.errorMessageMarkdown.length <= 500);
});

test('message deferred to a Friday via native delayed delivery (last safeguard): blocked', (t) => {
  const r = runMessage(t, at(10, 30, 10, 0), { delay: at(11, 6, 17, 0) });
  assert.equal(r.allowEvent, false);
  assert.match(r.errorMessage, /vendredi 6 novembre 2026 à 17:00/);
});

test('message deferred to Saturday or Monday (from Friday or Thursday): allowed', (t) => {
  assert.deepEqual(runMessage(t, at(10, 30, 10, 0), { delay: at(10, 31, 8, 0) }), { allowEvent: true });
  assert.deepEqual(runMessage(t, at(10, 30, 10, 0), { delay: at(11, 2, 8, 0) }), { allowEvent: true });
  assert.deepEqual(runMessage(t, at(10, 29, 19, 0), { delay: at(10, 31, 8, 0) }), { allowEvent: true });
});

test('message without Mailbox 1.14: no button; without 1.15: no markdown', (t) => {
  const r13 = runMessage(t, at(10, 30, 10, 0), { sets: ['1.12', '1.13'], delay: 0 });
  assert.equal(r13.allowEvent, false);
  assert.equal(r13.cancelLabel, undefined);
  assert.equal(r13.commandId, undefined);
  assert.equal(r13.errorMessageMarkdown, undefined);
  const r14 = runMessage(t, at(10, 30, 10, 0), { sets: ['1.12', '1.13', '1.14'], delay: 0 });
  assert.equal(r14.commandId, config.taskPaneCommandId);
  assert.equal(r14.errorMessageMarkdown, undefined);
});

test('message without Mailbox 1.13: blocked, message pointing to native delayed delivery', (t) => {
  const r = runMessage(t, at(10, 30, 10, 0), { sets: ['1.12'], noDelayApi: true });
  assert.equal(r.allowEvent, false);
  assert.match(r.errorMessage, /Différer la remise/);
  assert.equal(r.commandId, undefined);
  assert.equal(r.cancelLabel, undefined);
  assert.equal(r.errorMessageMarkdown, undefined);
});

test('message: delay read failure -> blocked as a safeguard', (t) => {
  const r = runMessage(t, at(10, 29, 10, 0), { delay: 'error' });
  assert.equal(r.allowEvent, false);
  assert.equal(r.errorMessage, config.strings.messageCheckFailed);
});

test('meeting on a Friday: blocked, no commandId, points to the first proposed day (Monday)', (t) => {
  const r = runAppointment(t, at(10, 30, 10, 0));
  assert.equal(r.allowEvent, false);
  assert.match(r.errorMessage, /invitations ne peuvent pas être envoyées le vendredi/);
  assert.match(r.errorMessage, /lundi/);
  assert.doesNotMatch(r.errorMessage, /samedi|dimanche/);
  assert.equal(r.errorMessage, "Les invitations ne peuvent pas être envoyées le vendredi. La réunion n'a pas été envoyée : envoyez-la à partir de lundi.");
  assert.equal(r.errorMessageMarkdown, "Les invitations **ne peuvent pas être envoyées le vendredi**.\n\nLa réunion n'a pas été envoyée : envoyez-la à partir de **lundi**.");
  assert.equal(r.commandId, undefined);
  assert.equal(r.cancelLabel, undefined);
  assert.ok(r.errorMessage.length <= 500);
  assert.ok(r.errorMessageMarkdown.length <= 500);
});

test('meeting: Friday 00:00 and 23:59 blocked, other days allowed', (t) => {
  assert.equal(runAppointment(t, at(10, 30, 0, 0)).allowEvent, false);
  assert.equal(runAppointment(t, at(10, 30, 23, 59)).allowEvent, false);
  assert.deepEqual(runAppointment(t, at(10, 29, 23, 59)), { allowEvent: true });
  assert.deepEqual(runAppointment(t, at(10, 31, 0, 0)), { allowEvent: true });
});

test('meeting without Mailbox 1.15: no markdown', (t) => {
  const r = runAppointment(t, at(10, 30, 10, 0), { sets: ['1.12'] });
  assert.equal(r.errorMessageMarkdown, undefined);
});

test('launchevent.js associates both handlers with the manifest FunctionName values', () => {
  const actions = installOffice({});
  delete require.cache[require.resolve('../src/launchevent/handlers')];
  delete require.cache[require.resolve('../src/launchevent/launchevent')];
  require('../src/launchevent/launchevent');
  assert.equal(typeof actions.onMessageSendHandler, 'function');
  assert.equal(typeof actions.onAppointmentSendHandler, 'function');
});

test('manifest.xml: consistent with the code', () => {
  const manifest = fs.readFileSync(path.join(root, 'manifest.xml'), 'utf8');
  assert.match(manifest, new RegExp(`<Control xsi:type="Button" id="${config.taskPaneCommandId}"`));
  assert.match(manifest, /<LaunchEvent Type="OnMessageSend" FunctionName="onMessageSendHandler" SendMode="SoftBlock"/);
  assert.match(manifest, /<LaunchEvent Type="OnAppointmentSend" FunctionName="onAppointmentSendHandler" SendMode="SoftBlock"/);
  assert.match(manifest, /bt:Sets DefaultMinVersion="1.12"/);
  assert.match(manifest, /<Override type="javascript" resid="JSRuntime.Url"/);
  assert.match(manifest, /id="JSRuntime.Url" DefaultValue="https:\/\/localhost:3000\/launchevent.js"/);
  assert.match(manifest, /VersionOverridesV1_1/);
  assert.equal(manifest.match(/Type="OnMessageSend"/g).length, 1);
  assert.equal(manifest.match(/Type="OnAppointmentSend"/g).length, 1);
});

test('texts: respect the Smart Alerts limits (500 characters, 20-character button)', () => {
  const rules = require('../src/shared/rules');
  const s = config.strings;
  assert.ok(s.cancelLabel.length <= 20);
  const vars = {
    days: 'le vendredi et le samedi',
    date: 'mercredi 30 septembre 2026 à 08:00',
    suggestions: 'dimanche ou lundi',
    time: '08:00',
    nextDay: 'lundi'
  };
  for (const key of Object.keys(s)) {
    if (/^(messageBlocked|appointmentBlocked|messageCheckFailed)/.test(key)) {
      assert.ok(rules.fill(s[key], vars).length <= 500, key);
    }
  }
});

function loadLaunchevent() {
  delete require.cache[require.resolve('../src/launchevent/handlers')];
  delete require.cache[require.resolve('../src/launchevent/launchevent')];
  require('../src/launchevent/launchevent');
}

test('launchevent.js calls Office.onReady() before the associate calls (browser runtime)', () => {
  const order = [];
  global.Office = {
    onReady: (...args) => { order.push(['onReady', args.length]); },
    actions: { associate: (name) => { order.push(['associate', name]); } }
  };
  loadLaunchevent();
  assert.deepEqual(order, [
    ['onReady', 0],
    ['associate', 'onMessageSendHandler'],
    ['associate', 'onAppointmentSendHandler']
  ]);
});

test('launchevent.js: without Office.onReady (JS-only runtime), the associate calls are still made', () => {
  const associated = [];
  global.Office = { actions: { associate: (name, fn) => { associated.push([name, typeof fn]); } } };
  assert.equal(typeof global.Office.onReady, 'undefined');
  loadLaunchevent();
  assert.deepEqual(associated, [
    ['onMessageSendHandler', 'function'],
    ['onAppointmentSendHandler', 'function']
  ]);
});

// --- fr / en localization ---

const FRENCH_RESIDUE = /[éèêàçù«»]|vendredi|interdit|Planifier|envoi|réunion|invitations ne/i;

for (const lang of ['en-US', 'en-GB', 'de-DE']) {
  test(`[${lang}] message on a Friday: message, button and markdown in English`, (t) => {
    const r = runMessage(t, at(10, 30, 10, 0), { delay: 0, lang });
    assert.equal(r.allowEvent, false);
    assert.match(r.errorMessage, /^Sending messages is not allowed on Fridays\./);
    assert.match(r.errorMessage, /on Monday or Tuesday at 8:00 AM/);
    assert.equal(r.cancelLabel, 'Schedule send');
    assert.ok(r.cancelLabel.length <= 20);
    assert.equal(r.commandId, config.taskPaneCommandId);
    assert.match(r.errorMessageMarkdown, /\*\*not allowed on Fridays\*\*/);
    assert.ok(r.errorMessage.length <= 500 && r.errorMessageMarkdown.length <= 500);
    for (const text of [r.errorMessage, r.errorMessageMarkdown, r.cancelLabel]) {
      assert.doesNotMatch(text, FRENCH_RESIDUE);
    }
  });
}

test('[en-US] Thursday evening deferred to Friday: message about the scheduled date, in English', (t) => {
  const r = runMessage(t, at(10, 29, 19, 0), { delay: at(10, 30, 8, 0), lang: 'en-US' });
  assert.equal(r.allowEvent, false);
  assert.match(r.errorMessage, /scheduled for Friday, October 30, 2026 at 8:00 AM/);
  assert.match(r.errorMessage, /Monday or Tuesday at 8:00 AM/);
  assert.doesNotMatch(r.errorMessage, FRENCH_RESIDUE);
});

test('[en-US] rules identical to French: allowed / blocked', (t) => {
  assert.deepEqual(runMessage(t, at(10, 29, 19, 0), { delay: 0, lang: 'en-US' }), { allowEvent: true });
  assert.deepEqual(runMessage(t, at(10, 30, 10, 0), { delay: at(10, 31, 8, 0), lang: 'en-US' }), { allowEvent: true });
  assert.equal(runMessage(t, at(10, 30, 0, 0), { delay: 0, lang: 'en-US' }).allowEvent, false);
  assert.equal(runMessage(t, at(10, 30, 23, 59), { delay: 0, lang: 'en-US' }).allowEvent, false);
});

test('[en-US] without 1.13 / 1.14 / 1.15: degradation and English texts', (t) => {
  const r12 = runMessage(t, at(10, 30, 10, 0), { sets: ['1.12'], noDelayApi: true, lang: 'en-US' });
  assert.match(r12.errorMessage, /Delay Delivery/);
  assert.equal(r12.cancelLabel, undefined);
  assert.doesNotMatch(r12.errorMessage, FRENCH_RESIDUE);
  const r13 = runMessage(t, at(10, 30, 10, 0), { sets: ['1.12', '1.13'], delay: 0, lang: 'en-US' });
  assert.equal(r13.commandId, undefined);
  assert.equal(r13.errorMessageMarkdown, undefined);
});

test('[en-US] delay read failure: message in English', (t) => {
  const r = runMessage(t, at(10, 29, 10, 0), { delay: 'error', lang: 'en-US' });
  assert.equal(r.allowEvent, false);
  assert.match(r.errorMessage, /^Unable to check the scheduled delivery time/);
});

test('[en-US] meeting on a Friday: message in English, no commandId', (t) => {
  const r = runAppointment(t, at(10, 30, 10, 0), { lang: 'en-US' });
  assert.equal(r.allowEvent, false);
  assert.equal(r.errorMessage, 'Meeting invitations cannot be sent on Fridays. The meeting was not sent: send it starting Monday.');
  assert.equal(r.errorMessageMarkdown, 'Meeting invitations **cannot be sent on Fridays**.\n\nThe meeting was not sent: send it starting **Monday**.');
  assert.equal(r.commandId, undefined);
  assert.deepEqual(runAppointment(t, at(10, 29, 10, 0), { lang: 'en-US' }), { allowEvent: true });
});

test('missing, empty or non-French language: fr / en fallback per the rule', (t) => {
  // missing displayLanguage -> French (product language)
  const missing = runMessage(t, at(10, 30, 10, 0), { delay: 0 });
  assert.equal(missing.cancelLabel, "Planifier l'envoi");
  assert.match(missing.errorMessage, /interdit le vendredi/);
  // empty string -> French
  assert.equal(runMessage(t, at(10, 30, 10, 0), { delay: 0, lang: '' }).cancelLabel, "Planifier l'envoi");
  // fr-CA -> French; unknown non-French language -> English
  assert.equal(runMessage(t, at(10, 30, 10, 0), { delay: 0, lang: 'fr-CA' }).cancelLabel, "Planifier l'envoi");
  assert.equal(runMessage(t, at(10, 30, 10, 0), { delay: 0, lang: 'xx-YY' }).cancelLabel, 'Schedule send');
  assert.match(runAppointment(t, at(10, 30, 10, 0), { lang: 'fr-FR' }).errorMessage, /invitations ne peuvent pas/);
});

test('language re-read on every call (not frozen at import time)', (t) => {
  const fr = runMessage(t, at(10, 30, 10, 0), { delay: 0, lang: 'fr-FR' });
  const en = runMessage(t, at(10, 30, 10, 0), { delay: 0, lang: 'en-US' });
  assert.equal(fr.cancelLabel, "Planifier l'envoi");
  assert.equal(en.cancelLabel, 'Schedule send');
});

test('manifest.xml: en-US localized texts for the name, description and button', () => {
  const manifest = fs.readFileSync(path.join(root, 'manifest.xml'), 'utf8');
  assert.match(manifest, /<DefaultLocale>fr-FR<\/DefaultLocale>/);
  assert.match(manifest, /<DisplayName DefaultValue="NoFridayMail">\s*<Override Locale="en-US" Value="NoFridayMail" \/>/);
  assert.match(manifest, /<Description DefaultValue="[^"]+">\s*<Override Locale="en-US" Value="[^"]+" \/>/);
  assert.match(manifest, /<bt:String id="TaskpaneButton.Label" DefaultValue="Planifier l'envoi">\s*<bt:Override Locale="en-US" Value="Schedule send" \/>/);
  assert.match(manifest, /<bt:String id="TaskpaneButton.Tooltip" DefaultValue="[^"]+">\s*<bt:Override Locale="en-US" Value="[^"]+" \/>/);
  // The English ribbon button label matches the English cancelLabel.
  assert.equal(config.languages.en.cancelLabel, 'Schedule send');
});

// --- Meeting: "starting" = first allowed day after today ---

test('meeting: Wednesday+Thursday blocked, on a Thursday -> "vendredi" / "Friday"', (t) => {
  const saved = config.blockedDays;
  config.blockedDays = [3, 4];
  try {
    const fr = runAppointment(t, at(10, 29, 10, 0), { lang: 'fr-FR' });
    assert.equal(fr.allowEvent, false);
    assert.equal(fr.errorMessage, "Les invitations ne peuvent pas être envoyées le mercredi et le jeudi. La réunion n'a pas été envoyée : envoyez-la à partir de vendredi.");
    assert.match(fr.errorMessageMarkdown, /à partir de \*\*vendredi\*\*\./);
    const en = runAppointment(t, at(10, 29, 10, 0), { lang: 'en-US' });
    assert.equal(en.errorMessage, 'Meeting invitations cannot be sent on Wednesdays and Thursdays. The meeting was not sent: send it starting Friday.');
    assert.match(en.errorMessageMarkdown, /starting \*\*Friday\*\*\./);
    // on a Wednesday: the next day (Thursday) is blocked too -> Friday
    assert.match(runAppointment(t, at(10, 28, 10, 0)).errorMessage, /à partir de vendredi\./);
  } finally {
    config.blockedDays = saved;
  }
});

test('meeting: Friday blocked by default -> "lundi" / "Monday" (never the weekend)', (t) => {
  assert.match(runAppointment(t, at(10, 30, 10, 0), { lang: 'fr-FR' }).errorMessage, /à partir de lundi\.$/);
  assert.match(runAppointment(t, at(10, 30, 10, 0), { lang: 'en-US' }).errorMessage, /starting Monday\.$/);
  assert.doesNotMatch(runAppointment(t, at(10, 30, 10, 0), { lang: 'fr-FR' }).errorMessage, /samedi|dimanche/);
});

test('meeting: Friday+Saturday blocked, on a Friday -> "lundi"; fallback when nextAllowedSuggestions fails', (t) => {
  const saved = config.blockedDays;
  config.blockedDays = [5, 6];
  try {
    assert.match(runAppointment(t, at(10, 30, 10, 0)).errorMessage, /à partir de lundi\./);
    const rulesModule = require('../src/shared/rules');
    const original = rulesModule.nextAllowedSuggestions;
    rulesModule.nextAllowedSuggestions = () => { throw new Error('boom'); };
    try {
      const fr = runAppointment(t, at(10, 30, 10, 0), { lang: 'fr-FR' });
      assert.equal(fr.allowEvent, false);
      assert.match(fr.errorMessage, /à partir de lundi\./);
      assert.equal(fr.errorMessageMarkdown, undefined, 'the fallback is plain text');
      assert.match(runAppointment(t, at(10, 30, 10, 0), { lang: 'en-US' }).errorMessage, /starting Monday\./);
      assert.deepEqual(runAppointment(t, at(10, 29, 10, 0)), { allowEvent: true });
    } finally {
      rulesModule.nextAllowedSuggestions = original;
    }
  } finally {
    config.blockedDays = saved;
  }
});

test('meeting: fallback with Friday blocked by default -> Monday', (t) => {
  const rulesModule = require('../src/shared/rules');
  const original = rulesModule.nextAllowedSuggestions;
  rulesModule.nextAllowedSuggestions = () => { throw new Error('boom'); };
  try {
    assert.match(runAppointment(t, at(10, 30, 10, 0)).errorMessage, /à partir de lundi\./);
  } finally {
    rulesModule.nextAllowedSuggestions = original;
  }
});

test('Wednesday+Thursday blocked: message on a Thursday -> "vendredi ou lundi"; meeting -> "vendredi" / "Friday"', (t) => {
  const saved = config.blockedDays;
  config.blockedDays = [3, 4];
  try {
    const mail = runMessage(t, at(10, 29, 10, 0), { delay: 0 });
    assert.equal(mail.allowEvent, false);
    assert.match(mail.errorMessage, /interdit le mercredi et le jeudi/);
    assert.match(mail.errorMessage, /vendredi ou lundi à 08:00/);
    assert.match(runMessage(t, at(10, 29, 10, 0), { delay: 0, lang: 'en-US' }).errorMessage, /on Friday or Monday at 8:00 AM/);
    assert.match(runAppointment(t, at(10, 29, 10, 0)).errorMessage, /à partir de vendredi\./);
    assert.match(runAppointment(t, at(10, 29, 10, 0), { lang: 'en-US' }).errorMessage, /starting Friday\./);
    assert.deepEqual(runMessage(t, at(10, 30, 10, 0), { delay: 0 }), { allowEvent: true }, 'Friday allowed when it is not blocked');
  } finally {
    config.blockedDays = saved;
  }
});

test('send on a Saturday or Sunday: never blocked (weekends are not blocked), even when deferred', (t) => {
  assert.deepEqual(runMessage(t, at(10, 31, 10, 0), { delay: 0 }), { allowEvent: true });
  assert.deepEqual(runMessage(t, at(11, 1, 10, 0), { delay: 0 }), { allowEvent: true });
  assert.deepEqual(runMessage(t, at(10, 29, 10, 0), { delay: at(10, 31, 9, 0) }), { allowEvent: true });
  assert.deepEqual(runAppointment(t, at(10, 31, 10, 0)), { allowEvent: true });
});

test('all working days blocked: explicit message (message and meeting), no button, no infinite loop', (t) => {
  const saved = config.blockedDays;
  config.blockedDays = [1, 2, 3, 4, 5];
  try {
    const mail = runMessage(t, at(10, 28, 10, 0), { delay: 0 });
    assert.equal(mail.allowEvent, false);
    assert.match(mail.errorMessage, /aucun autre jour ouvré n'est disponible/);
    assert.equal(mail.commandId, undefined);
    assert.equal(mail.cancelLabel, undefined);
    assert.match(mail.errorMessageMarkdown, /\*\*interdit/);
    const mailEn = runMessage(t, at(10, 28, 10, 0), { delay: 0, lang: 'en-US' });
    assert.match(mailEn.errorMessage, /no other working day is available/);
    assert.doesNotMatch(mailEn.errorMessage, /[éèàç]/);
    const appt = runAppointment(t, at(10, 28, 10, 0));
    assert.equal(appt.allowEvent, false);
    assert.match(appt.errorMessage, /aucun autre jour ouvré n'est disponible\. La réunion n'a pas été envoyée\.$/);
    assert.match(runAppointment(t, at(10, 28, 10, 0), { lang: 'en-US' }).errorMessage, /no other working day is available/);
    // fallback (catch): same explicit message
    const rulesModule = require('../src/shared/rules');
    const original = rulesModule.nextAllowedSuggestions;
    rulesModule.nextAllowedSuggestions = () => { throw new Error('boom'); };
    try {
      assert.match(runAppointment(t, at(10, 28, 10, 0)).errorMessage, /aucun autre jour ouvré/);
    } finally {
      rulesModule.nextAllowedSuggestions = original;
    }
    // a Saturday (not blocked) is still allowed
    assert.deepEqual(runMessage(t, at(10, 31, 10, 0), { delay: 0 }), { allowEvent: true });
  } finally {
    config.blockedDays = saved;
  }
});

// ---------------------------------------------------------------- justified exceptional send (X-NoFriday-Bypass)

const bypassLib = require('../src/shared/bypass');

const HEADER = bypassLib.HEADER_NAME;
const BYPASS_ON = { enabled: true, minLength: 20, maxLength: 200, minWords: 3, minDistinctChars: 6 };
const VALID_HEADER = { [HEADER]: bypassLib.buildHeaderValue('Réponse urgente à un client bloqué') };
const FRIDAY = at(10, 30, 10, 0);

/** Runs fn with config.bypass replaced (restored afterwards, even on failure). */
function withBypass(settings, fn) {
  const saved = config.bypass;
  config.bypass = settings;
  try {
    return fn();
  } finally {
    config.bypass = saved;
  }
}

test('exceptional send: disabled by default -> a valid header changes nothing, it is not even read', (t) => {
  assert.equal(config.bypass.enabled, false);
  const calls = [];
  const r = runMessage(t, FRIDAY, { delay: 0, headers: VALID_HEADER, headerCalls: calls });
  assert.equal(r.allowEvent, false);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(r.errorMessage, /exceptionnel/i, 'no mention of the option');
  assert.doesNotMatch(r.errorMessageMarkdown, /exceptionnel/i);
  assert.equal(runMessage(t, FRIDAY, { delay: 0, headers: VALID_HEADER, lang: 'en-US' }).allowEvent, false);
  withBypass({ enabled: false, minLength: 20, maxLength: 200, minWords: 3, minDistinctChars: 6 }, () => {
    assert.equal(runMessage(t, FRIDAY, { delay: 0, headers: VALID_HEADER }).allowEvent, false);
  });
});

test('exceptional send: blocked day + valid header -> allowed (also with a deferred delivery on a blocked day)', (t) => {
  withBypass(BYPASS_ON, () => {
    const calls = [];
    assert.deepEqual(runMessage(t, FRIDAY, { delay: 0, headers: VALID_HEADER, headerCalls: calls }), { allowEvent: true });
    assert.deepEqual(calls, [[HEADER]], 'only the X-NoFriday-Bypass header is requested');
    assert.deepEqual(runMessage(t, at(10, 29, 19, 0), { delay: at(10, 30, 8, 0), headers: VALID_HEADER }), { allowEvent: true });
    assert.deepEqual(runMessage(t, FRIDAY, { delay: 0, headers: VALID_HEADER, lang: 'en-US' }), { allowEvent: true });
    // without Mailbox 1.13 (deferred delivery not readable): the header is still taken into account
    assert.deepEqual(
      runMessage(t, FRIDAY, { noDelayApi: true, sets: ['1.8', '1.12'], headers: VALID_HEADER }),
      { allowEvent: true }
    );
    // valid justification at the minLength boundary (20 characters)
    const exact = { [HEADER]: bypassLib.buildHeaderValue('Panne reseau client!') };
    assert.deepEqual(runMessage(t, FRIDAY, { delay: 0, headers: exact }), { allowEvent: true });
  });
});

test('exceptional send: the handler is stateless (sendAsync re-triggers it: same decision on every call)', (t) => {
  withBypass(BYPASS_ON, () => {
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ['Date'], now: FRIDAY.getTime() });
    installOffice({ delay: 0, headers: VALID_HEADER });
    const handlers = loadHandlers();
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      handlers.onMessageSendHandler({ completed: (o) => results.push(o) });
    }
    assert.deepEqual(results, [{ allowEvent: true }, { allowEvent: true }, { allowEvent: true }]);
    // Without a header: blocked on every call, the option hint is present.
    installOffice({ delay: 0, headers: {} });
    const loaded = loadHandlers();
    const blocked = [];
    loaded.onMessageSendHandler({ completed: (o) => blocked.push(o) });
    loaded.onMessageSendHandler({ completed: (o) => blocked.push(o) });
    assert.deepEqual(blocked[0], blocked[1]);
    assert.equal(blocked[0].allowEvent, false);
  });
});

test('exceptional send: malformed header or too short justification -> normal block', (t) => {
  withBypass(BYPASS_ON, () => {
    const bad = [
      undefined,
      '',
      'v1;',
      'v1; ',
      'v2; ' + 'x'.repeat(30),
      'V1; reponse urgente a un client',
      'reponse urgente a un client',
      'v1;reponse urgente a un client',
      'v1; %E0%A4%A', // invalid percent sequence
      'v1; %ZZ%ZZ%ZZ%ZZ%ZZ%ZZ%ZZ%ZZ',
      'v1; ' + '%20'.repeat(40), // spaces only
      'v1; court', // 5 characters
      'v1; ' + 'x'.repeat(19), // 19 < 20
      'v1; R%C3%A9ponse', // 7 characters once decoded (not 16 bytes)
      42
    ];
    // Well-formed headers but weak justifications: same rejections as in the task pane.
    const weak = [
      '.',
      'aaaaaaaaaaaaaaaaaaaa', // same character repeated
      'ok ok ok ok ok ok ok', // 2-letter words
      'test test test', // too short
      'test test test test test', // only 3 distinct letters
      'abab abab abab abab abab',
      '1234 5678 9012 3456 7890',
      'Client bloqué !!!!!!!! vite',
      'x'.repeat(20)
    ].map((text) => bypassLib.buildHeaderValue(text));
    bad.push(...weak);
    for (const value of bad) {
      const r = runMessage(t, FRIDAY, { delay: 0, headers: { [HEADER]: value } });
      assert.equal(r.allowEvent, false, `value ${JSON.stringify(value)}`);
      assert.match(r.errorMessage, /interdit le vendredi/);
    }
    // another header does not count
    assert.equal(runMessage(t, FRIDAY, { delay: 0, headers: { 'X-Friday-Exempt': 'true' } }).allowEvent, false);
    // configurable minLength
    withBypass({ enabled: true, minLength: 30, maxLength: 200, minWords: 3, minDistinctChars: 6 }, () => {
      assert.equal(runMessage(t, FRIDAY, { delay: 0, headers: VALID_HEADER }).allowEvent, true, '34 characters >= 30');
      assert.equal(
        runMessage(t, FRIDAY, { delay: 0, headers: { [HEADER]: bypassLib.buildHeaderValue('Panne reseau client chez nous') } }).allowEvent,
        false,
        '29 characters < 30'
      );
    });
    // configurable maxLength and word count
    withBypass({ enabled: true, minLength: 20, maxLength: 30, minWords: 3, minDistinctChars: 6 }, () => {
      assert.equal(runMessage(t, FRIDAY, { delay: 0, headers: VALID_HEADER }).allowEvent, false, '34 > 30');
    });
    withBypass({ enabled: true, minLength: 20, maxLength: 200, minWords: 5, minDistinctChars: 6 }, () => {
      assert.equal(runMessage(t, FRIDAY, { delay: 0, headers: VALID_HEADER }).allowEvent, false, '5 words required, 4 present');
    });
    withBypass({ enabled: true, minLength: 20, maxLength: 200, minWords: 0, minDistinctChars: 0 }, () => {
      const ok = { [HEADER]: bypassLib.buildHeaderValue('ok ok ok ok ok ok ok') };
      assert.equal(runMessage(t, FRIDAY, { delay: 0, headers: ok }).allowEvent, true, 'checks disabled by setting');
    });
  });
});

test('exceptional send: header read error -> normal block with the option hint', (t) => {
  withBypass(BYPASS_ON, () => {
    for (const headers of ['error', 'throw', 'nodata']) {
      const r = runMessage(t, FRIDAY, { delay: 0, headers });
      assert.equal(r.allowEvent, false, headers);
      assert.match(r.errorMessage, /interdit le vendredi/);
      assert.match(r.errorMessage, /Envoi exceptionnel/);
      assert.equal(r.commandId, config.taskPaneCommandId, 'the schedule-send button is still offered');
    }
  });
});

test('exceptional send: no internetHeaders or no Mailbox 1.8 -> normal block, without the option hint', (t) => {
  withBypass(BYPASS_ON, () => {
    const noObject = runMessage(t, FRIDAY, { delay: 0 });
    assert.equal(noObject.allowEvent, false);
    assert.doesNotMatch(noObject.errorMessage, /exceptionnel/i);
    assert.doesNotMatch(noObject.errorMessageMarkdown, /exceptionnel/i);
    const noSet = runMessage(t, FRIDAY, { delay: 0, headers: VALID_HEADER, sets: ['1.12', '1.13', '1.14', '1.15'] });
    assert.equal(noSet.allowEvent, false);
    assert.doesNotMatch(noSet.errorMessage, /exceptionnel/i);
  });
});

test('exceptional send: allowed day -> headers never read', (t) => {
  withBypass(BYPASS_ON, () => {
    const calls = [];
    assert.deepEqual(runMessage(t, at(10, 29, 10, 0), { delay: 0, headers: 'error', headerCalls: calls }), { allowEvent: true });
    assert.deepEqual(runMessage(t, at(10, 31, 10, 0), { delay: 0, headers: 'throw', headerCalls: calls }), { allowEvent: true });
    assert.deepEqual(calls, []);
  });
});

test('exceptional send: a delayed delivery read failure always blocks (no bypass through the header)', (t) => {
  withBypass(BYPASS_ON, () => {
    const r = runMessage(t, FRIDAY, { delay: 'error', headers: VALID_HEADER });
    assert.equal(r.allowEvent, false);
    assert.match(r.errorMessage, /Impossible de vérifier/);
  });
});

test('exceptional send: appointments never go through the header', (t) => {
  withBypass(BYPASS_ON, () => {
    const calls = [];
    const r = runAppointment(t, FRIDAY, { headers: VALID_HEADER, headerCalls: calls });
    assert.equal(r.allowEvent, false);
    assert.match(r.errorMessage, /invitations ne peuvent pas être envoyées/);
    assert.deepEqual(calls, [], 'headers are not read');
    assert.doesNotMatch(r.errorMessage, /exceptionnel/i);
    assert.equal(runAppointment(t, FRIDAY, { headers: VALID_HEADER, lang: 'en-US' }).allowEvent, false);
  });
});

test('exceptional send: hint in the dialog, fr and en, 500 characters at most, Markdown included', (t) => {
  withBypass(BYPASS_ON, () => {
    const delayed = at(10, 30, 8, 0);
    for (const [lang, word] of [['fr-FR', /Envoi exceptionnel/], ['en-US', /Exceptional send/]]) {
      for (const opts of [
        { delay: 0 },
        { delay: delayed },
        { delay: 0, sets: ['1.8', '1.12', '1.13'] } // without 1.14 / 1.15
      ]) {
        const r = runMessage(t, FRIDAY, Object.assign({ headers: {}, lang }, opts));
        assert.equal(r.allowEvent, false);
        assert.match(r.errorMessage, word, lang);
        assert.ok(r.errorMessage.length <= 500, `${lang} errorMessage ${r.errorMessage.length}`);
        if (r.errorMessageMarkdown) {
          assert.match(r.errorMessageMarkdown, word);
          assert.ok(r.errorMessageMarkdown.length <= 500, `${lang} markdown ${r.errorMessageMarkdown.length}`);
        }
      }
    }
    const fr = runMessage(t, FRIDAY, { delay: 0, headers: {} });
    assert.match(fr.errorMessage, /journalisée, soumise à autorisation/);
    assert.match(fr.errorMessageMarkdown, /\n\n\*\*Envoi exceptionnel\*\*/);
    assert.equal(fr.cancelLabel, "Planifier l'envoi", 'the button label does not change');
    // no replacement day: the hint is still useful (the task pane is reachable via the ribbon)
    const saved = config.blockedDays;
    config.blockedDays = [1, 2, 3, 4, 5];
    try {
      const noDay = runMessage(t, at(10, 28, 10, 0), { delay: 0, headers: {} });
      assert.equal(noDay.allowEvent, false);
      assert.match(noDay.errorMessage, /Envoi exceptionnel/);
      assert.ok(noDay.errorMessage.length <= 500);
    } finally {
      config.blockedDays = saved;
    }
    // without Mailbox 1.13 the task pane is unusable: no hint
    const noDelayApi = runMessage(t, FRIDAY, { noDelayApi: true, sets: ['1.8', '1.12'], headers: {} });
    assert.equal(noDelayApi.allowEvent, false);
    assert.doesNotMatch(noDelayApi.errorMessage, /exceptionnel/i);
  });
});

// ---------------------------------------------------------------- MFA step: v2 header with receipt

const MFA_ON = Object.assign({}, BYPASS_ON, {
  mfa: { required: true, tenantId: '11111111-2222-4333-8444-555555555555', clientId: '99999999-2222-4333-8444-555555555555', authContext: 'c1' }
});
const MFA_OFF = Object.assign({}, MFA_ON, { mfa: Object.assign({}, MFA_ON.mfa, { required: false }) });
const V2_TEXT = 'Réponse urgente au client Durand';
const receiptAtOffset = (secondsFromNow, id = 'abcDEF123456', sig = 'QWERTYuiopASDFghjklZXC') =>
  `${id}.${Math.floor(FRIDAY.getTime() / 1000) + secondsFromNow}.${sig}`;
const v2Header = (receipt, text = V2_TEXT) => ({ [HEADER]: bypassLib.buildHeaderValueV2(text, receipt) });

test('mfa.required: a v2 header with a well-formed, recent receipt lets the message go', (t) => {
  withBypass(MFA_ON, () => {
    const calls = [];
    assert.deepEqual(runMessage(t, FRIDAY, { delay: 0, headers: v2Header(receiptAtOffset(0)), headerCalls: calls }), { allowEvent: true });
    assert.deepEqual(calls, [[HEADER]]);
    assert.deepEqual(runMessage(t, FRIDAY, { delay: 0, headers: v2Header(receiptAtOffset(-3600)), lang: 'en-US' }), { allowEvent: true });
    assert.deepEqual(runMessage(t, FRIDAY, { delay: 0, headers: v2Header(receiptAtOffset(86400)) }), { allowEvent: true }, 'upper bound: one day');
    assert.deepEqual(runMessage(t, FRIDAY, { delay: 0, headers: v2Header(receiptAtOffset(-86400)) }), { allowEvent: true }, 'lower bound: one day');
    assert.deepEqual(runMessage(t, at(10, 29, 19, 0), { delay: at(10, 30, 8, 0), headers: v2Header(receiptAtOffset(0)) }), { allowEvent: true }, 'deferred delivery on a Friday');
  });
});

test('mfa.required: version 1, missing / malformed / too old / future receipt, weak justification -> normal block', (t) => {
  withBypass(MFA_ON, () => {
    const blocked = (headers, label) => {
      const r = runMessage(t, FRIDAY, { delay: 0, headers });
      assert.equal(r.allowEvent, false, label);
      assert.match(r.errorMessage, /interdit le vendredi/, label);
      assert.match(r.errorMessage, /Envoi exceptionnel/, `${label}: option hint`);
      assert.ok(r.errorMessage.length <= 500);
    };
    blocked({ [HEADER]: bypassLib.buildHeaderValue(V2_TEXT) }, 'v1 rejected when MFA is required');
    blocked({ [HEADER]: 'v2; ' + bypassLib.encodeJustification(V2_TEXT) }, 'v2 without receipt');
    blocked({ [HEADER]: 'v2; ' + bypassLib.encodeJustification(V2_TEXT) + '; r=' }, 'empty receipt');
    blocked(v2Header('court'), 'malformed receipt');
    blocked(v2Header(receiptAtOffset(0, 'abcDEF12345')), '11-character id');
    blocked(v2Header(receiptAtOffset(0, 'abcDEF123456', 'QWERTYuiopASDFghjklZX')), '21-character signature');
    blocked(v2Header(receiptAtOffset(0, 'abcDEF12345!')), 'forbidden character in the id');
    blocked(v2Header(receiptAtOffset(-86401)), 'receipt more than one day old');
    blocked(v2Header(receiptAtOffset(86401)), 'receipt from the future');
    blocked(v2Header(`abcDEF123456.1000000000.QWERTYuiopASDFghjklZXC`), 'receipt from 2001');
    for (const weak of ['.', 'aaaaaaaaaaaaaaaaaaaa', 'ok ok ok ok ok ok ok', 'test test test test test', 'Panne reseau client']) {
      blocked(v2Header(receiptAtOffset(0), weak), `weak justification "${weak}"`);
    }
    blocked({ [HEADER]: 42 }, 'non-text value');
    blocked({}, 'no header');
  });
});

test('mfa not required (mfa absent or required false): v1 and v2 accepted, malformed receipt rejected', (t) => {
  for (const settings of [BYPASS_ON, MFA_OFF]) {
    withBypass(settings, () => {
      assert.deepEqual(runMessage(t, FRIDAY, { delay: 0, headers: VALID_HEADER }), { allowEvent: true });
      assert.deepEqual(runMessage(t, FRIDAY, { delay: 0, headers: v2Header(receiptAtOffset(0)) }), { allowEvent: true });
      assert.equal(runMessage(t, FRIDAY, { delay: 0, headers: v2Header('court') }).allowEvent, false);
    });
  }
});

test('mfa.required: never for meetings, never when bypass is disabled', (t) => {
  withBypass(MFA_ON, () => {
    const calls = [];
    assert.equal(runAppointment(t, FRIDAY, { headers: v2Header(receiptAtOffset(0)), headerCalls: calls }).allowEvent, false);
    assert.deepEqual(calls, []);
  });
  withBypass(Object.assign({}, MFA_ON, { enabled: false }), () => {
    assert.equal(runMessage(t, FRIDAY, { delay: 0, headers: v2Header(receiptAtOffset(0)) }).allowEvent, false);
  });
});

test('the event runtime loads neither MSAL nor the task pane authentication module', () => {
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  for (const file of ['src/launchevent/handlers.js', 'src/launchevent/launchevent.js', 'src/shared/bypass.js', 'src/shared/config.js', 'src/shared/rules.js']) {
    const text = read(file);
    assert.doesNotMatch(text, /msal|@azure|\.\/naa|taskpane\/naa/i, file);
  }
  assert.match(read('src/taskpane/taskpane.js'), /require\('\.\/naa'\)/, 'only the task pane uses naa.js');
});

// ---------------------------------------------------------------- header name case, sessionData, support codes

const SESSION_KEY = bypassLib.SESSION_KEY;

test('header: name read case-insensitively (upper, lower, mixed case)', (t) => {
  withBypass(BYPASS_ON, () => {
    const value = bypassLib.buildHeaderValue('Réponse urgente à un client bloqué');
    for (const name of ['X-NoFriday-Bypass', 'x-nofriday-bypass', 'X-NOFRIDAY-BYPASS', 'x-NoFriday-bypass', 'X-nofriday-Bypass']) {
      assert.deepEqual(runMessage(t, FRIDAY, { delay: 0, headers: {}, headersRaw: { [name]: value } }), { allowEvent: true }, name);
    }
    // a neighbouring header does not count
    assert.equal(runMessage(t, FRIDAY, { delay: 0, headers: {}, headersRaw: { 'x-nofriday-bypass-2': value } }).allowEvent, false);
    assert.equal(bypassLib.lookupHeader({ 'x-nofriday-bypass': 'a' }, 'X-NoFriday-Bypass'), 'a');
    assert.equal(bypassLib.lookupHeader({ 'X-NOFRIDAY-BYPASS': 'b' }, 'x-nofriday-bypass'), 'b');
    assert.equal(bypassLib.lookupHeader({}, 'X-NoFriday-Bypass'), undefined);
    assert.equal(bypassLib.lookupHeader(null, 'X'), undefined);
    assert.equal(bypassLib.lookupHeader('texte', 'X'), undefined);
  });
});

test('sessionData: fallback channel (header absent, malformed or unreadable), same acceptance rule', (t) => {
  withBypass(BYPASS_ON, () => {
    const good = bypassLib.buildHeaderValue('Réponse urgente à un client bloqué');
    const calls = [];
    // header absent + valid session
    assert.deepEqual(runMessage(t, FRIDAY, { delay: 0, headers: {}, session: { [SESSION_KEY]: good }, sessionCalls: calls }), { allowEvent: true });
    assert.deepEqual(calls, [SESSION_KEY]);
    // malformed / weak / unreadable header + valid session
    for (const headers of [{ [HEADER]: 'v1; court' }, { [HEADER]: 'v9; xxx' }, 'error', 'throw', 'nodata']) {
      assert.deepEqual(runMessage(t, FRIDAY, { delay: 0, headers, session: { [SESSION_KEY]: good } }), { allowEvent: true }, JSON.stringify(headers));
    }
    // valid header: sessionData is not even read
    const none = [];
    assert.deepEqual(runMessage(t, FRIDAY, { delay: 0, headers: { [HEADER]: good }, session: {}, sessionCalls: none }), { allowEvent: true });
    assert.deepEqual(none, []);
    // sessionData alone (without internetHeaders) is enough for the client-side decision
    assert.deepEqual(runMessage(t, FRIDAY, { delay: 0, session: { [SESSION_KEY]: good } }), { allowEvent: true });
    // weak, malformed, absent or failing session, or no Mailbox 1.11: blocked
    for (const session of [{ [SESSION_KEY]: 'v1; court' }, { [SESSION_KEY]: 'n’importe quoi' }, { [SESSION_KEY]: 'test test test' }, {}, 'error', 'throw']) {
      assert.equal(runMessage(t, FRIDAY, { delay: 0, headers: {}, session }).allowEvent, false, JSON.stringify(session));
    }
    const seen = [];
    const noSet = runMessage(t, FRIDAY, { delay: 0, headers: {}, session: { [SESSION_KEY]: good }, sessionCalls: seen, sets: ['1.8', '1.12', '1.13', '1.14', '1.15'] });
    assert.equal(noSet.allowEvent, false, 'without Mailbox 1.11: sessionData ignored');
    assert.deepEqual(seen, []);
    // allowed days: nothing is read
    const idle = [];
    assert.deepEqual(runMessage(t, at(10, 29, 10, 0), { delay: 0, headers: 'error', session: 'error', sessionCalls: idle }), { allowEvent: true });
    assert.deepEqual(idle, []);
    // meetings: never
    assert.equal(runAppointment(t, FRIDAY, { headers: {}, session: { [SESSION_KEY]: good } }).allowEvent, false);
  });
});

test('sessionData with mfa.required: only v2 with a recent receipt is accepted, as for the header', (t) => {
  withBypass(MFA_ON, () => {
    const ok = bypassLib.buildHeaderValueV2(V2_TEXT, receiptAtOffset(0));
    assert.deepEqual(runMessage(t, FRIDAY, { delay: 0, headers: {}, session: { [SESSION_KEY]: ok } }), { allowEvent: true });
    assert.equal(runMessage(t, FRIDAY, { delay: 0, headers: {}, session: { [SESSION_KEY]: bypassLib.buildHeaderValue(V2_TEXT) } }).allowEvent, false, 'v1 rejected');
    assert.equal(runMessage(t, FRIDAY, { delay: 0, headers: {}, session: { [SESSION_KEY]: bypassLib.buildHeaderValueV2(V2_TEXT, receiptAtOffset(-90000)) } }).allowEvent, false, 'receipt too old');
    assert.equal(runMessage(t, FRIDAY, { delay: 0, headers: {}, session: { [SESSION_KEY]: bypassLib.buildHeaderValueV2(V2_TEXT, 'court') } }).allowEvent, false, 'malformed receipt');
  });
});

/** Runs fn while capturing console.warn; returns the lines. */
function captureWarn(fn) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

test('support codes: only when a justification was FOUND but rejected (B2 malformed / weak, B3 receipt)', (t) => {
  withBypass(MFA_ON, () => {
    const old = bypassLib.buildHeaderValueV2(V2_TEXT, receiptAtOffset(-90000));
    const v1 = bypassLib.buildHeaderValue(V2_TEXT);
    const cases = [
      [{ headers: { [HEADER]: v1 } }, 'B2', 'v1 while MFA is required'],
      [{ headers: { [HEADER]: 'n’importe quoi' } }, 'B2', 'malformed'],
      [{ headers: { [HEADER]: bypassLib.buildHeaderValueV2('test test test test test', receiptAtOffset(0)) } }, 'B2', 'weak justification'],
      [{ headers: { [HEADER]: old } }, 'B3', 'receipt too old'],
      [{ headers: { [HEADER]: 'v2; ' + bypassLib.encodeJustification(V2_TEXT) + '; r=court' } }, 'B3', 'malformed receipt'],
      [{ headers: { [HEADER]: old }, session: { [SESSION_KEY]: v1 } }, 'B3', 'B3 takes precedence over B2'],
      [{ headers: { [HEADER]: v1 }, session: { [SESSION_KEY]: old } }, 'B3', 'session B3 takes precedence over header B2'],
      [{ headers: 'error', session: { [SESSION_KEY]: v1 } }, 'B2', 'value present before a read error'],
      [{ headers: {}, session: { [SESSION_KEY]: v1 } }, 'B2', 'malformed session'],
      [{ headers: 'throw', session: { [SESSION_KEY]: old } }, 'B3', 'stale session after a read exception']
    ];
    const fr = { B2: 'justification mal formée', B3: 'reçu invalide ou trop ancien' };
    for (const [opts, code, label] of cases) {
      const r = runMessage(t, FRIDAY, Object.assign({ delay: 0 }, opts));
      assert.equal(r.allowEvent, false, label);
      assert.ok(r.errorMessage.endsWith(`(code NFM-${code} : ${fr[code]})`), `${label} : ${r.errorMessage}`);
      assert.ok(r.errorMessageMarkdown.endsWith(`\n\n(code NFM-${code} : ${fr[code]})`), label);
      assert.equal((r.errorMessage.match(/code NFM-/g) || []).length, 1, 'a single code');
    }
    const en = runMessage(t, FRIDAY, { delay: 0, headers: { [HEADER]: v1 }, lang: 'en-US' });
    assert.ok(en.errorMessage.endsWith('(code NFM-B2: justification malformed)'));
    assert.ok(en.errorMessageMarkdown.endsWith('\n\n(code NFM-B2: justification malformed)'));
    const en3 = runMessage(t, FRIDAY, { delay: 0, headers: { [HEADER]: old }, lang: 'en-US' });
    assert.ok(en3.errorMessage.endsWith('(code NFM-B3: receipt invalid or too old)'));
    // without Mailbox 1.13 (no option hint): the code is still added
    const noDelay = runMessage(t, FRIDAY, { noDelayApi: true, sets: ['1.8', '1.12'], headers: { [HEADER]: v1 } });
    assert.doesNotMatch(noDelay.errorMessage, /exceptionnel/i);
    assert.ok(noDelay.errorMessage.endsWith('(code NFM-B2 : justification mal formée)'));
  });
});

test('first request: absent value or refused read (OWA: failure for a nonexistent key) -> NO code, only console.warn', (t) => {
  withBypass(MFA_ON, () => {
    const cases = [
      [{ headers: {} }, 'absent'],
      [{ headers: {}, session: {} }, 'absent'],
      [{ headers: 'error' }, 'read refused'],
      [{ headers: 'throw' }, 'read refused'],
      [{ headers: 'nodata' }, 'absent'],
      [{ headers: {}, session: 'error' }, 'read refused'],
      [{ headers: {}, session: 'throw' }, 'read refused'],
      [{ headers: 'error', session: 'error' }, 'read refused'],
      [{ session: 'error' }, 'read refused'],
      [{ headers: 'error', session: {} }, 'read refused']
    ];
    for (const lang of ['fr-FR', 'en-US']) {
      for (const [opts, kind] of cases) {
        let r;
        const warns = captureWarn(() => { r = runMessage(t, FRIDAY, Object.assign({ delay: 0, lang }, opts)); });
        assert.equal(r.allowEvent, false);
        assert.doesNotMatch(r.errorMessage, /NFM-B|code NFM/, JSON.stringify(opts));
        assert.doesNotMatch(r.errorMessageMarkdown, /NFM-B|code NFM/);
        assert.match(r.errorMessage, /interdit|not allowed/);
        assert.match(r.errorMessage, /Envoi exceptionnel|Exceptional send/, 'the option hint is still displayed');
        assert.equal(warns.length, 1, JSON.stringify(opts));
        assert.match(warns[0], new RegExp('^NoFridayMail: no readable justification \\(' + kind));
        assert.equal(/Bearer|v1;|v2;|r=/.test(warns[0]), false, 'never a value in the trace');
      }
    }
    // a value that is found then rejected does not produce an "absent" trace
    const warns = captureWarn(() => runMessage(t, FRIDAY, { delay: 0, headers: { [HEADER]: 'n’importe quoi' } }));
    assert.deepEqual(warns, []);
  });
  assert.equal(config.languages.fr.messageBypassCodeB1, undefined);
  assert.equal(config.languages.fr.messageBypassCodeB4, undefined);
});

test('support codes: 500 characters respected (text and Markdown, fr and en, all messages, all codes)', (t) => {
  withBypass(MFA_ON, () => {
    const delayed = at(10, 30, 8, 0);
    const old = bypassLib.buildHeaderValueV2(V2_TEXT, receiptAtOffset(-90000));
    const v1 = bypassLib.buildHeaderValue(V2_TEXT);
    const sources = [{ headers: { [HEADER]: v1 } }, { headers: { [HEADER]: old } }];
    for (const lang of ['fr-FR', 'en-US']) {
      for (const source of sources) {
        for (const scenario of [{ delay: 0 }, { delay: delayed }, { delay: 0, sets: ['1.8', '1.11', '1.12', '1.13'] }]) {
          const r = runMessage(t, FRIDAY, Object.assign({ lang }, source, scenario));
          assert.equal(r.allowEvent, false);
          assert.match(r.errorMessage, /NFM-B[23]/);
          assert.ok(r.errorMessage.length <= 500, `${lang} text ${r.errorMessage.length}`);
          if (r.errorMessageMarkdown) {
            assert.match(r.errorMessageMarkdown, /NFM-B[23]/);
            assert.ok(r.errorMessageMarkdown.length <= 500, `${lang} markdown ${r.errorMessageMarkdown.length}`);
          }
        }
      }
    }
    // no replacement day (longest message): still <= 500
    const saved = config.blockedDays;
    config.blockedDays = [1, 2, 3, 4, 5];
    try {
      for (const lang of ['fr-FR', 'en-US']) {
        const stale = bypassLib.buildHeaderValueV2(V2_TEXT, receiptAtOffset(-300000)); // more than one day before Wednesday
        const r = runMessage(t, at(10, 28, 10, 0), { delay: 0, headers: { [HEADER]: stale }, lang });
        assert.ok(r.errorMessage.length <= 500 && r.errorMessageMarkdown.length <= 500, lang);
      }
    } finally {
      config.blockedDays = saved;
    }
  });
});
