'use strict';

// X-NoFriday-Bypass header contract: cleanup, percent-encoding, decoding, validation.
const test = require('node:test');
const assert = require('node:assert/strict');

const bypass = require('../src/shared/bypass');

test('constants: header name and version prefix', () => {
  assert.equal(bypass.HEADER_NAME, 'X-NoFriday-Bypass');
  assert.equal(bypass.VERSION_PREFIX, 'v1; ');
});

test('normalizeJustification: edges trimmed, whitespace and line breaks collapsed to a single space', () => {
  assert.equal(bypass.normalizeJustification('  Bonjour   le\tmonde \r\n suite\n\n fin  '), 'Bonjour le monde suite fin');
  assert.equal(bypass.normalizeJustification('a b c d'), 'a b c d', 'non-breaking and Unicode spaces included');
  assert.equal(bypass.normalizeJustification('   \n\t '), '');
  assert.equal(bypass.normalizeJustification(null), '');
  assert.equal(bypass.normalizeJustification(undefined), '');
  assert.equal(bypass.normalizeJustification(42), '42');
});

test('encoding: reference example, readable French text', () => {
  assert.equal(bypass.buildHeaderValue('Réponse urgente client'), 'v1; R%C3%A9ponse urgente client');
  assert.equal(bypass.encodeJustification('Réponse urgente client'), 'R%C3%A9ponse urgente client');
  assert.equal(bypass.buildHeaderValue('  Réponse   urgente\nclient  '), 'v1; R%C3%A9ponse urgente client');
  assert.equal(
    bypass.encodeJustification("Panne chez l'hébergeur : à traiter avant 17 h (n° 4521)"),
    "Panne chez l'h%C3%A9bergeur : %C3%A0 traiter avant 17 h (n%C2%B0 4521)"
  );
});

test('encoding: ";" and "%" always encoded, printable ASCII kept', () => {
  assert.equal(bypass.encodeJustification('a;b'), 'a%3Bb');
  assert.equal(bypass.encodeJustification('100% sûr'), '100%25 s%C3%BBr');
  assert.equal(bypass.encodeJustification('déjà %C3%A9 encodé'), 'd%C3%A9j%C3%A0 %25C3%25A9 encod%C3%A9', 'no double decoding');
  const printable = ' !"#$&\'()*+,-./0123456789:<=>?@ABCXYZ[\\]^_`abcxyz{|}~';
  assert.equal(bypass.encodeJustification(printable), printable.replace(/^ /, ''));
});

test('encoding: non-ASCII (accents, symbols, CJK, emoji), control characters and lone surrogates', () => {
  assert.equal(bypass.encodeJustification('€ – “quote”'), '%E2%82%AC %E2%80%93 %E2%80%9Cquote%E2%80%9D');
  assert.equal(bypass.encodeJustification('日本語'), '%E6%97%A5%E6%9C%AC%E8%AA%9E');
  assert.equal(bypass.encodeJustification('ok 😀'), 'ok %F0%9F%98%80', 'surrogate pair = one 4-byte UTF-8 character');
  assert.equal(bypass.encodeJustification('a\u0001b\u007fc'), 'a%01b%7Fc');
  assert.equal(bypass.encodeJustification('lone \ud83d here'), 'lone %EF%BF%BD here', 'lone surrogate half -> U+FFFD, no exception');
  assert.equal(bypass.encodeJustification('\ude00 x'), '%EF%BF%BD x');
  assert.equal(bypass.encodeJustification('é\ud83d'), '%C3%A9%EF%BF%BD');
});

test('produced value: a single printable ASCII line, a single ";" (the version one)', () => {
  const samples = [
    'Réponse urgente à un client',
    'ligne 1\nligne 2\r\nligne 3',
    'a;b;c ; d',
    '日本語 + emoji 😀 + 100%',
    '\u0000\u001f\u007f\u0085  ﻿',
    'x'.repeat(200)
  ];
  for (const sample of samples) {
    const value = bypass.buildHeaderValue(sample);
    assert.match(value, /^v1; [\x20-\x7e]*$/, JSON.stringify(sample));
    assert.equal(value.split(';').length, 2, 'a single ";"');
    assert.doesNotMatch(value, /[\r\n]/);
  }
});

