'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../package/src/shared/config');
const rules = require('../package/src/shared/rules');

// Reference week (local dates, hence independent of the test machine's time zone):
// Monday 26 October 2026 ... Friday 30 ... Saturday 31 ... Sunday 1 November 2026.
const at = (month, day, hour = 12, minute = 0) => new Date(2026, month - 1, day, hour, minute, 0, 0);

test('reference dates fall on the expected weekdays', () => {
  assert.equal(at(10, 26).getDay(), 1);
  assert.equal(at(10, 30).getDay(), 5);
  assert.equal(at(10, 31).getDay(), 6);
  assert.equal(at(11, 1).getDay(), 0);
  assert.equal(at(11, 6).getDay(), 5);
});

test('default configuration: Friday blocked, 08:00', () => {
  assert.deepEqual(config.blockedDays, [5]);
  assert.equal(config.sendHour, 8);
  assert.equal(config.sendMinute, 0);
});

test('isBlocked: each day of the week, only Friday is blocked', () => {
  const expected = [
    [at(10, 26), 'Monday', false],
    [at(10, 27), 'Tuesday', false],
    [at(10, 28), 'Wednesday', false],
    [at(10, 29), 'Thursday', false],
    [at(10, 30), 'Friday', true],
    [at(10, 31), 'Saturday', false],
    [at(11, 1), 'Sunday', false]
  ];
  for (const [date, name, blocked] of expected) {
    assert.equal(rules.isBlocked(date, config), blocked, name);
  }
});

test('isBlocked: Friday 00:00 and 23:59 boundaries', () => {
  assert.equal(rules.isBlocked(at(10, 30, 0, 0), config), true, 'Friday 00:00');
  assert.equal(rules.isBlocked(at(10, 30, 23, 59), config), true, 'Friday 23:59');
  assert.equal(rules.isBlocked(at(10, 29, 23, 59), config), false, 'Thursday 23:59');
  assert.equal(rules.isBlocked(at(10, 31, 0, 0), config), false, 'Saturday 00:00');
});

test('isBlocked: several blocked days and invalid values', () => {
  const cfg = Object.assign({}, config, { blockedDays: [5, 6] });
  assert.equal(rules.isBlocked(at(10, 31), cfg), true);
  assert.equal(rules.isBlocked(at(11, 1), cfg), false);
  assert.equal(rules.isBlocked(new Date(NaN), config), false);
  assert.equal(rules.isBlocked(null, config), false);
});

test('effective time: now when there is no delay (0, null, undefined)', () => {
  const now = at(10, 29, 18, 0);
  for (const delay of [0, null, undefined]) {
    assert.equal(rules.effectiveDeliveryTime(now, delay), now);
  }
});

test('effective time: a past delay is ignored', () => {
  const now = at(10, 30, 10, 0);
  assert.equal(rules.effectiveDeliveryTime(now, at(10, 29, 10, 0)), now);
  assert.equal(rules.effectiveDeliveryTime(now, now), now);
});

test('Thursday evening deferred to Friday: blocked', () => {
  const now = at(10, 29, 19, 30);
  const result = rules.evaluateSend(now, at(10, 30, 8, 0), config);
  assert.equal(result.blocked, true);
  assert.equal(result.delayed, true);
  assert.equal(result.effective.getDay(), 5);
});

test('Thursday evening deferred to Friday 23:59 or 00:00: blocked', () => {
  const now = at(10, 29, 19, 30);
  assert.equal(rules.evaluateSend(now, at(10, 30, 0, 0), config).blocked, true);
  assert.equal(rules.evaluateSend(now, at(10, 30, 23, 59), config).blocked, true);
});

test('Thursday deferred to Saturday: allowed', () => {
  const result = rules.evaluateSend(at(10, 29, 19, 30), at(10, 31, 8, 0), config);
  assert.equal(result.blocked, false);
});

test('Friday deferred to Saturday or Monday: allowed', () => {
  const now = at(10, 30, 15, 0);
  assert.equal(rules.evaluateSend(now, at(10, 31, 8, 0), config).blocked, false, 'Saturday');
  assert.equal(rules.evaluateSend(now, at(11, 2, 8, 0), config).blocked, false, 'Monday');
});

