'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../package/src/shared/config');
const rules = require('../package/src/shared/rules');

const at = (month, day, hour = 12, minute = 0) => new Date(2026, month - 1, day, hour, minute, 0, 0);
const placeholders = (value) => (typeof value === 'string' ? (value.match(/\{\w+\}/g) || []).sort().join(',') : '');

test('fr and en: same keys, same types, same {placeholders}', () => {
  const fr = config.languages.fr;
  const en = config.languages.en;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(fr).sort());
  for (const key of Object.keys(fr)) {
    assert.equal(typeof en[key], typeof fr[key], key);
    assert.equal(placeholders(en[key]), placeholders(fr[key]), `placeholders of ${key}`);
    if (Array.isArray(fr[key])) {
      assert.equal(en[key].length, fr[key].length, key);
    } else if (typeof fr[key] === 'string' && key !== 'daysIntro' && key !== 'firstSuffix') {
      // daysIntro (fr) and firstSuffix (en) are intentionally empty.
      assert.notEqual(en[key].trim(), '', key);
      assert.notEqual(fr[key].trim(), '', key);
    }
  }
  assert.equal(fr.dayNames.length, 7);
  assert.equal(fr.monthNames.length, 12);
});

test('en texts contain no leftover French text', () => {
  const en = config.languages.en;
  for (const key of Object.keys(en)) {
    if (typeof en[key] === 'string') {
      assert.doesNotMatch(en[key], /[éèêàçù«»]|Planifier|envoi|vendredi/i, key);
    }
  }
});

test('Smart Alerts limits in each language: cancelLabel <= 20, messages <= 500', () => {
  for (const lang of ['fr', 'en']) {
    const s = config.languages[lang];
    assert.ok(s.cancelLabel.length <= 20, `${lang} cancelLabel (${s.cancelLabel.length})`);
    const cfg = Object.assign({}, config.forLang(lang), { blockedDays: [2, 3] });
    const vars = {
      days: rules.blockedDaysLabel(cfg),
      date: rules.formatDate(at(9, 30, 23, 59), cfg),
      suggestions: rules.suggestionsLabel(rules.nextAllowedSuggestions(at(9, 30), cfg), cfg),
      time: rules.sendTimeLabel(cfg),
      nextDay: s.dayNames[3]
    };
    for (const key of Object.keys(s)) {
      if (/^(messageBlocked|appointmentBlocked|messageCheckFailed)/.test(key)) {
        assert.ok(rules.fill(s[key], vars).length <= 500, `${lang} ${key}`);
      }
    }
  }
});

test('resolveLang: fr* -> fr, other -> en, missing or invalid -> default language (fr)', () => {
  assert.equal(config.DEFAULT_LANG, 'fr');
  for (const lang of ['fr', 'fr-FR', 'fr-CA', 'fr-BE', 'FR', 'fr_FR', 'fr-fr']) {
    assert.equal(config.resolveLang(lang), 'fr', lang);
  }
  for (const lang of ['en', 'en-US', 'en-GB', 'de-DE', 'es-ES', 'frisian', 'nl-BE', 'ja-JP']) {
    assert.equal(config.resolveLang(lang), 'en', lang);
  }
  for (const lang of [undefined, null, '', '   ', 42, {}, []]) {
    assert.equal(config.resolveLang(lang), 'fr', String(lang));
  }
});

test('pickStrings / forLang: string sets and settings read at call time', () => {
  assert.equal(config.pickStrings('en-US').cancelLabel, 'Schedule send');
  assert.equal(config.pickStrings('fr-FR').cancelLabel, "Planifier l'envoi");
  assert.equal(config.pickStrings(undefined).cancelLabel, "Planifier l'envoi");
  assert.equal(config.forLang('en-US').lang, 'en');
  assert.deepEqual(config.forLang('en-US').blockedDays, [5]);
  const saved = config.blockedDays;
  config.blockedDays = [1];
  try {
    assert.deepEqual(config.forLang('fr').blockedDays, [1]);
  } finally {
    config.blockedDays = saved;
  }
});