test('decoding: round trip on varied (cleaned) texts', () => {
  const samples = [
    'Réponse urgente client',
    'Panne chez l’hébergeur ; à traiter avant 17 h (100% sûr)',
    '日本語 😀 émoji',
    'texte avec "guillemets", <balises> & {accolades}',
    '%41 reste %41'
  ];
  for (const sample of samples) {
    assert.equal(bypass.decodeHeaderValue(bypass.buildHeaderValue(sample)), sample, sample);
  }
  assert.equal(bypass.decodeHeaderValue(bypass.buildHeaderValue(' a \n b ')), 'a b', 'decoding returns the cleaned text');
  assert.equal(bypass.decodeHeaderValue('v1; R%C3%A9ponse urgente client'), 'Réponse urgente client');
  assert.deepEqual(bypass.parseHeaderValue('v1; R%C3%A9ponse'), { version: 'v1', justification: 'Réponse' });
  assert.equal(bypass.decodeHeaderValue('  v1; abc'), 'abc', 'leading spaces tolerated');
});

test('decoding: malformed values -> null', () => {
  for (const bad of ['', 'v1;', 'v1', 'v2; abc', 'V1; abc', 'v1;abc', ' ; abc', 'abc', 'v1; %', 'v1; %E0%A4%A', 'v1; %GG', null, undefined, 12, {}]) {
    assert.equal(bypass.parseHeaderValue(bad), null, String(bad));
    assert.equal(bypass.decodeHeaderValue(bad), null, String(bad));
    assert.equal(bypass.isAcceptableHeaderValue(bad, 1), false, String(bad));
  }
});

const SETTINGS = { minLength: 20, maxLength: 200, minWords: 3, minDistinctChars: 6 };

test('isAcceptableHeaderValue: same rule as the input, applied to the decoded justification', () => {
  const v = (text) => bypass.buildHeaderValue(text);
  assert.equal(bypass.isAcceptableHeaderValue(v('Réponse urgente au client Durand'), SETTINGS), true);
  assert.equal(bypass.isAcceptableHeaderValue(v('Panne reseau client!'), SETTINGS), true, 'exactly 20 characters');
  assert.equal(bypass.isAcceptableHeaderValue(v('Panne reseau client'), SETTINGS), false, '19 characters');
  // length of the decoded justification, not of the encoded header (each accent takes 6 encoded characters)
  assert.equal(bypass.isAcceptableHeaderValue(v('éèê àçù ôîû œuvres demain'), SETTINGS), true, 'accents counted as letters');
  assert.equal(bypass.isAcceptableHeaderValue(v('é'.repeat(15)), { minLength: 15, minWords: 0, minDistinctChars: 0 }), false, 'repetition');
  // weak justification: rejected even if the header is well formed
  for (const weak of ['.', 'aaaaaaaaaaaaaaaaaaaa', 'ok ok ok ok ok ok ok', 'test test test', 'xxxxx yyyyy zzzzz www', '.................... ....']) {
    assert.equal(bypass.isAcceptableHeaderValue(v(weak), SETTINGS), false, weak);
  }
  assert.equal(bypass.isAcceptableHeaderValue('v1; ' + '%20'.repeat(30), SETTINGS), false, 'spaces only = empty');
  assert.equal(bypass.isAcceptableHeaderValue('v1; ' + 'ab c%20'.repeat(10), SETTINGS), false, 'words too short');
  assert.equal(bypass.isAcceptableHeaderValue(v('Réponse urgente au client Durand '.repeat(7)), SETTINGS), false, 'too long as well');
  assert.equal(bypass.isAcceptableHeaderValue(v('Réponse urgente au client Durand'), undefined), true, 'default settings');
  assert.equal(bypass.isAcceptableHeaderValue(v('Réponse urgente'), undefined), false, 'default: 20 characters minimum');
});

