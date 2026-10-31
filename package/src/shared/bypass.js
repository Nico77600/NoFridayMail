'use strict';

/*
 * Justified exceptional send: contract of the X-NoFriday-Bypass header (pure functions, no Office dependency).
 *
 *   X-NoFriday-Bypass: v1; <encoded justification>
 *
 * The justification is cleaned (leading and trailing spaces removed, inner whitespace and line breaks collapsed
 * to a single space) then percent-encoded: only non-ASCII characters, control characters, ";" and "%" are
 * encoded (UTF-8, like encodeURIComponent). The rest of printable ASCII, spaces included, stays readable:
 * an accented letter such as e-acute becomes "%C3%A9". The value therefore fits on a single ASCII line with
 * no stray ";" (the ";" separates the version from the text).
 *
 * Justification quality (validateJustification): length, words of 3 letters, distinct letters, no repeated
 * character. This is a user-side check, deliberately bypassable by a determined human: the guarantee is
 * server-side (group authorisation + logging).
 *
 * Version 2 (MFA step, `bypass.mfa.required`): `v2; <encoded justification>; r=<receipt>`. The receipt
 * `<id 12>.<ts 10 digits>.<signature 22>` is issued by the API (POST /api/bypass) after validating an Entra token
 * with an authentication context (MFA). The add-in CANNOT verify the signature (no client-side secret): it only
 * checks the shape and the date; the guarantee is server-side (API log, receipt verification with
 * tools/verify-receipt.js, correlation).
 *
 * Authorisation and audit are SERVER-SIDE (Exchange transport rule, Purview): this module decides nothing,
 * it builds and reads back the header. This file is bundled into launchevent.js: ES5 only.
 */

var HEADER_NAME = 'X-NoFriday-Bypass';
// Client-side fallback channel: item.sessionData (Mailbox 1.11), shared between the task pane and the event runtime.
var SESSION_KEY = 'nfm-bypass';
var VERSION_PREFIX = 'v1; ';
var VERSION2_PREFIX = 'v2; ';
var RECEIPT_PATTERN = /^[A-Za-z0-9_-]{12}\.\d{10}\.[A-Za-z0-9_-]{22}$/;
var RECEIPT_MAX_SKEW_SECONDS = 86400; // one day either side of the workstation clock
var AUTH_CONTEXT_PATTERN = /^c([1-9]|[1-9][0-9])$/;

// Defaults (exceptional send disabled), same as config.js without injection.
// minWords: number of words of at least 3 letters; minDistinctChars: distinct letters (case-insensitive).
var DEFAULTS = { enabled: false, minLength: 20, maxLength: 200, minWords: 3, minDistinctChars: 6 };

// Letters: basic Latin, Latin-1 (without multiplication and division signs) and Latin Extended-A / B (accented
// letters, ligatures...). No \p{L} in ES5: explicit ranges, written as \u escapes so the bundle stays ASCII.
var LETTER = 'A-Za-z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u024f';
var LETTERS_GLOBAL = new RegExp('[' + LETTER + ']', 'g');
var SAME_CHAR_RUN = /([\s\S])\1{4,}/; // same character more than 4 times in a row

/** Complete settings from a partial (or missing) object: enabled is true only when exactly true. */
function normalizeSettings(raw) {
  var source = raw && typeof raw === 'object' ? raw : {};
  function intOr(value, fallback, min) {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value && value >= min ? value : fallback;
  }
  var settings = {
    enabled: source.enabled === true,
    minLength: intOr(source.minLength, DEFAULTS.minLength, 1),
    maxLength: intOr(source.maxLength, DEFAULTS.maxLength, 1),
    minWords: intOr(source.minWords, DEFAULTS.minWords, 0),
    minDistinctChars: intOr(source.minDistinctChars, DEFAULTS.minDistinctChars, 0)
  };
  // MFA step (optional): the mfa key exists only when the environment defines it.
  if (source.mfa && typeof source.mfa === 'object') {
    settings.mfa = {
      required: source.mfa.required === true,
      tenantId: typeof source.mfa.tenantId === 'string' ? source.mfa.tenantId : '',
      clientId: typeof source.mfa.clientId === 'string' ? source.mfa.clientId : '',
      authContext:
        typeof source.mfa.authContext === 'string' && AUTH_CONTEXT_PATTERN.test(source.mfa.authContext)
          ? source.mfa.authContext
          : 'c1'
    };
  }
  return settings;
}

/** True if the environment requires the MFA step (API receipt): version 1 is then no longer accepted. */
function mfaRequired(settings) {
  return !!(settings && settings.enabled && settings.mfa && settings.mfa.required === true);
}

