'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseBlockedDays, parseWorkingDays, describeBlockedDays } = require('../package/tools/blocked-days');
const config = require('../package/src/shared/config');
const rules = require('../package/src/shared/rules');
const handlers = require('../package/src/launchevent/handlers');

const at = (month, day, hour = 12, minute = 0) => new Date(2026, month - 1, day, hour, minute, 0, 0);

test('BLOCKED_DAYS: missing or empty -> default [5]', () => {
  for (const raw of [undefined, null, '', '   ']) {
    assert.deepEqual(parseBlockedDays(raw), [5]);
  }
});

test('BLOCKED_DAYS: valid values (sorted, spaces tolerated)', () => {
  assert.deepEqual(parseBlockedDays('3,4'), [3, 4]);
  assert.deepEqual(parseBlockedDays(' 4 , 3 '), [3, 4]);
  assert.deepEqual(parseBlockedDays('0'), [0]);
  assert.deepEqual(parseBlockedDays('0,1,2,3,4,6'), [0, 1, 2, 3, 4, 6]);
  assert.equal(describeBlockedDays([3, 4]), 'Wednesday, Thursday ([3,4])');
});

test('BLOCKED_DAYS: invalid values rejected', () => {
  for (const raw of ['7', '-1', '3.5', 'a', '3,', ',3', '3;4', '1e1', '03', '3,3', '0,1,2,3,4,5,6']) {
    assert.throws(() => parseBlockedDays(raw), /BLOCKED_DAYS is invalid/, raw);
  }
});

test('the default [5] applies when __BLOCKED_DAYS__ is not defined (Node)', () => {
  assert.deepEqual(config.blockedDays, [5]);
});

// Test configuration: Wednesday + Thursday blocked, Friday free.
function withLabDays(fn) {
  const saved = config.blockedDays;
  config.blockedDays = [3, 4];
  try {
    fn();
  } finally {
    config.blockedDays = saved;
  }
}

test('blocked days 3,4: date rules', () => {
  withLabDays(() => {
    assert.equal(rules.isBlocked(at(10, 28), config), true, 'Wednesday');
    assert.equal(rules.isBlocked(at(10, 29), config), true, 'Thursday');
    assert.equal(rules.isBlocked(at(10, 30), config), false, 'Friday free');
    assert.equal(rules.blockedDaysLabel(config), 'le mercredi et le jeudi');
    const s = rules.nextAllowedSuggestions(at(10, 28, 10, 0), config);
    assert.deepEqual(s.first, at(10, 30, 8, 0), 'Wednesday -> Thursday blocked -> Friday');
    assert.deepEqual(s.second, at(11, 2, 8, 0), 'then Monday (weekend skipped)');
  });
});

test('blocked days 3,4: the custom-date message names the chosen day, not "Friday"', () => {
  withLabDays(() => {
    const now = at(10, 26, 10, 0);
    const wed = rules.validateCustomDate(at(10, 28, 9, 0), now, config);
    assert.equal(wed.code, 'blocked');
    assert.equal(wed.message, "Le mercredi n'est pas autorisé, choisissez un autre jour");
    const thu = rules.validateCustomDate(rules.parseDateTimeLocal('2026-10-29T23:59'), now, config);
    assert.equal(thu.message, "Le jeudi n'est pas autorisé, choisissez un autre jour");
    assert.equal(rules.validateCustomDate(at(10, 30, 9, 0), now, config).valid, true, 'Friday allowed');
  });
});

test('blocked days 3,4: email and meeting handlers', () => {
  withLabDays(() => {
    const run = (fn, now) => {
      const realDate = Date;
      // Frozen clock without relying on t.mock: Date subclass.
      global.Date = class extends realDate {
        constructor(...args) {
          super(...(args.length ? args : [now.getTime()]));
        }
        static now() {
          return now.getTime();
        }
      };
      let result = null;
      try {
        global.Office = {
          context: {
            mailbox: { item: {} },
            requirements: { isSetSupported: (n, v) => v === '1.12' }
          },
          AsyncResultStatus: { Succeeded: 'succeeded', Failed: 'failed' }
        };
        fn({ completed: (o) => { result = o; } });
      } finally {
        global.Date = realDate;
      }
      return result;
    };

    const wed = run(handlers.onMessageSendHandler, at(10, 28, 10, 0));
    assert.equal(wed.allowEvent, false);
    assert.match(wed.errorMessage, /interdit le mercredi et le jeudi/);
    assert.doesNotMatch(wed.errorMessage, /vendredi/);

    assert.deepEqual(run(handlers.onMessageSendHandler, at(10, 30, 10, 0)), { allowEvent: true });

    const appt = run(handlers.onAppointmentSendHandler, at(10, 29, 10, 0));
    assert.equal(appt.allowEvent, false);
    assert.match(appt.errorMessage, /le mercredi et le jeudi/);
    assert.deepEqual(run(handlers.onAppointmentSendHandler, at(10, 30, 10, 0)), { allowEvent: true });
  });
});

test('WORKING_DAYS: missing or empty -> default [1,2,3,4,5]; valid values sorted', () => {
  for (const raw of [undefined, null, '', '  ']) {
    assert.deepEqual(parseWorkingDays(raw), [1, 2, 3, 4, 5]);
  }
  assert.deepEqual(parseWorkingDays('1,2,3'), [1, 2, 3]);
  assert.deepEqual(parseWorkingDays(' 5 , 1 '), [1, 5]);
  assert.deepEqual(parseWorkingDays('0,1,2,3,4,5,6'), [0, 1, 2, 3, 4, 5, 6], 'all 7 days are allowed');
  assert.deepEqual(parseWorkingDays('6'), [6]);
});

test('WORKING_DAYS: invalid values rejected (build fails)', () => {
  for (const raw of ['7', '-1', '1.5', 'a', '1,', ',1', '1;2', '1,1', '01']) {
    assert.throws(() => parseWorkingDays(raw), /WORKING_DAYS is invalid/, raw);
  }
});

test('default config: workingDays [1,2,3,4,5] (Node, no DefinePlugin)', () => {
  assert.deepEqual(config.workingDays, [1, 2, 3, 4, 5]);
  assert.deepEqual(config.forLang('fr').workingDays, [1, 2, 3, 4, 5]);
});