test('validateJustification: empty, short, long, ok (cleaned length)', () => {
  assert.deepEqual(bypass.validateJustification('', SETTINGS), { valid: false, code: 'empty', length: 0, text: '', words: 0, distinct: 0 });
  assert.equal(bypass.validateJustification('   \n ', SETTINGS).code, 'empty');
  assert.equal(bypass.validateJustification(null, SETTINGS).code, 'empty');
  assert.equal(bypass.validateJustification('Panne reseau client', SETTINGS).code, 'short');
  const ok = bypass.validateJustification('  Panne reseau client!  ', SETTINGS);
  assert.equal(ok.valid, true);
  assert.equal(ok.code, 'ok');
  assert.equal(ok.length, 20);
  assert.equal(ok.text, 'Panne reseau client!');
  const long = 'Réponse urgente au client Durand '.repeat(7).trim();
  assert.equal(long.length, 230);
  assert.equal(bypass.validateJustification(long, SETTINGS).code, 'long');
  assert.equal(bypass.validateJustification(long.slice(0, 200), SETTINGS).valid, true, 'exactly 200 characters');
  assert.equal(bypass.validateJustification('a      b ', { minLength: 1, maxLength: 200, minWords: 0, minDistinctChars: 0 }).length, 3, 'whitespace collapsed before counting');
  assert.equal(bypass.validateJustification('Panne reseau client!', { minLength: 5, maxLength: 10 }).code, 'long');
  assert.equal(bypass.validateJustification('é😀', { minLength: 1, maxLength: 5, minWords: 0, minDistinctChars: 0 }).length, 3, 'length in UTF-16 units');
});

test('validateJustification: rejected examples (".", "aaaa...", "ok ok...", "test test test")', () => {
  const code = (text) => bypass.validateJustification(text, SETTINGS).code;
  assert.equal(code('.'), 'short');
  assert.equal(code('aaaaaaaaaaaaaaaaaaaa'), 'repeat');
  assert.equal(code('ok ok ok ok ok ok ok'), 'words', '2-letter words');
  assert.equal(code('test test test'), 'short', '14 characters');
  assert.equal(code('test test test test test'), 'distinct', 'only t, e, s');
  assert.equal(code('abab abab abab abab abab'), 'distinct');
  assert.equal(code('......................'), 'repeat');
  assert.equal(code('!!!!!! oui oui oui oui oui'), 'repeat');
  assert.equal(code('xxxxx yyyyy zzzzz wwwww'), 'repeat');
  assert.equal(code('1234 5678 9012 3456 7890'), 'words', 'digits are not letters');
  assert.equal(code('a b c d e f g h i j k l m n'), 'words', 'single letters');
});

test('validateJustification: valid examples, accents and case', () => {
  const r = (text) => bypass.validateJustification(text, SETTINGS);
  assert.equal(r('Réponse urgente au client Durand').valid, true);
  assert.equal(r('Réponse urgente au client Durand').words, 4);
  assert.equal(r('éèê àçù ôîû œuvres demain').valid, true);
  assert.equal(r('Éé Àà Çç Œœ ÿÿÿ naïve').words, 2, 'both accented words have three letters or more');
  assert.equal(bypass.countDistinctLetters('AaAa Bb'), 2, 'case ignored');
  assert.equal(bypass.countDistinctLetters('éÉ eE'), 2, 'accented e and plain e are two different letters');
  assert.equal(bypass.countDistinctLetters('œ ç ÿ ß'), 4, 'French and extended Latin letters');
  assert.equal(bypass.countWords('ab abc 123 a-b-c été'), 3, 'counts abc, a-b-c and the accented 3-letter word');
  assert.equal(bypass.countWords('日本語 русский'), 0, 'non-Latin: not counted (known limit)');
  assert.equal(bypass.countWords(''), 0);
  assert.equal(r('Merci de traiter ça maintenant svp').valid, true);
  assert.equal(r('Client bloqué en production !!!!').valid, true, 'four repetitions allowed');
  assert.equal(r('Client bloqué en production !!!!!').code, 'repeat', 'five repetitions rejected');
  assert.equal(r('CCcCC client bloqué production').code, 'repeat', 'case ignored for repetitions');
  assert.equal(r('Réponse   urgente\n\nau client Durand').valid, true, 'multi-line input');
});

