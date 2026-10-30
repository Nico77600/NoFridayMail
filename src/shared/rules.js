'use strict';

/*
 * NoFridayMail date rules: pure functions, no Office dependency.
 * All dates are interpreted in the client's local time zone.
 * Deliberately ES5 (see config.js).
 */

function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, function (match, key) {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match;
  });
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/** True if the day of `date` is in cfg.blockedDays. */
function isBlocked(date, cfg) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return false;
  }
  return cfg.blockedDays.indexOf(date.getDay()) !== -1;
}

/**
 * Normalises a delayed-delivery value. Office returns 0 when no date is set,
 * otherwise a Date. Returns a valid Date or null.
 */
function toDate(value) {
  if (value === 0 || value === null || value === undefined || value === '') {
    return null;
  }
  var d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Effective delivery time: the delay if set and in the future, otherwise now.
 */
function effectiveDeliveryTime(now, delay) {
  var d = toDate(delay);
  if (d && d.getTime() > now.getTime()) {
    return d;
  }
  return now;
}

/** True if `delay` is a delayed delivery that is set AND in the future (0, null, Date(0) and past dates: no). */
function hasFutureDelay(delay, now) {
  var d = toDate(delay);
  return !!d && d.getTime() > now.getTime();
}

/** Evaluates a send: { blocked, effective, delayed }. */
function evaluateSend(now, delay, cfg) {
  var effective = effectiveDeliveryTime(now, delay);
  return {
    blocked: isBlocked(effective, cfg),
    effective: effective,
    delayed: effective !== now
  };
}

/** Date at `base` + `dayOffset` days, at the configured send time. */
function atSendTime(base, dayOffset, cfg) {
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate() + dayOffset,
    cfg.sendHour,
    cfg.sendMinute || 0,
    0,
    0
  );
}

/** True if the day of `date` is a working day (cfg.workingDays; every day if undefined). */
function isWorkingDay(date, cfg) {
  if (!cfg.workingDays) {
    return true;
  }
  return cfg.workingDays.indexOf(date.getDay()) !== -1;
}

/** PROPOSED day: working and not blocked (weekends are not blocked, they are simply never proposed). */
function isProposable(date, cfg) {
  return isWorkingDay(date, cfg) && !isBlocked(date, cfg);
}

/**
 * Scheduling suggestions from a reference date: the first two proposed days (working and not blocked)
 * strictly after the reference, at the configured send time.
 * Returns { first, second }; second is null when only one day exists within the horizon, and both
 * are null when no day can be proposed (e.g. every working day is blocked).
 * `horizonDays` (default 21) bounds the search so the loop always ends.
 */
function nextAllowedSuggestions(ref, cfg, horizonDays) {
  var limit = horizonDays || 21;
  var found = [];
  var offset;
  for (offset = 1; offset <= limit && found.length < 2; offset += 1) {
    var day = atSendTime(ref, offset, cfg);
    if (isProposable(day, cfg)) {
      found.push(day);
    }
  }
  return { first: found[0] || null, second: found[1] || null };
}

/**
 * Reads the value of an <input type="datetime-local"> ("YYYY-MM-DDTHH:mm", with or without
 * seconds) as a local date. Returns null when empty or invalid
 * (February 31, etc.).
 */
function parseDateTimeLocal(text) {
  var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(text || ''));
  if (!m) {
    return null;
  }
  var y = +m[1];
  var mo = +m[2] - 1;
  var d = +m[3];
  var h = +m[4];
  var mi = +m[5];
  var s = m[6] ? +m[6] : 0;
  var date = new Date(y, mo, d, h, mi, s, 0);
  if (
    date.getFullYear() !== y || date.getMonth() !== mo || date.getDate() !== d ||
    date.getHours() !== h || date.getMinutes() !== mi
  ) {
    return null;
  }
  return date;
}

/**
 * Validates a custom scheduling date.
 * Rejects: invalid value, blocked day (Friday by default), past or present date.
 * Returns { valid, code, message }; code = null | 'invalid' | 'blocked' | 'past'.
 */
function validateCustomDate(date, now, cfg) {
  var s = cfg.strings;
  var d = toDate(date);
  if (!d) {
    return { valid: false, code: 'invalid', message: s.tpInvalidCustom };
  }
  if (isBlocked(d, cfg)) {
    return {
      valid: false,
      code: 'blocked',
      message: fill(s.tpBlockedCustom, { day: s.dayNames[d.getDay()] })
    };
  }
  if (d.getTime() <= now.getTime()) {
    return { valid: false, code: 'past', message: s.tpPastCustom };
  }
  return { valid: true, code: null, message: '' };
}

/**
 * Local time: "08:00" (24 h) or "8:00 AM" if cfg.strings.time12h.
 * Without cfg: 24 h.
 */
