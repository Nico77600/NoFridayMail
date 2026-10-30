'use strict';

/*
 * Prepares the api/ folder before a build or a deployment (MFA step, bypass.mfa.required):
 *   api/shared/bypass.js   copy of src/shared/bypass.js (SAME validation rule as the task pane and the handler;
 *                          the api/ folder is deployed alone, it cannot read src/);
 *   api/config.json        environment settings: tenantId, clientId, authContext, justification limits.
 * Both files are generated (ignored by git). No secret: the receipt key (NFM_RECEIPT_KEY) is an application
 * setting of the Static Web App, never a file.
 *
 *   node tools/prepare-api.js <environment>
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const apiDir = path.join(root, 'api');

/** API settings for resolved rules (rules.bypass, see env-config.resolveRules). */
function apiConfig(rules, envName) {
  const b = rules.bypass;
  return {
    environment: envName || null,
    tenantId: b.mfa.tenantId,
    clientId: b.mfa.clientId,
    authContext: b.mfa.authContext,
    bypass: {
      minLength: b.minLength,
      maxLength: b.maxLength,
      minWords: b.minWords,
      minDistinctChars: b.minDistinctChars
    }
  };
}

/** Atomic write (temporary file, then rename): a concurrent reader never sees a partial file. */
function writeAtomic(file, content) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}

/** Copies src/shared/bypass.js into api/shared/ (untouched when already identical); returns its path. */
function syncShared(dir) {
  const sharedDir = path.join(dir || apiDir, 'shared');
  fs.mkdirSync(sharedDir, { recursive: true });
  const copy = path.join(sharedDir, 'bypass.js');
  const source = fs.readFileSync(path.join(root, 'src', 'shared', 'bypass.js'));
  if (!fs.existsSync(copy) || !fs.readFileSync(copy).equals(source)) {
    writeAtomic(copy, source);
  }
  return copy;
}

/** Writes api/shared/bypass.js and api/config.json; returns the paths written. */
function prepareApi(rules, envName, dir) {
  const target = dir || apiDir;
  const copy = syncShared(target);
  const config = path.join(target, 'config.json');
  writeAtomic(config, JSON.stringify(apiConfig(rules, envName), null, 2) + '\n');
  return { copy, config };
}

module.exports = { prepareApi, syncShared, apiConfig };

if (require.main === module) {
  try {
    const { loadEnvironment, resolveRules, apiEnabled } = require('./env-config');
    const name = process.argv[2];
    if (!name) {
      throw new Error('Usage: node tools/prepare-api.js <environment>');
    }
    const rules = resolveRules(loadEnvironment(name), process.env);
    if (!apiEnabled(rules)) {
      throw new Error(`Environment "${name}" does not require the MFA step (bypass.mfa.required): no API to prepare.`);
    }
    const out = prepareApi(rules, name);
    console.log(`API prepared: ${path.relative(root, out.copy)}, ${path.relative(root, out.config)}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