test('validateJustification: configurable thresholds, 0 disables a check', () => {
  const lenient = { minLength: 5, maxLength: 200, minWords: 0, minDistinctChars: 0 };
  assert.equal(bypass.validateJustification('ok ok ok', lenient).valid, true);
  assert.equal(bypass.validateJustification('ok ok ok', { minLength: 5, maxLength: 200, minWords: 1, minDistinctChars: 0 }).code, 'words');
  assert.equal(bypass.validateJustification('Panne réseau client', { minLength: 5, maxLength: 200, minWords: 3, minDistinctChars: 20 }).code, 'distinct');
  assert.equal(bypass.validateJustification('Panne réseau client', { minLength: 5, maxLength: 200, minWords: 4, minDistinctChars: 0 }).code, 'words');
  assert.equal(bypass.validateJustification('aaaaa bbbbb', lenient).code, 'repeat', 'repetition is always rejected');
});

test('normalizeSettings: defaults, disabled unless enabled === true, invalid values ignored', () => {
  const defaults = { enabled: false, minLength: 20, maxLength: 200, minWords: 3, minDistinctChars: 6 };
  assert.deepEqual(bypass.normalizeSettings(undefined), defaults);
  assert.deepEqual(bypass.normalizeSettings(null), defaults);
  assert.deepEqual(bypass.normalizeSettings({}), defaults);
  assert.deepEqual(bypass.normalizeSettings({ enabled: true }), Object.assign({}, defaults, { enabled: true }));
  assert.deepEqual(
    bypass.normalizeSettings({ enabled: true, minLength: 30, maxLength: 100, minWords: 2, minDistinctChars: 0 }),
    { enabled: true, minLength: 30, maxLength: 100, minWords: 2, minDistinctChars: 0 }
  );
  for (const enabled of ['true', 1, 'yes', {}, [], null]) {
    assert.equal(bypass.normalizeSettings({ enabled }).enabled, false, String(enabled));
  }
  for (const bad of [0, -3, 1.5, '20', NaN, Infinity, null]) {
    assert.equal(bypass.normalizeSettings({ minLength: bad }).minLength, 20, String(bad));
  }
  for (const bad of [-1, 1.5, '3', NaN]) {
    assert.equal(bypass.normalizeSettings({ minWords: bad }).minWords, 3, String(bad));
    assert.equal(bypass.normalizeSettings({ minDistinctChars: bad }).minDistinctChars, 6, String(bad));
  }
  assert.equal(bypass.normalizeSettings('oui').enabled, false);
  assert.deepEqual(bypass.DEFAULTS, defaults);
});

test('server mirror (docs/BYPASS.md): everything the add-in accepts matches the FRIDAY-43 rule pattern', () => {
  const mirror = /^v1; .*[A-Za-z]{3,}.* .*[A-Za-z]{3,}.* .*[A-Za-z]{3,}/;
  const strict = /^(?=v1; .{20,}$)v1; .*[A-Za-z]{3,}.* .*[A-Za-z]{3,}.* .*[A-Za-z]{3,}/;
  const accepted = [
    'Réponse urgente au client Durand',
    'Panne reseau client chez nous',
    'Client bloqué en production, merci de débloquer',
    'Facture à envoyer avant la clôture bancaire',
    'Incident majeur : coupure chez Orange Business',
    'Demande du directeur général pour la presse'
  ];
  for (const text of accepted) {
    assert.equal(bypass.validateJustification(text, SETTINGS).valid, true, text);
    const value = bypass.buildHeaderValue(text);
    assert.match(value, mirror, text);
    assert.match(value, strict, text);
  }
  // The server also rejects these (not enough 3-letter words) but stays more lenient than the add-in
  // on repetitions and distinct letter count (coarse mirror).
  for (const text of ['ok ok ok ok ok ok ok', '1234 5678 9012 3456 7890', 'a b c d e f g h i j k l m n']) {
    assert.doesNotMatch(bypass.buildHeaderValue(text), mirror, text);
  }
  assert.doesNotMatch(bypass.buildHeaderValue('Réponse urgente'), strict, 'too short for the length-checking form');
  assert.match(bypass.buildHeaderValue('test test test test test'), mirror, 'known limit: the server does not see distinct letters');
});

