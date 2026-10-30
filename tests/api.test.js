'use strict';

// Managed API POST /api/bypass: receipt (pure functions), Entra token validation (keys and JWKS generated
// locally, no network call) and handler (statuses, claims challenge, log without token or key).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');

const root = path.join(__dirname, '..');
const { syncShared } = require('../tools/prepare-api');
syncShared(); // api/shared/bypass.js: generated copy of src/shared/bypass.js (git-ignored)

const receiptLib = require('../api/src/lib/receipt');
const { validateAccessToken } = require('../api/src/lib/token');
const { handleBypass, bearerToken } = require('../api/src/lib/bypass-handler');
const bypass = require('../src/shared/bypass');

const TENANT = '11111111-2222-4333-8444-555555555555';
const CLIENT = '99999999-2222-4333-8444-555555555555';
const OID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NOW = Date.UTC(2026, 9, 30, 10, 0, 0);
const KEY_BYTES = crypto.randomBytes(32);
const KEY_SETTING = KEY_BYTES.toString('base64');
const TEXT = 'Réponse urgente au client Durand';
const CONFIG = {
  environment: 'test',
  tenantId: TENANT,
  clientId: CLIENT,
  authContext: 'c1',
  bypass: { minLength: 20, maxLength: 200, minWords: 3, minDistinctChars: 6 }
};

let signer;
let otherSigner;
let keyResolver;

async function makeSigner(kid) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwk: Object.assign(jwk, { kid, alg: 'RS256', use: 'sig' }), kid };
}

test.before(async () => {
  signer = await makeSigner('kid-1');
  otherSigner = await makeSigner('kid-1'); // same kid, different key: invalid signature
  keyResolver = createLocalJWKSet({ keys: [signer.jwk] });
});

/** Signed v2 access token; `claims` adds to / replaces the claims, null removes one. */
async function makeToken(claims, options) {
  const o = options || {};
  const payload = Object.assign(
    { tid: TENANT, oid: OID, preferred_username: 'alice@exemple.fr', scp: 'access_as_user', acrs: ['c1'], ver: '2.0', uti: 'UTI-abc_123-XYZ' },
    claims || {}
  );
  Object.keys(payload).forEach((k) => { if (payload[k] === null) delete payload[k]; });
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'kid-1' })
    .setIssuer(o.iss || `https://login.microsoftonline.com/${TENANT}/v2.0`)
    .setAudience(o.aud || CLIENT)
    .setIssuedAt(Math.floor(NOW / 1000) - 60)
    .setExpirationTime(o.exp === undefined ? Math.floor(NOW / 1000) + 3600 : o.exp)
    .setNotBefore(Math.floor(NOW / 1000) - 60);
  return jwt.sign((o.signer || signer).privateKey);
}

function deps(extra) {
  const logs = [];
  return Object.assign(
    { config: CONFIG, keyResolver, receiptKey: KEY_SETTING, log: (line) => logs.push(line), nowMs: () => NOW, logs },
    extra
  );
}

async function call(token, body, extra, input) {
  const d = deps(extra);
  const result = await handleBypass(
    Object.assign(
      {
        method: 'POST',
        tokenHeader: token === undefined ? undefined : `Bearer ${token}`,
        userAgent: 'Outlook/16.0 test',
        clientIp: '203.0.113.7',
        body: body === undefined ? { justification: TEXT } : body
      },
      input
    ),
    d
  );
  return Object.assign(result, { logs: d.logs });
}

// ------------------------------------------------------------------ receipt: pure functions

test('receipt: shape <id 12>.<ts 10>.<sig 22>, verification, tampering', () => {
  const created = receiptLib.createReceipt({ key: KEY_BYTES, oid: OID, justification: TEXT, nowMs: NOW });
  assert.match(created.receipt, /^[A-Za-z0-9_-]{12}\.\d{10}\.[A-Za-z0-9_-]{22}$/);
  assert.equal(created.id.length, 12);
  assert.equal(created.sig.length, 22);
  assert.equal(created.ts, Math.floor(NOW / 1000));
  assert.equal(created.sha256, crypto.createHash('sha256').update(TEXT, 'utf8').digest('hex'));
  assert.equal(bypass.isReceiptFormat(created.receipt), true, 'same shape as the add-in check');
  assert.equal(bypass.isReceiptCurrent(created.receipt, NOW), true);

  const ok = receiptLib.verifyReceipt({ key: KEY_BYTES, receipt: created.receipt, oid: OID, justification: TEXT });
  assert.deepEqual(ok, { valid: true, id: created.id, ts: created.ts });
  const bad = (overrides) => receiptLib.verifyReceipt(Object.assign({ key: KEY_BYTES, receipt: created.receipt, oid: OID, justification: TEXT }, overrides));
  assert.equal(bad({ oid: 'autre' }).valid, false);
  assert.equal(bad({ oid: 'autre' }).reason, 'signature');
  assert.equal(bad({ justification: TEXT + '.' }).valid, false);
  assert.equal(bad({ key: crypto.randomBytes(32) }).valid, false);
  const [id, ts, sig] = created.receipt.split('.');
  assert.equal(bad({ receipt: `${id}.${Number(ts) + 1}.${sig}` }).valid, false, 'date altered');
  assert.equal(bad({ receipt: `${id.slice(0, 11)}${id[11] === 'X' ? 'Y' : 'X'}.${ts}.${sig}` }).valid, false, 'id altered (last character always different)');
  assert.equal(bad({ receipt: `${id}.${ts}.${sig.slice(0, 21)}${sig[21] === 'A' ? 'B' : 'A'}` }).valid, false, 'signature altered');
  for (const garbage of ['', 'abc', `${id}.${ts}`, `${id}.${ts}.${sig}.x`, `${id}.12345.${sig}`, undefined, 42]) {
    assert.deepEqual(bad({ receipt: garbage }), { valid: false, reason: 'format' }, String(garbage));
  }
});