test('Friday with no delay: blocked; Friday with a past delay: blocked', () => {
  const now = at(10, 30, 15, 0);
  assert.equal(rules.evaluateSend(now, 0, config).blocked, true);
  assert.equal(rules.evaluateSend(now, at(10, 29, 8, 0), config).blocked, true);
});

test('Friday deferred to another Friday (native delayed delivery): blocked', () => {
  const now = at(10, 30, 15, 0);
  assert.equal(rules.evaluateSend(now, at(11, 6, 9, 0), config).blocked, true);
});

test('delay given as a number or an ISO string', () => {
  const now = at(10, 29, 12, 0);
  assert.equal(rules.evaluateSend(now, at(10, 30, 8, 0).getTime(), config).blocked, true);
  assert.equal(rules.evaluateSend(now, at(10, 30, 8, 0).toISOString(), config).blocked, true);
  assert.equal(rules.evaluateSend(now, 'not a date', config).blocked, false);
});

test('config: default working days = Monday to Friday (weekends never proposed, never blocked)', () => {
  assert.deepEqual(config.workingDays, [1, 2, 3, 4, 5]);
  assert.deepEqual(config.blockedDays, [5]);
  assert.equal(rules.isBlocked(at(10, 31), config), false, 'Saturday is not blocked');
  assert.equal(rules.isWorkingDay(at(10, 31), config), false);
  assert.equal(rules.isProposable(at(10, 31), config), false);
  assert.equal(rules.isProposable(at(10, 30), config), false, 'Friday: working day but blocked');
  assert.equal(rules.isProposable(at(10, 29), config), true);
  assert.equal(rules.isWorkingDay(at(10, 29), Object.assign({}, config, { workingDays: undefined })), true);
});

test('suggestions from a Friday: Monday 08:00 and Tuesday 08:00', () => {
  const s = rules.nextAllowedSuggestions(at(10, 30, 10, 0), config);
  assert.deepEqual(s.first, at(11, 2, 8, 0));
  assert.deepEqual(s.second, at(11, 3, 8, 0));
  assert.equal(rules.suggestionsLabel(s, config.forLang('fr')), 'lundi ou mardi');
  assert.equal(rules.suggestionsLabel(s, config.forLang('en')), 'Monday or Tuesday');
});

test('suggestions from Friday 23:59: unchanged', () => {
  const s = rules.nextAllowedSuggestions(at(10, 30, 23, 59), config);
  assert.deepEqual([s.first, s.second], [at(11, 2, 8, 0), at(11, 3, 8, 0)]);
});

test('suggestions from a Thursday: blocked Friday and weekend are skipped (Monday, Tuesday)', () => {
  const s = rules.nextAllowedSuggestions(at(10, 29, 10, 0), config);
  assert.deepEqual([s.first, s.second], [at(11, 2, 8, 0), at(11, 3, 8, 0)]);
});

test('suggestions from a Wednesday: Thursday then Monday (Friday blocked, weekend skipped)', () => {
  const s = rules.nextAllowedSuggestions(at(10, 28, 10, 0), config);
  assert.deepEqual([s.first, s.second], [at(10, 29, 8, 0), at(11, 2, 8, 0)]);
});

test('suggestions from a Saturday or Sunday: Monday and Tuesday', () => {
  assert.deepEqual(
    [rules.nextAllowedSuggestions(at(10, 31, 14, 0), config).first, rules.nextAllowedSuggestions(at(10, 31, 14, 0), config).second],
    [at(11, 2, 8, 0), at(11, 3, 8, 0)]
  );
  const sun = rules.nextAllowedSuggestions(at(11, 1, 14, 0), config);
  assert.deepEqual([sun.first, sun.second], [at(11, 2, 8, 0), at(11, 3, 8, 0)]);
});

test('suggestions from a Monday: Tuesday and Wednesday', () => {
  const s = rules.nextAllowedSuggestions(at(10, 26, 9, 0), config);
  assert.deepEqual([s.first, s.second], [at(10, 27, 8, 0), at(10, 28, 8, 0)]);
});