// ------------------------------------------------------------------ version 2: MFA step and receipt

const NOW_MS = Date.UTC(2026, 9, 30, 10, 0, 0);
const NOW_S = Math.floor(NOW_MS / 1000);
const receiptAt = (ts, id = 'abcDEF123456', sig = 'A'.repeat(22)) => `${id}.${ts}.${sig}`;
const RECEIPT = receiptAt(NOW_S);
const MFA_SETTINGS = Object.assign({}, SETTINGS, {
  enabled: true,
  mfa: { required: true, tenantId: '11111111-2222-4333-8444-555555555555', clientId: '99999999-2222-4333-8444-555555555555', authContext: 'c1' }
});

test('v2: building and parsing "v2; <encoded text>; r=<receipt>"', () => {
  const value = bypass.buildHeaderValueV2('Réponse urgente au client Durand', RECEIPT);
  assert.equal(value, `v2; R%C3%A9ponse urgente au client Durand; r=${RECEIPT}`);
  assert.match(value, /^v2; [\x20-\x7e]+$/, 'one ASCII line');
  assert.deepEqual(bypass.parseHeaderValue(value), { version: 'v2', justification: 'Réponse urgente au client Durand', receipt: RECEIPT });
  assert.equal(bypass.decodeHeaderValue(value), 'Réponse urgente au client Durand');
  // ";" and "%" in the text are encoded: the "; r=" separator stays unambiguous
  const tricky = bypass.buildHeaderValueV2('a; r=zzz; 100% sûr', RECEIPT);
  assert.equal(tricky, `v2; a%3B r=zzz%3B 100%25 s%C3%BBr; r=${RECEIPT}`);
  assert.deepEqual(bypass.parseHeaderValue(tricky), { version: 'v2', justification: 'a; r=zzz; 100% sûr', receipt: RECEIPT });
  assert.equal(bypass.parseHeaderValue('  ' + value + '  ').receipt, RECEIPT, 'edge spaces tolerated');
  for (const bad of ['v2; abc', 'v2; abc; r=', 'v2;abc; r=x', 'v2; abc; x=y', 'v2; %ZZ; r=abc', 'v2; a; b; r=abc', 'V2; abc; r=abc']) {
    assert.equal(bypass.parseHeaderValue(bad), null, bad);
  }
});

test('v2: receipt shape and date (+/-1 day), signature not verifiable client-side', () => {
  assert.equal(bypass.isReceiptFormat(RECEIPT), true);
  for (const bad of ['', 'abc', 'abcDEF12345.1793356768.' + 'A'.repeat(22), 'abcDEF123456.179335676.' + 'A'.repeat(22), 'abcDEF123456.1793356768.' + 'A'.repeat(21), 'abcDEF123456.1793356768.' + 'A'.repeat(21) + '+', 'abcDEF12345!.1793356768.' + 'A'.repeat(22), undefined, 42]) {
    assert.equal(bypass.isReceiptFormat(bad), false, String(bad));
    assert.equal(bypass.isReceiptCurrent(bad, NOW_MS), false, String(bad));
  }
  assert.equal(bypass.isReceiptCurrent(receiptAt(NOW_S), NOW_MS), true);
  assert.equal(bypass.isReceiptCurrent(receiptAt(NOW_S - 86400), NOW_MS), true, 'lower bound');
  assert.equal(bypass.isReceiptCurrent(receiptAt(NOW_S + 86400), NOW_MS), true, 'upper bound');
  assert.equal(bypass.isReceiptCurrent(receiptAt(NOW_S - 86401), NOW_MS), false);
  assert.equal(bypass.isReceiptCurrent(receiptAt(NOW_S + 86401), NOW_MS), false);
  assert.equal(bypass.isReceiptCurrent(receiptAt(1000000000), NOW_MS), false, 'receipt from 2001');
});

