'use strict';

/*
 * "Schedule send" task pane.
 * All date logic comes from ../shared/rules.js (pure functions).
 * Office API reference (Microsoft Learn): item.delayDeliveryTime (Mailbox 1.13)
 * getAsync -> Date, or 0 if nothing is set; setAsync(future Date);
 * item.sendAsync (Mailbox 1.15).
 *
 * Interface: two suggestions, a row of allowed days and time chips (no native
 * picker). Clicking a card NEVER triggers a send: only the action button does, after
 * validation by rules.validateCustomDate (defence in depth, even though the interface offers
 * no blocked day or past time).
 *
 * Exceptional send (optional, config.bypass.enabled + Mailbox 1.8): collapsed section below the
 * scheduling interface. The pane only collects the justification and sets the X-NoFriday-Bypass header; it
 * does not know whether the user is authorised (server-side decision, see docs/BYPASS.md).
 *
 * Language: read at startup (Office.context.displayLanguage); cfg/s below
 * carry the settings and strings in that language (fr by default).
 */

var config = require('../shared/config');
var rules = require('../shared/rules');
var bypass = require('../shared/bypass');
var naa = require('./naa');
var theme = require('./theme');

var DAY_MAX = 10; // day cards present in taskpane.html
var CHIP_MAX = 8; // time chips present in taskpane.html
var SUGGESTIONS = ['first', 'second'];

var cfg = config.forLang(config.DEFAULT_LANG);
var s = cfg.strings;
var state = {
  // Selection: { kind: null | 'suggestion' | 'slot', key (suggestion), dayKey, timeKey }
  sel: { kind: null, key: null, dayKey: null, timeKey: null },
  canSend: false, // Mailbox 1.15: sendAsync available, schedule and send in one click
  suggestions: null,
  days: [], // proposed days (Date at local midnight)
  slots: [], // slots of the selected day
  delay: null // current delayed-delivery Date or null
};

