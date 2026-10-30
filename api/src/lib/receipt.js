'use strict';

/*
 * Exceptional-send receipt: pure functions (node:crypto only, no dependency).
 *
 *   receipt   = <id>.<ts>.<sig>
 *   id        12 base64url characters (9 random bytes)
 *   ts        seconds since 1970 (10 digits)
 *   sig       first 22 characters of base64url(HMAC-SHA256(key, "<id>.<ts>.<oid>.<sha256(justification)>"))
 *   oid       Entra object identifier of the user (oid claim of the token)
 *   sha256    lowercase hexadecimal SHA-256 of the CLEANED justification (UTF-8)
 *
 * The key is the NFM_RECEIPT_KEY application setting: base64 of at least 32 random bytes. It is never logged
 * or returned. The add-in cannot verify the signature (no secret on the client side): verification happens
 * server side / for compliance (tools/verify-receipt.js).
 */
const crypto = require('node:crypto');

const ID_LENGTH = 12;
const SIG_LENGTH = 22;
const MIN_KEY_BYTES = 32;
const RECEIPT_PATTERN = /^([A-Za-z0-9_-]{12})\.(\d{10})\.([A-Za-z0-9_-]{22})$/;

/** Key (Buffer) from the base64 application setting; null if missing or too short (< 32 bytes). */
function decodeKey(setting) {
  if (typeof setting !== 'string' || setting.trim() === '') {
    return null;
  }
  const key = Buffer.from(setting.trim(), 'base64');
  return key.length >= MIN_KEY_BYTES ? key : null;
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function newReceiptId() {
  return crypto.randomBytes(9).toString('base64url'); // 9 bytes = exactly 12 characters
}

function signature(key, id, ts, oid, justification) {
  const message = `${id}.${ts}.${oid}.${sha256Hex(justification)}`;
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest('base64url').slice(0, SIG_LENGTH);
}

/**
 * Creates a receipt. justification: already cleaned text (bypass.normalizeJustification).
 * Returns { receipt, id, ts, sig, sha256 }.
 */
function createReceipt({ key, oid, justification, nowMs, id }) {
  if (!Buffer.isBuffer(key) || key.length < MIN_KEY_BYTES) {
    throw new Error('Receipt key missing or too short.');
  }
  if (typeof oid !== 'string' || oid === '') {
    throw new Error('oid is required.');
  }
  const receiptId = id || newReceiptId();
  const ts = Math.floor((typeof nowMs === 'number' ? nowMs : Date.now()) / 1000);
  const sig = signature(key, receiptId, ts, oid, justification);
  return { receipt: `${receiptId}.${ts}.${sig}`, id: receiptId, ts, sig, sha256: sha256Hex(justification) };
}

/**
 * Verifies a receipt for an oid and a (cleaned) justification. Returns { valid, reason, id?, ts? } with
 * reason: 'format' | 'signature' (absent when valid). Constant-time comparison.
 */
function verifyReceipt({ key, receipt, oid, justification }) {
  const match = typeof receipt === 'string' ? RECEIPT_PATTERN.exec(receipt) : null;
  if (!match) {
    return { valid: false, reason: 'format' };
  }
  const [, id, tsText, sig] = match;
  const expected = signature(key, id, tsText, String(oid), justification);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  return valid ? { valid: true, id, ts: Number(tsText) } : { valid: false, reason: 'signature', id, ts: Number(tsText) };
}

module.exports = {
  ID_LENGTH,
  SIG_LENGTH,
  MIN_KEY_BYTES,
  RECEIPT_PATTERN,
  decodeKey,
  sha256Hex,
  newReceiptId,
  createReceipt,
  verifyReceipt
};