test('suggestions (Wednesday+Thursday blocked): Thursday -> Friday and Monday; Wednesday -> Friday and Monday', () => {
  const custom = Object.assign({}, config, { blockedDays: [3, 4] });
  const thu = rules.nextAllowedSuggestions(at(10, 29, 10, 0), custom);
  assert.deepEqual([thu.first, thu.second], [at(10, 30, 8, 0), at(11, 2, 8, 0)]);
  const wed = rules.nextAllowedSuggestions(at(10, 28, 10, 0), custom);
  assert.deepEqual([wed.first, wed.second], [at(10, 30, 8, 0), at(11, 2, 8, 0)]);
  assert.equal(rules.suggestionsLabel(thu, config.forLang('en')), 'Friday or Monday');
});

test('suggestions: configurable working days, never the weekend nor a blocked day', () => {
  const sat = Object.assign({}, config, { workingDays: [1, 2, 3, 4, 5, 6] });
  const s = rules.nextAllowedSuggestions(at(10, 29, 10, 0), sat);
  assert.deepEqual([s.first, s.second], [at(10, 31, 8, 0), at(11, 2, 8, 0)], 'Saturday proposed when it is a working day');
  const mondayOnly = Object.assign({}, config, { workingDays: [1] });
  const m = rules.nextAllowedSuggestions(at(10, 28, 10, 0), mondayOnly);
  assert.deepEqual([m.first, m.second], [at(11, 2, 8, 0), at(11, 9, 8, 0)]);
  assert.equal(rules.suggestionsLabel(m, config.forLang('fr')), 'lundi', 'same day name: only one');
});

test('suggestions: always in the future, working days, not blocked, at the configured time', () => {
  for (let day = 26; day <= 40; day += 1) {
    const ref = at(10, day, 23, 59);
    const s = rules.nextAllowedSuggestions(ref, config);
    for (const d of [s.first, s.second]) {
      assert.ok(d.getTime() > ref.getTime());
      assert.equal(rules.isProposable(d, config), true);
      assert.equal(d.getHours(), 8);
    }
    assert.ok(s.second.getTime() > s.first.getTime());
  }
});

test('suggestions: a single suggestion if the horizon holds only one, none if everything is blocked (no infinite loop)', () => {
  const one = rules.nextAllowedSuggestions(at(10, 28, 10, 0), config, 1);
  assert.deepEqual(one.first, at(10, 29, 8, 0));
  assert.equal(one.second, null);
  assert.equal(rules.suggestionsLabel(one, config.forLang('fr')), 'jeudi');
  const allBlocked = Object.assign({}, config, { blockedDays: [1, 2, 3, 4, 5] });
  const none = rules.nextAllowedSuggestions(at(10, 28, 10, 0), allBlocked);
  assert.deepEqual(none, { first: null, second: null });
  assert.equal(rules.suggestionsLabel(none, config.forLang('fr')), '');
  const noWorking = Object.assign({}, config, { workingDays: [] });
  assert.deepEqual(rules.nextAllowedSuggestions(at(10, 28, 10, 0), noWorking), { first: null, second: null });
  assert.deepEqual(rules.allowedDays(at(10, 28, 10, 0), allBlocked, 10), []);
  assert.deepEqual(rules.allowedDays(at(10, 28, 10, 0), noWorking, 10), []);
});

test('parseDateTimeLocal: valid and invalid formats', () => {
  assert.deepEqual(rules.parseDateTimeLocal('2026-10-31T08:00'), at(10, 31, 8, 0));
  assert.deepEqual(rules.parseDateTimeLocal('2026-10-31T08:00:30'), new Date(2026, 9, 31, 8, 0, 30));
  assert.equal(rules.parseDateTimeLocal(''), null);
  assert.equal(rules.parseDateTimeLocal(undefined), null);
  assert.equal(rules.parseDateTimeLocal('2026-02-31T08:00'), null);
  assert.equal(rules.parseDateTimeLocal('2026-10-31'), null);
  assert.equal(rules.parseDateTimeLocal('n’importe quoi'), null);
});

test('custom date: a Friday is rejected (including 00:00 and 23:59)', () => {
  const now = at(10, 28, 10, 0);
  for (const value of ['2026-10-30T00:00', '2026-10-30T08:00', '2026-10-30T23:59', '2026-11-06T00:00', '2026-11-06T23:59']) {
    const result = rules.validateCustomDate(rules.parseDateTimeLocal(value), now, config);
    assert.equal(result.valid, false, value);
    assert.equal(result.code, 'blocked', value);
    assert.equal(result.message, "Le vendredi n'est pas autorisé, choisissez un autre jour", value);
  }
});