function $(id) {
  return document.getElementById(id);
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function showStatus(kind, text, busy) {
  /* Status banner (MessageBar style): kind = 'info' | 'success' | 'error'; busy = spinner.
     aria-live="polite" on the container: the text is announced when it changes. */
  var el = $('status');
  el.className = 'banner ' + kind + (busy ? ' busy' : '');
  $('result').textContent = text;
  el.hidden = false;
}

function showResult(text, ok) {
  showStatus(ok ? 'success' : 'error', text, false);
}

function clearResult() {
  $('result').textContent = '';
  $('status').className = 'banner info';
  $('status').hidden = true;
}

function dayIndexByKey(key) {
  var i;
  for (i = 0; i < state.days.length; i += 1) {
    if (rules.dayKey(state.days[i]) === key) {
      return i;
    }
  }
  return -1;
}

function slotIndexByKey(key) {
  var i;
  for (i = 0; i < state.slots.length; i += 1) {
    if (state.slots[i].key === key) {
      return i;
    }
  }
  return -1;
}

/**
 * Date chosen in the interface, with its validation (always rules.validateCustomDate).
 * { date, partial, validation }; date is null until the choice is complete.
 */
function currentSelection() {
  var sel = state.sel;
  var now = new Date();
  var date = null;
  var partial = false;
  if (sel.kind === 'suggestion') {
    date = state.suggestions[sel.key];
  } else if (sel.kind === 'slot') {
    var dayIdx = dayIndexByKey(sel.dayKey);
    var slot = sel.timeKey ? rules.parseSlotTime(sel.timeKey) : null;
    if (dayIdx !== -1 && slot) {
      date = rules.slotDate(state.days[dayIdx], slot);
    } else {
      partial = true;
    }
  }
  if (!date) {
    return { date: null, partial: partial, validation: { valid: false, code: 'none', message: '' } };
  }
  return { date: date, partial: false, validation: rules.validateCustomDate(date, now, cfg) };
}

/** Action label, summary (aria-live) and button state from the selection. */
function refreshConfirm() {
  var sel = currentSelection();
  var label;
  var summary = '';
  var isError = false;
  if (sel.date && sel.validation.valid) {
    label = rules.fill(state.canSend ? s.tpCtaSend : s.tpCtaSchedule, { summary: rules.formatSummary(sel.date, cfg) });
    summary = rules.fill(s.tpSummary, { date: rules.formatDate(sel.date, cfg) });
  } else if (sel.date) {
    label = s.tpCtaNone;
    summary = sel.validation.message;
    isError = true;
  } else if (sel.partial) {
    label = s.tpCtaPickTime;
    summary = s.tpSummaryNone;
  } else {
    label = s.tpCtaNone;
    summary = s.tpSummaryNone;
  }
  $('confirm').textContent = label;
  $('confirm').disabled = !(sel.date && sel.validation.valid);
  $('summary').textContent = summary;
  $('summary').className = 'summary' + (isError ? ' err' : '');
  return sel;
}

/** aria-checked and roving tabindex (a single tab stop per group). */
function updateAria() {
  var sel = state.sel;
  var i;
  var checked;
  var firstVisible;

  // Suggestions
  checked = null;
  firstVisible = null;
  for (i = 0; i < SUGGESTIONS.length; i += 1) {
    var sug = $('sug-' + SUGGESTIONS[i]);
    var on = sel.kind === 'suggestion' && sel.key === SUGGESTIONS[i];
    sug.setAttribute('aria-checked', on ? 'true' : 'false');
    if (on) {
      checked = sug;
    }
    if (!sug.hidden && !firstVisible) {
      firstVisible = sug;
    }
  }
  for (i = 0; i < SUGGESTIONS.length; i += 1) {
    var el = $('sug-' + SUGGESTIONS[i]);
    el.setAttribute('tabindex', el === (checked || firstVisible) ? '0' : '-1');
  }

  // Days
  var checkedDay = sel.kind === 'slot' ? dayIndexByKey(sel.dayKey) : -1;
  for (i = 0; i < DAY_MAX; i += 1) {
    var day = $('day-' + i);
    day.setAttribute('aria-checked', i === checkedDay ? 'true' : 'false');
    day.setAttribute('tabindex', i === (checkedDay !== -1 ? checkedDay : 0) ? '0' : '-1');
  }

  // Times
  var checkedChip = sel.kind === 'slot' && sel.timeKey ? slotIndexByKey(sel.timeKey) : -1;
  for (i = 0; i < CHIP_MAX; i += 1) {
    var chip = $('chip-' + i);
    chip.setAttribute('aria-checked', i === checkedChip ? 'true' : 'false');
    chip.setAttribute('tabindex', i === (checkedChip !== -1 ? checkedChip : 0) ? '0' : '-1');
  }
}

function renderSuggestions() {
  var effective = rules.effectiveDeliveryTime(new Date(), state.delay);
  // If the send is already scheduled on a blocked day, propose from that date; otherwise from now.
  var ref = rules.isBlocked(effective, cfg) ? effective : new Date();
  // The first two proposed days (working and not blocked) after the reference; a single card if there is
  // only one, none (and the section hidden) if there are none.
  state.suggestions = rules.nextAllowedSuggestions(ref, cfg);
  var i;
  for (i = 0; i < SUGGESTIONS.length; i += 1) {
    var key = SUGGESTIONS[i];
    var date = state.suggestions[key];
    var card = $('sug-' + key);
    if (!date) {
      card.hidden = true;
      continue;
    }
    $('label-' + key).textContent = rules.fill(s.tpOption, {
      day: capitalize(s.dayNames[date.getDay()]),
      time: rules.formatTime(date, cfg)
    });
    $('date-' + key).textContent = rules.formatDate(date, cfg);
    card.hidden = false;
  }
  var none = !state.suggestions.first;
  $('sug-group').hidden = none;
  $('title-suggestions').hidden = none;
  // Selected suggestion no longer available: fall back to the first, otherwise no selection.
  if (state.sel.kind === 'suggestion' && !state.suggestions[state.sel.key]) {
    state.sel = state.suggestions.first
      ? { kind: 'suggestion', key: 'first', dayKey: null, timeKey: null }
      : { kind: null, key: null, dayKey: null, timeKey: null };
  }
}

/** Day cards: next allowed days (blocked days absent, today if a slot remains). */
function renderDays() {
  var now = new Date();
  var count = Math.min(cfg.dayCount || DAY_MAX, DAY_MAX);
  state.days = rules.allowedDays(now, cfg, count);
  var i;
  for (i = 0; i < DAY_MAX; i += 1) {
    var el = $('day-' + i);
    if (i >= state.days.length) {
      el.hidden = true;
      continue;
    }
    var day = state.days[i];
    var rel = rules.relativeDay(day, now);
    var relText = rel === 'today' ? s.tpToday : rel === 'tomorrow' ? s.tpTomorrow : '';
    $('day-' + i + '-rel').textContent = relText;
    $('day-' + i + '-wd').textContent = s.dayShort[day.getDay()];
    $('day-' + i + '-num').textContent = String(day.getDate());
    $('day-' + i + '-mon').textContent = s.monthShort[day.getMonth()];
    el.setAttribute('aria-label', (relText ? relText + ', ' : '') + rules.formatDayFull(day, cfg));
    el.hidden = false;
  }
  // Selected day gone (past midnight, for example): clear the choice.
  if (state.sel.kind === 'slot' && dayIndexByKey(state.sel.dayKey) === -1) {
    state.sel = { kind: null, key: null, dayKey: null, timeKey: null };
  }
}

/** Time chips of the selected day (no past time today). */
function renderTimes() {
  var sel = state.sel;
  var i;
  state.slots = [];
  if (sel.kind === 'slot' && dayIndexByKey(sel.dayKey) !== -1) {
    state.slots = rules.timeSlots(state.days[dayIndexByKey(sel.dayKey)], new Date(), cfg);
    if (sel.timeKey && slotIndexByKey(sel.timeKey) === -1) {
      sel.timeKey = null;
    }
  }
  var shown = Math.min(state.slots.length, CHIP_MAX);
  for (i = 0; i < CHIP_MAX; i += 1) {
    var chip = $('chip-' + i);
    if (i < shown) {
      chip.textContent = rules.formatTime(state.slots[i].date, cfg);
      chip.hidden = false;
    } else {
      chip.hidden = true;
    }
  }
  state.slots = state.slots.slice(0, CHIP_MAX);
  $('times-group').hidden = shown === 0;
  $('times-hint').textContent = shown === 0 ? (state.days.length === 0 ? s.tpNoDays : s.tpPickDayFirst) : '';
  $('times-hint').hidden = shown !== 0;
}

function renderAll() {
  renderSuggestions();
  renderDays();
  renderTimes();
  updateAria();
  refreshConfirm();
}

function renderCurrent() {
  var cur = $('current');
  var remove = $('remove');
  if (state.delay && state.delay.getTime() > Date.now()) {
    cur.textContent = rules.fill(
      rules.isBlocked(state.delay, cfg) ? s.tpCurrentDelayedBlocked : s.tpCurrentDelayed,
      { date: rules.formatDate(state.delay, cfg) }
    );
    cur.hidden = false;
    remove.hidden = false;
  } else {
    cur.textContent = s.tpCurrentNone;
    cur.hidden = true;
    remove.hidden = true;
  }
}

function refreshDelay(done) {
  var item = Office.context.mailbox.item;
  item.delayDeliveryTime.getAsync(function (result) {
    state.delay = result.status === Office.AsyncResultStatus.Succeeded ? rules.toDate(result.value) : null;
    renderCurrent();
    renderAll();
    if (done) {
      done();
    }
  });
}

function afterSelection(elementId, focus) {
  renderTimes();
  updateAria();
  clearResult();
  refreshConfirm();
  var el = $(elementId);
  if (focus && el && el.focus) {
    el.focus();
  }
}

function selectSuggestion(key, focus) {
  state.sel = { kind: 'suggestion', key: key, dayKey: null, timeKey: null };
  afterSelection('sug-' + key, focus);
}

function selectDay(index, focus) {
  if (index < 0 || index >= state.days.length) {
    return;
  }
  var dayKey = rules.dayKey(state.days[index]);
  var previousTime = state.sel.kind === 'slot' ? state.sel.timeKey : null;
  state.sel = { kind: 'slot', key: null, dayKey: dayKey, timeKey: previousTime };
  afterSelection('day-' + index, focus); // renderTimes removes the time if it does not exist that day
}

function selectTime(index, focus) {
  if (state.sel.kind !== 'slot' || index < 0 || index >= state.slots.length) {
    return;
  }
  state.sel.timeKey = state.slots[index].key;
  afterSelection('chip-' + index, focus);
}

function scheduleError(e) {
  // Office APIs may throw a synchronous exception (e.g. ArgumentTypeException).
  showResult(rules.fill(s.tpScheduleFailed, { error: e && e.message ? e.message : '' }), false);
  refreshConfirm();
}

/**
 * Programmatic send (Mailbox 1.15). All the work (setAsync, verification by getAsync)
 * is done BEFORE: the docs do not guarantee that code runs after sendAsync or in its
 * success callback. The callback only handles failure.
 * sendAsync re-triggers OnMessageSend: the handler reads the delivery time again (and, for an exceptional send,
 * the header) and decides as it does for a click on Send.
 * statusText: banner text; failTemplate: failure text with {error}; onFail: restores state.
 */
function sendWith(statusText, failTemplate, onFail) {
  showStatus('info', statusText, true);
  var failed = function (message) {
    showResult(rules.fill(failTemplate, { error: message }), false);
    onFail();
  };
  try {
    Office.context.mailbox.item.sendAsync(function (sendResult) {
      if (sendResult.status === Office.AsyncResultStatus.Failed) {
        failed(sendResult.error ? sendResult.error.message : '');
      }
    });
  } catch (e) {
    failed(e && e.message ? e.message : '');
  }
}

function sendNow(date) {
  sendWith(rules.fill(s.tpSending, { date: rules.formatDate(date, cfg) }), s.tpSendFailed, refreshConfirm);
}

/** Only entry point to setAsync / sendAsync: the action button. */
function onConfirm() {
  clearResult();
  var sel = refreshConfirm();
  // Defence in depth: revalidate just before the call, whatever the interface did.
  var check = sel.date
    ? rules.validateCustomDate(sel.date, new Date(), cfg)
    : { valid: false, message: s.tpCtaNone };
  if (!check.valid) {
    showResult(check.message || s.tpCtaNone, false);
    return;
  }
  var date = sel.date;
  $('confirm').disabled = true;
  try {
    Office.context.mailbox.item.delayDeliveryTime.setAsync(date, function (result) {
      if (result.status === Office.AsyncResultStatus.Failed) {
        showResult(rules.fill(s.tpScheduleFailed, { error: result.error ? result.error.message : '' }), false);
        refreshConfirm();
        return;
      }
      try {
        // refreshDelay reads the delivery time again with getAsync: this is the check before any send.
        refreshDelay(function () {
          if (!state.canSend) {
            showResult(rules.fill(s.tpScheduled, { date: rules.formatDate(date, cfg) }), true);
            return;
          }
          var verified = rules.hasFutureDelay(state.delay, new Date()) && !rules.isBlocked(state.delay, cfg);
          if (!verified) {
            showResult(s.tpVerifyFailed, false);
            return;
          }
          $('confirm').disabled = true;
          sendNow(state.delay);
        });
      } catch (e) {
        scheduleError(e);
      }
    });
  } catch (e) {
    scheduleError(e);
  }
}

function onRemove() {
  clearResult();
  var delayApi = Office.context.mailbox.item.delayDeliveryTime;
  var failed = function () {
    refreshDelay(function () {
      showResult(s.tpRemoveFailed, false);
    });
  };
  try {
    // No documented API clears the delayed delivery. Hosts may throw a synchronous exception on
    // setAsync(0) and setAsync(null), whereas setAsync(new Date(0)) is accepted and getAsync then
    // returns 0 (= no delay). It is used, then verified; otherwise fall back to the delay action.
    delayApi.setAsync(new Date(0), function (result) {
      if (result.status === Office.AsyncResultStatus.Failed) {
        failed();
        return;
      }
      try {
        delayApi.getAsync(function (check) {
          // Removed = 0 (no delay) or a date that is no longer in the future.
          if (
            check.status === Office.AsyncResultStatus.Succeeded &&
            !rules.hasFutureDelay(check.value, new Date())
          ) {
            refreshDelay(function () {
              showResult(s.tpRemoved, true);
            });
          } else {
            failed();
          }
        });
      } catch (e) {
        failed();
      }
    });
  } catch (e) {
    failed();
  }
}

// ---------------------------------------------------------------------------------------------------------
// Justified exceptional send
// ---------------------------------------------------------------------------------------------------------

function errorMessageOf(e) {
  return e && e.message ? e.message : '';
}

/** Value of a header in the object returned by internetHeaders.getAsync (name compared case-insensitively). */
function headerValueOf(map, name) {
  return bypass.lookupHeader(map, name);
}

/**
 * Client-side fallback channel: item.sessionData (Mailbox 1.11), shared between this pane and the event runtime
 * for the same message being composed. The OnMessageSend handler reads it if the Internet header is missing or unreadable.
 * The Internet header remains REQUIRED (Exchange transport rule): sessionData only helps the client decision.
 */
function sessionApi(item, method) {
  try {
    return !!(
      Office.context.requirements.isSetSupported('Mailbox', '1.11') &&
      item.sessionData &&
      typeof item.sessionData[method] === 'function'
    );
  } catch (e) {
    return false;
  }
}

/** Writes the value to sessionData (best effort: a failure blocks nothing, the header is already set and read back), then next(). */
function saveSession(item, value, next) {
  if (!sessionApi(item, 'setAsync')) {
    next();
    return;
  }
  var called = false;
  var once = function () {
    if (!called) {
      called = true;
      next();
    }
  };
  try {
    item.sessionData.setAsync(bypass.SESSION_KEY, value, function () {
      once();
    });
  } catch (e) {
    once();
  }
}

/** Removes the key from sessionData (best effort), then next(). */
function clearSession(item, next) {
  if (!sessionApi(item, 'removeAsync')) {
    next();
    return;
  }
  var called = false;
  var once = function () {
    if (!called) {
      called = true;
      next();
    }
  };
  try {
    item.sessionData.removeAsync(bypass.SESSION_KEY, function () {
      once();
    });
  } catch (e) {
    once();
  }
}

function refreshBypassCounter() {
  var v = bypass.validateJustification($('bypass-text').value, cfg.bypass);
  $('bypass-counter').textContent = rules.fill(s.tpBypassCounter, {
    count: v.length,
    max: cfg.bypass.maxLength,
    min: cfg.bypass.minLength
  });
  $('bypass-counter').className = 'hint counter' + (v.code === 'long' ? ' err' : '');
  return v;
}

/** Message for the refusal reason of bypass.validateJustification (same rule as the OnMessageSend handler). */
function bypassErrorFor(v) {
  var vars = {
    min: cfg.bypass.minLength,
    max: cfg.bypass.maxLength,
    words: cfg.bypass.minWords || 1
  };
  var keys = {
    empty: 'tpBypassEmpty',
    short: 'tpBypassTooShort',
    long: 'tpBypassTooLong',
    repeat: 'tpBypassRepeat',
    words: 'tpBypassWords',
    distinct: 'tpBypassDistinct'
  };
  return rules.fill(s[keys[v.code]], vars);
}

/**
 * Validates the input live: counter, message under the field (neutral instruction while the field is empty,
 * error afterwards) and button state, disabled until the justification is valid.
 */
function refreshBypassForm() {
  var v = refreshBypassCounter();
  var touched = v.code !== 'empty';
  var message = v.valid ? '' : bypassErrorFor(v);
  $('bypass-error').textContent = message;
  $('bypass-error').className = 'field-error' + (touched ? '' : ' info');
  $('bypass-error').hidden = !message;
  $('bypass-text').setAttribute('aria-invalid', touched && !v.valid ? 'true' : 'false');
  state.bypassValid = v.valid;
  $('bypass-send').disabled = !!state.bypassBusy || !v.valid;
  return v;
}

function setBypassBusy(busy) {
  state.bypassBusy = busy;
  $('bypass-text').disabled = busy;
  $('bypass-send').disabled = busy || !state.bypassValid;
}

function showBypassSaved(text) {
  $('bypass-saved-text').textContent = rules.fill(s.tpBypassSaved, { text: text });
  $('bypass-saved').hidden = false;
}

/** The two headers (written / read back) designate the same version, justification and receipt. */
function sameHeader(readValue, expectedValue) {
  var a = bypass.parseHeaderValue(readValue);
  var b = bypass.parseHeaderValue(expectedValue);
  return !!a && !!b && a.version === b.version && a.justification === b.justification && a.receipt === b.receipt;
}

/** Claims of the 401 insufficient_claims challenge (WWW-Authenticate: ... claims="<base64>"), or null. */
function claimsFromChallenge(wwwAuthenticate) {
  var text = typeof wwwAuthenticate === 'string' ? wwwAuthenticate : '';
  var match = /claims="([^"]+)"/.exec(text);
  if (!match || !/insufficient_claims/.test(text)) {
    return null;
  }
  try {
    var decoded = atob(match[1]);
    JSON.parse(decoded); // must be JSON: MSAL requires it
    return decoded;
  } catch (e) {
    return null;
  }
}