test('receipt: signature = first 22 characters of base64url(HMAC-SHA256(key, id.ts.oid.sha256(text)))', () => {
  const created = receiptLib.createReceipt({ key: KEY_BYTES, oid: OID, justification: TEXT, nowMs: NOW, id: 'abcDEF123456' });
  const sha = crypto.createHash('sha256').update(TEXT, 'utf8').digest('hex');
  const expected = crypto.createHmac('sha256', KEY_BYTES).update(`abcDEF123456.${created.ts}.${OID}.${sha}`).digest('base64url').slice(0, 22);
  assert.equal(created.sig, expected);
  assert.equal(created.receipt, `abcDEF123456.${created.ts}.${expected}`);
  // same input, same receipt; different text or oid, different signature
  const again = receiptLib.createReceipt({ key: KEY_BYTES, oid: OID, justification: TEXT, nowMs: NOW, id: 'abcDEF123456' });
  assert.equal(again.receipt, created.receipt);
  assert.notEqual(receiptLib.createReceipt({ key: KEY_BYTES, oid: OID, justification: TEXT + '!', nowMs: NOW, id: 'abcDEF123456' }).sig, created.sig);
  assert.notEqual(receiptLib.createReceipt({ key: KEY_BYTES, oid: 'x', justification: TEXT, nowMs: NOW, id: 'abcDEF123456' }).sig, created.sig);
});

test('receipt: distinct random ids; key required, 32 bytes minimum', () => {
  const ids = new Set();
  for (let i = 0; i < 2000; i += 1) ids.add(receiptLib.newReceiptId());
  assert.equal(ids.size, 2000);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{12}$/);
  assert.equal(receiptLib.decodeKey(KEY_SETTING).length, 32);
  assert.equal(receiptLib.decodeKey(crypto.randomBytes(48).toString('base64')).length, 48);
  for (const bad of [undefined, null, '', '   ', 42, crypto.randomBytes(31).toString('base64'), 'pas du base64 !!']) {
    assert.equal(receiptLib.decodeKey(bad), null, String(bad));
  }
  assert.throws(() => receiptLib.createReceipt({ key: Buffer.alloc(16), oid: OID, justification: TEXT }), /Receipt key/);
  assert.throws(() => receiptLib.createReceipt({ key: null, oid: OID, justification: TEXT }), /Receipt key/);
  assert.throws(() => receiptLib.createReceipt({ key: KEY_BYTES, oid: '', justification: TEXT }), /oid/);
});

// ------------------------------------------------------------------ token validation

const opts = () => ({ tenantId: TENANT, clientId: CLIENT, authContext: 'c1', keyResolver, nowMs: NOW });

test('token: valid (audience <clientId> or api://<clientId>)', async () => {
  const a = await validateAccessToken(await makeToken(), opts());
  assert.equal(a.ok, true);
  assert.equal(a.claims.oid, OID);
  const b = await validateAccessToken(await makeToken({}, { aud: `api://${CLIENT}` }), opts());
  assert.equal(b.ok, true);
});

