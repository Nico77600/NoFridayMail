'use strict';

// Task pane tested with a minimal fake DOM: suggestion cards, allowed days, hour chips,
// sticky action button, banner. None of these cards may ever trigger a send.
const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../package/src/shared/config');

const DAY_MAX = 10;
const CHIP_MAX = 8;
const BYPASS_OFF = config.bypass; // default setting (disabled): restored after each test

function makeEl(id, extra) {
  const listeners = {};
  return Object.assign(
    {
      id,
      value: '',
      textContent: '',
      className: '',
      hidden: false,
      disabled: false,
      attrs: {},
      focused: 0,
      focus() { this.focused += 1; },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
      removeAttribute(name) { delete this.attrs[name]; },
      style: { props: {}, setProperty(name, value) { this.props[name] = value; } },
      listeners,
      addEventListener(type, fn) {
        (listeners[type] = listeners[type] || []).push(fn);
      },
      fire(type, event) {
        (listeners[type] || []).forEach((fn) => fn(Object.assign({ target: this }, event)));
      }
    },
    extra
  );
}

// opts: { sets: Mailbox sets, sendAsync: function (cb), lang, theme,
//          bypass: settings { enabled, minLength, maxLength }, internetHeaders: true | { initial, set, get, remove },
//          itemType, naa: { factory } (fake MSAL factory), sessionData: true | { set, remove } };
// removeMode: 'normal' | 'throw' | 'noop' for Date(0); calls.order = order of the Office calls.
function setup(t, nowDate, delayValue, removeMode, opts) {
  opts = opts || {};
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['Date'], now: nowDate.getTime() });

  const ids = [
    'unsupported', 'unsupported-text', 'title', 'intro', 'main', 'footer', 'current', 'title-suggestions',
    'title-days', 'title-times', 'times-hint', 'times-group', 'days-group', 'sug-group', 'sug-first',
    'sug-second', 'label-first', 'date-first', 'label-second', 'date-second', 'summary', 'confirm',
    'remove', 'status', 'result', 'bypass-section', 'bypass-toggle', 'bypass-title', 'bypass-panel',
    'bypass-intro', 'bypass-saved', 'bypass-saved-text', 'bypass-remove', 'bypass-label', 'bypass-text',
    'bypass-counter', 'bypass-error', 'bypass-send', 'bypass-form', 'bypass-unsupported', 'bypass-retry', 'bypass-reuse'
  ];
  for (let i = 0; i < DAY_MAX; i += 1) {
    ids.push(`day-${i}`, `day-${i}-rel`, `day-${i}-wd`, `day-${i}-num`, `day-${i}-mon`);
  }
  for (let i = 0; i < CHIP_MAX; i += 1) {
    ids.push(`chip-${i}`);
  }
  const els = {};
  ids.forEach((id) => { els[id] = makeEl(id); });
  // Initial HTML state: hidden attributes and disabled buttons.
  ['unsupported', 'main', 'footer', 'status', 'remove', 'current', 'times-group', 'bypass-section', 'bypass-panel',
    'bypass-saved', 'bypass-error', 'bypass-unsupported', 'bypass-retry', 'bypass-reuse'].forEach((id) => { els[id].hidden = true; });
  for (let i = 0; i < DAY_MAX; i += 1) { els[`day-${i}`].hidden = true; }
  for (let i = 0; i < CHIP_MAX; i += 1) { els[`chip-${i}`].hidden = true; }
  els.confirm.disabled = true;

  global.document = {
    getElementById: (id) => els[id],
    documentElement: makeEl('html', { lang: '' }),
    title: ''
  };

  config.bypass = opts.bypass || BYPASS_OFF;
  t.after(() => { config.bypass = BYPASS_OFF; });
  const calls = { setAsync: [], sendAsync: 0, order: [], headers: {}, headerSets: [], headerRemoves: [], session: {}, sessionSets: [], sessionRemoves: [] };
  const hdr = opts.internetHeaders === true ? {} : opts.internetHeaders;
  if (hdr) {
    Object.assign(calls.headers, hdr.initial || {});
  }
  let delay = delayValue === undefined ? 0 : delayValue;
  global.Office = {
    HostType: { Outlook: 'outlook' },
    AsyncResultStatus: { Succeeded: 'succeeded', Failed: 'failed' },
    context: {
      displayLanguage: opts.lang,
      officeTheme: opts.theme,
      requirements: { isSetSupported: (n, v) => !opts.sets || opts.sets.indexOf(v) !== -1 },
      mailbox: {
        item: {
          subject: { getAsync() {} },
          delayDeliveryTime: {
            getAsync: (cb) => {
              calls.order.push('getAsync');
              cb({ status: 'succeeded', value: delay });
            },
            // Reproduces OWA: anything that is not a Date throws a synchronous exception.
            setAsync: (date, cb) => {
              if (date === null || date === undefined) {
                throw new Error('Sys.ArgumentNullException: Value cannot be null.');
              }
              if (!(date instanceof Date)) {
                throw new Error("Sys.ArgumentTypeException: Object of type '" + typeof date + "' cannot be converted to type 'function'.");
              }
              calls.setAsync.push(date);
              calls.order.push('setAsync');
              if (date.getTime() === 0) {
                if (removeMode === 'throw') {
                  throw new Error('boom');
                }
                if (removeMode !== 'noop') {
                  delay = 0; // Date(0) = delivery delay cleared
                }
              } else {
                delay = date;
              }
              cb({ status: 'succeeded' });
            }
          }
        }
      }
    },
    onReady: (cb) => cb({ host: 'outlook' })
  };
  if (opts.itemType) {
    global.Office.context.mailbox.item.itemType = opts.itemType;
  }
  if (hdr) {
    global.Office.context.mailbox.item.internetHeaders = {
      getAsync: (names, cb) => {
        calls.order.push('hdrGet');
        if (hdr.get) {
          hdr.get(names, cb, calls);
          return;
        }
        const value = {};
        names.forEach((n) => { if (calls.headers[n] !== undefined) value[n] = calls.headers[n]; });
        cb({ status: 'succeeded', value });
      },
      setAsync: (obj, cb) => {
        calls.order.push('hdrSet');
        calls.headerSets.push(Object.assign({}, obj));
        if (hdr.set) {
          hdr.set(obj, cb, calls);
          return;
        }
        Object.assign(calls.headers, obj);
        cb({ status: 'succeeded' });
      },
      removeAsync: (names, cb) => {
        calls.order.push('hdrRemove');
        calls.headerRemoves.push(names);
        if (hdr.remove) {
          hdr.remove(names, cb, calls);
          return;
        }
        names.forEach((n) => { delete calls.headers[n]; });
        cb({ status: 'succeeded' });
      }
    };
  }
  if (opts.sessionData) {
    // item.sessionData (Mailbox 1.11): fallback channel shared with the event runtime.
    const sd = opts.sessionData === true ? {} : opts.sessionData;
    global.Office.context.mailbox.item.sessionData = {
      setAsync: (name, value, cb) => {
        calls.order.push('sessSet');
        calls.sessionSets.push([name, value]);
        if (sd.set) { sd.set(name, value, cb); return; }
        calls.session[name] = value;
        cb({ status: 'succeeded' });
      },
      removeAsync: (name, cb) => {
        calls.order.push('sessRemove');
        calls.sessionRemoves.push(name);
        if (sd.remove) { sd.remove(name, cb); return; }
        delete calls.session[name];
        cb({ status: 'succeeded' });
      }
    };
  }
  if (opts.sendAsync) {
    global.Office.context.mailbox.item.sendAsync = (cb) => {
      calls.sendAsync += 1;
      calls.order.push('sendAsync');
      opts.sendAsync(cb);
    };
  }

  // Fake MSAL factory (MFA step): never the real MSAL under Node.
  require('../package/src/taskpane/naa').setFactory(opts.naa ? opts.naa.factory : null);
  delete require.cache[require.resolve('../package/src/taskpane/taskpane')];
  require('../package/src/taskpane/taskpane');

  const press = (groupId, key, targetId) =>
    els[groupId].fire('keydown', { key, target: targetId ? els[targetId] : els[groupId], preventDefault() {} });
  return {
    els,
    calls,
    doc: global.document,
    press,
    click: (id) => els[id].fire('click'),
    /** Picks a day (card index) then an hour (chip index). */
    pick(day, chip) {
      els[`day-${day}`].fire('click');
      if (chip !== undefined) {
        els[`chip-${chip}`].fire('click');
      }
    },
    checked: (prefix, count) => {
      const out = [];
      for (let i = 0; i < count; i += 1) {
        out.push(els[`${prefix}${i}`].getAttribute('aria-checked') === 'true');
      }
      return out;
    },
    visibleChips: () => {
      const out = [];
      for (let i = 0; i < CHIP_MAX; i += 1) {
        if (!els[`chip-${i}`].hidden) out.push(els[`chip-${i}`].textContent);
      }
      return out;
    },
    visibleDays: () => {
      const out = [];
      for (let i = 0; i < DAY_MAX; i += 1) {
        if (!els[`day-${i}`].hidden) {
          out.push({
            rel: els[`day-${i}-rel`].textContent,
            wd: els[`day-${i}-wd`].textContent,
            num: els[`day-${i}-num`].textContent,
            mon: els[`day-${i}-mon`].textContent,
            label: els[`day-${i}`].getAttribute('aria-label')
          });
        }
      }
      return out;
    }
  };
}

// Wednesday 28 October 2026, 10:00 (Friday blocked by default).
const NOW = new Date(2026, 9, 28, 10, 0, 0, 0);
const FRIDAY_DELAY = new Date(2026, 9, 30, 8, 0, 0, 0);
const status = (ctx) => ctx.els.status.className;

// ---------------------------------------------------------------- initial rendering

test('initial rendering: suggestions, days, disabled button with explicit text', (t) => {
  const ctx = setup(t, NOW);
  const { els } = ctx;
  assert.equal(els.main.hidden, false);
  assert.equal(els.footer.hidden, false);
  assert.equal(els['date-first'].textContent, 'jeudi 29 octobre 2026 à 08:00');
  assert.equal(els['date-second'].textContent, 'lundi 2 novembre 2026 à 08:00');
  assert.equal(els['label-first'].textContent, 'Jeudi à 08:00');
  assert.equal(els.current.hidden, true);
  assert.equal(els.remove.hidden, true);
  assert.equal(els.confirm.disabled, true);
  assert.equal(els.confirm.textContent, 'Choisissez un jour et une heure');
  assert.equal(els.summary.textContent, 'Aucun créneau choisi.');
  assert.equal(els['times-group'].hidden, true);
  assert.equal(els['times-hint'].textContent, "Choisissez d'abord un jour.");
  assert.equal(els['title-suggestions'].textContent, 'Suggestions');
  assert.equal(els['title-days'].textContent, 'Choisir un jour');
  assert.equal(els['title-times'].textContent, 'Heure');
});

test('days: next 10 allowed days, today / tomorrow, Fridays absent', (t) => {
  const ctx = setup(t, NOW);
  const days = ctx.visibleDays();
  assert.equal(days.length, 10);
  assert.deepEqual(days.slice(0, 4).map((d) => [d.rel, d.wd, d.num, d.mon]), [
    ["Aujourd'hui", 'mer.', '28', 'oct.'],
    ['Demain', 'jeu.', '29', 'oct.'],
    ['', 'lun.', '2', 'nov.'],
    ['', 'mar.', '3', 'nov.']
  ]);
  assert.equal(days[0].label, "Aujourd'hui, mercredi 28 octobre");
  assert.equal(days[2].label, 'lundi 2 novembre');
  assert.equal(days.some((d) => d.wd === 'ven.'), false, 'no Friday proposed');
  assert.equal(days.some((d) => d.wd === 'sam.' || d.wd === 'dim.'), false, 'no weekend proposed');
  assert.equal(days.some((d) => /vendredi/.test(d.label)), false);
});

test('days: configurable blocked days (3,4 = Wednesday and Thursday absent)', (t) => {
  const saved = config.blockedDays;
  config.blockedDays = [3, 4];
  try {
    const days = setup(t, NOW).visibleDays();
    assert.equal(days.some((d) => d.wd === 'mer.' || d.wd === 'jeu.'), false);
    assert.deepEqual(days.slice(0, 3).map((d) => d.wd), ['ven.', 'lun.', 'mar.']);
    assert.equal(days.some((d) => d.wd === 'sam.' || d.wd === 'dim.'), false);
  } finally {
    config.blockedDays = saved;
  }
});

test('days: today absent when no hour is left; tomorrow becomes "Demain"', (t) => {
  const late = setup(t, new Date(2026, 9, 28, 17, 0, 0, 0));
  const days = late.visibleDays();
  assert.equal(days[0].wd, 'jeu.');
  assert.equal(days[0].rel, 'Demain');
});

test('hours: no past hour today, all hours on other days', (t) => {
  const ctx = setup(t, NOW);
  ctx.pick(0); // today, 10:00: 08:00, 09:00 and 10:00 are past (10:00 = now)
  assert.deepEqual(ctx.visibleChips(), ['11:00', '14:00', '16:00']);
  ctx.pick(1); // tomorrow
  assert.deepEqual(ctx.visibleChips(), ['08:00', '09:00', '10:00', '11:00', '14:00', '16:00']);
  const later = setup(t, new Date(2026, 9, 28, 15, 0, 0, 0));
  later.pick(0);
  assert.deepEqual(later.visibleChips(), ['16:00']);
});