/** Call to the site API (same origin): { network: true } or { status, ok, body, claims }. */
function callBypassApi(token, text) {
  return fetch('/api/bypass', {
    method: 'POST',
    // Entra token in X-NFM-Token: the managed functions of Static Web Apps replace the Authorization header with their
    // own internal token (the Entra token would never arrive). Authorization is therefore not used.
    headers: { 'Content-Type': 'application/json', 'X-NFM-Token': 'Bearer ' + token },
    body: JSON.stringify({ justification: text }),
    cache: 'no-store'
  }).then(
    function (response) {
      return response.json().then(null, function () { return {}; }).then(function (body) {
        return {
          status: response.status,
          ok: response.ok,
          body: body || {},
          claims: response.status === 401 ? claimsFromChallenge(response.headers.get('WWW-Authenticate')) : null
        };
      });
    },
    function () {
      return { network: true };
    }
  );
}

/** Localised text for an API response failure. */
function apiErrorText(outcome) {
  if (outcome.network) {
    return s.tpBypassNetwork;
  }
  if (outcome.status === 400 && outcome.body && outcome.body.error === 'invalid_justification') {
    var code = outcome.body.code;
    if (code === 'empty' || code === 'short' || code === 'long' || code === 'repeat' || code === 'words' || code === 'distinct') {
      return rules.fill(s.tpBypassMfaRejected, { reason: bypassErrorFor({ code: code }) });
    }
  }
  if (outcome.status === 401) {
    // Do not invoke MFA when it is not the reason: only insufficient_claims means "context not satisfied".
    return outcome.body && outcome.body.error === 'insufficient_claims' ? s.tpBypassUnauthorized : s.tpBypassTokenRejected;
  }
  return rules.fill(s.tpBypassServerError, { status: outcome.status || '' });
}