test('token: rejected (signature, issuer, audience, tenant, scope, oid, expiry, missing)', async () => {
  const expectInvalid = async (token, detail) => {
    const r = await validateAccessToken(token, opts());
    assert.equal(r.ok, false, detail);
    assert.equal(r.error, 'invalid_token', detail);
  };
  await expectInvalid(await makeToken({}, { signer: otherSigner }), 'wrong signature');
  await expectInvalid(await makeToken({}, { iss: 'https://login.microsoftonline.com/autre/v2.0' }), 'wrong issuer');
  await expectInvalid(await makeToken({}, { iss: `https://sts.windows.net/${TENANT}/` }), 'v1 issuer');
  await expectInvalid(await makeToken({}, { aud: '00000000-0000-0000-0000-000000000001' }), 'wrong audience');
  await expectInvalid(await makeToken({}, { aud: 'api://autre' }), 'wrong api:// audience');
  await expectInvalid(await makeToken({ tid: 'autre-locataire' }), 'wrong tid');
  await expectInvalid(await makeToken({ scp: null }), 'no scp');
  await expectInvalid(await makeToken({ scp: 'User.Read' }), 'wrong scope');
  await expectInvalid(await makeToken({ scp: 'access_as_user_not' }), 'adjacent scope');
  await expectInvalid(await makeToken({ oid: null }), 'no oid');
  await expectInvalid(await makeToken({}, { exp: Math.floor(NOW / 1000) - 3600 }), 'expired');
  await expectInvalid('', 'missing');
  await expectInvalid(undefined, 'undefined');
  await expectInvalid('pas.un.jeton', 'malformed');
  await expectInvalid('x', 'malformed 2');
  // alg=none rejected
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ tid: TENANT, oid: OID, scp: 'access_as_user', acrs: ['c1'], iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: CLIENT })).toString('base64url')}.`;
  await expectInvalid(none, 'alg none');
});

test('token: valid but without the authentication context (acrs) -> insufficient_claims', async () => {
  for (const acrs of [null, [], ['c2'], ['c10'], 'c2']) {
    const r = await validateAccessToken(await makeToken({ acrs }), opts());
    assert.equal(r.ok, false, JSON.stringify(acrs));
    assert.equal(r.error, 'insufficient_claims', JSON.stringify(acrs));
  }
  assert.equal((await validateAccessToken(await makeToken({ acrs: ['c2', 'c1'] }), opts())).ok, true);
  assert.equal((await validateAccessToken(await makeToken({ acrs: 'c1' }), opts())).ok, true, 'claim as a string');
  const c2 = await validateAccessToken(await makeToken({ acrs: ['c2'] }), Object.assign(opts(), { authContext: 'c2' }));
  assert.equal(c2.ok, true, 'configurable context');
});

test('bearerToken: Bearer scheme only', () => {
  assert.equal(bearerToken('Bearer abc.def-ghi_jkl'), 'abc.def-ghi_jkl');
  assert.equal(bearerToken('bearer abc'), 'abc');
  for (const bad of [undefined, null, '', 'Basic abc', 'Bearer', 'Bearer ', 'Bearer a b', 'abc']) {
    assert.equal(bearerToken(bad), null, String(bad));
  }
});

// ------------------------------------------------------------------ handler

test('API: valid token + valid justification -> 200 with a verifiable receipt, complete log', async () => {
  const token = await makeToken();
  const r = await call(token);
  assert.equal(r.status, 200);
  assert.match(r.body.receipt, receiptLib.RECEIPT_PATTERN);
  assert.equal(r.body.ts, Math.floor(NOW / 1000));
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.equal(
    receiptLib.verifyReceipt({ key: KEY_BYTES, receipt: r.body.receipt, oid: OID, justification: TEXT }).valid,
    true
  );
  assert.equal(bypass.isReceiptCurrent(r.body.receipt, NOW), true);

  assert.equal(r.logs.length, 1);
  assert.match(r.logs[0], /^NFM_BYPASS \{/);
  const entry = JSON.parse(r.logs[0].slice('NFM_BYPASS '.length));
  assert.equal(entry.event, 'bypass_receipt');
  assert.equal(entry.receiptId, r.body.receipt.split('.')[0]);
  assert.equal(entry.ts, r.body.ts);
  assert.equal(entry.upn, 'alice@exemple.fr');
  assert.equal(entry.oid, OID);
  assert.equal(entry.tid, TENANT);
  assert.equal(entry.ip, '203.0.113.7');
  assert.equal(entry.justification, TEXT);
  assert.equal(entry.sha256, crypto.createHash('sha256').update(TEXT, 'utf8').digest('hex'));
  assert.equal(entry.authContext, 'c1');
  assert.equal(entry.userAgent, 'Outlook/16.0 test');
  assert.equal(entry.environment, 'test');
  assert.equal(entry.subjectHash, null);
  // MFA freshness: unique token identifier (= Entra UniqueTokenIdentifier), issue time, satisfied contexts
  assert.equal(entry.uti, 'UTI-abc_123-XYZ');
  assert.equal(entry.iat, Math.floor(NOW / 1000) - 60);
  assert.deepEqual(entry.acrs, ['c1']);
});

test('API: the log never contains the token, the key or the full token signature', async () => {
  const token = await makeToken();
  const [h, p, s] = token.split('.');
  const scenarios = [
    await call(token),
    await call(token, { justification: 'aaaaaaaaaaaaaaaaaaaa' }),
    await call(await makeToken({ acrs: null })),
    await call(await makeToken({}, { signer: otherSigner })),
    await call(token, undefined, { receiptKey: undefined })
  ];
  for (const r of scenarios) {
    const all = r.logs.join('\n') + JSON.stringify(r.body) + JSON.stringify(r.headers);
    for (const secret of [token, h, p, s, KEY_SETTING, KEY_BYTES.toString('hex')]) {
      assert.equal(all.includes(secret), false, 'no secret in the log or the response');
    }
  }
  assert.ok(scenarios.slice(1).every((r) => r.logs.every((l) => /^NFM_BYPASS_DENIED /.test(l))), 'denial: distinct NFM_BYPASS_DENIED prefix');
});

test('API: optional subjectHash kept only when well formed', async () => {
  const token = await makeToken();
  const ok = await call(token, { justification: TEXT, subjectHash: 'AbC123+/=_-' });
  assert.equal(JSON.parse(ok.logs[0].slice(11)).subjectHash, 'AbC123+/=_-');
  for (const bad of ['a b', '<script>', 'x'.repeat(129), 42, '']) {
    const r = await call(token, { justification: TEXT, subjectHash: bad });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.logs[0].slice(11)).subjectHash, null, String(bad));
  }
});

test('API: no token, wrong scheme or invalid token -> 401 invalid_token', async () => {
  const none = await call(undefined);
  assert.equal(none.status, 401);
  assert.deepEqual(none.body, { error: 'missing_token' });
  assert.match(none.headers['WWW-Authenticate'], /^Bearer/);
  assert.doesNotMatch(none.headers['WWW-Authenticate'], /claims=/);
  assert.equal((await call(undefined, undefined, undefined, { tokenHeader: 'Basic abc' })).status, 401);
  assert.equal((await call(undefined, undefined, undefined, { tokenHeader: 'Bearer' })).status, 401);
  const wrongKey = await call(await makeToken({}, { signer: otherSigner }));
  assert.equal(wrongKey.status, 401);
  assert.match(wrongKey.headers['WWW-Authenticate'], /error="invalid_token"/);
  for (const [claims, options] of [
    [{}, { aud: 'api://autre' }],
    [{}, { iss: 'https://login.microsoftonline.com/autre/v2.0' }],
    [{ scp: null }, {}],
    [{}, { exp: Math.floor(NOW / 1000) - 7200 }]
  ]) {
    const r = await call(await makeToken(claims, options));
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'invalid_token');
  }
  assert.equal(none.logs.length, 0, 'a request without a token writes no receipt');
});

test('API: token without acrs -> 401 with the insufficient_claims challenge (base64 claims)', async () => {
  const r = await call(await makeToken({ acrs: null }));
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { error: 'insufficient_claims' });
  const header = r.headers['WWW-Authenticate'];
  assert.match(header, /^Bearer /);
  assert.match(header, /error="insufficient_claims"/);
  const claims = /claims="([^"]+)"/.exec(header)[1];
  assert.equal(
    Buffer.from(claims, 'base64').toString('utf8'),
    '{"access_token":{"acrs":{"essential":true,"value":"c1"}}}'
  );
  assert.equal(Buffer.from(claims, 'base64').toString('utf8'), bypass.acrsClaims('c1'));
  assert.match(r.logs[0], /^NFM_BYPASS_DENIED .*"reason":"insufficient_claims"/);
  assert.match(r.logs[0], new RegExp(OID), 'the oid is logged for audit');
  // different configured context -> different challenge
  const c3 = await call(await makeToken({ acrs: ['c1'] }), undefined, { config: Object.assign({}, CONFIG, { authContext: 'c3' }) });
  assert.equal(c3.status, 401);
  assert.equal(JSON.parse(Buffer.from(/claims="([^"]+)"/.exec(c3.headers['WWW-Authenticate'])[1], 'base64').toString()).access_token.acrs.value, 'c3');
});

test('API: weak justification or invalid body -> 400 with the reason code (same rule as the add-in)', async () => {
  const token = await makeToken();
  const expected = [
    ['.', 'short'],
    ['aaaaaaaaaaaaaaaaaaaa', 'repeat'],
    ['ok ok ok ok ok ok ok', 'words'],
    ['test test test', 'short'],
    ['test test test test test', 'distinct'],
    ['x'.repeat(201), 'long'],
    ['', 'empty'],
    ['   \n  ', 'empty']
  ];
  for (const [text, code] of expected) {
    const r = await call(token, { justification: text });
    assert.equal(r.status, 400, text);
    assert.deepEqual(r.body, { error: 'invalid_justification', code }, text);
    assert.equal(bypass.validateJustification(text, CONFIG.bypass).code, code, 'same verdict as validateJustification');
    assert.equal(r.logs.every((l) => !l.startsWith('NFM_BYPASS {')), true, 'no receipt logged');
  }
  for (const body of [undefined, null, {}, { justification: 42 }, [], 'texte', { text: TEXT }]) {
    const r = await call(token, body === undefined ? null : body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(r.body, { error: 'invalid_request' }, JSON.stringify(body));
  }
  // environment limits
  const strict = await call(token, { justification: TEXT }, { config: Object.assign({}, CONFIG, { bypass: { minLength: 50, maxLength: 200, minWords: 3, minDistinctChars: 6 } }) });
  assert.deepEqual(strict.body, { error: 'invalid_justification', code: 'short' });
  // text normalized before validation and before signing
  const messy = await call(token, { justification: '  Réponse   urgente\nau client Durand  ' });
  assert.equal(messy.status, 200);
  assert.equal(JSON.parse(messy.logs[0].slice(11)).justification, TEXT.replace('au client Durand', 'au client Durand'));
  assert.equal(receiptLib.verifyReceipt({ key: KEY_BYTES, receipt: messy.body.receipt, oid: OID, justification: 'Réponse urgente au client Durand' }).valid, true);
});

test('API: NFM_RECEIPT_KEY missing or too short -> 500; configuration missing -> 500; GET -> 405', async () => {
  const token = await makeToken();
  for (const receiptKey of [undefined, '', crypto.randomBytes(16).toString('base64')]) {
    const r = await call(token, undefined, { receiptKey });
    assert.equal(r.status, 500, String(receiptKey));
    assert.deepEqual(r.body, { error: 'server_misconfigured' });
    assert.match(r.logs[0], /NFM_RECEIPT_KEY/);
    assert.equal(r.logs[0].includes(String(receiptKey)) && !!receiptKey, false, 'the key value is not logged');
  }
  for (const config of [null, undefined, {}, { tenantId: TENANT }, { tenantId: TENANT, clientId: CLIENT }]) {
    const r = await call(token, undefined, { config });
    assert.equal(r.status, 500, JSON.stringify(config));
  }
  const get = await call(token, undefined, undefined, { method: 'GET' });
  assert.equal(get.status, 405);
  assert.equal(get.headers.Allow, 'POST');
  // without a token the missing key is not visible: 401 first
  assert.equal((await call(undefined, undefined, { receiptKey: undefined })).status, 401);
});

test('API: each successful call produces a distinct receipt and log', async () => {
  const token = await makeToken();
  const a = await call(token);
  const b = await call(token);
  assert.notEqual(a.body.receipt, b.body.receipt);
  assert.notEqual(a.logs[0], b.logs[0]);
});

// ------------------------------------------------------------------ Azure function (adapter)

test('Azure function: registers POST /api/bypass (anonymous at function level), never answers 200 without a token', async () => {
  const registered = {};
  const fake = { app: { http: (name, options) => { registered[name] = options; } } };
  const original = Module._load;
  Module._load = function (request, ...rest) {
    return request === '@azure/functions' ? fake : original.call(this, request, ...rest);
  };
  const file = path.join(root, 'api', 'src', 'functions', 'bypass.js');
  delete require.cache[file];
  try {
    require(file);
  } finally {
    Module._load = original;
  }
  assert.deepEqual(Object.keys(registered), ['bypass']);
  assert.equal(registered.bypass.route, 'bypass');
  assert.equal(registered.bypass.authLevel, 'anonymous');
  assert.ok(registered.bypass.methods.includes('POST'));
  const logs = [];
  const result = await registered.bypass.handler(
    { method: 'POST', headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ justification: TEXT }) },
    { log: (line) => logs.push(line) }
  );
  assert.ok(result.status === 401 || result.status === 500, `without token: ${result.status}`);
  assert.ok(result.jsonBody && result.headers);
});

test('api/package.json: v4 model, Node 22, pinned dependencies, folder ready for Static Web Apps', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'api', 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'src/functions/*.js');
  assert.match(pkg.engines.node, /22/);
  assert.match(pkg.dependencies['@azure/functions'], /^4\./);
  assert.match(pkg.dependencies.jose, /^\d+\.\d+\.\d+$/, 'exact version');
  assert.equal(Object.keys(pkg.dependencies).length, 2);
  assert.ok(fs.existsSync(path.join(root, 'api', 'host.json')));
  assert.ok(fs.existsSync(path.join(root, 'api', 'package-lock.json')));
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  for (const entry of ['api/shared/', 'api/config.json', 'api/node_modules/']) assert.ok(gitignore.includes(entry), entry);
  // The generated copy is identical to the shared source (a single validation rule).
  assert.equal(
    fs.readFileSync(path.join(root, 'api', 'shared', 'bypass.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'src', 'shared', 'bypass.js'), 'utf8')
  );
});

// ------------------------------------------------------------------ verification tool (compliance)

test('verify-receipt: valid v2 header, tampered, version 1, malformed', () => {
  const { verifyHeader } = require('../tools/verify-receipt');
  const created = receiptLib.createReceipt({ key: KEY_BYTES, oid: OID, justification: TEXT, nowMs: NOW });
  const header = bypass.buildHeaderValueV2(TEXT, created.receipt);
  const ok = verifyHeader({ key: KEY_BYTES, header, oid: OID });
  assert.equal(ok.valid, true);
  assert.equal(ok.justification, TEXT);
  assert.equal(ok.id, created.id);
  assert.equal(ok.date, new Date(NOW).toISOString().replace('.000Z', '.000Z'));
  assert.equal(verifyHeader({ key: KEY_BYTES, header, oid: 'autre' }).reason, 'signature');
  assert.equal(verifyHeader({ key: KEY_BYTES, header: header.replace('client', 'Client'), oid: OID }).reason, 'signature', 'justification altered');
  assert.equal(verifyHeader({ key: crypto.randomBytes(32), header, oid: OID }).valid, false);
  assert.equal(verifyHeader({ key: KEY_BYTES, header: bypass.buildHeaderValue(TEXT), oid: OID }).reason, 'version');
  assert.equal(verifyHeader({ key: KEY_BYTES, header: 'n’importe quoi', oid: OID }).reason, 'header');
  assert.equal(verifyHeader({ key: KEY_BYTES, header: 'v2; abc; r=court', oid: OID }).reason, 'format');
});

test('verify-receipt: CLI (exit codes, key only through the environment)', () => {
  const { main } = require('../tools/verify-receipt');
  const created = receiptLib.createReceipt({ key: KEY_BYTES, oid: OID, justification: TEXT, nowMs: NOW });
  const header = bypass.buildHeaderValueV2(TEXT, created.receipt);
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    const env = { NFM_RECEIPT_KEY: KEY_SETTING };
    assert.equal(main(['--header', header, '--oid', OID], env), 0);
    assert.match(out.join('\n'), /VALID {4}receipt/);
    assert.match(out.join('\n'), /Réponse urgente au client Durand/);
    out.length = 0;
    assert.equal(main(['--receipt', created.receipt, '--oid', OID, '--justification', TEXT], env), 0);
    assert.equal(main(['--receipt', created.receipt, '--oid', 'autre', '--justification', TEXT], env), 1);
    assert.match(out.join('\n'), /INVALID /);
    assert.equal(main(['--header', header, '--oid', OID], {}), 2, 'key missing');
    assert.equal(main(['--header', header, '--oid', OID], { NFM_RECEIPT_KEY: 'court' }), 2, 'key too short');
    assert.equal(main(['--header', header], env), 2, 'oid missing');
    assert.equal(main(['--key', KEY_SETTING, '--header', header, '--oid', OID], env), 2, 'the key is not passed as an argument');
    assert.match(err.join('\n'), /Unknown argument/);
    assert.equal(err.join('\n').includes(KEY_SETTING), false);
  } finally {
    console.log = log;
    console.error = error;
  }
});

// ------------------------------------------------------------------ safe diagnostics of a rejected token

test('diagnostics: disallowed algorithm (HS256) -> invalid_token ERR_JOSE_ALG_NOT_ALLOWED with metadata and no secret', async () => {
  const secret = new TextEncoder().encode('un-secret-hs256-de-test-0123456789abcdef');
  const token = await new SignJWT({ tid: TENANT, oid: OID, scp: 'access_as_user', acrs: ['c1'], ver: '2.0', azp: CLIENT, idtyp: 'user', auth_time: 1793000000 })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: 'kid-hs', nonce: 'NONCE-VALUE' })
    .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`)
    .setAudience(`api://${CLIENT}`)
    .setIssuedAt(1793350000)
    .setNotBefore(1793350000)
    .setExpirationTime(Math.floor(NOW / 1000) + 3600)
    .sign(secret);
  const signature = token.split('.')[2];
  const r = await call(token);
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { error: 'invalid_token' });
  const entry = JSON.parse(r.logs[0].slice('NFM_BYPASS_DENIED '.length));
  assert.equal(entry.reason, 'invalid_token');
  assert.equal(entry.detail, 'ERR_JOSE_ALG_NOT_ALLOWED');
  assert.equal(entry.diag.parts, 3);
  assert.deepEqual(entry.diag.header, { alg: 'HS256', typ: 'JWT', kid: 'kid-hs', nonce: true });
  assert.equal(entry.diag.claims.aud, `api://${CLIENT}`);
  assert.equal(entry.diag.claims.iss, `https://login.microsoftonline.com/${TENANT}/v2.0`);
  assert.equal(entry.diag.claims.ver, '2.0');
  assert.equal(entry.diag.claims.tid, TENANT);
  assert.equal(entry.diag.claims.azp, CLIENT);
  assert.equal(entry.diag.claims.scp, 'access_as_user');
  assert.deepEqual(entry.diag.claims.acrs, ['c1']);
  assert.equal(entry.diag.claims.idtyp, 'user');
  assert.equal(entry.diag.claims.iat, 1793350000);
  assert.equal(entry.diag.claims.nbf, 1793350000);
  assert.equal(entry.diag.claims.exp, Math.floor(NOW / 1000) + 3600);
  assert.equal(entry.diag.claims.auth_time, 1793000000);
  const all = r.logs.join('\n') + JSON.stringify(r.body) + JSON.stringify(r.headers);
  for (const secret of [token, signature, 'NONCE-VALUE', OID + 'x']) {
    assert.equal(all.includes(secret), false, 'neither the token, nor the signature, nor the nonce value');
  }
});

