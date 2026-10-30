'use strict';

/*
 * Verifies the receipt of an X-NoFriday-Bypass header (v2): offline compliance tool.
 *
 *   $env:NFM_RECEIPT_KEY = '<Static Web App key>'      # base64, never as a command-line argument
 *   node tools/verify-receipt.js --header "v2; Urgent%20reply%20to%20the%20customer; r=abcDEF123456.1793356768.xxxxxxxxxxxxxxxxxxxxxx" --oid <oid>
 *   node tools/verify-receipt.js --receipt <receipt> --oid <oid> --justification "Urgent reply to the customer"
 *
 * The receipt is signed with the sender's oid (Entra) and the justification: the oid is found in the API log
 * (NFM_BYPASS) or in the Entra sign-in logs. Exit code: 0 valid, 1 invalid, 2 usage / key.
 * The key is read from NFM_RECEIPT_KEY (az staticwebapp appsettings list ...; never paste it into a repository
 * file or a ticket).
 */
const { verifyReceipt, decodeKey } = require('../api/src/lib/receipt');
const bypass = require('../src/shared/bypass');

/** Verifies a complete header. Returns { valid, reason?, id?, ts?, date?, justification?, version? }. */
function verifyHeader({ key, header, oid }) {
  const parsed = bypass.parseHeaderValue(header);
  if (!parsed) {
    return { valid: false, reason: 'header' };
  }
  if (parsed.version !== 'v2') {
    return { valid: false, reason: 'version', version: parsed.version, justification: parsed.justification };
  }
  return Object.assign({ version: 'v2', justification: parsed.justification }, verifyParts({ key, receipt: parsed.receipt, oid, justification: parsed.justification }));
}

/** Verifies a receipt, an oid and a justification (cleaned before computing). */
function verifyParts({ key, receipt, oid, justification }) {
  const result = verifyReceipt({ key, receipt, oid, justification: bypass.normalizeJustification(justification) });
  if (result.ts) {
    result.date = new Date(result.ts * 1000).toISOString();
  }
  return result;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (!/^--(header|oid|receipt|justification)$/.test(name) || i + 1 >= argv.length) {
      throw new Error(`Unknown argument or missing value: ${name}`);
    }
    out[name.slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

function main(argv, env) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  const usage =
    'Usage: NFM_RECEIPT_KEY=<base64 key> node tools/verify-receipt.js --header "<value>" --oid <oid>\n' +
    '       NFM_RECEIPT_KEY=<base64 key> node tools/verify-receipt.js --receipt <receipt> --oid <oid> --justification "<text>"';
  const key = decodeKey(env.NFM_RECEIPT_KEY);
  if (!key) {
    console.error(`The NFM_RECEIPT_KEY variable (base64, 32 bytes minimum) is missing or invalid.\n${usage}`);
    return 2;
  }
  if (!args.oid || !(args.header || (args.receipt && args.justification !== undefined))) {
    console.error(usage);
    return 2;
  }
  const result = args.header
    ? verifyHeader({ key, header: args.header, oid: args.oid })
    : verifyParts({ key, receipt: args.receipt, oid: args.oid, justification: args.justification });
  if (result.valid) {
    console.log(`VALID    receipt ${result.id}, issued on ${result.date}`);
    if (result.justification) console.log(`         justification: ${result.justification}`);
    return 0;
  }
  const why = {
    header: 'the header is not in the v1/v2 format',
    version: 'the header is version 1: no receipt (send without the MFA step)',
    format: 'the receipt has an invalid form',
    signature: 'the signature does not match (different oid, justification or receipt, or another key)'
  }[result.reason];
  console.log(`INVALID  ${why}`);
  return 1;
}

module.exports = { verifyHeader, verifyParts, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