function authErrorText(error) {
  var kind = naa.classify(error);
  if (kind === 'cancelled') {
    return s.tpBypassMfaCancelled;
  }
  if (kind === 'blocked') {
    return s.tpBypassMfaPopupBlocked;
  }
  return rules.fill(s.tpBypassMfaFailed, { error: (error && (error.errorMessage || error.message)) || '' });
}

/**
 * MFA step: Entra token with the authentication context, then receipt from the API.
 * IMPORTANT: naa.acquireToken (acquireTokenPopup) is the FIRST asynchronous call, as a synchronous continuation of the
 * click: nothing is awaited before it (not Office, not headers, not the delivery time), otherwise the browser blocks the window
 * (popup_window_error). A 401 insufficient_claims is NOT replayed automatically (a new window opened
 * from a promise would be blocked): the caller offers the "retry verification" button, hence a new
 * click. done(errorText, null, challengeClaims) or done(null, receipt); called exactly once.
 */
function requestReceipt(text, claimsJson, retried, done) {
  var mfa = cfg.bypass.mfa;
  var finished = false;
  var finish = function (error, receipt, challengeClaims) {
    if (!finished) {
      finished = true;
      done(error, receipt, challengeClaims);
    }
  };
  var pending = naa.acquireToken(mfa, claimsJson);
  if (pending === null) {
    finish(s.tpBypassMfaPreparing);
    return;
  }
  pending.then(function (token) {
    return callBypassApi(token, text);
  }).then(function (outcome) {
    if (outcome.ok && bypass.isReceiptFormat(outcome.body.receipt)) {
      finish(null, outcome.body.receipt);
    } else if (!outcome.ok && outcome.status === 401 && outcome.claims && !retried) {
      finish(s.tpBypassMfaClaimsRetry, null, outcome.claims);
    } else {
      finish(outcome.ok ? rules.fill(s.tpBypassServerError, { status: outcome.status }) : apiErrorText(outcome));
    }
  }).then(null, function (error) {
    finish(authErrorText(error));
  });
}