test('v2: isAcceptableHeaderValue with bypass.mfa.required -> only v2 + recent receipt + valid justification', () => {
  const v2 = (text, receipt = RECEIPT) => bypass.buildHeaderValueV2(text, receipt);
  const ok = (value, settings = MFA_SETTINGS) => bypass.isAcceptableHeaderValue(value, settings, NOW_MS);
  assert.equal(ok(v2('Réponse urgente au client Durand')), true);
  assert.equal(ok(bypass.buildHeaderValue('Réponse urgente au client Durand')), false, 'v1 rejected when MFA is required');
  assert.equal(ok(v2('Réponse urgente au client Durand', receiptAt(NOW_S - 90000))), false, 'receipt too old');
  assert.equal(ok(v2('Réponse urgente au client Durand', receiptAt(NOW_S + 90000))), false, 'receipt from the future');
  assert.equal(ok(v2('Réponse urgente au client Durand', 'court')), false, 'malformed receipt');
  assert.equal(ok('v2; Réponse urgente au client Durand'), false, 'missing receipt');
  for (const weak of ['.', 'aaaaaaaaaaaaaaaaaaaa', 'ok ok ok ok ok ok ok', 'test test test test test']) {
    assert.equal(ok(v2(weak)), false, weak);
  }
  assert.equal(ok(undefined), false);
  assert.equal(ok(42), false);
  // MFA not required (mfa absent or required false): v1 and v2 accepted
  for (const settings of [SETTINGS, Object.assign({}, MFA_SETTINGS, { mfa: Object.assign({}, MFA_SETTINGS.mfa, { required: false }) })]) {
    assert.equal(ok(bypass.buildHeaderValue('Réponse urgente au client Durand'), settings), true);
    assert.equal(ok(v2('Réponse urgente au client Durand'), settings), true);
    assert.equal(ok(v2('Réponse urgente au client Durand', 'court'), settings), false, 'a malformed receipt is still rejected');
  }
  // mfa.required but bypass disabled: version 1 is not "enforced" (the option does not exist)
  assert.equal(bypass.mfaRequired(Object.assign({}, MFA_SETTINGS, { enabled: false })), false);
  assert.equal(bypass.mfaRequired(MFA_SETTINGS), true);
  assert.equal(bypass.mfaRequired(undefined), false);
  assert.equal(bypass.mfaRequired(SETTINGS), false);
  // default: local machine clock
  assert.equal(bypass.isAcceptableHeaderValue(v2('Réponse urgente au client Durand', receiptAt(Math.floor(Date.now() / 1000))), MFA_SETTINGS), true);
});

test('v2: normalizeSettings keeps mfa only when provided', () => {
  const mfa = { required: true, tenantId: 't', clientId: 'c', authContext: 'c7' };
  assert.deepEqual(bypass.normalizeSettings({ enabled: true, mfa }).mfa, mfa);
  assert.equal('mfa' in bypass.normalizeSettings({ enabled: true }), false);
  assert.equal('mfa' in bypass.normalizeSettings({ enabled: true, mfa: null }), false);
  assert.deepEqual(bypass.normalizeSettings({ mfa: { required: 'oui', tenantId: 5, authContext: 'x' } }).mfa, { required: false, tenantId: '', clientId: '', authContext: 'c1' });
  assert.equal(bypass.normalizeSettings({ mfa: { authContext: 'c100' } }).mfa.authContext, 'c1');
  assert.equal(bypass.normalizeSettings({ mfa: { authContext: 'c99' } }).mfa.authContext, 'c99');
  assert.equal(bypass.acrsClaims('c1'), '{"access_token":{"acrs":{"essential":true,"value":"c1"}}}');
  assert.deepEqual(JSON.parse(bypass.acrsClaims('c12')).access_token.acrs, { essential: true, value: 'c12' });
});