test('diagnostics: encrypted token (5-segment JWE), unreadable or missing -> parts and decoding errors, never the content', async () => {
  const { diagnose } = require('../api/src/lib/token');
  const jwe = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..IV123.CIPHERTEXT-SECRET.TAG123';
  const d = diagnose(jwe);
  assert.equal(d.parts, 5);
  assert.equal(d.header.alg, 'dir');
  assert.ok(d.claimsError, 'unreadable claims reported');
  const r = await call(jwe);
  assert.equal(r.status, 401);
  const entry = JSON.parse(r.logs[0].slice('NFM_BYPASS_DENIED '.length));
  assert.equal(entry.diag.parts, 5);
  assert.equal(r.logs.join('').includes('CIPHERTEXT-SECRET'), false);
  assert.deepEqual(diagnose(''), { parts: 0 });
  assert.deepEqual(diagnose(undefined), { parts: 0 });
  const junk = diagnose('pas.un.jeton');
  assert.equal(junk.parts, 3);
  assert.ok(junk.headerError && junk.claimsError);
});

test('diagnostics: insufficient_claims and scope / audience denials also log the diag (iat, acrs...)', async () => {
  const noAcrs = await call(await makeToken({ acrs: null }));
  const e1 = JSON.parse(noAcrs.logs[0].slice('NFM_BYPASS_DENIED '.length));
  assert.equal(e1.reason, 'insufficient_claims');
  assert.equal(e1.diag.header.alg, 'RS256');
  assert.equal(e1.diag.claims.acrs, undefined);
  assert.equal(e1.diag.claims.iat, Math.floor(NOW / 1000) - 60);
  assert.equal(e1.diag.claims.exp, Math.floor(NOW / 1000) + 3600);
  assert.equal(e1.diag.claims.scp, 'access_as_user');
  const wrongScope = await call(await makeToken({ scp: 'User.Read' }));
  const e2 = JSON.parse(wrongScope.logs[0].slice('NFM_BYPASS_DENIED '.length));
  assert.equal(e2.detail, 'scp');
  assert.equal(e2.diag.claims.scp, 'User.Read');
  const wrongAud = await call(await makeToken({}, { aud: '00000000-0000-0000-0000-000000000001' }));
  const e3 = JSON.parse(wrongAud.logs[0].slice('NFM_BYPASS_DENIED '.length));
  assert.equal(e3.diag.claims.aud, '00000000-0000-0000-0000-000000000001');
  assert.equal(e3.detail, 'ERR_JWT_CLAIM_VALIDATION_FAILED');
});

