'use strict';

/*
 * POST /api/bypass: issues an exceptional-send receipt after a verified identity (MFA) and a valid justification.
 *
 * Independent of the Azure Functions SDK (testable under Node): takes plain values and returns
 * { status, headers, body }. The function (src/functions/bypass.js) only does the adaptation.
 *
 *   1. site configuration (tenantId, clientId, authContext) present, otherwise 500;
 *   2. valid Entra Bearer token (token.js): otherwise 401; without an authentication context (MFA), 401 with the
 *      challenge WWW-Authenticate: Bearer error="insufficient_claims", claims="<base64 of the claims to request>";
 *   3. JSON body { justification, subjectHash? }: 400 if invalid; justification revalidated by the SAME function
 *      as the task pane and the handler (shared/bypass.js, copy of src/shared/bypass.js): 400 + reason code;
 *   4. NFM_RECEIPT_KEY key (base64, >= 32 bytes) present, otherwise 500;
 *   5. signed receipt (receipt.js) and log entry "NFM_BYPASS <json>" (Application Insights traces).
 * The token is NEVER logged or returned; neither is the key.
 */
const bypass = require('../../shared/bypass');
const { validateAccessToken } = require('./token');
const { createReceipt, decodeKey } = require('./receipt');

const LOG_PREFIX = 'NFM_BYPASS';
const LOG_DENIED_PREFIX = 'NFM_BYPASS_DENIED';
const SUBJECT_HASH = /^[A-Za-z0-9+/=_-]{1,128}$/;
const NO_STORE = { 'Cache-Control': 'no-store' };

function reply(status, body, headers) {
  return { status, headers: Object.assign({ 'Content-Type': 'application/json' }, NO_STORE, headers || {}), body };
}

/** Token of the Bearer scheme, or null. */
function bearerToken(authorization) {
  const match = typeof authorization === 'string' ? /^Bearer\s+([A-Za-z0-9._~+/=-]+)\s*$/i.exec(authorization) : null;
  return match ? match[1] : null;
}

function challenge(error, claimsJson) {
  const parts = ['Bearer realm="nofridaymail"', `error="${error}"`];
  if (claimsJson) {
    parts.push(`claims="${Buffer.from(claimsJson, 'utf8').toString('base64')}"`);
  }
  return { 'WWW-Authenticate': parts.join(', ') };
}

/**
 * input: { method, tokenHeader, authorization, userAgent, clientIp, body } (body = parsed JSON object, or undefined).
 *   tokenHeader   value of the X-NFM-Token header ("Bearer <Entra token>"): the ONLY source of the token;
 *   authorization value of the Authorization header: IGNORED. The managed functions of Static Web Apps REPLACE this
 *                 header with their own internal token (HS256, issuer *.scm.azurewebsites.net): the client's Entra
 *                 token never reaches it. Only its presence is logged (authorizationHeaderIgnored).
 * deps  : { config, keyResolver, receiptKey, log, nowMs }.
 */
async function handleBypass(input, deps) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const nowMs = typeof deps.nowMs === 'function' ? deps.nowMs() : Date.now();
  const config = deps.config;

  if (!config || !config.tenantId || !config.clientId || !config.authContext) {
    log(`${LOG_DENIED_PREFIX} ${JSON.stringify({ reason: 'server_misconfigured', missing: 'config' })}`);
    return reply(500, { error: 'server_misconfigured' });
  }
  if (input.method !== 'POST') {
    return reply(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  const authorizationIgnored = typeof input.authorization === 'string' && input.authorization !== '';
  const token = bearerToken(input.tokenHeader);
  if (!token) {
    // Token missing: reason distinct from invalid_token (an SWA token in Authorization does not count).
    if (authorizationIgnored) {
      log(
        `${LOG_DENIED_PREFIX} ${JSON.stringify({
          reason: 'missing_token',
          ip: input.clientIp || null,
          diag: { authorizationHeaderIgnored: true }
        })}`
      );
    }
    return reply(401, { error: 'missing_token' }, { 'WWW-Authenticate': 'Bearer realm="nofridaymail"' });
  }
  const checked = await validateAccessToken(token, {
    tenantId: config.tenantId,
    clientId: config.clientId,
    authContext: config.authContext,
    keyResolver: deps.keyResolver,
    nowMs
  });
  if (!checked.ok) {
    const claims = checked.claims || {};
    log(
      `${LOG_DENIED_PREFIX} ${JSON.stringify({
        reason: checked.error,
        detail: checked.detail,
        oid: claims.oid || null,
        upn: claims.preferred_username || null,
        // Unique token identifier (not secret), issue time and satisfied contexts: for correlation with Entra.
        uti: claims.uti || null,
        iat: claims.iat || null,
        acrs: claims.acrs || null,
        ip: input.clientIp || null,
        // Non-secret metadata of the refused token (never the token or the signature): see token.js, diagnose().
        diag: checked.diag ? Object.assign({}, checked.diag, authorizationIgnored ? { authorizationHeaderIgnored: true } : {}) : undefined
      })}`
    );
    if (checked.error === 'insufficient_claims') {
      return reply(401, { error: 'insufficient_claims' }, challenge('insufficient_claims', bypass.acrsClaims(config.authContext)));
    }
    return reply(401, { error: 'invalid_token' }, challenge('invalid_token'));
  }
  const claims = checked.claims;

  const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body : null;
  if (!body || typeof body.justification !== 'string') {
    return reply(400, { error: 'invalid_request' });
  }
  const justification = bypass.normalizeJustification(body.justification);
  const verdict = bypass.validateJustification(justification, bypass.normalizeSettings(config.bypass));
  if (!verdict.valid) {
    log(`${LOG_DENIED_PREFIX} ${JSON.stringify({ reason: 'invalid_justification', code: verdict.code, oid: claims.oid, uti: claims.uti || null, iat: claims.iat || null, acrs: claims.acrs || null })}`);
    return reply(400, { error: 'invalid_justification', code: verdict.code });
  }

  const key = decodeKey(deps.receiptKey);
  if (!key) {
    // Never the value of the key: only its absence or insufficient size.
    log(`${LOG_DENIED_PREFIX} ${JSON.stringify({ reason: 'server_misconfigured', missing: 'NFM_RECEIPT_KEY' })}`);
    return reply(500, { error: 'server_misconfigured' });
  }

  const created = createReceipt({ key, oid: claims.oid, justification: verdict.text, nowMs });
  const entry = {
    event: 'bypass_receipt',
    environment: config.environment || null,
    receiptId: created.id,
    ts: created.ts,
    upn: claims.preferred_username || null,
    oid: claims.oid,
    tid: claims.tid,
    // Access token: unique identifier (uti, = UniqueTokenIdentifier of the Entra sign-in logs), issue time (iat,
    // seconds) and satisfied authentication contexts (acrs). NEVER the token itself.
    uti: claims.uti || null,
    iat: claims.iat || null,
    acrs: claims.acrs || null,
    ip: input.clientIp || null,
    justification: verdict.text,
    sha256: created.sha256,
    authContext: config.authContext,
    userAgent: input.userAgent || null,
    subjectHash: typeof body.subjectHash === 'string' && SUBJECT_HASH.test(body.subjectHash) ? body.subjectHash : null
  };
  log(`${LOG_PREFIX} ${JSON.stringify(entry)}`);
  return reply(200, { receipt: created.receipt, ts: created.ts });
}

module.exports = { handleBypass, bearerToken, challenge, LOG_PREFIX, LOG_DENIED_PREFIX };
