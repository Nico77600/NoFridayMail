'use strict';

/*
 * Validation of an Entra ID v2 access token (jose): signature (tenant public keys), issuer, audience,
 * tenant, access_as_user scope and authentication context (acrs claim).
 *
 * Result: { ok: true, claims } or { ok: false, error, detail } with error:
 *   'invalid_token'        token missing, malformed, expired, wrong signature / issuer / audience / tenant /
 *                          scope: the client must authenticate again;
 *   'insufficient_claims'  valid token but WITHOUT the authentication context (MFA not replayed): the client must
 *                          request a token again with the acrs claim ("claims" challenge).
 * The token is never logged or returned.
 *
 * Token origin: the X-NFM-Token header (see bypass-handler.js), NEVER Authorization. The managed functions
 * of Azure Static Web Apps replace Authorization with an internal token (HS256, issuer https://<guid>.scm.
 * azurewebsites.net, audience https://<guid>.azurewebsites.net/azurefunctions): the client's Entra token does not reach it.
 */
const { createRemoteJWKSet, jwtVerify, decodeProtectedHeader, decodeJwt } = require('jose');

const REQUIRED_SCOPE = 'access_as_user';

/**
 * SAFE diagnostic of a refused token: never the token or its signature, only non-secret metadata
 * (header: alg, typ, kid, presence of a nonce; unverified claims: aud, iss, ver, tid, appid / azp,
 * scp, acrs, idtyp; number of segments, to recognize a 5-segment JWE).
 */
function diagnose(token) {
  const diag = { parts: typeof token === 'string' && token !== '' ? token.split('.').length : 0 };
  if (typeof token !== 'string' || token === '') {
    return diag;
  }
  try {
    const h = decodeProtectedHeader(token);
    diag.header = { alg: h.alg, typ: h.typ, kid: h.kid, nonce: Object.prototype.hasOwnProperty.call(h, 'nonce') };
  } catch (e) {
    diag.headerError = e && e.code ? e.code : 'undecodable';
  }
  try {
    const c = decodeJwt(token);
    diag.claims = {
      aud: c.aud,
      iss: c.iss,
      ver: c.ver,
      tid: c.tid,
      appid: c.appid,
      azp: c.azp,
      scp: c.scp,
      acrs: c.acrs,
      uti: c.uti,
      idtyp: c.idtyp,
      // Dates (seconds): a token served from a cache rather than by a new MFA has an old iat.
      iat: c.iat,
      nbf: c.nbf,
      exp: c.exp,
      auth_time: c.auth_time
    };
  } catch (e) {
    diag.claimsError = e && e.code ? e.code : 'undecodable';
  }
  return diag;
}

/** Source of the tenant public keys (cached by jose). */
function remoteKeyResolver(tenantId) {
  return createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
}

/**
 * options: { tenantId, clientId, authContext, keyResolver (jose function), nowMs }.
 * Accepted audiences: <clientId> and api://<clientId>.
 */
async function validateAccessToken(token, options) {
  const { tenantId, clientId, authContext, keyResolver, nowMs } = options;
  if (typeof token !== 'string' || token === '') {
    return { ok: false, error: 'invalid_token', detail: 'missing' };
  }
  let payload;
  try {
    const verified = await jwtVerify(token, keyResolver, {
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      audience: [clientId, `api://${clientId}`],
      algorithms: ['RS256'],
      currentDate: typeof nowMs === 'number' ? new Date(nowMs) : undefined,
      clockTolerance: 60
    });
    payload = verified.payload;
  } catch (e) {
    return { ok: false, error: 'invalid_token', detail: e && e.code ? e.code : 'verification_failed', diag: diagnose(token) };
  }
  if (payload.tid !== tenantId) {
    return { ok: false, error: 'invalid_token', detail: 'tid', diag: diagnose(token) };
  }
  const scopes = typeof payload.scp === 'string' ? payload.scp.split(' ') : [];
  if (scopes.indexOf(REQUIRED_SCOPE) === -1) {
    return { ok: false, error: 'invalid_token', detail: 'scp', diag: diagnose(token) };
  }
  if (typeof payload.oid !== 'string' || payload.oid === '') {
    return { ok: false, error: 'invalid_token', detail: 'oid', diag: diagnose(token) };
  }
  // acrs: list of the satisfied authentication contexts (present only if the client requested it).
  const acrs = Array.isArray(payload.acrs) ? payload.acrs : typeof payload.acrs === 'string' ? [payload.acrs] : [];
  if (acrs.indexOf(authContext) === -1) {
    return { ok: false, error: 'insufficient_claims', detail: 'acrs', claims: payload, diag: diagnose(token) };
  }
  return { ok: true, claims: payload };
}

module.exports = { validateAccessToken, remoteKeyResolver, diagnose, REQUIRED_SCOPE };