test('custom date: a past Friday is rejected too', () => {
  const now = at(11, 10, 10, 0);
  const result = rules.validateCustomDate(at(10, 30, 8, 0), now, config);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'blocked');
});

test('custom date: a date in the past or equal to now is rejected', () => {
  const now = at(10, 28, 10, 0);
  assert.equal(rules.validateCustomDate(at(10, 27, 8, 0), now, config).code, 'past');
  assert.equal(rules.validateCustomDate(at(10, 28, 9, 59), now, config).code, 'past');
  assert.equal(rules.validateCustomDate(new Date(now.getTime()), now, config).code, 'past');
});

test('custom date: invalid values rejected', () => {
  const now = at(10, 28, 10, 0);
  for (const value of [null, undefined, 0, '', new Date(NaN), 'abc']) {
    const result = rules.validateCustomDate(value, now, config);
    assert.equal(result.valid, false);
    assert.equal(result.code, 'invalid');
  }
});

test('custom date: non-blocked future days accepted', () => {
  const now = at(10, 28, 10, 0);
  for (const date of [at(10, 28, 10, 1), at(10, 29, 0, 0), at(10, 31, 23, 59), at(11, 1, 8, 0), at(11, 2, 8, 0)]) {
    const result = rules.validateCustomDate(date, now, config);
    assert.equal(result.valid, true, String(date));
    assert.equal(result.code, null);
  }
});

test('French date formatting', () => {
  assert.equal(rules.formatDateFr(at(10, 31, 8, 0), config), 'samedi 31 octobre 2026 à 08:00');
  assert.equal(rules.formatDateFr(at(11, 1, 8, 0), config), 'dimanche 1er novembre 2026 à 08:00');
  assert.equal(rules.formatDateFr(at(11, 2, 9, 5), config), 'lundi 2 novembre 2026 à 09:05');
  assert.equal(rules.sendTimeLabel(config), '08:00');
});

test('labels: blocked days and suggestions', () => {
  assert.equal(rules.blockedDaysLabel(config), 'le vendredi');
  assert.equal(
    rules.blockedDaysLabel(Object.assign({}, config, { blockedDays: [5, 6] })),
    'le vendredi et le samedi'
  );
  assert.equal(rules.suggestionsLabel(rules.nextAllowedSuggestions(at(10, 30), config), config), 'lundi ou mardi');
});

test('Date(0) or a past date = no delayed delivery (no future delivery)', () => {
  const now = at(10, 30, 10, 0);
  for (const delay of [0, new Date(0), at(10, 29, 8, 0), now, null, undefined]) {
    assert.equal(rules.hasFutureDelay(delay, now), false, String(delay));
    assert.equal(rules.effectiveDeliveryTime(now, delay), now, String(delay));
  }
  assert.equal(rules.hasFutureDelay(at(10, 31, 8, 0), now), true);
  // Date(0) as the delay is evaluated as "now".
  assert.equal(rules.evaluateSend(at(10, 29, 12, 0), new Date(0), config).blocked, false);
  assert.equal(rules.evaluateSend(at(10, 29, 12, 0), new Date(0), config).delayed, false);
});

// --- Task pane days and time slots (pure functions) ---

test('parseSlotTime / slotTimesOf: valid and invalid values, duplicates, sorting', () => {
  assert.deepEqual(rules.parseSlotTime('08:00'), { key: '08:00', hour: 8, minute: 0 });
  assert.deepEqual(rules.parseSlotTime('9:05'), { key: '09:05', hour: 9, minute: 5 });
  for (const bad of ['', '24:00', '12:60', 'abc', '8', '08:0', null, undefined, 800]) {
    assert.equal(rules.parseSlotTime(bad), null, String(bad));
  }
  const cfg = Object.assign({}, config, { slotTimes: ['16:00', '08:00', '08:00', 'x', '9:30'] });
  assert.deepEqual(rules.slotTimesOf(cfg).map((s) => s.key), ['08:00', '09:30', '16:00']);
  assert.deepEqual(rules.slotTimesOf(Object.assign({}, config, { slotTimes: undefined })), []);
});

test('config: default time slots, 8 at most (task pane chips)', () => {
  assert.deepEqual(config.slotTimes, ['08:00', '09:00', '10:00', '11:00', '14:00', '16:00']);
  assert.ok(rules.slotTimesOf(config).length <= 8);
  assert.equal(config.dayCount, 10);
});