/**
 * "Send with justification" button (v1) / "Verify my identity and send" (v2, MFA step).
 * v2: Entra token + API receipt BEFORE any change to the message. Then, in order, each step being
 * verified before the next; on any failure the message is NOT sent:
 *   1. input validation (synchronous, same rule as the handler);
 *   2. (v2) identity window (acquireTokenPopup, first asynchronous call of the click), receipt from the API;
 *   3. delayed delivery cleared (Date(0)) then read back: the message must go now;
 *   4. X-NoFriday-Bypass header set (internetHeaders.setAsync) then read back (getAsync);
 *   5. sendAsync (Mailbox 1.15) or, failing that, a prompt to click Send.
 */
function onBypassSend() {
  if (state.bypassMfa) {
    startMfa(bypass.acrsClaims(cfg.bypass.mfa.authContext), false);
    return;
  }
  if (state.bypassBusy) {
    return;
  }
  clearResult();
  // Defence in depth: the button is already disabled while the input is invalid.
  var v = refreshBypassForm();
  if (!v.valid) {
    $('bypass-text').focus();
    return;
  }
  setBypassBusy(true);
  var fail = function (text) {
    setBypassBusy(false);
    showResult(text, false);
  };
  commitAndSend(v, bypass.buildHeaderValue(v.text), s.tpBypassSending, s.tpBypassReady, fail);
}