test('detectLang: reads Office.context.displayLanguage at call time, try/catch guard when Office is absent', () => {
  const saved = global.Office;
  try {
    delete global.Office;
    assert.equal(config.detectLang(), undefined);
    assert.equal(config.forLang().lang, 'fr', 'Office absent -> fr');
    global.Office = { context: {} };
    assert.equal(config.forLang().lang, 'fr', 'displayLanguage missing -> fr');
    global.Office = { context: { displayLanguage: 'en-US' } };
    assert.equal(config.forLang().lang, 'en');
    global.Office = { context: { displayLanguage: 'fr-FR' } };
    assert.equal(config.forLang().lang, 'fr');
    global.Office = { context: { displayLanguage: 'xx-YY' } };
    assert.equal(config.forLang().lang, 'en', 'unknown non-French language -> en');
    global.Office = { get context() { throw new Error('boom'); } };
    assert.equal(config.forLang().lang, 'fr', 'exception -> fr');
  } finally {
    global.Office = saved;
  }
});

test('date formatting: fr and en, without Intl', () => {
  const fr = config.forLang('fr');
  const en = config.forLang('en');
  assert.equal(rules.formatDate(at(10, 31, 8, 0), fr), 'samedi 31 octobre 2026 à 08:00');
  assert.equal(rules.formatDate(at(10, 31, 8, 0), en), 'Saturday, October 31, 2026 at 8:00 AM');
  assert.equal(rules.formatDate(at(11, 1, 8, 0), fr), 'dimanche 1er novembre 2026 à 08:00');
  assert.equal(rules.formatDate(at(11, 1, 8, 0), en), 'Sunday, November 1, 2026 at 8:00 AM');
  assert.equal(rules.formatDate(at(11, 2, 13, 5), en), 'Monday, November 2, 2026 at 1:05 PM');
  assert.equal(rules.formatDate(at(11, 2, 13, 5), fr), 'lundi 2 novembre 2026 à 13:05');
});

test('12-hour time in English: midnight, noon, 23:59', () => {
  const en = config.forLang('en');
  assert.equal(rules.formatTime(at(10, 31, 0, 0), en), '12:00 AM');
  assert.equal(rules.formatTime(at(10, 31, 12, 30), en), '12:30 PM');
  assert.equal(rules.formatTime(at(10, 31, 23, 59), en), '11:59 PM');
  assert.equal(rules.formatTime(at(10, 31, 0, 0), config.forLang('fr')), '00:00');
  assert.equal(rules.formatTime(at(10, 31, 9, 7)), '09:07', 'without cfg: 24-hour');
  assert.equal(rules.sendTimeLabel(en), '8:00 AM');
  assert.equal(rules.sendTimeLabel(config.forLang('fr')), '08:00');
});

test('blocked-day and suggestion labels: fr and en', () => {
  const frBoth = Object.assign(config.forLang('fr'), { blockedDays: [5, 6] });
  const enBoth = Object.assign(config.forLang('en'), { blockedDays: [5, 6] });
  assert.equal(rules.blockedDaysLabel(config.forLang('fr')), 'le vendredi');
  assert.equal(rules.blockedDaysLabel(config.forLang('en')), 'on Fridays');
  assert.equal(rules.blockedDaysLabel(frBoth), 'le vendredi et le samedi');
  assert.equal(rules.blockedDaysLabel(enBoth), 'on Fridays and Saturdays');
  const s = rules.nextAllowedSuggestions(at(10, 30), config.forLang('en'));
  assert.equal(rules.suggestionsLabel(s, config.forLang('en')), 'Monday or Tuesday');
  assert.equal(rules.suggestionsLabel(s, config.forLang('fr')), 'lundi ou mardi');
});

test('custom date validation: message in the selected language', () => {
  const now = at(10, 28, 10, 0);
  const friday = rules.parseDateTimeLocal('2026-10-30T23:59');
  assert.equal(
    rules.validateCustomDate(friday, now, config.forLang('fr')).message,
    "Le vendredi n'est pas autorisé, choisissez un autre jour"
  );
  assert.equal(
    rules.validateCustomDate(friday, now, config.forLang('en')).message,
    'Friday is not allowed, choose another day'
  );
  assert.equal(rules.validateCustomDate(at(10, 27), now, config.forLang('en')).message, 'The date must be in the future.');
  assert.equal(rules.validateCustomDate(null, now, config.forLang('en')).message, 'Invalid date or time.');
});