test('hours configurable in config.js (slotTimes)', (t) => {
  const saved = config.slotTimes;
  config.slotTimes = ['07:30', '18:00', 'nimporte', '25:00'];
  try {
    const ctx = setup(t, NOW);
    ctx.pick(1);
    assert.deepEqual(ctx.visibleChips(), ['07:30', '18:00'], 'invalid values ignored');
  } finally {
    config.slotTimes = saved;
  }
});

// ---------------------------------------------------------------- selection and action button

test('button: label = summary of the choice, without "et envoyer" before Mailbox 1.15', (t) => {
  const ctx = setup(t, NOW);
  ctx.pick(2);
  assert.equal(ctx.els.confirm.disabled, true);
  assert.equal(ctx.els.confirm.textContent, 'Choisissez une heure');
  ctx.click('chip-1'); // 09:00
  assert.equal(ctx.els.confirm.disabled, false);
  assert.equal(ctx.els.confirm.textContent, "Planifier l'envoi · lun. 2 nov. à 09:00");
  assert.equal(ctx.els.summary.textContent, 'Envoi prévu : lundi 2 novembre 2026 à 09:00');
});

test('button: "Planifier et envoyer" label with Mailbox 1.15 and sendAsync', (t) => {
  const ctx = setup(t, NOW, 0, 'normal', { sendAsync: () => {} });
  ctx.pick(2, 1);
  assert.equal(ctx.els.confirm.textContent, 'Planifier et envoyer · lun. 2 nov. à 09:00');
});

test('button: summary in English (12-hour)', (t) => {
  const ctx = setup(t, NOW, 0, 'normal', { lang: 'en-US', sendAsync: () => {} });
  assert.equal(ctx.els.confirm.textContent, 'Choose a day and time');
  ctx.pick(2);
  assert.equal(ctx.els.confirm.textContent, 'Choose a time');
  ctx.click('chip-1');
  assert.equal(ctx.els.confirm.textContent, 'Schedule and send · Mon, Nov 2 at 9:00 AM');
  assert.equal(ctx.els.summary.textContent, 'Scheduled for: Monday, November 2, 2026 at 9:00 AM');
  assert.deepEqual(ctx.visibleChips().slice(0, 3), ['8:00 AM', '9:00 AM', '10:00 AM']);
  const plain = setup(t, NOW, 0, 'normal', { lang: 'en-US' });
  plain.pick(2, 1);
  assert.equal(plain.els.confirm.textContent, 'Schedule send · Mon, Nov 2 at 9:00 AM');
});

test('suggestion and day/hour are mutually exclusive', (t) => {
  const ctx = setup(t, NOW);
  ctx.click('sug-second');
  assert.equal(ctx.els['sug-second'].getAttribute('aria-checked'), 'true');
  assert.equal(ctx.els['sug-first'].getAttribute('aria-checked'), 'false');
  assert.equal(ctx.els.confirm.textContent, "Planifier l'envoi · lun. 2 nov. à 08:00");
  ctx.pick(2, 1);
  assert.equal(ctx.els['sug-second'].getAttribute('aria-checked'), 'false', 'choosing a day deselects the suggestion');
  assert.deepEqual(ctx.checked('day-', 3), [false, false, true]);
  assert.deepEqual(ctx.checked('chip-', 2), [false, true]);
  ctx.click('sug-first');
  assert.equal(ctx.els['sug-first'].getAttribute('aria-checked'), 'true');
  assert.deepEqual(ctx.checked('day-', 3), [false, false, false], 'choosing a suggestion deselects the day');
  assert.deepEqual(ctx.checked('chip-', 2), [false, false]);
  assert.equal(ctx.els['times-group'].hidden, true);
});

test('changing day keeps the hour if it exists, otherwise clears it', (t) => {
  const ctx = setup(t, NOW);
  ctx.pick(1, 3); // tomorrow 11:00
  ctx.click('day-2'); // Monday: 11:00 exists
  assert.deepEqual(ctx.checked('chip-', 4), [false, false, false, true]);
  const keep = ctx.els.confirm.textContent;
  assert.match(keep, /lun\. 2 nov\. à 11:00/);
  ctx.click('day-0'); // today: 11:00 still exists (10:00 = now)
  assert.match(ctx.els.confirm.textContent, /mer\. 28 oct\. à 11:00/);
  ctx.click('chip-0'); // becomes 11:00 (first chip of the day)
  const early = setup(t, new Date(2026, 9, 28, 15, 0, 0, 0));
  early.pick(1, 0); // tomorrow 08:00
  early.click('day-0'); // today: only 16:00 exists, 08:00 is cleared
  assert.equal(early.els.confirm.disabled, true);
  assert.equal(early.els.confirm.textContent, 'Choisissez une heure');
});

test('clicking a card never triggers setAsync nor sendAsync', (t) => {
  const ctx = setup(t, NOW, 0, 'normal', { sendAsync: () => {} });
  ctx.click('sug-first');
  ctx.click('sug-second');
  for (let i = 0; i < 10; i += 1) ctx.click(`day-${i}`);
  ctx.click('day-1');
  for (let i = 0; i < 6; i += 1) ctx.click(`chip-${i}`);
  assert.equal(ctx.calls.setAsync.length, 0);
  assert.equal(ctx.calls.sendAsync, 0);
  assert.equal(ctx.els.status.hidden, true);
});

// ---------------------------------------------------------------- keyboard

test('keyboard (suggestions): arrows, Home/End, Space/Enter, no send', (t) => {
  const ctx = setup(t, NOW, 0, 'normal', { sendAsync: () => {} });
  const { els } = ctx;
  ctx.press('sug-group', 'ArrowDown');
  assert.equal(els['sug-first'].getAttribute('aria-checked'), 'true');
  assert.equal(els['sug-first'].focused, 1);
  ctx.press('sug-group', 'ArrowRight');
  assert.equal(els['sug-second'].getAttribute('aria-checked'), 'true');
  ctx.press('sug-group', 'ArrowDown');
  assert.equal(els['sug-first'].getAttribute('aria-checked'), 'true', 'wraps back to the first');
  ctx.press('sug-group', 'ArrowUp');
  assert.equal(els['sug-second'].getAttribute('aria-checked'), 'true');
  ctx.press('sug-group', 'Home');
  assert.equal(els['sug-first'].getAttribute('aria-checked'), 'true');
  ctx.press('sug-group', 'End');
  assert.equal(els['sug-second'].getAttribute('aria-checked'), 'true');
  ctx.press('sug-group', ' ', 'sug-first');
  assert.equal(els['sug-first'].getAttribute('aria-checked'), 'true');
  ctx.press('sug-group', 'Tab');
  assert.equal(els['sug-first'].getAttribute('aria-checked'), 'true', 'other keys change nothing');
  assert.equal(ctx.calls.setAsync.length + ctx.calls.sendAsync, 0);
});

test('keyboard (days and hours): navigation in each radiogroup, roving tabindex', (t) => {
  const ctx = setup(t, NOW, 0, 'normal', { sendAsync: () => {} });
  const { els } = ctx;
  ctx.press('days-group', 'ArrowRight');
  assert.deepEqual(ctx.checked('day-', 3), [true, false, false]);
  ctx.press('days-group', 'ArrowRight', 'day-0');
  ctx.press('days-group', 'ArrowRight', 'day-1');
  assert.deepEqual(ctx.checked('day-', 3), [false, false, true]);
  assert.equal(els['day-2'].getAttribute('tabindex'), '0');
  assert.equal(els['day-0'].getAttribute('tabindex'), '-1');
  ctx.press('days-group', 'End', 'day-2');
  assert.equal(els['day-9'].getAttribute('aria-checked'), 'true');
  ctx.press('days-group', 'ArrowRight', 'day-9');
  assert.equal(els['day-0'].getAttribute('aria-checked'), 'true', 'wraps back to the first day');
  ctx.press('days-group', 'ArrowLeft', 'day-0');
  assert.equal(els['day-9'].getAttribute('aria-checked'), 'true');
  ctx.press('days-group', 'Home', 'day-9');
  ctx.press('days-group', 'ArrowDown', 'day-0'); // day 1 (tomorrow)
  assert.equal(els['day-1'].focused > 0, true, 'focus follows the selection');
  // hours
  assert.equal(els['times-group'].hidden, false);
  ctx.press('times-group', 'ArrowRight');
  assert.deepEqual(ctx.checked('chip-', 3), [true, false, false]);
  ctx.press('times-group', 'End', 'chip-0');
  assert.deepEqual(ctx.checked('chip-', 6), [false, false, false, false, false, true]);
  ctx.press('times-group', 'Enter', 'chip-2');
  assert.deepEqual(ctx.checked('chip-', 3), [false, false, true]);
  assert.equal(els.confirm.disabled, false);
  assert.equal(ctx.calls.setAsync.length + ctx.calls.sendAsync, 0, 'the keyboard never sends');
});

test('suggestions: on a Sunday, the first two working days (Monday, Tuesday) are proposed', (t) => {
  const ctx = setup(t, new Date(2026, 10, 1, 10, 0, 0, 0));
  assert.equal(ctx.els['sug-second'].hidden, false);
  assert.equal(ctx.els['date-first'].textContent, 'lundi 2 novembre 2026 à 08:00');
  assert.equal(ctx.els['date-second'].textContent, 'mardi 3 novembre 2026 à 08:00');
  ctx.press('sug-group', 'ArrowDown');
  ctx.press('sug-group', 'ArrowDown', 'sug-first');
  assert.equal(ctx.els['sug-second'].getAttribute('aria-checked'), 'true');
});

test('suggestions: on a Friday -> Monday and Tuesday, never the weekend', (t) => {
  const ctx = setup(t, new Date(2026, 9, 30, 10, 0, 0, 0));
  assert.equal(ctx.els['date-first'].textContent, 'lundi 2 novembre 2026 à 08:00');
  assert.equal(ctx.els['date-second'].textContent, 'mardi 3 novembre 2026 à 08:00');
  const wd = ctx.visibleDays().map((d) => d.wd);
  assert.deepEqual(wd.slice(0, 3), ['lun.', 'mar.', 'mer.']);
});

test('suggestions: Wednesday+Thursday blocked, on a Thursday -> Friday and Monday', (t) => {
  const saved = config.blockedDays;
  config.blockedDays = [3, 4];
  try {
    const ctx = setup(t, new Date(2026, 9, 29, 10, 0, 0, 0));
    assert.equal(ctx.els['label-first'].textContent, 'Vendredi à 08:00');
    assert.equal(ctx.els['date-first'].textContent, 'vendredi 30 octobre 2026 à 08:00');
    assert.equal(ctx.els['date-second'].textContent, 'lundi 2 novembre 2026 à 08:00');
    assert.equal(ctx.visibleDays().some((d) => ['sam.', 'dim.', 'mer.', 'jeu.'].indexOf(d.wd) !== -1), false);
  } finally {
    config.blockedDays = saved;
  }
});

test('configurable working days (workingDays): Monday only -> two distinct Mondays', (t) => {
  const saved = config.workingDays;
  config.workingDays = [1];
  try {
    const ctx = setup(t, NOW);
    assert.equal(ctx.els['date-first'].textContent, 'lundi 2 novembre 2026 à 08:00');
    assert.equal(ctx.els['date-second'].textContent, 'lundi 9 novembre 2026 à 08:00');
    assert.deepEqual(ctx.visibleDays().slice(0, 3).map((d) => d.wd), ['lun.', 'lun.', 'lun.']);
  } finally {
    config.workingDays = saved;
  }
});

test('no proposable day (all working days blocked): cards hidden, explicit message, no infinite loop', (t) => {
  const saved = config.blockedDays;
  config.blockedDays = [1, 2, 3, 4, 5];
  try {
    const ctx = setup(t, NOW, 0, 'normal', { sendAsync: () => {} });
    assert.equal(ctx.els['sug-first'].hidden, true);
    assert.equal(ctx.els['sug-second'].hidden, true);
    assert.equal(ctx.els['sug-group'].hidden, true);
    assert.equal(ctx.els['title-suggestions'].hidden, true);
    assert.equal(ctx.visibleDays().length, 0);
    assert.equal(ctx.els['times-hint'].textContent, 'Aucun jour ouvré disponible.');
    assert.equal(ctx.els.confirm.disabled, true);
    assert.equal(ctx.els.confirm.textContent, 'Choisissez un jour et une heure');
    ctx.press('sug-group', 'ArrowDown');
    ctx.press('days-group', 'ArrowRight');
    ctx.els.confirm.disabled = false;
    ctx.click('confirm');
    assert.equal(ctx.calls.setAsync.length + ctx.calls.sendAsync, 0);
    const en = setup(t, NOW, 0, 'normal', { lang: 'en-US' });
    assert.equal(en.els['times-hint'].textContent, 'No working day available.');
  } finally {
    config.blockedDays = saved;
  }
});

// ---------------------------------------------------------------- validation (defense in depth)

test('validation: a day blocked after the fact is rejected on click, never sent', (t) => {
  const ctx = setup(t, NOW, 0, 'normal', { sendAsync: () => {} });
  ctx.pick(2, 1); // Monday 09:00
  assert.equal(ctx.els.confirm.disabled, false);
  config.blockedDays.push(1); // Monday becomes blocked (same array as the task pane's)
  try {
    ctx.els.confirm.disabled = false; // bypassing the interface
    ctx.click('confirm');
    assert.equal(ctx.calls.setAsync.length, 0);
    assert.equal(ctx.calls.sendAsync, 0);
    assert.equal(ctx.els.result.textContent, "Le lundi n'est pas autorisé, choisissez un autre jour");
    assert.match(status(ctx), /\berror\b/);
  } finally {
    config.blockedDays.pop();
  }
});