/** "Retry verification": new click hence new window allowed, with the claims of the 401 challenge. */
function onBypassRetry() {
  startMfa(state.retryClaims || bypass.acrsClaims(cfg.bypass.mfa.authContext), true);
}

/**
 * MFA step, in the click handler. Everything before naa.acquireToken is SYNCHRONOUS (DOM, validation):
 * the MSAL client is already initialised (naa.init when the pane opens); if it is not, say so without waiting.
 */
function startMfa(claimsJson, retried) {
  if (state.bypassBusy) {
    return;
  }
  clearResult();
  $('bypass-retry').hidden = true;
  var v = refreshBypassForm();
  if (!v.valid) {
    $('bypass-text').focus();
    return;
  }
  var mfa = cfg.bypass.mfa;
  var clientStatus = naa.status(mfa);
  if (clientStatus !== 'ready') {
    if (clientStatus === 'failed') {
      var initError = naa.lastError(mfa);
      naa.init(mfa); // retry for the next click
      showResult(authErrorText(initError), false);
    } else {
      if (clientStatus === 'none') {
        naa.init(mfa);
      }
      showResult(s.tpBypassMfaPreparing, false);
    }
    return;
  }
  setBypassBusy(true);
  showStatus('info', s.tpBypassMfaChecking, true);
  var fail = function (text) {
    setBypassBusy(false);
    showResult(text, false);
  };
  requestReceipt(v.text, claimsJson, retried, function (error, receipt, challengeClaims) {
    if (error) {
      fail(error);
      if (challengeClaims) {
        state.retryClaims = challengeClaims;
        $('bypass-retry').hidden = false;
        if ($('bypass-retry').focus) {
          $('bypass-retry').focus();
        }
      }
      return;
    }
    commitAndSend(v, bypass.buildHeaderValueV2(v.text, receipt), s.tpBypassMfaSending, s.tpBypassMfaReady, fail);
  });
}

function commitAndSend(v, value, sendingText, readyText, fail) {
  var item = Office.context.mailbox.item;
  var name = bypass.HEADER_NAME;
  if (state.bypassMfa) {
    showStatus('info', sendingText, true);
  }
  // A synchronous exception from a callback (Office API) becomes a displayed failure, never a send.
  var guarded = function (fn) {
    return function (result) {
      try {
        fn(result);
      } catch (e) {
        fail(rules.fill(s.tpBypassFailed, { error: errorMessageOf(e) }));
      }
    };
  };
  var failed = function (result) {
    return !result || result.status === Office.AsyncResultStatus.Failed;
  };

  var verifyHeader = guarded(function () {
    item.internetHeaders.getAsync([name], guarded(function (read) {
      if (failed(read) || !sameHeader(headerValueOf(read.value, name), value)) {
        fail(s.tpBypassVerifyFailed);
        return;
      }
      showBypassSaved(v.text);
      // Fallback channel (sessionData) written BEFORE sendAsync: OnMessageSend may run before it sees the header.
      saveSession(item, value, function () {
        if (!state.canSend) {
          setBypassBusy(false);
          showResult(readyText, true);
          return;
        }
        sendWith(sendingText, s.tpBypassSendFailed, function () {
          setBypassBusy(false);
        });
      });
    }));
  });
  var setHeader = guarded(function () {
    var headers = {};
    headers[name] = value;
    item.internetHeaders.setAsync(headers, guarded(function (written) {
      if (failed(written)) {
        fail(rules.fill(s.tpBypassFailed, { error: written && written.error ? written.error.message : '' }));
        return;
      }
      verifyHeader();
    }));
  });
  var verifyDelay = guarded(function () {
    item.delayDeliveryTime.getAsync(guarded(function (check) {
      if (failed(check) || rules.hasFutureDelay(check.value, new Date())) {
        fail(s.tpBypassDelayFailed);
        return;
      }
      state.delay = null;
      renderCurrent();
      renderAll();
      setHeader();
    }));
  });
  try {
    // No documented API clears the delayed delivery: setAsync(new Date(0)) (see onRemove).
    item.delayDeliveryTime.setAsync(new Date(0), guarded(function (cleared) {
      if (failed(cleared)) {
        fail(s.tpBypassDelayFailed);
        return;
      }
      verifyDelay();
    }));
  } catch (e) {
    fail(rules.fill(s.tpBypassFailed, { error: errorMessageOf(e) }));
  }
}