test('exceptional send: hint added to blocked messages stays <= 500 characters in each language', () => {
  for (const lang of ['fr', 'en']) {
    const s = config.languages[lang];
    const cfg = Object.assign({}, config.forLang(lang), { blockedDays: [2, 3] });
    const vars = {
      days: rules.blockedDaysLabel(cfg),
      date: rules.formatDate(at(9, 30, 23, 59), cfg),
      suggestions: rules.suggestionsLabel(rules.nextAllowedSuggestions(at(9, 30), cfg), cfg),
      time: rules.sendTimeLabel(cfg),
      nextDay: s.dayNames[3]
    };
    for (const key of Object.keys(s)) {
      if (/^messageBlocked/.test(key)) {
        const isMd = /Md$/.test(key);
        const total = rules.fill(s[key], vars) + (isMd ? '\n\n' + s.messageBypassHintMd : ' ' + s.messageBypassHint);
        assert.ok(total.length <= 500, `${lang} ${key} + exceptional send hint (${total.length})`);
      }
    }
    assert.match(s.messageBypassHintMd, /\*\*/);
    assert.doesNotMatch(s.messageBypassHint, /\*\*/);
  }
});

test('exceptional send: each pane text announces logging and possible rejection (fr and en)', () => {
  const fr = config.languages.fr;
  const en = config.languages.en;
  assert.match(fr.tpBypassIntro, /journalisée/);
  assert.match(fr.tpBypassIntro, /refusé si vous n'y êtes pas autorisé/);
  assert.match(en.tpBypassIntro, /logged/);
  assert.match(en.tpBypassIntro, /rejected if you are not authorized/);
  assert.match(fr.messageBypassHint, /journalisée, soumise à autorisation/);
  assert.match(en.messageBypassHint, /logged and subject to authorization/);
  assert.match(fr.tpBypassReady, /refusé si vous n'y êtes pas autorisé/);
  assert.match(en.tpBypassReady, /rejected if you are not authorized/);
  assert.equal(fr.tpBypassSend, 'Envoyer avec justification');
  assert.equal(en.tpBypassSend, 'Send with justification');
  assert.equal(fr.tpBypassTitle, 'Envoi exceptionnel');
  assert.equal(en.tpBypassTitle, 'Exceptional send');
});

test('exceptional send: default settings disabled, exposed by forLang', () => {
  assert.deepEqual(config.bypass, { enabled: false, minLength: 20, maxLength: 200, minWords: 3, minDistinctChars: 6 });
  assert.deepEqual(config.forLang('en').bypass, config.bypass);
});

test('support codes NFM-B2 and B3: same fr / en keys, dialog messages <= 500 characters with the longest code', () => {
  for (const lang of ['fr', 'en']) {
    const s = config.languages[lang];
    const codes = ['B2', 'B3'].map((c) => s['messageBypassCode' + c]);
    for (const [index, code] of codes.entries()) {
      assert.match(code, new RegExp('^code NFM-B' + (index + 2) + ' ?: '), lang + ' B' + (index + 2));
      assert.ok(code.length <= 45, code);
    }
    const longest = codes.reduce((a, b) => (b.length > a.length ? b : a));
    const cfg = Object.assign({}, config.forLang(lang), { blockedDays: [2, 3] });
    const vars = {
      days: rules.blockedDaysLabel(cfg),
      date: rules.formatDate(at(9, 30, 23, 59), cfg),
      suggestions: rules.suggestionsLabel(rules.nextAllowedSuggestions(at(9, 30), cfg), cfg),
      time: rules.sendTimeLabel(cfg),
      nextDay: s.dayNames[3]
    };
    for (const key of Object.keys(s)) {
      if (/^messageBlocked/.test(key)) {
        const isMd = /Md$/.test(key);
        const total = rules.fill(s[key], vars) + (isMd ? '\n\n' + s.messageBypassHintMd + '\n\n(' + longest + ')' : ' ' + s.messageBypassHint + ' (' + longest + ')');
        assert.ok(total.length <= 500, lang + ' ' + key + ' + hint + code (' + total.length + ')');
      }
    }
  }
});