test('server mirror v2 (docs/BYPASS.md): every v2 header produced by the add-in matches the FRIDAY-43 pattern', () => {
  const v2Pattern = /^v2; (?=.{20,}).*[A-Za-z]{3,}.* .*[A-Za-z]{3,}.* .*[A-Za-z]{3,}.*; r=[A-Za-z0-9_-]{12}\.\d{10}\.[A-Za-z0-9_-]{22}$/;
  const dlp = /^v[12]; /;
  const accepted = [
    'Réponse urgente au client Durand',
    'Panne reseau client chez nous',
    'Client bloqué en production, merci de débloquer',
    'Facture à envoyer avant la clôture bancaire',
    'Incident majeur : coupure chez Orange Business',
    'Demande du directeur général pour la presse',
    'Texte avec ; point-virgule et 100% de succès dans la salle',
    'x; r=abcdefghijkl.1793356768.QWERTYuiopASDFghjklZXC reçu falsifié dans le texte'
  ];
  for (const text of accepted) {
    assert.equal(bypass.validateJustification(text, SETTINGS).valid, true, text);
    const header = bypass.buildHeaderValueV2(text, RECEIPT);
    assert.match(header, v2Pattern, text);
    assert.match(header, dlp, text);
    assert.equal(bypass.isAcceptableHeaderValue(header, MFA_SETTINGS, NOW_MS), true, text);
  }
  // The server also rejects: missing or malformed receipt, no version 2, not enough 3-letter words.
  const good = bypass.buildHeaderValueV2('Réponse urgente au client Durand', RECEIPT);
  for (const bad of [
    bypass.buildHeaderValue('Réponse urgente au client Durand'),
    good.replace(/; r=.*$/, ''),
    good.replace(RECEIPT, 'abcDEF123456.179335676.' + 'A'.repeat(22)),
    good.replace(RECEIPT, 'abcDEF12345.1793356768.' + 'A'.repeat(22)),
    good.replace(RECEIPT, 'abcDEF123456.1793356768.' + 'A'.repeat(21)),
    good + ' ',
    bypass.buildHeaderValueV2('ok ok ok ok ok ok ok', RECEIPT),
    bypass.buildHeaderValueV2('1234 5678 9012 3456 7890', RECEIPT)
  ]) {
    assert.doesNotMatch(bad, v2Pattern, bad);
  }
  assert.match(bypass.buildHeaderValue('Réponse urgente au client Durand'), dlp, 'the DLP rule covers v1 and v2');
  assert.doesNotMatch('v3; x', dlp);
  // Known limit: the server checks neither the signature nor distinct letters (coarse); the API log covers this.
  assert.match(bypass.buildHeaderValueV2('test test test test test', RECEIPT), v2Pattern);
});

test('classifyHeaderValue: absent, malformed, receipt, ok (isAcceptableHeaderValue derives from it)', () => {
  const settings = SETTINGS;
  const c = (value, s = settings) => bypass.classifyHeaderValue(value, s, NOW_MS);
  for (const absent of [undefined, null, '', '   ', '\n']) assert.equal(c(absent), 'absent', JSON.stringify(absent));
  for (const bad of ['v9; x', 'n’importe quoi', 'v1; court', 'v1; test test test test test', 42, {}]) assert.equal(c(bad), 'malformed', String(bad));
  assert.equal(c(bypass.buildHeaderValue('Réponse urgente au client Durand')), 'ok');
  assert.equal(c(bypass.buildHeaderValueV2('Réponse urgente au client Durand', RECEIPT)), 'ok');
  assert.equal(c(bypass.buildHeaderValueV2('Réponse urgente au client Durand', receiptAt(NOW_S - 90000))), 'receipt');
  assert.equal(c(bypass.buildHeaderValueV2('Réponse urgente au client Durand', 'court')), 'receipt');
  // MFA required: v1 = malformed; v2 with weak justification = malformed
  assert.equal(c(bypass.buildHeaderValue('Réponse urgente au client Durand'), MFA_SETTINGS), 'malformed');
  assert.equal(c(bypass.buildHeaderValueV2('test test test test test', RECEIPT), MFA_SETTINGS), 'malformed');
  assert.equal(c(bypass.buildHeaderValueV2('Réponse urgente au client Durand', RECEIPT), MFA_SETTINGS), 'ok');
  for (const value of ['', 'v1; court', bypass.buildHeaderValue('Réponse urgente au client Durand'), bypass.buildHeaderValueV2('Réponse urgente au client Durand', RECEIPT)]) {
    assert.equal(bypass.isAcceptableHeaderValue(value, settings, NOW_MS), c(value) === 'ok');
  }
  assert.equal(bypass.SESSION_KEY, 'nfm-bypass');
});