/** "Remove justification": deletes the header (internetHeaders.removeAsync). */
function onBypassRemove() {
  clearResult();
  var item = Office.context.mailbox.item;
  var failedRemoval = function (message) {
    showResult(rules.fill(s.tpBypassRemoveFailed, { error: message }), false);
  };
  try {
    item.internetHeaders.removeAsync([bypass.HEADER_NAME], function (result) {
      if (result.status === Office.AsyncResultStatus.Failed) {
        failedRemoval(result.error ? result.error.message : '');
        return;
      }
      // The fallback key is removed too: without a justification, the handler must find nothing.
      clearSession(item, function () {
        $('bypass-saved').hidden = true;
        showResult(s.tpBypassRemoved, true);
      });
    });
  } catch (e) {
    failedRemoval(errorMessageOf(e));
  }
}

function toggleBypass() {
  var open = $('bypass-toggle').getAttribute('aria-expanded') !== 'true';
  $('bypass-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  $('bypass-panel').hidden = !open;
  if (open && $('bypass-text').focus) {
    $('bypass-text').focus();
  }
}

/** Authentication mode diagnostic (NAA or browser): console.warn trace only, nothing displayed, no token. */
function showBypassMode() {
  var naaMode = naa.mode() === 'naa';
  try {
    console.warn('NoFridayMail: Entra authentication in ' + (naaMode ? 'NAA (Nested App Authentication)' : 'browser (NAA unavailable)') + ' mode');
  } catch (e) {
    // console unavailable: nothing else to do.
  }
}

/** The section exists only for a message being composed with Mailbox 1.8 (internetHeaders) and bypass.enabled. */
function bypassSupported(item) {
  return !!(
    cfg.bypass &&
    cfg.bypass.enabled &&
    item.itemType !== 'appointment' &&
    Office.context.requirements.isSetSupported('Mailbox', '1.8') &&
    item.internetHeaders &&
    typeof item.internetHeaders.setAsync === 'function' &&
    typeof item.internetHeaders.getAsync === 'function'
  );
}

function initBypass(item) {
  if (!bypassSupported(item)) {
    return;
  }
  // MFA step required (bypass.mfa.required): version 1 (no receipt) is NEVER offered.
  state.bypassMfa = bypass.mfaRequired(cfg.bypass);
  $('bypass-title').textContent = s.tpBypassTitle;
  $('bypass-section').hidden = false;
  if (state.bypassMfa) {
    // Diagnostic (no token): MSAL silently falls back to browser mode when NAA is absent.
    showBypassMode();
  }
  if (state.bypassMfa && !naa.isSupported()) {
    // Without Nested App Authentication 1.1: message and no button.
    $('bypass-intro').hidden = true;
    $('bypass-form').hidden = true;
    $('bypass-unsupported').textContent = s.tpBypassMfaUnsupported;
    $('bypass-unsupported').hidden = false;
    $('bypass-toggle').addEventListener('click', toggleBypass);
    return;
  }
  $('bypass-intro').textContent = state.bypassMfa ? s.tpBypassMfaIntro : s.tpBypassIntro;
  $('bypass-label').textContent = s.tpBypassLabel;
  $('bypass-send').textContent = state.bypassMfa ? s.tpBypassMfaSend : s.tpBypassSend;
  $('bypass-remove').textContent = s.tpBypassRemove;
  refreshBypassForm();
  $('bypass-toggle').addEventListener('click', toggleBypass);
  $('bypass-text').addEventListener('input', refreshBypassForm);
  $('bypass-send').addEventListener('click', onBypassSend);
  $('bypass-remove').addEventListener('click', onBypassRemove);
  if (state.bypassMfa) {
    // Note (Entra docs: sign-in frequency "every time", 5-minute clock tolerance).
    $('bypass-reuse').textContent = s.tpBypassMfaReuse;
    $('bypass-reuse').hidden = false;
    $('bypass-retry').textContent = s.tpBypassMfaRetry;
    $('bypass-retry').addEventListener('click', onBypassRetry);
    // MSAL client created and initialised BEFORE the click (Promise cached): the click handler must not await
    // anything before opening the identity window, otherwise the browser blocks it.
    naa.init(cfg.bypass.mfa);
  }
  // Justification already set (pane reopened): display it with the option to remove it.
  try {
    item.internetHeaders.getAsync([bypass.HEADER_NAME], function (result) {
      if (!result || result.status === Office.AsyncResultStatus.Failed) {
        return;
      }
      var parsed = bypass.parseHeaderValue(headerValueOf(result.value, bypass.HEADER_NAME));
      if (parsed && parsed.justification) {
        showBypassSaved(parsed.justification);
      }
    });
  } catch (e) {
    // Read impossible: the section stays usable, without a "saved" state.
  }
}

/** Ids of the visible elements of a group, in order. */
function visibleIds(prefix, max) {
  var out = [];
  var i;
  if (prefix === 'sug-') {
    for (i = 0; i < SUGGESTIONS.length; i += 1) {
      if (!$('sug-' + SUGGESTIONS[i]).hidden) {
        out.push('sug-' + SUGGESTIONS[i]);
      }
    }
    return out;
  }
  for (i = 0; i < max; i += 1) {
    if (!$(prefix + i).hidden) {
      out.push(prefix + i);
    }
  }
  return out;
}

/**
 * Accessible radio group: arrows = move and select, Home/End, Space/Enter = select.
 * None of these keys triggers a send.
 */
function wireGroup(groupId, prefix, max, select) {
  $(groupId).addEventListener('keydown', function (e) {
    var key = e && e.key;
    var ids = visibleIds(prefix, max);
    if (!ids.length) {
      return;
    }
    var focusedId = e.target && e.target.id ? e.target.id : null;
    var current = focusedId ? ids.indexOf(focusedId) : -1;
    if (current === -1) {
      var i;
      for (i = 0; i < ids.length; i += 1) {
        if ($(ids[i]).getAttribute('aria-checked') === 'true') {
          current = i;
        }
      }
    }
    var target = null;
    if (key === 'ArrowDown' || key === 'ArrowRight') {
      target = ids[(current + 1) % ids.length];
    } else if (key === 'ArrowUp' || key === 'ArrowLeft') {
      target = ids[(current <= 0 ? ids.length : current) - 1];
    } else if (key === 'Home') {
      target = ids[0];
    } else if (key === 'End') {
      target = ids[ids.length - 1];
    } else if (key === ' ' || key === 'Spacebar' || key === 'Enter') {
      target = focusedId && ids.indexOf(focusedId) !== -1 ? focusedId : ids[current === -1 ? 0 : current];
    }
    if (target) {
      if (e.preventDefault) {
        e.preventDefault();
      }
      select(target, true);
    }
  });
}

function wire() {
  var i;
  var pickSuggestion = function (key) {
    return function () {
      selectSuggestion(key, false);
    };
  };
  for (i = 0; i < SUGGESTIONS.length; i += 1) {
    $('sug-' + SUGGESTIONS[i]).addEventListener('click', pickSuggestion(SUGGESTIONS[i]));
  }
  var pickDay = function (index) {
    return function () {
      selectDay(index, false);
    };
  };
  for (i = 0; i < DAY_MAX; i += 1) {
    $('day-' + i).addEventListener('click', pickDay(i));
  }
  var pickTime = function (index) {
    return function () {
      selectTime(index, false);
    };
  };
  for (i = 0; i < CHIP_MAX; i += 1) {
    $('chip-' + i).addEventListener('click', pickTime(i));
  }
  wireGroup('sug-group', 'sug-', SUGGESTIONS.length, function (id, focus) {
    selectSuggestion(id.slice(4), focus);
  });
  wireGroup('days-group', 'day-', DAY_MAX, function (id, focus) {
    selectDay(parseInt(id.slice(4), 10), focus);
  });
  wireGroup('times-group', 'chip-', CHIP_MAX, function (id, focus) {
    selectTime(parseInt(id.slice(5), 10), focus);
  });
  $('confirm').addEventListener('click', onConfirm);
  $('remove').addEventListener('click', onRemove);
}

/**
 * Theme: Fluent 2 palette from the CSS (light, dark via prefers-color-scheme); if Outlook provides
 * Office.context.officeTheme and the AA contrast is met, it is applied.
 */
function applyTheme() {
  var root = document.documentElement;
  if (!root || !root.setAttribute) {
    return;
  }
  var derived = null;
  try {
    derived = theme.deriveTheme(Office.context.officeTheme);
  } catch (e) {
    derived = null;
  }
  if (!derived) {
    root.removeAttribute('data-theme'); // fallback: prefers-color-scheme
    return;
  }
  root.setAttribute('data-theme', derived.dark ? 'dark' : 'light');
  var name;
  for (name in derived.vars) {
    if (Object.prototype.hasOwnProperty.call(derived.vars, name)) {
      root.style.setProperty(name, derived.vars[name]);
    }
  }
}

/** Fixed texts of the page, in the display language. */
function applyStaticTexts() {
  if (document.documentElement) {
    document.documentElement.lang = cfg.lang;
  }
  document.title = s.tpTitle;
  $('title').textContent = s.tpTitle;
  $('intro').textContent = rules.fill(s.tpIntro, { days: rules.blockedDaysLabel(cfg) });
  $('title-suggestions').textContent = s.tpSuggestions;
  $('title-days').textContent = s.tpDays;
  $('title-times').textContent = s.tpTimes;
  $('remove').textContent = s.tpRemove;
  $('confirm').textContent = s.tpCtaNone;
}

Office.onReady(function (info) {
  if (info.host !== Office.HostType.Outlook) {
    return;
  }
  // Language read when the pane opens; falls back to French if unavailable.
  cfg = config.forLang();
  s = cfg.strings;
  applyTheme();
  applyStaticTexts();

  var item = Office.context.mailbox && Office.context.mailbox.item;
  var unsupported = $('unsupported');
  if (!item || typeof item.subject !== 'object' || typeof item.subject.getAsync !== 'function') {
    $('unsupported-text').textContent = s.tpNotCompose;
    unsupported.hidden = false;
    return;
  }
  var canDelay =
    Office.context.requirements.isSetSupported('Mailbox', '1.13') &&
    item.delayDeliveryTime &&
    typeof item.delayDeliveryTime.setAsync === 'function';
  if (!canDelay) {
    $('unsupported-text').textContent = rules.fill(s.tpNoDelayApi, { days: rules.blockedDaysLabel(cfg) });
    unsupported.hidden = false;
    return;
  }
  state.canSend =
    Office.context.requirements.isSetSupported('Mailbox', '1.15') && typeof item.sendAsync === 'function';
  wire();
  initBypass(item);
  $('main').hidden = false;
  $('footer').hidden = false;
  refreshDelay();
});