/** Claims to request for the authentication context (acrs), as JSON: required by the task pane auth client and by the API. */
function acrsClaims(authContext) {
  return JSON.stringify({ access_token: { acrs: { essential: true, value: authContext } } });
}

/** Receipt shape: "<id 12>.<ts 10 digits>.<signature 22>". */
function isReceiptFormat(receipt) {
  return typeof receipt === 'string' && RECEIPT_PATTERN.test(receipt);
}

/** True if the receipt has the right shape and a date (seconds) within one day of `nowMs`. */
function isReceiptCurrent(receipt, nowMs) {
  if (!isReceiptFormat(receipt)) {
    return false;
  }
  var ts = parseInt(receipt.split('.')[1], 10);
  return Math.abs(ts - nowMs / 1000) <= RECEIPT_MAX_SKEW_SECONDS;
}

/** Cleaned justification: text, inner whitespace (line breaks included) collapsed to one space, edges trimmed. */
function normalizeJustification(text) {
  if (text === null || text === undefined) {
    return '';
  }
  return String(text).replace(/\s+/g, ' ').replace(/^ | $/g, '');
}

// Encodes a run of non-ASCII / control characters as UTF-8; a lone half of a surrogate pair
// (which would throw URIError) becomes U+FFFD.
function encodeRun(run) {
  try {
    return encodeURIComponent(run);
  } catch (e) {
    return run.replace(/[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]|[^\ud800-\udfff]+/g, function (part) {
      return /^[\ud800-\udfff]$/.test(part) ? '%EF%BF%BD' : encodeURIComponent(part);
    });
  }
}

/** Cleaned then encoded justification (without the version prefix). */
function encodeJustification(text) {
  return normalizeJustification(text).replace(/[^\x20-\x7e]+|[;%]/g, encodeRun);
}

/** Full header value: "v1; <encoded justification>". */
function buildHeaderValue(text) {
  return VERSION_PREFIX + encodeJustification(text);
}

/** Full v2 header value: "v2; <encoded justification>; r=<receipt>". */
function buildHeaderValueV2(text, receipt) {
  return VERSION2_PREFIX + encodeJustification(text) + '; r=' + receipt;
}

function decodeText(encoded) {
  try {
    return normalizeJustification(decodeURIComponent(encoded));
  } catch (e) {
    return null;
  }
}

/**
 * Reads back a header value. Returns { version: 'v1', justification } or, for version 2,
 * { version: 'v2', justification, receipt } (cleaned justification), or null if the value is not of the form
 * "v1; <encoded text>" nor "v2; <encoded text>; r=<receipt>". The receipt shape is not checked here
 * (see isReceiptFormat / isReceiptCurrent).
 */
function parseHeaderValue(value) {
  if (typeof value !== 'string') {
    return null;
  }
  // A header read back may have lost its trailing space or gained edge whitespace: only the edges are tolerated.
  var trimmed = value.replace(/^\s+/, '');
  if (trimmed.indexOf(VERSION2_PREFIX) === 0) {
    // The encoded text contains no ";": the first "; r=" separates the receipt.
    var match = /^v2; ([^;]*); r=(\S+)\s*$/.exec(trimmed);
    var text2 = match ? decodeText(match[1]) : null;
    return text2 === null ? null : { version: 'v2', justification: text2, receipt: match[2] };
  }
  if (trimmed.indexOf(VERSION_PREFIX) !== 0) {
    return null;
  }
  var text = decodeText(trimmed.substring(VERSION_PREFIX.length));
  return text === null ? null : { version: 'v1', justification: text };
}

/** Decoded justification (helper for documentation and tests); null if the value is malformed. */
function decodeHeaderValue(value) {
  var parsed = parseHeaderValue(value);
  return parsed ? parsed.justification : null;
}

/** Number of words (separated by spaces) containing at least 3 letters. */
function countWords(text) {
  var count = 0;
  var tokens = text.split(' ');
  var i;
  for (i = 0; i < tokens.length; i += 1) {
    var letters = tokens[i].match(LETTERS_GLOBAL);
    if (letters && letters.length >= 3) {
      count += 1;
    }
  }
  return count;
}

/** Number of distinct letters, case-insensitive. */
function countDistinctLetters(text) {
  var letters = text.toLowerCase().match(LETTERS_GLOBAL) || [];
  var seen = {};
  var count = 0;
  var i;
  for (i = 0; i < letters.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(seen, letters[i])) {
      seen[letters[i]] = true;
      count += 1;
    }
  }
  return count;
}