function formatTime(date, cfg) {
  var h = date.getHours();
  var m = pad2(date.getMinutes());
  if (cfg && cfg.strings.time12h) {
    return (h % 12 === 0 ? 12 : h % 12) + ':' + m + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  return pad2(h) + ':' + m;
}

/** Configured send time, e.g. "08:00" (fr) or "8:00 AM" (en). */
function sendTimeLabel(cfg) {
  return formatTime(new Date(2000, 0, 1, cfg.sendHour, cfg.sendMinute || 0, 0, 0), cfg);
}

/**
 * Full date in the language of cfg.strings, without Intl:
 * "Saturday, October 31, 2026 at 8:00 AM" (en) or its French equivalent.
 */
function formatDate(date, cfg) {
  var s = cfg.strings;
  var day = date.getDate();
  return fill(s.dateFormat, {
    weekday: s.dayNames[date.getDay()],
    day: day + (day === 1 ? s.firstSuffix : ''),
    month: s.monthNames[date.getMonth()],
    year: date.getFullYear(),
    time: formatTime(date, cfg)
  });
}

/** Blocked-day phrase, e.g. "on Fridays" / "on Fridays and Saturdays" (en) or the French equivalent. */
function blockedDaysLabel(cfg) {
  var s = cfg.strings;
  var parts = [];
  var i;
  for (i = 0; i < cfg.blockedDays.length; i += 1) {
    parts.push(fill(s.daysPrefix, { day: s.dayNames[cfg.blockedDays[i]] }));
  }
  return s.daysIntro + parts.join(s.daysAnd);
}

/** Local calendar day as a "YYYY-MM-DD" string (stable key for the day cards). */
function dayKey(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

/** Local midnight of the day of `date`. */
function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

/** "HH:MM" -> { key, hour, minute } or null. */
function parseSlotTime(text) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(text === undefined || text === null ? '' : text));
  if (!m || +m[1] > 23 || +m[2] > 59) {
    return null;
  }
  return { key: pad2(+m[1]) + ':' + m[2], hour: +m[1], minute: +m[2] };
}

/** Valid configured time slots (cfg.slotTimes), de-duplicated and sorted. */
function slotTimesOf(cfg) {
  var out = [];
  var seen = {};
  var list = cfg.slotTimes || [];
  var i;
  for (i = 0; i < list.length; i += 1) {
    var slot = parseSlotTime(list[i]);
    if (slot && !seen[slot.key]) {
      seen[slot.key] = true;
      out.push(slot);
    }
  }
  out.sort(function (a, b) {
    return a.hour * 60 + a.minute - (b.hour * 60 + b.minute);
  });
  return out;
}

/** Local date of day `day` at the slot time. */
function slotDate(day, slot) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), slot.hour, slot.minute, 0, 0);
}

/**
 * Slots proposed for a day: those of cfg.slotTimes strictly after `now` (so no past time
 * today); none if the day is blocked. Returns [{ key, hour, minute, date }].
 */
function timeSlots(day, now, cfg) {
  var out = [];
  if (isBlocked(day, cfg)) {
    return out;
  }
  var slots = slotTimesOf(cfg);
  var i;
  for (i = 0; i < slots.length; i += 1) {
    var date = slotDate(day, slots[i]);
    if (date.getTime() > now.getTime()) {
      out.push({ key: slots[i].key, hour: slots[i].hour, minute: slots[i].minute, date: date });
    }
  }
  return out;
}

/**
 * Next proposed days from today (working and not blocked: weekends and blocked days
 * are absent; today only if a slot remains). Returns at most `count` dates at local midnight.
 */
function allowedDays(now, cfg, count) {
  var out = [];
  var offset = 0;
  var guard = (count || 10) * 4 + 21;
  while (out.length < (count || 10) && offset < guard) {
    var day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 0, 0, 0, 0);
    if (isProposable(day, cfg) && timeSlots(day, now, cfg).length > 0) {
      out.push(day);
    }
    offset += 1;
  }
  return out;
}

/** 'today' | 'tomorrow' | '' depending on the gap with `now` (in calendar days). */
function relativeDay(day, now) {
  var a = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  var b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  var diff = Math.round((a - b) / 86400000);
  return diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : '';
}

/** Short summary, e.g. "Fri, Oct 30 at 9:00 AM" (en) or the French equivalent. */
function formatSummary(date, cfg) {
  var s = cfg.strings;
  return fill(s.summaryFormat, {
    weekday: s.dayShort[date.getDay()],
    day: date.getDate(),
    month: s.monthShort[date.getMonth()],
    time: formatTime(date, cfg)
  });
}

/** Full day without time, e.g. "Saturday, October 31" (en) or the French equivalent. */
function formatDayFull(date, cfg) {
  var s = cfg.strings;
  return fill(s.dayFullFormat, {
    weekday: s.dayNames[date.getDay()],
    day: date.getDate(),
    month: s.monthNames[date.getMonth()]
  });
}

/** "Monday or Tuesday"; a single name if there is one suggestion or both days share a name; '' with no day. */
function suggestionsLabel(suggestions, cfg) {
  var s = cfg.strings;
  if (!suggestions.first) {
    return '';
  }
  var a = s.dayNames[suggestions.first.getDay()];
  if (!suggestions.second) {
    return a;
  }
  var b = s.dayNames[suggestions.second.getDay()];
  if (a === b) {
    return a;
  }
  return fill(s.suggestionOr, { a: a, b: b });
}

module.exports = {
  fill: fill,
  isBlocked: isBlocked,
  toDate: toDate,
  effectiveDeliveryTime: effectiveDeliveryTime,
  hasFutureDelay: hasFutureDelay,
  evaluateSend: evaluateSend,
  atSendTime: atSendTime,
  isWorkingDay: isWorkingDay,
  isProposable: isProposable,
  nextAllowedSuggestions: nextAllowedSuggestions,
  parseDateTimeLocal: parseDateTimeLocal,
  validateCustomDate: validateCustomDate,
  formatTime: formatTime,
  sendTimeLabel: sendTimeLabel,
  formatDate: formatDate,
  dayKey: dayKey,
  startOfDay: startOfDay,
  parseSlotTime: parseSlotTime,
  slotTimesOf: slotTimesOf,
  slotDate: slotDate,
  timeSlots: timeSlots,
  allowedDays: allowedDays,
  relativeDay: relativeDay,
  formatSummary: formatSummary,
  formatDayFull: formatDayFull,
  formatDateFr: formatDate, // alias of formatDate
  blockedDaysLabel: blockedDaysLabel,
  suggestionsLabel: suggestionsLabel
};
