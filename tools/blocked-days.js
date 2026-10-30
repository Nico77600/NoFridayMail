'use strict';

/*
 * Strict reading and validation of the BLOCKED_DAYS build variable (e.g. "3,4" = Wednesday + Thursday).
 * Values: integers 0 to 6 as in Date.getDay() (0 = Sunday ... 5 = Friday ... 6 = Saturday).
 * Variable missing or empty: default [5]. Any other invalid value fails the build.
 * The 7 days cannot all be blocked (no send would be possible any more).
 */
const DEFAULT_BLOCKED_DAYS = [5];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parseBlockedDays(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_BLOCKED_DAYS.slice();
  }
  const parts = String(raw).split(',').map((p) => p.trim());
  const days = [];
  for (const part of parts) {
    if (!/^[0-6]$/.test(part)) {
      throw new Error(
        `BLOCKED_DAYS is invalid: "${raw}". Expected: integers from 0 (Sunday) to 6 (Saturday) separated by commas, e.g. 3,4.`
      );
    }
    const n = Number(part);
    if (days.indexOf(n) !== -1) {
      throw new Error(`BLOCKED_DAYS is invalid: "${raw}" (day ${n} is duplicated).`);
    }
    days.push(n);
  }
  if (days.length === 7) {
    throw new Error('BLOCKED_DAYS is invalid: the 7 days cannot all be blocked.');
  }
  return days.sort((a, b) => a - b);
}

/**
 * Strict reading and validation of WORKING_DAYS (PROPOSED working days, e.g. "1,2,3,4,5").
 * Same rules as BLOCKED_DAYS (integers 0 to 6, no duplicates); at least one day, all 7 are allowed.
 * Missing or empty: default [1,2,3,4,5].
 */
const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];

function parseWorkingDays(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_WORKING_DAYS.slice();
  }
  const days = [];
  for (const part of String(raw).split(',').map((p) => p.trim())) {
    if (!/^[0-6]$/.test(part)) {
      throw new Error(
        `WORKING_DAYS is invalid: "${raw}". Expected: integers from 0 (Sunday) to 6 (Saturday) separated by commas, e.g. 1,2,3,4,5.`
      );
    }
    const n = Number(part);
    if (days.indexOf(n) !== -1) {
      throw new Error(`WORKING_DAYS is invalid: "${raw}" (day ${n} is duplicated).`);
    }
    days.push(n);
  }
  return days.sort((a, b) => a - b);
}

function describeBlockedDays(days) {
  return `${days.map((d) => DAY_NAMES[d]).join(', ')} (${JSON.stringify(days)})`;
}

module.exports = {
  parseBlockedDays,
  parseWorkingDays,
  describeBlockedDays,
  DEFAULT_BLOCKED_DAYS,
  DEFAULT_WORKING_DAYS
};