test('timeSlots: no past hour today, all hours on later days, nothing on a blocked day', () => {
  const now = at(10, 28, 10, 0);
  const keys = (day) => rules.timeSlots(day, now, config).map((s) => s.key);
  assert.deepEqual(keys(rules.startOfDay(now)), ['11:00', '14:00', '16:00'], '10:00 = now: excluded');
  assert.deepEqual(keys(at(10, 29, 0, 0)), ['08:00', '09:00', '10:00', '11:00', '14:00', '16:00']);
  assert.deepEqual(keys(at(10, 30, 0, 0)), [], 'Friday: no slot');
  assert.deepEqual(rules.timeSlots(rules.startOfDay(at(10, 28, 17, 0)), at(10, 28, 17, 0), config), []);
  for (const slot of rules.timeSlots(rules.startOfDay(now), now, config)) {
    assert.ok(slot.date.getTime() > now.getTime());
    assert.equal(rules.validateCustomDate(slot.date, now, config).valid, true);
  }
});

test('allowedDays: 10 allowed working days, Fridays and weekends excluded, today only if a slot remains', () => {
  const days = rules.allowedDays(at(10, 28, 10, 0), config, 10);
  assert.equal(days.length, 10);
  assert.equal(days.some((d) => d.getDay() === 5), false);
  assert.equal(days.some((d) => d.getDay() === 0 || d.getDay() === 6), false, 'never a weekend');
  assert.deepEqual(days.slice(0, 5).map((d) => rules.dayKey(d)), ['2026-10-28', '2026-10-29', '2026-11-02', '2026-11-03', '2026-11-04']);
  for (const d of days) {
    assert.equal(d.getHours(), 0);
    assert.equal(rules.isBlocked(d, config), false);
  }
  const late = rules.allowedDays(at(10, 28, 17, 0), config, 10);
  assert.equal(rules.dayKey(late[0]), '2026-10-29', 'no slot left today');
  assert.equal(rules.allowedDays(at(10, 28, 10, 0), config, 3).length, 3);
});

test('allowedDays: a Friday (current day) is skipped; several blocked days', () => {
  const fromFriday = rules.allowedDays(at(10, 30, 7, 0), config, 4);
  assert.deepEqual(fromFriday.map((d) => rules.dayKey(d)), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
  const cfg = Object.assign({}, config, { blockedDays: [5, 6] });
  const days = rules.allowedDays(at(10, 29, 7, 0), cfg, 4);
  assert.deepEqual(days.map((d) => rules.dayKey(d)), ['2026-10-29', '2026-11-02', '2026-11-03', '2026-11-04']);
});

test('allowedDays: does not loop when all days are blocked', () => {
  const cfg = Object.assign({}, config, { blockedDays: [0, 1, 2, 3, 4, 5, 6] });
  assert.deepEqual(rules.allowedDays(at(10, 28), cfg, 10), []);
});

test('dayKey, relativeDay, slotDate, formatSummary, formatDayFull', () => {
  const now = at(10, 28, 23, 30);
  assert.equal(rules.dayKey(at(1, 5, 12, 0)), '2026-01-05');
  assert.equal(rules.relativeDay(at(10, 28, 0, 0), now), 'today');
  assert.equal(rules.relativeDay(at(10, 29, 12, 0), now), 'tomorrow');
  assert.equal(rules.relativeDay(at(10, 31, 12, 0), now), '');
  assert.deepEqual(rules.slotDate(at(10, 31, 0, 0), { hour: 14, minute: 30 }), at(10, 31, 14, 30));
  const fr = config.forLang('fr');
  const en = config.forLang('en');
  assert.equal(rules.formatSummary(at(10, 30, 9, 0), fr), 'ven. 30 oct. à 09:00');
  assert.equal(rules.formatSummary(at(10, 30, 9, 0), en), 'Fri, Oct 30 at 9:00 AM');
  assert.equal(rules.formatSummary(at(11, 1, 16, 0), en), 'Sun, Nov 1 at 4:00 PM');
  assert.equal(rules.formatDayFull(at(10, 31, 8, 0), fr), 'samedi 31 octobre');
  assert.equal(rules.formatDayFull(at(10, 31, 8, 0), en), 'Saturday, October 31');
});