// ------------------------------------------------------------------ Static Web Apps replaces Authorization

test('SWA: Authorization (internal HS256 token of Static Web Apps) is ignored -> missing_token, distinct from invalid_token', async () => {
  const swaToken = await new SignJWT({ role: 'anonymous' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('https://0123abcd.scm.azurewebsites.net')
    .setAudience('https://0123abcd.azurewebsites.net/azurefunctions')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode('secret-interne-swa-0123456789abcdef0123'));
  const r = await call(undefined, undefined, undefined, { authorization: `Bearer ${swaToken}` });
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { error: 'missing_token' });
  assert.match(r.headers['WWW-Authenticate'], /^Bearer realm="nofridaymail"$/, 'challenge unchanged');
  assert.equal(r.logs.length, 1);
  const entry = JSON.parse(r.logs[0].slice('NFM_BYPASS_DENIED '.length));
  assert.equal(entry.reason, 'missing_token');
  assert.notEqual(entry.reason, 'invalid_token');
  assert.deepEqual(entry.diag, { authorizationHeaderIgnored: true });
  assert.equal(r.logs[0].includes(swaToken), false, 'the internal token is not logged');

  // No header at all: same response, no log (nothing to report)
  const none = await call(undefined);
  assert.equal(none.body.error, 'missing_token');
  assert.equal(none.logs.length, 0);

  // A valid Entra token in X-NFM-Token passes, EVEN when Authorization carries the internal SWA token
  const ok = await call(await makeToken(), undefined, undefined, { authorization: `Bearer ${swaToken}` });
  assert.equal(ok.status, 200);
  assert.match(ok.body.receipt, receiptLib.RECEIPT_PATTERN);

  // An invalid Entra token in X-NFM-Token while Authorization is present: invalid_token + marker in the diag
  const bad = await call(await makeToken({}, { signer: otherSigner }), undefined, undefined, { authorization: `Bearer ${swaToken}` });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, 'invalid_token');
  const badEntry = JSON.parse(bad.logs[0].slice('NFM_BYPASS_DENIED '.length));
  assert.equal(badEntry.reason, 'invalid_token');
  assert.equal(badEntry.diag.authorizationHeaderIgnored, true);
  assert.equal(badEntry.diag.header.alg, 'RS256');

  // A valid Entra token placed only in Authorization is rejected
  const onlyAuth = await call(undefined, undefined, undefined, { authorization: `Bearer ${await makeToken()}` });
  assert.equal(onlyAuth.status, 401);
  assert.equal(onlyAuth.body.error, 'missing_token');
});