test('validation: an hour that has become past is rejected on click', (t) => {
  const ctx = setup(t, NOW, 0, 'normal', { sendAsync: () => {} });
  ctx.pick(0, 0); // today 11:00
  assert.equal(ctx.els.confirm.disabled, false);
  t.mock.timers.tick(2 * 60 * 60 * 1000); // it is now 12:00
  ctx.els.confirm.disabled = false;
  ctx.click('confirm');
  assert.equal(ctx.calls.setAsync.length, 0);
  assert.equal(ctx.calls.sendAsync, 0);
  assert.equal(ctx.els.result.textContent, 'La date doit être dans le futur.');
});

test('validation: button forced with no choice or with a day only: no call', (t) => {
  const ctx = setup(t, NOW, 0, 'normal', { sendAsync: () => {} });
  ctx.els.confirm.disabled = false;
  ctx.click('confirm');
  ctx.pick(2);
  ctx.els.confirm.disabled = false;
  ctx.click('confirm');
  assert.equal(ctx.calls.setAsync.length, 0);
  assert.equal(ctx.calls.sendAsync, 0);
  assert.match(status(ctx), /\berror\b/);
});

// ---------------------------------------------------------------- scheduling and sending

test('scheduling a suggestion without 1.15: setAsync then "cliquez de nouveau sur Envoyer"', (t) => {
  const ctx = setup(t, NOW);
  ctx.click('sug-second');
  ctx.click('confirm');
  assert.equal(ctx.calls.setAsync.length, 1);
  assert.deepEqual(ctx.calls.setAsync[0], new Date(2026, 10, 2, 8, 0, 0, 0));
  assert.match(ctx.els.result.textContent, /^Envoi planifié — cliquez de nouveau sur Envoyer/);
  assert.match(status(ctx), /\bsuccess\b/);
  assert.equal(ctx.els.remove.hidden, false, 'Remove appears when a delay is set');
  assert.equal(ctx.els.current.hidden, false);
  assert.match(ctx.els.current.textContent, /lundi 2 novembre 2026 à 08:00/);
});

test('scheduling a day + an hour: the date passed to setAsync is the one in the summary', (t) => {
  const ctx = setup(t, NOW);
  ctx.pick(2, 4); // Monday, 5th chip = 14:00
  ctx.click('confirm');
  assert.deepEqual(ctx.calls.setAsync[0], new Date(2026, 10, 2, 14, 0, 0, 0));
});

test('1.15 + sendAsync: order setAsync -> getAsync -> sendAsync, nothing after', (t) => {
  const ctx = setup(t, NOW, 0, 'normal', { sendAsync: () => {} });
  ctx.pick(2, 1);
  ctx.calls.order.length = 0;
  ctx.click('confirm');
  assert.deepEqual(ctx.calls.order.slice(0, 3), ['setAsync', 'getAsync', 'sendAsync']);
  assert.equal(ctx.calls.order[ctx.calls.order.length - 1], 'sendAsync');
  assert.equal(ctx.calls.sendAsync, 1);
  assert.equal(ctx.els.result.textContent, 'Envoi planifié pour lundi 2 novembre 2026 à 09:00, envoi en cours…');
  assert.match(status(ctx), /\binfo\b/);
  assert.match(status(ctx), /\bbusy\b/);
  assert.equal(ctx.els.confirm.disabled, true);
});

test('without Mailbox 1.15 or without item.sendAsync: never sendAsync', (t) => {
  const noSet = setup(t, NOW, 0, 'normal', { sets: ['1.12', '1.13', '1.14'], sendAsync: () => {} });
  noSet.pick(2, 1);
  noSet.click('confirm');
  assert.equal(noSet.calls.sendAsync, 0);
  assert.match(noSet.els.result.textContent, /cliquez de nouveau sur Envoyer/);
  const noFn = setup(t, NOW);
  noFn.pick(2, 1);
  noFn.click('confirm');
  assert.equal(noFn.calls.sendAsync, 0);
});

test('sendAsync never called when the getAsync verification fails (blocked day / delay not set)', (t) => {
  const ctx = setup(t, NOW, 0, 'normal', { sendAsync: () => {} });
  const api = Office.context.mailbox.item.delayDeliveryTime;
  api.setAsync = (date, cb) => { cb({ status: 'succeeded' }); };
  api.getAsync = (cb) => cb({ status: 'succeeded', value: FRIDAY_DELAY });
  ctx.pick(2, 1);
  ctx.click('confirm');
  assert.equal(ctx.calls.sendAsync, 0);
  assert.equal(ctx.els.result.textContent, config.strings.tpVerifyFailed);
  api.getAsync = (cb) => cb({ status: 'succeeded', value: 0 });
  ctx.els.confirm.disabled = false;
  ctx.click('confirm');
  assert.equal(ctx.calls.sendAsync, 0);
});

test('sendAsync: asynchronous failure, synchronous exception and success without extra handling', (t) => {
  const failed = setup(t, NOW, 0, 'normal', {
    sendAsync: (cb) => cb({ status: 'failed', error: { message: 'Envoi refusé' } })
  });
  failed.pick(2, 1);
  failed.click('confirm');
  assert.equal(failed.calls.sendAsync, 1);
  assert.match(status(failed), /\berror\b/);
  assert.doesNotMatch(status(failed), /\bbusy\b/);
  assert.match(failed.els.result.textContent, /Envoi refusé/);
  assert.match(failed.els.result.textContent, /cliquez sur Envoyer/);
  assert.equal(failed.els.confirm.disabled, false);

  const thrown = setup(t, NOW, 0, 'normal', { sendAsync: () => { throw new Error('Sys.InvalidOperation'); } });
  thrown.pick(2, 1);
  thrown.click('confirm');
  assert.match(thrown.els.result.textContent, /Sys\.InvalidOperation/);
  assert.match(status(thrown), /\berror\b/);

  const ok = setup(t, NOW, 0, 'normal', { sendAsync: (cb) => cb({ status: 'succeeded' }) });
  ok.pick(2, 1);
  ok.click('confirm');
  assert.equal(ok.els.result.textContent, 'Envoi planifié pour lundi 2 novembre 2026 à 09:00, envoi en cours…');
});

test('setAsync throwing during scheduling: error displayed without crashing', (t) => {
  const ctx = setup(t, NOW);
  Office.context.mailbox.item.delayDeliveryTime.setAsync = () => { throw new Error('Sys.ArgumentTypeException'); };
  ctx.click('sug-first');
  ctx.click('confirm');
  assert.match(ctx.els.result.textContent, /La planification a échoué : Sys\.ArgumentTypeException/);
  assert.match(status(ctx), /\berror\b/);
});

test('changing card clears the banner', (t) => {
  const ctx = setup(t, NOW, 0, 'normal', { sendAsync: (cb) => cb({ status: 'failed', error: { message: 'x' } }) });
  ctx.pick(2, 1);
  ctx.click('confirm');
  assert.equal(ctx.els.status.hidden, false);
  ctx.click('sug-first');
  assert.equal(ctx.els.status.hidden, true);
});

// ---------------------------------------------------------------- removal

test('"Retirer la planification": Date(0), getAsync verification, never a send', (t) => {
  const ctx = setup(t, NOW, FRIDAY_DELAY, 'normal', { sendAsync: () => {} });
  assert.equal(ctx.els.remove.hidden, false);
  assert.equal(ctx.els.current.hidden, false);
  ctx.click('remove');
  assert.equal(ctx.calls.setAsync.length, 1);
  assert.ok(ctx.calls.setAsync[0] instanceof Date, 'never a number nor null (exception in OWA)');
  assert.equal(ctx.calls.setAsync[0].getTime(), 0);
  assert.equal(ctx.els.result.textContent, config.strings.tpRemoved);
  assert.match(status(ctx), /\bsuccess\b/);
  assert.equal(ctx.els.remove.hidden, true);
  assert.equal(ctx.els.current.hidden, true);
  assert.equal(ctx.calls.sendAsync, 0);
});

test('removal impossible (setAsync throws) or without effect: fallback message', (t) => {
  const thrown = setup(t, NOW, FRIDAY_DELAY, 'throw');
  thrown.click('remove');
  assert.equal(thrown.els.result.textContent, config.strings.tpRemoveFailed);
  assert.match(thrown.els.result.textContent, /Différer la remise/);
  assert.match(status(thrown), /\berror\b/);
  assert.equal(thrown.els.remove.hidden, false);
  const noop = setup(t, NOW, FRIDAY_DELAY, 'noop');
  noop.click('remove');
  assert.equal(noop.els.result.textContent, config.strings.tpRemoveFailed);
  assert.equal(noop.els.remove.hidden, false);
});

test('send already scheduled on a Friday: badge, Monday and Tuesday suggestions', (t) => {
  const ctx = setup(t, NOW, FRIDAY_DELAY);
  assert.match(ctx.els.current.textContent, /vendredi 30 octobre 2026 à 08:00/);
  assert.match(ctx.els.current.textContent, /interdit/);
  assert.equal(ctx.els['date-first'].textContent, 'lundi 2 novembre 2026 à 08:00');
  assert.equal(ctx.els['date-second'].textContent, 'mardi 3 novembre 2026 à 08:00');
});

// ---------------------------------------------------------------- languages, theme, support

test('task pane [fr-FR] / [en-US] / missing / [de-DE]: fixed texts and lang', (t) => {
  const fr = setup(t, NOW, 0, 'normal', { lang: 'fr-FR' });
  assert.equal(fr.doc.documentElement.lang, 'fr');
  assert.equal(fr.doc.title, "Planifier l'envoi");
  assert.equal(fr.els.title.textContent, "Planifier l'envoi");
  assert.equal(fr.els.remove.textContent, 'Retirer la planification');
  assert.equal(fr.els.intro.textContent, 'Les envois sont interdits le vendredi. Choisissez quand ce message doit partir.');

  const en = setup(t, NOW, 0, 'normal', { lang: 'en-US' });
  assert.equal(en.doc.documentElement.lang, 'en');
  assert.equal(en.doc.title, 'Schedule send');
  assert.equal(en.els.remove.textContent, 'Remove scheduling');
  assert.equal(en.els.intro.textContent, 'Sending is not allowed on Fridays. Choose when this message should go out.');
  assert.equal(en.els['title-days'].textContent, 'Choose a day');
  assert.equal(en.els['label-first'].textContent, 'Thursday at 8:00 AM');
  assert.equal(en.els['date-first'].textContent, 'Thursday, October 29, 2026 at 8:00 AM');
  assert.equal(en.els['label-second'].textContent, 'Monday at 8:00 AM');
  assert.deepEqual(en.visibleDays().slice(0, 2).map((d) => [d.rel, d.wd, d.num, d.mon]), [
    ['Today', 'Wed', '28', 'Oct'],
    ['Tomorrow', 'Thu', '29', 'Oct']
  ]);
  assert.equal(en.visibleDays()[2].label, 'Monday, November 2');
  assert.equal(en.els.current.textContent, 'No scheduled send: the message goes out as soon as you click Send.');

  assert.equal(setup(t, NOW, 0, 'normal', {}).els['title-days'].textContent, 'Choisir un jour');
  assert.equal(setup(t, NOW, 0, 'normal', { lang: 'de-DE' }).els['title-days'].textContent, 'Choose a day');
});

test('task pane [en-US]: scheduling and removal with English messages', (t) => {
  const plain = setup(t, NOW, 0, 'normal', { lang: 'en-US' });
  plain.click('sug-first');
  plain.click('confirm');
  assert.equal(plain.els.result.textContent, 'Send scheduled — click Send again (Thursday, October 29, 2026 at 8:00 AM).');
  const ok = setup(t, NOW, FRIDAY_DELAY, 'normal', { lang: 'en-US' });
  assert.match(ok.els.current.textContent, /^Currently scheduled to send: Friday, October 30, 2026 at 8:00 AM\./);
  ok.click('remove');
  assert.equal(ok.els.result.textContent, 'Scheduling removed. The message goes out as soon as you click Send.');
  const ko = setup(t, NOW, FRIDAY_DELAY, 'throw', { lang: 'en-US' });
  ko.click('remove');
  assert.match(ko.els.result.textContent, /Delay Delivery/);
});

test('Outlook without Mailbox 1.13: error banner, no cards nor button', (t) => {
  const ctx = setup(t, NOW, 0, 'normal', { sets: ['1.12'] });
  assert.equal(ctx.els.unsupported.hidden, false);
  assert.equal(ctx.els.main.hidden, true);
  assert.equal(ctx.els.footer.hidden, true);
  assert.match(ctx.els['unsupported-text'].textContent, /Différer la remise/);
});