/**
 * Justification validation (task pane input AND header read back by the handler: same rule).
 * Returns { valid, code, length, text, words, distinct }; code, in this order of checks:
 *   'empty'    nothing after cleaning
 *   'short'    fewer than minLength characters        'long'     more than maxLength characters
 *   'repeat'   the same character more than 4 times in a row ("aaaaa", ".....")
 *   'words'    fewer than minWords words of at least 3 letters
 *   'distinct' fewer than minDistinctChars distinct letters ("aaaa bbbb" is still refused)
 *   'ok'
 * `settings` = { minLength, maxLength, minWords, minDistinctChars } (see normalizeSettings).
 * `text` is the cleaned justification.
 */
function validateJustification(input, settings) {
  var s = normalizeSettings(settings);
  var text = normalizeJustification(input);
  var length = text.length;
  var words = countWords(text);
  var distinct = countDistinctLetters(text);
  var code = 'ok';
  if (length === 0) {
    code = 'empty';
  } else if (length < s.minLength) {
    code = 'short';
  } else if (length > s.maxLength) {
    code = 'long';
  } else if (SAME_CHAR_RUN.test(text.toLowerCase())) {
    code = 'repeat';
  } else if (words < s.minWords) {
    code = 'words';
  } else if (distinct < s.minDistinctChars) {
    code = 'distinct';
  }
  return { valid: code === 'ok', code: code, length: length, text: text, words: words, distinct: distinct };
}

/**
 * Value of a header in the object returned by internetHeaders.getAsync, compared case-insensitively on the name
 * (hosts may normalise header names). undefined if absent.
 */
function lookupHeader(map, name) {
  var wanted = String(name).toLowerCase();
  var key;
  if (!map || typeof map !== 'object') {
    return undefined;
  }
  for (key in map) {
    if (Object.prototype.hasOwnProperty.call(map, key) && key.toLowerCase() === wanted) {
      return map[key];
    }
  }
  return undefined;
}

/**
 * Classifies a header (or sessionData) value: 'absent' (nothing), 'malformed' (unreadable, wrong version for
 * an MFA environment, weak justification), 'receipt' (v2 whose receipt is malformed or more than a day old),
 * 'ok'. Used for the handler decision AND for the support code in the dialog.
 */
function classifyHeaderValue(value, settings, nowMs) {
  if (value === undefined || value === null || (typeof value === 'string' && value.replace(/\s/g, '') === '')) {
    return 'absent';
  }
  var parsed = parseHeaderValue(value);
  if (!parsed) {
    return 'malformed';
  }
  var now = typeof nowMs === 'number' ? nowMs : new Date().getTime();
  if (parsed.version === 'v2' && !isReceiptCurrent(parsed.receipt, now)) {
    return 'receipt';
  }
  if (mfaRequired(settings) && parsed.version !== 'v2') {
    return 'malformed';
  }
  return validateJustification(parsed.justification, settings).valid ? 'ok' : 'malformed';
}

/**
 * True if the value is well formed AND the decoded justification passes validateJustification.
 * Without the MFA step, "v1; ..." or "v2; ...; r=<receipt>" are accepted; with bypass.mfa.required, ONLY version 2
 * is, with a receipt of the right shape dated less than a day ago (nowMs: workstation time, in milliseconds).
 * The receipt signature cannot be verified here (no client-side secret).
 */
function isAcceptableHeaderValue(value, settings, nowMs) {
  return classifyHeaderValue(value, settings, nowMs) === 'ok';
}

module.exports = {
  HEADER_NAME: HEADER_NAME,
  SESSION_KEY: SESSION_KEY,
  lookupHeader: lookupHeader,
  classifyHeaderValue: classifyHeaderValue,
  VERSION_PREFIX: VERSION_PREFIX,
  VERSION2_PREFIX: VERSION2_PREFIX,
  RECEIPT_PATTERN: RECEIPT_PATTERN,
  AUTH_CONTEXT_PATTERN: AUTH_CONTEXT_PATTERN,
  DEFAULTS: DEFAULTS,
  normalizeSettings: normalizeSettings,
  normalizeJustification: normalizeJustification,
  encodeJustification: encodeJustification,
  buildHeaderValue: buildHeaderValue,
  buildHeaderValueV2: buildHeaderValueV2,
  mfaRequired: mfaRequired,
  acrsClaims: acrsClaims,
  isReceiptFormat: isReceiptFormat,
  isReceiptCurrent: isReceiptCurrent,
  parseHeaderValue: parseHeaderValue,
  decodeHeaderValue: decodeHeaderValue,
  isAcceptableHeaderValue: isAcceptableHeaderValue,
  validateJustification: validateJustification,
  countWords: countWords,
  countDistinctLetters: countDistinctLetters
};