test('Azure function: reads X-NFM-Token (never Authorization for the token); site configuration without header filter', async () => {
  const text = fs.readFileSync(path.join(root, 'api', 'src', 'functions', 'bypass.js'), 'utf8');
  assert.match(text, /tokenHeader: request\.headers\.get\('x-nfm-token'\)/);
  assert.match(text, /authorization: request\.headers\.get\('authorization'\)/, 'read for diagnostics only');
  const { withApi } = require('../tools/swa-config');
  const swa = withApi(JSON.parse(fs.readFileSync(path.join(root, 'staticwebapp.config.json'), 'utf8')));
  assert.equal(JSON.stringify(swa).toLowerCase().includes('x-nfm-token'), false, 'nothing filters or rewrites X-NFM-Token');
  assert.equal(swa.routes[0].headers.hasOwnProperty('X-NFM-Token'), false);
  assert.equal(swa.requestHeaders, undefined);
});

test('log: token uti, iat and acrs in receipts AND in denials (never the token)', async () => {
  const token = await makeToken({ acrs: ['c1', 'c2'] });
  const ok = await call(token);
  const entry = JSON.parse(ok.logs[0].slice('NFM_BYPASS '.length));
  assert.equal(entry.uti, 'UTI-abc_123-XYZ');
  assert.equal(entry.iat, Math.floor(NOW / 1000) - 60);
  assert.deepEqual(entry.acrs, ['c1', 'c2']);

  // justification rejected: the token is valid, its metadata is logged
  const weak = await call(token, { justification: 'aaaaaaaaaaaaaaaaaaaa' });
  const e2 = JSON.parse(weak.logs[0].slice('NFM_BYPASS_DENIED '.length));
  assert.equal(e2.reason, 'invalid_justification');
  assert.equal(e2.uti, 'UTI-abc_123-XYZ');
  assert.equal(e2.iat, Math.floor(NOW / 1000) - 60);
  assert.deepEqual(e2.acrs, ['c1', 'c2']);

  // context not satisfied: uti / iat / acrs of the rejected token
  const noCtx = await call(await makeToken({ acrs: ['c2'] }));
  const e3 = JSON.parse(noCtx.logs[0].slice('NFM_BYPASS_DENIED '.length));
  assert.equal(e3.reason, 'insufficient_claims');
  assert.equal(e3.uti, 'UTI-abc_123-XYZ');
  assert.equal(e3.iat, Math.floor(NOW / 1000) - 60);
  assert.deepEqual(e3.acrs, ['c2']);
  assert.equal(e3.diag.claims.uti, 'UTI-abc_123-XYZ');

  // token without uti: null (no invented value)
  const noUti = await call(await makeToken({ uti: null }));
  assert.equal(JSON.parse(noUti.logs[0].slice('NFM_BYPASS '.length)).uti, null);

  for (const r of [ok, weak, noCtx]) {
    const all = r.logs.join('\n');
    for (const secret of [token, token.split('.')[2]]) assert.equal(all.includes(secret), false, 'never the token nor its signature');
  }
});