test('theme: dark/light officeTheme applied, absent or low-contrast -> fallback', (t) => {
  const dark = setup(t, NOW, 0, 'normal', {
    theme: { bodyBackgroundColor: '#1f1f1f', bodyForegroundColor: '#ffffff', controlBackgroundColor: '#2b2b2b' }
  });
  assert.equal(dark.doc.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(dark.doc.documentElement.style.props['--bg'], '#1f1f1f');
  assert.ok(dark.doc.documentElement.style.props['--hdr2'], 'derived header token');
  const light = setup(t, NOW, 0, 'normal', {
    theme: { bodyBackgroundColor: '#ffffff', bodyForegroundColor: '#242424', controlBackgroundColor: '#ffffff' }
  });
  assert.equal(light.doc.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(setup(t, NOW).doc.documentElement.getAttribute('data-theme'), null);
  const bad = setup(t, NOW, 0, 'normal', { theme: { bodyBackgroundColor: '#777777', bodyForegroundColor: '#808080' } });
  assert.equal(bad.doc.documentElement.getAttribute('data-theme'), null, 'insufficient contrast: default palette');
});

// ---------------------------------------------------------------- justified exceptional send

const bypassLib = require('../package/src/shared/bypass');

const BYPASS_ON = { enabled: true, minLength: 20, maxLength: 200, minWords: 3, minDistinctChars: 6 };
const GOOD_TEXT = 'Réponse urgente à un client bloqué.';
const HEADER = bypassLib.HEADER_NAME;

/** Task pane with exceptional send enabled and headers available; `extra` completes the options. */
function bypassPane(t, extra, delay, removeMode) {
  return setup(t, NOW, delay === undefined ? 0 : delay, removeMode, Object.assign({ bypass: BYPASS_ON, internetHeaders: true }, extra));
}

function typeText(ctx, text) {
  ctx.els['bypass-text'].value = text;
  ctx.els['bypass-text'].fire('input');
}

test('exceptional send: section hidden when disabled (default), without Mailbox 1.8, without internetHeaders or for an appointment', (t) => {
  assert.equal(setup(t, NOW, 0, 'normal', { internetHeaders: true }).els['bypass-section'].hidden, true, 'disabled by default');
  assert.equal(setup(t, NOW, 0, 'normal', { bypass: { enabled: false, minLength: 20, maxLength: 200, minWords: 3, minDistinctChars: 6 }, internetHeaders: true }).els['bypass-section'].hidden, true);
  assert.equal(setup(t, NOW, 0, 'normal', { bypass: BYPASS_ON }).els['bypass-section'].hidden, true, 'no item.internetHeaders');
  assert.equal(
    bypassPane(t, { sets: ['1.12', '1.13', '1.14', '1.15'] }).els['bypass-section'].hidden,
    true,
    'Mailbox 1.8 not declared'
  );
  assert.equal(bypassPane(t, { itemType: 'appointment' }).els['bypass-section'].hidden, true, 'appointment');
  const on = bypassPane(t);
  assert.equal(on.els['bypass-section'].hidden, false);
  assert.equal(on.els['bypass-panel'].hidden, true, 'collapsed section');
});

test('exceptional send: fr and en texts, live counter, open / close', (t) => {
  const fr = bypassPane(t);
  assert.equal(fr.els['bypass-title'].textContent, 'Envoi exceptionnel');
  assert.equal(fr.els['bypass-send'].textContent, 'Envoyer avec justification');
  assert.match(fr.els['bypass-intro'].textContent, /journalisée pour la conformité/);
  assert.match(fr.els['bypass-intro'].textContent, /refusé si vous n'y êtes pas autorisé/);
  assert.equal(fr.els['bypass-counter'].textContent, '0 / 200 caractères (minimum 20)');
  typeText(fr, '  Réponse   urgente\nclient ');
  assert.equal(fr.els['bypass-counter'].textContent, '22 / 200 caractères (minimum 20)', 'counts the cleaned justification');
  fr.click('bypass-toggle');
  assert.equal(fr.els['bypass-toggle'].getAttribute('aria-expanded'), 'true');
  assert.equal(fr.els['bypass-panel'].hidden, false);
  assert.equal(fr.els['bypass-text'].focused, 1);
  fr.click('bypass-toggle');
  assert.equal(fr.els['bypass-toggle'].getAttribute('aria-expanded'), 'false');
  assert.equal(fr.els['bypass-panel'].hidden, true);

  const en = bypassPane(t, { lang: 'en-US' });
  assert.equal(en.els['bypass-title'].textContent, 'Exceptional send');
  assert.equal(en.els['bypass-send'].textContent, 'Send with justification');
  assert.match(en.els['bypass-intro'].textContent, /logged for compliance/);
  assert.match(en.els['bypass-intro'].textContent, /rejected if you are not authorized/);
  assert.equal(en.els['bypass-counter'].textContent, '0 / 200 characters (minimum 20)');
});

test('exceptional send: live validation, message under the field, button disabled while the input is invalid', (t) => {
  const ctx = bypassPane(t, { sendAsync: () => {} });
  const err = ctx.els['bypass-error'];
  const box = ctx.els['bypass-text'];
  const send = ctx.els['bypass-send'];
  ctx.calls.order.length = 0;

  // Empty field: neutral instruction (not an error), button disabled.
  assert.equal(send.disabled, true);
  assert.equal(err.hidden, false);
  assert.equal(err.textContent, "Expliquez en quelques mots pourquoi l'envoi ne peut pas attendre (au moins 3 mots).");
  assert.equal(err.className, 'field-error info');
  assert.equal(box.getAttribute('aria-invalid'), 'false');

  const expectInvalid = (text, pattern, label) => {
    typeText(ctx, text);
    assert.match(err.textContent, pattern, label);
    assert.equal(err.className, 'field-error', label);
    assert.equal(err.hidden, false, label);
    assert.equal(send.disabled, true, label);
    assert.equal(box.getAttribute('aria-invalid'), 'true', label);
  };
  expectInvalid('.', /trop courte : 20 caractères minimum/, 'single dot');
  expectInvalid('Urgent', /trop courte : 20 caractères minimum/, 'too short');
  expectInvalid('x'.repeat(201), /trop longue : 200 caractères maximum/, 'too long');
  assert.equal(ctx.els['bypass-counter'].className, 'hint counter err');
  expectInvalid('aaaaaaaaaaaaaaaaaaaa', /plus de 4 fois de suite/, 'repeated character');
  expectInvalid('ok ok ok ok ok ok ok', /au moins 3 mots de 3 lettres ou plus/, 'words too short');
  expectInvalid('test test test test test', /semble répétitive/, 'few distinct letters');
  expectInvalid('1234 5678 9012 3456 7890', /au moins 3 mots/, 'digits only');
  typeText(ctx, '              \n \t      ');
  assert.match(err.textContent, /Expliquez en quelques mots/, 'spaces only = empty');
  assert.equal(send.disabled, true);
  assert.equal(err.className, 'field-error info', 'empty: back to the neutral instruction');
  assert.equal(box.getAttribute('aria-invalid'), 'false');

  // Valid input: message cleared, button enabled.
  typeText(ctx, 'Réponse urgente au client Durand');
  assert.equal(err.hidden, true);
  assert.equal(err.textContent, '');
  assert.equal(send.disabled, false);
  assert.equal(box.getAttribute('aria-invalid'), 'false');
  assert.equal(ctx.els['bypass-counter'].textContent, '32 / 200 caractères (minimum 20)');
  typeText(ctx, 'Réponse urgente');
  assert.equal(send.disabled, true, 'disabled again');

  // Defense in depth: even a forced click on a disabled button calls nothing.
  typeText(ctx, 'test test test test test');
  ctx.click('bypass-send');
  assert.equal(box.focused >= 1, true);
  assert.deepEqual(ctx.calls.order, [], 'no Office call (no delay, no header, no send)');
  assert.equal(ctx.calls.sendAsync, 0);
  assert.deepEqual(ctx.calls.headerSets, []);
});

test('exceptional send: validation messages in English', (t) => {
  const ctx = bypassPane(t, { lang: 'en-US' });
  const err = ctx.els['bypass-error'];
  assert.equal(err.textContent, 'Explain in a few words why this message cannot wait (at least 3 words).');
  typeText(ctx, 'Urgent');
  assert.equal(err.textContent, 'Justification too short: 20 characters minimum.');
  typeText(ctx, 'aaaaaaaaaaaaaaaaaaaa');
  assert.equal(err.textContent, 'Avoid repeating the same character more than 4 times in a row.');
  typeText(ctx, 'ok ok ok ok ok ok ok');
  assert.equal(err.textContent, 'Use at least 3 words of 3 letters or more to explain why this message cannot wait.');
  typeText(ctx, 'test test test test test');
  assert.equal(err.textContent, 'This justification looks repetitive: describe the situation in your own words.');
  typeText(ctx, 'x'.repeat(201));
  assert.equal(err.textContent, 'Justification too long: 200 characters maximum.');
  typeText(ctx, 'Urgent reply to a customer');
  assert.equal(err.hidden, true);
  assert.equal(ctx.els['bypass-send'].disabled, false);
});

test('exceptional send: thresholds coming from the configuration (length, words, distinct letters)', (t) => {
  const ctx = bypassPane(t, { bypass: { enabled: true, minLength: 30, maxLength: 40, minWords: 4, minDistinctChars: 8 } });
  assert.equal(ctx.els['bypass-counter'].textContent, '0 / 40 caractères (minimum 30)');
  assert.match(ctx.els['bypass-error'].textContent, /au moins 4 mots/);
  typeText(ctx, 'Panne reseau client chez nous');
  assert.match(ctx.els['bypass-error'].textContent, /30 caractères minimum/, '29 characters');
  typeText(ctx, 'Panne reseau chez le client Durand');
  assert.equal(ctx.els['bypass-error'].hidden, true, '5 words of 3 letters or more ("le" does not count)');
  assert.equal(ctx.els['bypass-send'].disabled, false);
  typeText(ctx, 'Panne reseau chez le client Durand ce soir !');
  assert.match(ctx.els['bypass-error'].textContent, /40 caractères maximum/);
  assert.equal(ctx.els['bypass-send'].disabled, true);
  const words = bypassPane(t, { bypass: { enabled: true, minLength: 20, maxLength: 200, minWords: 6, minDistinctChars: 6 } });
  typeText(words, 'Panne reseau chez le client Durand');
  assert.match(words.els['bypass-error'].textContent, /au moins 6 mots/);
  const strict = bypassPane(t, { bypass: { enabled: true, minLength: 20, maxLength: 200, minWords: 3, minDistinctChars: 15 } });
  typeText(strict, 'Panne reseau client!');
  assert.match(strict.els['bypass-error'].textContent, /semble répétitive/);
  const off = bypassPane(t, { bypass: { enabled: true, minLength: 20, maxLength: 200, minWords: 0, minDistinctChars: 0 } });
  typeText(off, 'ok ok ok ok ok ok ok');
  assert.equal(off.els['bypass-send'].disabled, false, '0 disables the checks');
  assert.deepEqual(ctx.calls.headerSets, []);
});

test('exceptional send: order clear the delay -> set the header -> read back -> sendAsync', (t) => {
  const ctx = bypassPane(t, { sendAsync: () => {} }, FRIDAY_DELAY);
  assert.match(ctx.els.current.textContent, /vendredi 30 octobre 2026/, 'delay on a forbidden day initially');
  ctx.calls.order.length = 0;
  ctx.calls.setAsync.length = 0;
  typeText(ctx, GOOD_TEXT);
  ctx.click('bypass-send');
  assert.deepEqual(ctx.calls.order, ['setAsync', 'getAsync', 'hdrSet', 'hdrGet', 'sendAsync']);
  assert.equal(ctx.calls.setAsync.length, 1);
  assert.equal(ctx.calls.setAsync[0].getTime(), 0, 'delay cleared by Date(0)');
  assert.deepEqual(ctx.calls.headerSets, [{ [HEADER]: 'v1; R%C3%A9ponse urgente %C3%A0 un client bloqu%C3%A9.' }]);
  assert.equal(ctx.calls.sendAsync, 1);
  assert.equal(ctx.calls.order[ctx.calls.order.length - 1], 'sendAsync', 'nothing after sendAsync');
  assert.equal(ctx.els.result.textContent, 'Justification enregistrée, envoi en cours…');
  assert.match(status(ctx), /\bbusy\b/);
  assert.equal(ctx.els.current.hidden, true, 'the delay badge disappears');
  assert.match(ctx.els['bypass-saved-text'].textContent, /Justification enregistrée : « Réponse urgente à un client bloqué\. »/);
  assert.equal(ctx.els['bypass-saved'].hidden, false);
});

test('exceptional send: without Mailbox 1.15, prompts to click Send (no sendAsync)', (t) => {
  const noSet = bypassPane(t, { sets: ['1.8', '1.12', '1.13', '1.14'], sendAsync: () => {} });
  typeText(noSet, GOOD_TEXT);
  noSet.click('bypass-send');
  assert.equal(noSet.calls.sendAsync, 0);
  assert.equal(noSet.calls.headerSets.length, 1);
  assert.match(noSet.els.result.textContent, /^Justification enregistrée — cliquez sur Envoyer\./);
  assert.match(noSet.els.result.textContent, /refusé si vous n'y êtes pas autorisé/);
  assert.match(status(noSet), /\bsuccess\b/);
  assert.equal(noSet.els['bypass-send'].disabled, false, 'usable again');
  const noFn = bypassPane(t);
  typeText(noFn, GOOD_TEXT);
  noFn.click('bypass-send');
  assert.equal(noFn.calls.sendAsync, 0);
  assert.match(noFn.els.result.textContent, /cliquez sur Envoyer/);
  const en = bypassPane(t, { lang: 'en-US' });
  typeText(en, 'Urgent reply to a customer');
  en.click('bypass-send');
  assert.equal(en.els.result.textContent, 'Justification saved — click Send. The message will be rejected if you are not authorized.');
});

test('exceptional send: never a send when a step fails', (t) => {
  const send = () => {};
  // 1. clearing the delay: asynchronous failure
  const delayFail = bypassPane(t, { sendAsync: send }, FRIDAY_DELAY);
  Office.context.mailbox.item.delayDeliveryTime.setAsync = (date, cb) => cb({ status: 'failed', error: { message: 'x' } });
  typeText(delayFail, GOOD_TEXT);
  delayFail.click('bypass-send');
  assert.equal(delayFail.els.result.textContent, config.strings.tpBypassDelayFailed);
  assert.deepEqual(delayFail.calls.headerSets, []);
  assert.equal(delayFail.calls.sendAsync, 0);
  assert.equal(delayFail.els['bypass-send'].disabled, false);
  assert.match(status(delayFail), /\berror\b/);

  // 1b. clearing the delay: synchronous exception
  const delayThrow = bypassPane(t, { sendAsync: send }, FRIDAY_DELAY, 'throw');
  typeText(delayThrow, GOOD_TEXT);
  delayThrow.click('bypass-send');
  assert.match(delayThrow.els.result.textContent, /boom/);
  assert.deepEqual(delayThrow.calls.headerSets, []);
  assert.equal(delayThrow.calls.sendAsync, 0);

  // 2. delay still in the future after Date(0)
  const stillDelayed = bypassPane(t, { sendAsync: send }, FRIDAY_DELAY, 'noop');
  typeText(stillDelayed, GOOD_TEXT);
  stillDelayed.click('bypass-send');
  assert.equal(stillDelayed.els.result.textContent, config.strings.tpBypassDelayFailed);
  assert.deepEqual(stillDelayed.calls.headerSets, []);
  assert.equal(stillDelayed.calls.sendAsync, 0);

  // 3. setting the header: asynchronous failure
  const setFail = bypassPane(t, {
    sendAsync: send,
    internetHeaders: { set: (obj, cb) => cb({ status: 'failed', error: { message: 'En-tête refusé' } }) }
  });
  typeText(setFail, GOOD_TEXT);
  setFail.click('bypass-send');
  assert.match(setFail.els.result.textContent, /n'a pas pu être enregistrée : En-tête refusé\. Le message n'a pas été envoyé/);
  assert.equal(setFail.calls.sendAsync, 0);
  assert.equal(setFail.els['bypass-send'].disabled, false);

  // 3b. setting the header: synchronous exception
  const setThrow = bypassPane(t, { sendAsync: send, internetHeaders: { set: () => { throw new Error('Sys.Boom'); } } });
  typeText(setThrow, GOOD_TEXT);
  setThrow.click('bypass-send');
  assert.match(setThrow.els.result.textContent, /Sys\.Boom/);
  assert.equal(setThrow.calls.sendAsync, 0);

  // 4. verification: failing read, absent or different header
  const getFail = bypassPane(t, { sendAsync: send, internetHeaders: { get: (n, cb) => cb({ status: 'failed', error: { message: 'x' } }) } });
  typeText(getFail, GOOD_TEXT);
  getFail.click('bypass-send');
  assert.equal(getFail.els.result.textContent, config.strings.tpBypassVerifyFailed);
  assert.equal(getFail.calls.sendAsync, 0);
  const absent = bypassPane(t, { sendAsync: send, internetHeaders: { set: (obj, cb) => cb({ status: 'succeeded' }) } });
  typeText(absent, GOOD_TEXT);
  absent.click('bypass-send');
  assert.equal(absent.els.result.textContent, config.strings.tpBypassVerifyFailed);
  assert.equal(absent.calls.sendAsync, 0);
  const other = bypassPane(t, {
    sendAsync: send,
    internetHeaders: { get: (n, cb) => cb({ status: 'succeeded', value: { [HEADER]: 'v1; autre chose' } }) }
  });
  typeText(other, GOOD_TEXT);
  other.click('bypass-send');
  assert.equal(other.els.result.textContent, config.strings.tpBypassVerifyFailed);
  assert.equal(other.calls.sendAsync, 0);
  const noValue = bypassPane(t, { sendAsync: send, internetHeaders: { get: (n, cb) => cb({ status: 'succeeded' }) } });
  typeText(noValue, GOOD_TEXT);
  noValue.click('bypass-send');
  assert.equal(noValue.els.result.textContent, config.strings.tpBypassVerifyFailed);
  assert.equal(noValue.calls.sendAsync, 0);
});

test('exceptional send: sendAsync failing (asynchronous or exception): dedicated message, header kept', (t) => {
  const failed = bypassPane(t, { sendAsync: (cb) => cb({ status: 'failed', error: { message: 'Envoi refusé' } }) });
  typeText(failed, GOOD_TEXT);
  failed.click('bypass-send');
  assert.equal(failed.calls.sendAsync, 1);
  assert.match(failed.els.result.textContent, /Envoi refusé/);
  assert.match(failed.els.result.textContent, /La justification est enregistrée : cliquez sur Envoyer/);
  assert.match(status(failed), /\berror\b/);
  assert.doesNotMatch(status(failed), /\bbusy\b/);
  assert.equal(failed.els['bypass-send'].disabled, false);
  assert.equal(failed.els['bypass-text'].disabled, false);
  const thrown = bypassPane(t, { sendAsync: () => { throw new Error('Sys.InvalidOperation'); } });
  typeText(thrown, GOOD_TEXT);
  thrown.click('bypass-send');
  assert.match(thrown.els.result.textContent, /Sys\.InvalidOperation/);
  assert.equal(thrown.els['bypass-send'].disabled, false);
});

test('exceptional send: double click during the send ignored (button and field disabled)', (t) => {
  const ctx = bypassPane(t, { sendAsync: () => {} });
  typeText(ctx, GOOD_TEXT);
  ctx.click('bypass-send');
  assert.equal(ctx.els['bypass-send'].disabled, true);
  assert.equal(ctx.els['bypass-text'].disabled, true);
  ctx.click('bypass-send');
  assert.equal(ctx.calls.sendAsync, 1);
  assert.equal(ctx.calls.headerSets.length, 1);
});

test('exceptional send: single-line ASCII header value, read back case-insensitively by name', (t) => {
  const ctx = bypassPane(t, {
    sets: ['1.8', '1.12', '1.13', '1.14'],
    internetHeaders: {
      // Exchange may return the name in another case.
      get: (n, cb, calls) => cb({ status: 'succeeded', value: { 'x-nofriday-bypass': calls.headers[HEADER] } })
    }
  });
  typeText(ctx, 'Réponse;\n100% urgente client – €');
  ctx.click('bypass-send');
  const value = ctx.calls.headerSets[0][HEADER];
  assert.match(value, /^v1; [\x20-\x7e]+$/, 'printable ASCII, a single line');
  assert.equal(value.includes(';', 3), false, 'no ";" in the justification');
  assert.equal(bypassLib.decodeHeaderValue(value), 'Réponse; 100% urgente client – €');
  assert.match(ctx.els.result.textContent, /^Justification enregistrée — cliquez/);
});

test('exceptional send: pane reopened with a valid header -> "saved" state, removal possible', (t) => {
  const initial = { [HEADER]: bypassLib.buildHeaderValue('Réponse urgente client') };
  const ctx = bypassPane(t, { internetHeaders: { initial } });
  assert.equal(ctx.els['bypass-saved'].hidden, false);
  assert.equal(ctx.els['bypass-saved-text'].textContent, 'Justification enregistrée : « Réponse urgente client »');
  assert.equal(ctx.els['bypass-remove'].textContent, 'Retirer la justification');
  ctx.calls.order.length = 0;
  ctx.click('bypass-remove');
  assert.deepEqual(ctx.calls.headerRemoves, [[HEADER]]);
  assert.equal(ctx.calls.headers[HEADER], undefined);
  assert.equal(ctx.els['bypass-saved'].hidden, true);
  assert.equal(ctx.els.result.textContent, 'Justification retirée.');
  assert.match(status(ctx), /\bsuccess\b/);
  assert.equal(ctx.calls.sendAsync, 0, 'removing never triggers a send');

  const absent = bypassPane(t);
  assert.equal(absent.els['bypass-saved'].hidden, true, 'no header: no saved state');
  const garbage = bypassPane(t, { internetHeaders: { initial: { [HEADER]: 'v2; x' } } });
  assert.equal(garbage.els['bypass-saved'].hidden, true, 'malformed header ignored');
  const readFail = bypassPane(t, { internetHeaders: { get: (n, cb) => cb({ status: 'failed', error: { message: 'x' } }) } });
  assert.equal(readFail.els['bypass-saved'].hidden, true);
  assert.equal(readFail.els['bypass-section'].hidden, false, 'the section stays usable');
});

test('exceptional send: removal impossible (failure or exception): error message, justification kept', (t) => {
  const initial = { [HEADER]: bypassLib.buildHeaderValue('Réponse urgente client') };
  const failed = bypassPane(t, { internetHeaders: { initial, remove: (n, cb) => cb({ status: 'failed', error: { message: 'Refusé' } }) } });
  failed.click('bypass-remove');
  assert.equal(failed.els.result.textContent, 'La justification n\'a pas pu être retirée : Refusé');
  assert.equal(failed.els['bypass-saved'].hidden, false);
  assert.match(status(failed), /\berror\b/);
  const thrown = bypassPane(t, { internetHeaders: { initial, remove: () => { throw new Error('Sys.Boom'); } } });
  thrown.click('bypass-remove');
  assert.match(thrown.els.result.textContent, /Sys\.Boom/);
  assert.equal(thrown.els['bypass-saved'].hidden, false);
});

test('exceptional send: does not affect the existing scheduling flow', (t) => {
  const ctx = bypassPane(t, { sendAsync: () => {} });
  ctx.calls.order.length = 0;
  ctx.pick(2, 1);
  ctx.click('confirm');
  assert.deepEqual(ctx.calls.order.slice(0, 3), ['setAsync', 'getAsync', 'sendAsync']);
  assert.equal(ctx.calls.headerSets.length, 0, 'scheduling never sets the header');
});

// ---------------------------------------------------------------- MFA step: Entra identity + API receipt

const naaModule = require('../package/src/taskpane/naa');

const MFA_BYPASS = {
  enabled: true,
  minLength: 20,
  maxLength: 200,
  minWords: 3,
  minDistinctChars: 6,
  mfa: { required: true, tenantId: '11111111-2222-4333-8444-555555555555', clientId: '99999999-2222-4333-8444-555555555555', authContext: 'c1' }
};
const SCOPE = `api://${MFA_BYPASS.mfa.clientId}/access_as_user`;
const ACRS_C1 = '{"access_token":{"acrs":{"essential":true,"value":"c1"}}}';
const V2_TEXT = 'Réponse urgente au client Durand';
const RECEIPT_OK = `abcDEF123456.${Math.floor(NOW.getTime() / 1000)}.QWERTYuiopASDFghjklZXC`;

const settle = async () => {
  for (let i = 0; i < 12; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const popupBlocked = () => Object.assign(new Error('popup_window_error: Error opening popup window'), { errorCode: 'popup_window_error', name: 'BrowserAuthError' });
const cancelled = () => Object.assign(new Error('User cancelled the flow'), { errorCode: 'user_cancelled' });

/**
 * Fake MSAL factory. script = { popup(request), silent(request), factoryError, factoryPending }; calls: log.
 * `order` receives 'silent' / 'popup' / 'factory' (global order with the Office and fetch calls).
 */
function fakeNaa(script, order) {
  const calls = { factory: [], silent: [], popup: [] };
  const mark = (name) => { if (order) order.push(name); };
  const client = {
    acquireTokenSilent: (request) => { calls.silent.push(request); mark('silent'); return script.silent ? script.silent(request) : Promise.resolve({ accessToken: 'token-silent' }); },
    acquireTokenPopup: (request) => { calls.popup.push(request); mark('popup'); return script.popup ? script.popup(request) : Promise.resolve({ accessToken: 'token-popup' }); }
  };
  const factory = (config) => {
    calls.factory.push(config);
    if (script.factoryPending) return new Promise(() => {});
    return script.factoryError ? Promise.reject(script.factoryError) : Promise.resolve(client);
  };
  return { factory, calls };
}

/** Simulated HTTP response of the site API. */
function apiResponse(status, body, headers) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => (body === undefined ? Promise.reject(new Error('pas de JSON')) : Promise.resolve(body)),
    headers: { get: (name) => (headers && headers[name.toLowerCase()]) || null }
  };
}

const challenge = (claims) => ({
  'www-authenticate': `Bearer realm="nofridaymail", error="insufficient_claims", claims="${Buffer.from(claims).toString('base64')}"`
});

/**
 * Task pane in MFA mode, returned AFTER MSAL initialization (client ready before the click, as in production).
 * `api`: sequence of responses for fetch; `naaScript`: MSAL script; extra: setup options.
 * ctx.warns: output of any console method; ctx.naa.calls: MSAL calls; ctx.fetchCalls: API calls.
 */
async function mfaPane(t, naaScript, apiResponses, extra) {
  const order = [];
  const naa = fakeNaa(naaScript || {}, order);
  const fetchCalls = [];
  const queue = Array.isArray(apiResponses) ? apiResponses.slice() : [apiResponse(200, { receipt: RECEIPT_OK, ts: 1 })];
  const originalFetch = global.fetch;
  global.fetch = (url, init) => {
    fetchCalls.push({ url, init });
    order.push('fetch');
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return typeof next === 'function' ? next() : Promise.resolve(next);
  };
  // Every console method is captured (not only warn): the pane must stay silent during the MFA flow.
  const warns = [];
  const consoleMethods = ['log', 'info', 'debug', 'warn', 'error', 'trace'];
  const originalConsole = {};
  consoleMethods.forEach((name) => {
    originalConsole[name] = console[name];
    console[name] = (...args) => {
      const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      // Node itself may print runtime warnings through console.error (e.g. "ExperimentalWarning: The MockTimers
      // API is an experimental feature" on Node 22): they do not come from the task pane.
      if (/^\(node:\d+\) \w*Warning:/.test(text)) return;
      warns.push(text);
    };
  });
  t.after(() => {
    global.fetch = originalFetch;
    consoleMethods.forEach((name) => { console[name] = originalConsole[name]; });
    naaModule.setFactory(null);
  });
  const ctx = setup(t, NOW, 0, 'normal', Object.assign({ bypass: MFA_BYPASS, internetHeaders: true, naa, sendAsync: () => {} }, extra));
  // Task pane and MSAL calls share the same order log.
  const paneOrder = ctx.calls.order;
  order.push = (name) => { paneOrder.push(name); return paneOrder.length; };
  await settle(); // naa.init (client creation) completes BEFORE any click
  return Object.assign(ctx, { naa, fetchCalls, warns });
}

const writeMfa = (ctx, text = V2_TEXT) => typeText(ctx, text);

test('mfa: version 1 is never offered (labels, v2 header only); no console output', async (t) => {
  const ctx = await mfaPane(t);
  assert.equal(ctx.els['bypass-section'].hidden, false);
  assert.equal(ctx.els['bypass-send'].textContent, 'Valider mon identité et envoyer');
  assert.match(ctx.els['bypass-intro'].textContent, /validez votre identité \(authentification multifacteur\)/);
  assert.match(ctx.els['bypass-intro'].textContent, /refusé si vous n'y êtes pas autorisé/);
  assert.equal(ctx.els['bypass-form'].hidden, false);
  assert.equal(ctx.els['bypass-unsupported'].hidden, true);
  assert.equal(ctx.els['bypass-retry'].hidden, true);
  // The mode (NAA / browser) is neither displayed nor logged.
  assert.deepEqual(ctx.warns, [], 'no console output');
  assert.equal(ctx.els['bypass-diag'], undefined, 'no diagnostic element in the page');
  writeMfa(ctx);
  ctx.click('bypass-send');
  await settle();
  assert.equal(ctx.calls.headerSets.length, 1);
  assert.match(ctx.calls.headerSets[0][HEADER], /^v2; /);
  const en = await mfaPane(t, {}, undefined, { lang: 'en-US' });
  assert.equal(en.els['bypass-send'].textContent, 'Confirm my identity and send');
  assert.match(en.els['bypass-intro'].textContent, /confirm your identity \(multi-factor authentication\)/);
  assert.equal(config.languages.fr.tpBypassMode, undefined, 'no more "Mode:" text in the interface');
  assert.equal(config.languages.en.tpBypassMode, undefined);
});

test('mfa: without Nested App Authentication 1.1 -> message, "browser" mode, no button nor MSAL client', async (t) => {
  const ctx = await mfaPane(t, {}, undefined, { sets: ['1.8', '1.12', '1.13', '1.14', '1.15'] });
  assert.equal(ctx.els['bypass-section'].hidden, false);
  assert.equal(ctx.els['bypass-unsupported'].textContent, "Votre version d'Outlook ne permet pas l'envoi exceptionnel.");
  assert.equal(ctx.els['bypass-unsupported'].hidden, false);
  assert.equal(ctx.els['bypass-form'].hidden, true, 'no field nor button');
  assert.equal(ctx.els['bypass-intro'].hidden, true);
  assert.deepEqual(ctx.warns, [], 'no console output');
  assert.deepEqual(ctx.els['bypass-send'].listeners.click || [], [], 'no handler on the button');
  ctx.click('bypass-send');
  await settle();
  assert.deepEqual(ctx.naa.calls.popup, []);
  assert.deepEqual(ctx.naa.calls.factory, [], 'MSAL is not initialized without NAA');
  assert.equal(ctx.fetchCalls.length, 0);
  assert.equal(ctx.calls.sendAsync, 0);
  const en = await mfaPane(t, {}, undefined, { sets: ['1.8', '1.12', '1.13'], lang: 'en-US' });
  assert.equal(en.els['bypass-unsupported'].textContent, 'Your version of Outlook does not support exceptional send.');
});

test('mfa: MSAL is created and initialized BEFORE the click (once, cached Promise)', async (t) => {
  const ctx = await mfaPane(t);
  assert.equal(ctx.naa.calls.factory.length, 1, 'created when the pane opens');
  assert.deepEqual(ctx.naa.calls.factory[0], {
    auth: { clientId: MFA_BYPASS.mfa.clientId, authority: `https://login.microsoftonline.com/${MFA_BYPASS.mfa.tenantId}` }
  });
  assert.equal(naaModule.status(MFA_BYPASS.mfa), 'ready');
  writeMfa(ctx);
  ctx.click('bypass-send');
  await settle();
  assert.equal(ctx.naa.calls.factory.length, 1, 'the click does not recreate the client');
});

test('mfa: the click opens the window FIRST (synchronous acquireTokenPopup, no silent call, nothing awaited before)', async (t) => {
  const ctx = await mfaPane(t);
  ctx.calls.order.length = 0;
  writeMfa(ctx);
  ctx.click('bypass-send');
  // Immediately after the click, without any wait: the window is already requested and NOTHING else has been called.
  assert.deepEqual(ctx.calls.order, ['popup'], 'no Office, header, delay nor fetch before the window');
  assert.deepEqual(ctx.naa.calls.popup, [{ scopes: [SCOPE], claims: ACRS_C1 }]);
  assert.deepEqual(ctx.naa.calls.silent, [], 'never a silent token with claims (MFA every time)');
  assert.equal(ctx.els.result.textContent, 'Vérification de votre identité…');
  assert.match(status(ctx), /\bbusy\b/);
  assert.equal(ctx.els['bypass-send'].disabled, true);
  await settle();
  assert.deepEqual(ctx.calls.order, ['popup', 'fetch', 'setAsync', 'getAsync', 'hdrSet', 'hdrGet', 'sendAsync']);
  assert.deepEqual(ctx.naa.calls.silent, []);
});

test('mfa: nominal flow - receipt, then delay cleared -> v2 header -> read back -> sendAsync', async (t) => {
  const ctx = await mfaPane(t);
  writeMfa(ctx);
  ctx.click('bypass-send');
  await settle();
  assert.equal(ctx.fetchCalls.length, 1);
  assert.equal(ctx.fetchCalls[0].url, '/api/bypass');
  assert.equal(ctx.fetchCalls[0].init.method, 'POST');
  assert.equal(ctx.fetchCalls[0].init.headers['X-NFM-Token'], 'Bearer token-popup');
  assert.equal(ctx.fetchCalls[0].init.headers.Authorization, undefined, 'Static Web Apps replaces Authorization: never used');
  assert.equal(ctx.fetchCalls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(ctx.fetchCalls[0].init.body), { justification: V2_TEXT });
  assert.deepEqual(ctx.calls.headerSets, [{ [HEADER]: `v2; R%C3%A9ponse urgente au client Durand; r=${RECEIPT_OK}` }]);
  assert.equal(ctx.calls.setAsync[ctx.calls.setAsync.length - 1].getTime(), 0, 'delay cleared');
  assert.equal(ctx.calls.sendAsync, 1);
  assert.equal(ctx.els.result.textContent, 'Identité vérifiée, envoi…');
  assert.match(ctx.els['bypass-saved-text'].textContent, /Réponse urgente au client Durand/);
});

test('mfa: client not ready at click time -> "Preparation..." message, no call, button reusable', async (t) => {
  const pending = await mfaPane(t, { factoryPending: true });
  assert.equal(naaModule.status(MFA_BYPASS.mfa), 'pending');
  pending.calls.order.length = 0;
  writeMfa(pending);
  pending.click('bypass-send');
  assert.equal(pending.els.result.textContent, 'Préparation de la vérification… réessayez dans un instant.');
  assert.match(status(pending), /\berror\b/);
  assert.doesNotMatch(status(pending), /\bbusy\b/);
  await settle();
  assert.deepEqual(pending.naa.calls.popup, []);
  assert.equal(pending.fetchCalls.length, 0);
  assert.deepEqual(pending.calls.order, []);
  assert.equal(pending.els['bypass-send'].disabled, false);
  assert.equal(pending.naa.calls.factory.length, 1, 'no new creation while waiting');

  const en = await mfaPane(t, { factoryPending: true }, undefined, { lang: 'en-US' });
  writeMfa(en);
  en.click('bypass-send');
  assert.equal(en.els.result.textContent, 'Preparing the verification… try again in a moment.');

  // failed initialization: the detail is displayed, the next click restarts the creation
  const failed = await mfaPane(t, { factoryError: new Error('NAA indisponible') });
  assert.equal(naaModule.status(MFA_BYPASS.mfa), 'failed');
  writeMfa(failed);
  failed.click('bypass-send');
  assert.match(failed.els.result.textContent, /a échoué \(NAA indisponible\)/);
  assert.equal(failed.naa.calls.factory.length, 2, 'new initialization attempt for the next click');
  assert.equal(failed.calls.sendAsync, 0);
  assert.deepEqual(failed.naa.calls.popup, []);
});

test('mfa: window errors -> localized messages (blocked, cancelled, other)', async (t) => {
  const BLOCKED_FR = "La fenêtre de vérification d'identité a été bloquée. Autorisez les fenêtres contextuelles pour Outlook dans votre navigateur, puis réessayez.";
  const cases = [
    [popupBlocked(), BLOCKED_FR, 'popup_window_error'],
    [Object.assign(new Error('x'), { errorCode: 'empty_window_error' }), BLOCKED_FR, 'empty_window_error'],
    [Object.assign(new Error('x'), { errorCode: 'popup_blocked' }), BLOCKED_FR, 'popup_blocked'],
    [new Error('BrowserAuthError: popup_window_error - Error opening popup window'), BLOCKED_FR, 'no code, message only'],
    [cancelled(), "Vérification annulée. Le message n'a pas été envoyé.", 'user_cancelled'],
    [Object.assign(new Error('x'), { errorCode: 'authority_mismatch', errorMessage: 'Autorité inattendue' }), "La validation de votre identité a échoué (Autorité inattendue). Le message n'a pas été envoyé.", 'other']
  ];
  for (const [error, expected, label] of cases) {
    const ctx = await mfaPane(t, { popup: () => Promise.reject(error) });
    ctx.calls.order.length = 0;
    writeMfa(ctx);
    ctx.click('bypass-send');
    await settle();
    assert.equal(ctx.els.result.textContent, expected, label);
    assert.match(status(ctx), /\berror\b/);
    assert.doesNotMatch(status(ctx), /\bbusy\b/);
    assert.equal(ctx.fetchCalls.length, 0);
    assert.deepEqual(ctx.calls.order.filter((n) => n !== 'popup'), [], 'no delay, header nor send');
    assert.deepEqual(ctx.naa.calls.silent, [], 'no silent fallback');
    assert.equal(ctx.els['bypass-send'].disabled, false, 'retryable');
    assert.equal(ctx.els['bypass-text'].disabled, false);
  }
  const en = await mfaPane(t, { popup: () => Promise.reject(popupBlocked()) }, undefined, { lang: 'en-US' });
  writeMfa(en);
  en.click('bypass-send');
  await settle();
  assert.equal(en.els.result.textContent, 'The identity verification pop-up was blocked. Allow pop-ups for Outlook in your browser, then try again.');
  const enCancel = await mfaPane(t, { popup: () => Promise.reject(cancelled()) }, undefined, { lang: 'en-US' });
  writeMfa(enCancel);
  enCancel.click('bypass-send');
  await settle();
  assert.equal(enCancel.els.result.textContent, 'Verification cancelled. The message was not sent.');
  const emptyToken = await mfaPane(t, { popup: () => Promise.resolve({}) });
  writeMfa(emptyToken);
  emptyToken.click('bypass-send');
  await settle();
  assert.equal(emptyToken.fetchCalls.length, 0);
  assert.match(emptyToken.els.result.textContent, /a échoué/);
});

test('mfa: 401 insufficient_claims -> retry button (new click, new window), never an automatic new window', async (t) => {
  const claims = '{"access_token":{"acrs":{"essential":true,"value":"c2"}}}';
  const ctx = await mfaPane(t, {}, [
    apiResponse(401, { error: 'insufficient_claims' }, challenge(claims)),
    apiResponse(200, { receipt: RECEIPT_OK, ts: 1 })
  ]);
  writeMfa(ctx);
  ctx.click('bypass-send');
  await settle();
  assert.equal(ctx.naa.calls.popup.length, 1, 'no second window without a click');
  assert.equal(ctx.fetchCalls.length, 1);
  assert.equal(ctx.els.result.textContent, 'Une nouvelle vérification est nécessaire : cliquez sur « Réessayer la vérification ».');
  assert.equal(ctx.els['bypass-retry'].hidden, false);
  assert.equal(ctx.els['bypass-retry'].textContent, 'Réessayer la vérification');
  assert.equal(ctx.calls.sendAsync, 0);
  assert.equal(ctx.calls.headerSets.length, 0);
  assert.equal(ctx.els['bypass-send'].disabled, false);
  // new click: window opened immediately with the challenge claims
  ctx.calls.order.length = 0;
  ctx.click('bypass-retry');
  assert.deepEqual(ctx.calls.order, ['popup'], 'window opened synchronously in the click');
  assert.equal(ctx.els['bypass-retry'].hidden, true);
  assert.deepEqual(ctx.naa.calls.popup[1], { scopes: [SCOPE], claims });
  assert.deepEqual(ctx.naa.calls.silent, []);
  await settle();
  assert.equal(ctx.fetchCalls.length, 2);
  assert.equal(ctx.calls.sendAsync, 1);
  assert.match(ctx.calls.headerSets[0][HEADER], /^v2; /);

  // second challenge after the retry: stop (message, no button)
  const loop = await mfaPane(t, {}, [apiResponse(401, { error: 'insufficient_claims' }, challenge(claims))]);
  writeMfa(loop);
  loop.click('bypass-send');
  await settle();
  assert.equal(loop.els['bypass-retry'].hidden, false);
  loop.click('bypass-retry');
  await settle();
  assert.equal(loop.naa.calls.popup.length, 2);
  assert.equal(loop.els['bypass-retry'].hidden, true, 'only one retry offered');
  assert.equal(loop.els.result.textContent, "Votre identité n'a pas pu être validée (authentification multifacteur requise) : le message n'a pas été envoyé.");
  assert.equal(loop.calls.sendAsync, 0);

  // the button is reserved for a usable challenge; in English
  const en = await mfaPane(t, {}, [apiResponse(401, { error: 'insufficient_claims' }, challenge(claims))], { lang: 'en-US' });
  writeMfa(en);
  en.click('bypass-send');
  await settle();
  assert.equal(en.els.result.textContent, 'A new verification is required: click "Retry verification".');
  assert.equal(en.els['bypass-retry'].textContent, 'Retry verification');
});

test('mfa: 401 by reason - a rejected token does not invoke MFA; insufficient_claims without a usable challenge stops', async (t) => {
  const TOKEN_REJECTED = "Jeton refusé par le serveur (diagnostic dans le journal de l'API). Le message n'a pas été envoyé.";
  const MFA_MESSAGE = "Votre identité n'a pas pu être validée (authentification multifacteur requise) : le message n'a pas été envoyé.";
  const cases = [
    [apiResponse(401, { error: 'invalid_token' }), TOKEN_REJECTED],
    [apiResponse(401, { error: 'invalid_token' }, { 'www-authenticate': 'Bearer error="invalid_token"' }), TOKEN_REJECTED],
    [apiResponse(401, undefined), TOKEN_REJECTED],
    [apiResponse(401, { error: 'insufficient_claims' }), MFA_MESSAGE],
    [apiResponse(401, { error: 'insufficient_claims' }, { 'www-authenticate': 'Bearer error="insufficient_claims", claims="@@@"' }), MFA_MESSAGE],
    [apiResponse(401, { error: 'insufficient_claims' }, { 'www-authenticate': `Bearer error="insufficient_claims", claims="${Buffer.from('pas du json').toString('base64')}"` }), MFA_MESSAGE]
  ];
  for (const [response, expected] of cases) {
    const ctx = await mfaPane(t, {}, [response]);
    writeMfa(ctx);
    ctx.click('bypass-send');
    await settle();
    assert.equal(ctx.els.result.textContent, expected);
    assert.equal(ctx.els['bypass-retry'].hidden, true, 'no button without a usable challenge');
    assert.equal(ctx.naa.calls.popup.length, 1);
    assert.equal(ctx.fetchCalls.length, 1);
    assert.equal(ctx.calls.sendAsync, 0);
  }
  assert.doesNotMatch(TOKEN_REJECTED, /multifacteur/);
  const en = await mfaPane(t, {}, [apiResponse(401, { error: 'invalid_token' })], { lang: 'en-US' });
  writeMfa(en);
  en.click('bypass-send');
  await settle();
  assert.equal(en.els.result.textContent, 'Token rejected by the server (diagnostic in the API log). The message was not sent.');
});

test('mfa: API errors (400 with reason, 5xx, network, invalid receipt) -> localized message, never a send', async (t) => {
  const failures = [
    [[apiResponse(400, { error: 'invalid_justification', code: 'words' })], /Justification refusée par le service : Utilisez au moins 3 mots/],
    [[apiResponse(400, { error: 'invalid_justification', code: 'short' })], /Justification refusée par le service : Justification trop courte : 20 caractères minimum/],
    [[apiResponse(400, { error: 'invalid_justification', code: 'repeat' })], /plus de 4 fois de suite/],
    [[apiResponse(400, { error: 'invalid_request' })], /erreur \(400\)/],
    [[apiResponse(400, { error: 'invalid_justification', code: 'inconnu' })], /erreur \(400\)/],
    [[apiResponse(500, { error: 'server_misconfigured' })], /Le service de justification a répondu par une erreur \(500\)/],
    [[apiResponse(503, undefined)], /erreur \(503\)/],
    [[apiResponse(502, 'pas un objet')], /erreur \(502\)/],
    [[() => Promise.reject(new TypeError('Failed to fetch'))], /injoignable : vérifiez votre connexion/],
    [[apiResponse(200, { receipt: 'pas-un-reçu' })], /erreur \(200\)/],
    [[apiResponse(200, {})], /erreur \(200\)/]
  ];
  for (const [responses, pattern] of failures) {
    const ctx = await mfaPane(t, {}, responses);
    ctx.calls.order.length = 0;
    writeMfa(ctx);
    ctx.click('bypass-send');
    await settle();
    assert.match(ctx.els.result.textContent, pattern);
    assert.match(status(ctx), /\berror\b/);
    assert.equal(ctx.fetchCalls.length, 1);
    assert.equal(ctx.calls.sendAsync, 0, 'never a send');
    assert.equal(ctx.calls.headerSets.length, 0, 'no header set');
    assert.deepEqual(ctx.calls.order.filter((n) => ['setAsync', 'getAsync', 'hdrSet', 'hdrGet', 'sendAsync'].includes(n)), [], 'the message is not modified');
    assert.equal(ctx.els['bypass-send'].disabled, false);
  }
  const en = await mfaPane(t, {}, [apiResponse(500, {})], { lang: 'en-US' });
  writeMfa(en);
  en.click('bypass-send');
  await settle();
  assert.equal(en.els.result.textContent, 'The justification service returned an error (500). The message was not sent.');
  const net = await mfaPane(t, {}, [() => Promise.reject(new TypeError('x'))], { lang: 'en-US' });
  writeMfa(net);
  net.click('bypass-send');
  await settle();
  assert.equal(net.els.result.textContent, 'The justification service is unreachable: check your connection. The message was not sent.');
});

test('mfa: without Mailbox 1.15, v2 header set then "cliquez sur Envoyer"', async (t) => {
  const ctx = await mfaPane(t, {}, undefined, { sets: ['1.1', '1.8', '1.12', '1.13', '1.14'] });
  writeMfa(ctx);
  ctx.click('bypass-send');
  await settle();
  assert.equal(ctx.calls.sendAsync, 0);
  assert.match(ctx.calls.headerSets[0][HEADER], /^v2; .*; r=abcDEF123456\./);
  assert.match(ctx.els.result.textContent, /^Identité vérifiée, justification enregistrée — cliquez sur Envoyer\./);
  assert.match(status(ctx), /\bsuccess\b/);
  assert.equal(ctx.els['bypass-send'].disabled, false);
});

test('mfa: after the receipt, a delay / header / read-back / send failure never sends', async (t) => {
  const headerSetFails = await mfaPane(t, {}, undefined, { internetHeaders: { set: (obj, cb) => cb({ status: 'failed', error: { message: 'refusé' } }) } });
  writeMfa(headerSetFails);
  headerSetFails.click('bypass-send');
  await settle();
  assert.match(headerSetFails.els.result.textContent, /n'a pas pu être enregistrée : refusé/);
  assert.equal(headerSetFails.calls.sendAsync, 0);

  const readBackDiffers = await mfaPane(t, {}, undefined, {
    internetHeaders: { get: (n, cb) => cb({ status: 'succeeded', value: { [HEADER]: `v2; autre texte tres different; r=${RECEIPT_OK}` } }) }
  });
  writeMfa(readBackDiffers);
  readBackDiffers.click('bypass-send');
  await settle();
  assert.equal(readBackDiffers.els.result.textContent, config.strings.tpBypassVerifyFailed);
  assert.equal(readBackDiffers.calls.sendAsync, 0);

  const otherReceipt = await mfaPane(t, {}, undefined, {
    internetHeaders: { get: (n, cb) => cb({ status: 'succeeded', value: { [HEADER]: bypassLib.buildHeaderValueV2(V2_TEXT, RECEIPT_OK.replace('abcDEF', 'zzzzzz')) } }) }
  });
  writeMfa(otherReceipt);
  otherReceipt.click('bypass-send');
  await settle();
  assert.equal(otherReceipt.els.result.textContent, config.strings.tpBypassVerifyFailed, 'same text, other receipt');
  assert.equal(otherReceipt.calls.sendAsync, 0);

  const sendFails = await mfaPane(t, {}, undefined, { sendAsync: (cb) => cb({ status: 'failed', error: { message: 'Envoi refusé' } }) });
  writeMfa(sendFails);
  sendFails.click('bypass-send');
  await settle();
  assert.match(sendFails.els.result.textContent, /Envoi refusé/);
  assert.match(sendFails.els.result.textContent, /La justification est enregistrée : cliquez sur Envoyer/);
  assert.equal(sendFails.els['bypass-send'].disabled, false);
});

test('mfa: local validation before any call (never a window for a weak justification)', async (t) => {
  const ctx = await mfaPane(t);
  assert.equal(ctx.els['bypass-send'].disabled, true);
  writeMfa(ctx, 'test test test test test');
  assert.equal(ctx.els['bypass-send'].disabled, true);
  ctx.click('bypass-send'); // forced click
  await settle();
  assert.deepEqual(ctx.naa.calls.popup, []);
  assert.deepEqual(ctx.naa.calls.silent, []);
  assert.equal(ctx.fetchCalls.length, 0);
  assert.equal(ctx.calls.headerSets.length, 0);
});

test('mfa: double click ignored during verification; new attempt after a send failure', async (t) => {
  const ctx = await mfaPane(t, {}, undefined, { sendAsync: (cb) => cb({ status: 'failed', error: { message: 'x' } }) });
  writeMfa(ctx);
  ctx.click('bypass-send');
  ctx.click('bypass-send'); // during verification: ignored
  await settle();
  assert.equal(ctx.naa.calls.popup.length, 1);
  assert.equal(ctx.fetchCalls.length, 1);
  ctx.click('bypass-send'); // after the send failure: new attempt (new click, new window)
  await settle();
  assert.equal(ctx.naa.calls.popup.length, 2);
  assert.equal(ctx.fetchCalls.length, 2);
  assert.equal(ctx.naa.calls.factory.length, 1, 'NAA client reused');
});

test('mfa: v1 mode unchanged when the MFA step is not required (no MSAL initialization)', async (t) => {
  const ctx = bypassPane(t, { sendAsync: () => {} });
  assert.equal(ctx.els['bypass-send'].textContent, 'Envoyer avec justification');
  typeText(ctx, GOOD_TEXT);
  ctx.click('bypass-send');
  await settle();
  assert.match(ctx.calls.headerSets[0][HEADER], /^v1; /);
  const fake = fakeNaa({});
  const notRequired = setup(t, NOW, 0, 'normal', {
    bypass: Object.assign({}, MFA_BYPASS, { mfa: Object.assign({}, MFA_BYPASS.mfa, { required: false }) }),
    internetHeaders: true,
    naa: fake,
    sendAsync: () => {}
  });
  assert.equal(notRequired.els['bypass-send'].textContent, 'Envoyer avec justification');
  assert.deepEqual(fake.calls.factory, [], 'MSAL never created without mfa.required');
});

test('naa.js: without claims -> silent then window; with claims -> window only; null when not ready', async (t) => {
  const mfa = MFA_BYPASS.mfa;
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  t.after(() => { console.warn = originalWarn; naaModule.setFactory(null); });

  // not ready: null, nothing called
  const never = fakeNaa({ factoryPending: true });
  naaModule.setFactory(never.factory);
  naaModule.init(mfa);
  assert.equal(naaModule.status(mfa), 'pending');
  assert.equal(naaModule.acquireToken(mfa, ACRS_C1), null);
  assert.deepEqual(never.calls.popup, []);

  const fake = fakeNaa({ silent: () => Promise.reject(Object.assign(new Error('interaction_required'), { errorCode: 'interaction_required' })) });
  naaModule.setFactory(fake.factory);
  assert.equal(naaModule.status(mfa), 'none');
  assert.equal(naaModule.acquireToken(mfa, ACRS_C1), null, 'client absent');
  await naaModule.init(mfa);
  assert.equal(naaModule.status(mfa), 'ready');
  assert.equal(naaModule.init(mfa), naaModule.init(mfa), 'cached Promise');
  assert.equal(fake.calls.factory.length, 1);

  // without claims: silent first, window if interaction is needed
  assert.equal(await naaModule.acquireToken(mfa, undefined), 'token-popup');
  assert.deepEqual(fake.calls.silent, [{ scopes: [SCOPE] }]);
  assert.deepEqual(fake.calls.popup, [{ scopes: [SCOPE] }]);
  // with claims: window only
  assert.equal(await naaModule.acquireToken(mfa, ACRS_C1), 'token-popup');
  assert.equal(fake.calls.silent.length, 1, 'no additional silent call');
  assert.deepEqual(fake.calls.popup[1], { scopes: [SCOPE], claims: ACRS_C1 });
  assert.deepEqual(naaModule.scopesFor(mfa), [SCOPE]);

  // cancellation during the silent call: no window
  const cancelFake = fakeNaa({ silent: () => Promise.reject(cancelled()) });
  naaModule.setFactory(cancelFake.factory);
  await naaModule.init(mfa);
  await assert.rejects(() => naaModule.acquireToken(mfa, undefined), (e) => e.errorCode === 'user_cancelled');
  assert.deepEqual(cancelFake.calls.popup, []);

  // synchronous window exception: rejection, no exception
  const throwing = fakeNaa({ popup: () => { throw popupBlocked(); } });
  naaModule.setFactory(throwing.factory);
  await naaModule.init(mfa);
  await assert.rejects(() => naaModule.acquireToken(mfa, ACRS_C1), (e) => e.errorCode === 'popup_window_error');

  // classification
  assert.equal(naaModule.classify(cancelled()), 'cancelled');
  assert.equal(naaModule.isCancellation(cancelled()), true);
  assert.equal(naaModule.classify(popupBlocked()), 'blocked');
  assert.equal(naaModule.classify({ errorCode: 'empty_window_error' }), 'blocked');
  assert.equal(naaModule.classify(new Error('boom')), 'other');
  assert.equal(naaModule.classify({ errorCode: 'interaction_required' }), 'other');
  assert.equal(naaModule.classify(undefined), 'other');

  // modes and NAA detection
  const savedOffice = global.Office;
  try {
    global.Office = { context: { requirements: { isSetSupported: (name, version) => name === 'NestedAppAuth' && version === '1.1' } } };
    assert.equal(naaModule.isSupported(), true);
    assert.equal(naaModule.mode(), 'naa');
    global.Office = { context: { requirements: { isSetSupported: (name) => name === 'Mailbox' } } };
    assert.equal(naaModule.isSupported(), false);
    assert.equal(naaModule.mode(), 'browser');
    global.Office = { context: { requirements: { isSetSupported: () => { throw new Error('boom'); } } } };
    assert.equal(naaModule.isSupported(), false);
    global.Office = {};
    assert.equal(naaModule.isSupported(), false);
  } finally {
    global.Office = savedOffice;
  }
});

test('mfa: the pane never logs token claims nor MFA configuration (full flow, every console method)', async (t) => {
  const mfa = MFA_BYPASS.mfa;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = { alg: 'RS256', typ: 'JWT', nonce: 'NONCE-SECRET', kid: 'k1' };
  const payload = {
    aud: `api://${mfa.clientId}`,
    iss: `https://login.microsoftonline.com/${mfa.tenantId}/v2.0`,
    ver: '2.0',
    scp: 'access_as_user',
    acrs: ['c1'],
    uti: 'UTI-SECRET-VALUE',
    oid: 'SECRET-OID-NOT-LOGGED',
    iat: 1793350000,
    exp: 1793353600
  };
  const SIGNATURE = 'SIGNATURE-SECRET-VALUE';
  const token = `${b64(header)}.${b64(payload)}.${SIGNATURE}`;
  const result = { accessToken: token, tokenType: 'Bearer', scopes: [SCOPE], fromCache: true, expiresOn: new Date(Date.UTC(2026, 9, 30, 11, 0, 0)), account: { environment: 'login.windows.net' } };
  const tokenResult = () => Promise.resolve(result);
  const ctx = await mfaPane(
    t,
    { silent: tokenResult, popup: tokenResult },
    [apiResponse(401, { error: 'mfa_required' }, challenge(ACRS_C1)), apiResponse(200, { receipt: RECEIPT_OK, ts: 1 })]
  );
  writeMfa(ctx);
  ctx.click('bypass-send');
  await settle();
  assert.ok(ctx.fetchCalls.length >= 1, 'the flow reached the API');
  // The MSAL wrapper alone, with the same token, is silent as well.
  const fake = fakeNaa({ popup: tokenResult });
  naaModule.setFactory(fake.factory);
  await naaModule.init(mfa);
  assert.equal(await naaModule.acquireToken(mfa, ACRS_C1), token);
  const all = ctx.warns.join('\n');
  assert.equal(all, '', 'nothing is written to the console');
  const forbidden = [
    token, SIGNATURE, b64(payload), b64(header), 'NONCE-SECRET', 'UTI-SECRET-VALUE', 'SECRET-OID-NOT-LOGGED',
    mfa.tenantId, mfa.clientId, mfa.authContext, 'access_as_user', 'acrs', 'aud', 'scp', 'uti', 'login.windows.net'
  ];
  for (const value of forbidden) {
    assert.equal(all.includes(value), false, `console free of "${value}"`);
  }
});

// ---------------------------------------------------------------- sessionData: fallback channel of the handler

test('sessionData: value written AFTER the header read-back and BEFORE sendAsync (v1)', (t) => {
  const ctx = bypassPane(t, { sendAsync: () => {}, sessionData: true });
  ctx.calls.order.length = 0;
  typeText(ctx, GOOD_TEXT);
  ctx.click('bypass-send');
  assert.deepEqual(ctx.calls.order, ['setAsync', 'getAsync', 'hdrSet', 'hdrGet', 'sessSet', 'sendAsync']);
  assert.deepEqual(ctx.calls.sessionSets, [['nfm-bypass', ctx.calls.headerSets[0][HEADER]]], 'same value as the header, nfm-bypass key');
  assert.equal(bypassLib.SESSION_KEY, 'nfm-bypass');
  assert.equal(ctx.calls.headers[HEADER], ctx.calls.session['nfm-bypass']);
});

test('sessionData: without Mailbox 1.11 or without the API, nothing is written; the original order is kept', (t) => {
  const noSet = bypassPane(t, { sendAsync: () => {}, sessionData: true, sets: ['1.8', '1.12', '1.13', '1.14', '1.15'] });
  noSet.calls.order.length = 0;
  typeText(noSet, GOOD_TEXT);
  noSet.click('bypass-send');
  assert.deepEqual(noSet.calls.order, ['setAsync', 'getAsync', 'hdrSet', 'hdrGet', 'sendAsync']);
  const noApi = bypassPane(t, { sendAsync: () => {} });
  noApi.calls.order.length = 0;
  typeText(noApi, GOOD_TEXT);
  noApi.click('bypass-send');
  assert.deepEqual(noApi.calls.order, ['setAsync', 'getAsync', 'hdrSet', 'hdrGet', 'sendAsync']);
});

test('sessionData: failing write (asynchronous or exception) = best effort, the send continues; never written if the header fails', (t) => {
  const failed = bypassPane(t, { sendAsync: () => {}, sessionData: { set: (n, v, cb) => cb({ status: 'failed', error: { message: 'x' } }) } });
  typeText(failed, GOOD_TEXT);
  failed.click('bypass-send');
  assert.equal(failed.calls.sendAsync, 1, 'the header is set and read back: the send continues');
  const thrown = bypassPane(t, { sendAsync: () => {}, sessionData: { set: () => { throw new Error('Sys.Boom'); } } });
  typeText(thrown, GOOD_TEXT);
  thrown.click('bypass-send');
  assert.equal(thrown.calls.sendAsync, 1);
  const noSession = bypassPane(t, {
    sendAsync: () => {},
    sessionData: true,
    internetHeaders: { set: (obj, cb) => cb({ status: 'failed', error: { message: 'refusé' } }) }
  });
  typeText(noSession, GOOD_TEXT);
  noSession.click('bypass-send');
  assert.deepEqual(noSession.calls.sessionSets, [], 'header not set: sessionData not written');
  assert.equal(noSession.calls.sendAsync, 0);
  const verifyFails = bypassPane(t, {
    sendAsync: () => {},
    sessionData: true,
    internetHeaders: { get: (n, cb) => cb({ status: 'succeeded', value: {} }) }
  });
  typeText(verifyFails, GOOD_TEXT);
  verifyFails.click('bypass-send');
  assert.deepEqual(verifyFails.calls.sessionSets, [], 'header not read back: sessionData not written');
  assert.equal(verifyFails.calls.sendAsync, 0);
  // without Mailbox 1.15: the value is written then "cliquez sur Envoyer"
  const manual = bypassPane(t, { sessionData: true, sets: ['1.8', '1.11', '1.12', '1.13', '1.14'] });
  typeText(manual, GOOD_TEXT);
  manual.click('bypass-send');
  assert.equal(manual.calls.sessionSets.length, 1);
  assert.match(manual.els.result.textContent, /cliquez sur Envoyer/);
});

test('sessionData: "Retirer la justification" also removes the key; failed header removal = key kept', (t) => {
  const initial = { [HEADER]: bypassLib.buildHeaderValue('Réponse urgente client') };
  const ctx = bypassPane(t, { internetHeaders: { initial }, sessionData: true });
  ctx.calls.session['nfm-bypass'] = 'v1; Réponse urgente client';
  ctx.calls.order.length = 0;
  ctx.click('bypass-remove');
  assert.deepEqual(ctx.calls.order, ['hdrRemove', 'sessRemove']);
  assert.deepEqual(ctx.calls.sessionRemoves, ['nfm-bypass']);
  assert.equal(ctx.calls.session['nfm-bypass'], undefined);
  assert.equal(ctx.els['bypass-saved'].hidden, true);
  assert.equal(ctx.els.result.textContent, 'Justification retirée.');

  const failedHeader = bypassPane(t, { internetHeaders: { initial, remove: (n, cb) => cb({ status: 'failed', error: { message: 'Refusé' } }) }, sessionData: true });
  failedHeader.click('bypass-remove');
  assert.deepEqual(failedHeader.calls.sessionRemoves, []);
  assert.match(failedHeader.els.result.textContent, /Refusé/);

  // failing or throwing key removal: the justification is still removed on the interface side
  const sessionFails = bypassPane(t, { internetHeaders: { initial }, sessionData: { remove: (n, cb) => cb({ status: 'failed', error: { message: 'x' } }) } });
  sessionFails.click('bypass-remove');
  assert.equal(sessionFails.els['bypass-saved'].hidden, true);
  const sessionThrows = bypassPane(t, { internetHeaders: { initial }, sessionData: { remove: () => { throw new Error('Sys.Boom'); } } });
  sessionThrows.click('bypass-remove');
  assert.equal(sessionThrows.els.result.textContent, 'Justification retirée.');
  // without sessionData: unchanged
  const plain = bypassPane(t, { internetHeaders: { initial } });
  plain.click('bypass-remove');
  assert.equal(plain.els.result.textContent, 'Justification retirée.');
});

test('sessionData: in MFA mode, the v2 value is written before sendAsync', async (t) => {
  const ctx = await mfaPane(t, {}, undefined, { sessionData: true });
  ctx.calls.order.length = 0;
  writeMfa(ctx);
  ctx.click('bypass-send');
  await settle();
  assert.deepEqual(ctx.calls.order, ['popup', 'fetch', 'setAsync', 'getAsync', 'hdrSet', 'hdrGet', 'sessSet', 'sendAsync']);
  assert.match(ctx.calls.sessionSets[0][1], /^v2; .*; r=abcDEF123456\./);
  assert.equal(ctx.calls.sessionSets[0][1], ctx.calls.headerSets[0][HEADER]);
});

test('header read back with a lowercase name by the task pane (case-insensitive verification)', (t) => {
  for (const name of ['x-nofriday-bypass', 'X-NOFRIDAY-BYPASS', 'X-NoFriday-bypass']) {
    const ctx = bypassPane(t, {
      sendAsync: () => {},
      internetHeaders: { get: (n, cb, calls) => cb({ status: 'succeeded', value: { [name]: calls.headers[HEADER] } }) }
    });
    typeText(ctx, GOOD_TEXT);
    ctx.click('bypass-send');
    assert.equal(ctx.calls.sendAsync, 1, name);
  }
});

test('mfa: discreet hint "verification may be reused for 5 minutes" (FR / EN), MFA mode only', async (t) => {
  const fr = await mfaPane(t);
  assert.equal(fr.els['bypass-reuse'].textContent, "La vérification d'identité peut être réutilisée pendant 5 minutes.");
  assert.equal(fr.els['bypass-reuse'].hidden, false);
  // behavior does not change: a successful send works as before, the text stays displayed
  writeMfa(fr);
  fr.click('bypass-send');
  await settle();
  assert.equal(fr.calls.sendAsync, 1);
  assert.equal(fr.els['bypass-reuse'].hidden, false);
  const en = await mfaPane(t, {}, undefined, { lang: 'en-US' });
  assert.equal(en.els['bypass-reuse'].textContent, 'Identity verification may be reused for 5 minutes.');
  // without MFA step (v1) or without NAA: nothing
  const v1 = bypassPane(t, { sendAsync: () => {} });
  assert.equal(v1.els['bypass-reuse'].hidden, true);
  assert.equal(v1.els['bypass-reuse'].textContent, '');
  const noNaa = await mfaPane(t, {}, undefined, { sets: ['1.8', '1.12', '1.13'] });
  assert.equal(noNaa.els['bypass-reuse'].hidden, true);
});
