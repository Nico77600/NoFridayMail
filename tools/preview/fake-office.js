/*
 * Fake Office.js to preview the REAL task pane (dist/taskpane.js) without Outlook.
 * Development tool only: never referenced by the manifest, never loaded in production.
 *
 * Configuration: window.__PREVIEW__ (standalone pages) or query string:
 *   ?theme=light|dark|auto   auto = no officeTheme (prefers-color-scheme fallback)
 *   &lang=fr|en|de|...       Office.context.displayLanguage (fr-FR, en-US ...)
 *   &state=default|chosen|scheduled|blocked|sending|error|nodelay|bypass|bypasserror|bypasssaved
 *            chosen = a day and a time selected; scheduled = after "Schedule send" (without 1.15)
 *            bypass* = "Exceptional send" section open (the task pane must be built with BYPASS_ENABLED=true,
 *            which npm run preview does): valid input, validation error, justification already saved
 *   &now=2026-10-28T10:00    simulated local time (default: Wednesday 28 October 2026 10:00)
 * Must be loaded BEFORE taskpane.js.
 */
(function () {
  'use strict';

  function fromQuery() {
    var out = {};
    var q = (window.location && window.location.search ? window.location.search : '').replace(/^\?/, '');
    q.split('&').forEach(function (pair) {
      if (!pair) {
        return;
      }
      var kv = pair.split('=');
      out[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
    });
    return out;
  }

  var P = window.__PREVIEW__ || fromQuery();
  var theme = P.theme || 'light';
  var lang = P.lang || 'fr';
  var state = P.state || 'default';

  // Simulated clock: deterministic, to compare screenshots.
  var RealDate = Date;
  var nowText = P.now || '2026-10-28T10:00';
  var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(nowText);
  var fixed = new RealDate(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0).getTime();
  var offset = fixed - RealDate.now();
  function FakeDate() {
    var args = Array.prototype.slice.call(arguments);
    if (args.length === 0) {
      return new RealDate(RealDate.now() + offset);
    }
    return new (Function.prototype.bind.apply(RealDate, [null].concat(args)))();
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = function () { return RealDate.now() + offset; };
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  window.Date = FakeDate;

  var THEMES = {
    light: { bodyBackgroundColor: '#ffffff', bodyForegroundColor: '#242424', controlBackgroundColor: '#ffffff', controlForegroundColor: '#242424' },
    dark: { bodyBackgroundColor: '#242424', bodyForegroundColor: '#ffffff', controlBackgroundColor: '#292929', controlForegroundColor: '#ffffff' }
  };

  var sets = ['1.8', '1.12', '1.13', '1.14', '1.15'];
  if (state === 'nodelay') {
    sets = ['1.8', '1.12'];
  }

  // Simulated delayed delivery: 0 = none.
  var delay = 0;
  if (state === 'blocked') {
    delay = new RealDate(2026, 9, 30, 8, 0, 0, 0); // Friday
  }

  var sendAsync = function (cb) {
    if (state === 'error') {
      setTimeout(function () { cb({ status: 'failed', error: { message: 'Mailbox 1.15 sendAsync' } }); }, 0);
    }
    // sending: the callback is never called (send "in progress")
  };

  // Simulated Internet headers (Mailbox 1.8): { name: value }.
  var headers = {};
  if (state === 'bypasssaved') {
    headers['X-NoFriday-Bypass'] = 'v1; Urgent%20customer%20reply';
  }
  var internetHeaders = {
    getAsync: function (names, cb) {
      var value = {};
      names.forEach(function (n) { if (headers[n] !== undefined) { value[n] = headers[n]; } });
      cb({ status: 'succeeded', value: value });
    },
    setAsync: function (obj, cb) {
      Object.keys(obj).forEach(function (k) { headers[k] = obj[k]; });
      cb({ status: 'succeeded' });
    },
    removeAsync: function (names, cb) {
      names.forEach(function (n) { delete headers[n]; });
      cb({ status: 'succeeded' });
    }
  };

  var item = {
    itemType: 'message',
    internetHeaders: internetHeaders,
    subject: { getAsync: function () {} },
    delayDeliveryTime: {
      getAsync: function (cb) {
        cb({ status: 'succeeded', value: delay });
      },
      setAsync: function (date, cb) {
        if (!(date instanceof RealDate)) {
          throw new Error("Sys.ArgumentTypeException: Object of type '" + typeof date + "' cannot be converted.");
        }
        delay = date.getTime() === 0 ? 0 : date;
        cb({ status: 'succeeded' });
      }
    },
    sendAsync: sendAsync
  };

  window.Office = {
    HostType: { Outlook: 'outlook' },
    AsyncResultStatus: { Succeeded: 'succeeded', Failed: 'failed' },
    context: {
      displayLanguage: lang.length === 2 ? lang + (lang === 'fr' ? '-FR' : lang === 'en' ? '-US' : '') : lang,
      officeTheme: THEMES[theme],
      requirements: { isSetSupported: function (name, v) { return sets.indexOf(v) !== -1; } },
      mailbox: { item: item }
    },
    onReady: function (cb) {
      setTimeout(function () {
        cb({ host: 'outlook' });
        setTimeout(act, 30);
      }, 0);
    }
  };

  // Scenarios: the real task pane handlers are triggered by real DOM events.
  function byId(id) { return document.getElementById(id); }
  function act() {
    if (state === 'bypass' || state === 'bypasserror' || state === 'bypasssaved') {
      byId('bypass-toggle').click();
      var box = byId('bypass-text');
      box.value = state === 'bypasserror' ? 'Urgent' : 'Urgent reply to a customer blocked in production.';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      if (state === 'bypasserror') {
        byId('bypass-send').click();
      }
    } else if (state === 'chosen') {
      byId('day-2').click(); // Monday 2 November (Friday and weekend are not in the row)
      byId('chip-1').click(); // 09:00
    } else if (state === 'scheduled' || state === 'sending' || state === 'error') {
      byId('day-2').click();
      byId('chip-1').click();
      byId('confirm').click();
    }
  }

  if (state === 'scheduled') {
    // Remove sendAsync BEFORE the task pane starts to show the "without 1.15" path.
    sets = ['1.12', '1.13', '1.14'];
    delete item.sendAsync;
  }
  window.__PREVIEW_STATE__ = { theme: theme, lang: lang, state: state, now: nowText };
})();
