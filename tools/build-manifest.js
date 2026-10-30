'use strict';

/*
 * Produces the production manifest from manifest.xml (development template,
 * https://localhost:3000):
 *   - without an environment: dist/manifest.prod.xml (origin = ADDIN_BASE_URL);
 *   - with NFM_ENV=<name>: dist/<name>/manifest.prod.xml, with the Id, name, version, etc. of the environment.
 *
 *   ADDIN_BASE_URL=https://<name>.azurestaticapps.net node tools/build-manifest.js [--strict]
 *
 * --strict: fails when ADDIN_BASE_URL is missing (production build / deployment).
 * Without --strict, a substitute URL is used with a warning (CI, local build).
 */
const fs = require('fs');
const path = require('path');
const { describeBlockedDays } = require('./blocked-days');
const { getBuildContext } = require('./env-config');
const { normalizeOrigin, renderManifest } = require('./manifest-lib');

const PLACEHOLDER = 'https://nofridaymail.example.azurestaticapps.net';

/** Writes the manifest; returns { target, origin }. Throws an Error on failure. */
function buildManifest(ctx, options) {
  const strict = !!(options && options.strict);
  const pe = (options && options.processEnv) || process.env;
  const rules = ctx.rules;

  console.log(`Blocked days in effect: ${describeBlockedDays(rules.blockedDays)}${pe.BLOCKED_DAYS ? ' [BLOCKED_DAYS]' : ctx.env ? ` [${ctx.envName}]` : ' [default]'}`);
  console.log(`Working days proposed: ${describeBlockedDays(rules.workingDays)}${pe.WORKING_DAYS ? ' [WORKING_DAYS]' : ctx.env ? ` [${ctx.envName}]` : ' [default]'}`);
  if (ctx.env) {
    console.log(`Environment: ${ctx.envName} (Id ${ctx.env.addinId}, version ${ctx.env.version}, name "${ctx.env.displayName}")`);
  }

  let base = (pe.ADDIN_BASE_URL || '').trim();
  if (!base) {
    if (strict) {
      throw new Error('ADDIN_BASE_URL is required (e.g. https://<name>.azurestaticapps.net).');
    }
    console.warn(`ADDIN_BASE_URL is missing: using the substitute URL ${PLACEHOLDER} (the manifest cannot be deployed).`);
    base = PLACEHOLDER;
  }
  const origin = normalizeOrigin(base);

  const source = fs.readFileSync(path.join(ctx.root, 'manifest.xml'), 'utf8');
  const output = renderManifest(source, origin, ctx.env);
  fs.mkdirSync(ctx.outDir, { recursive: true });
  fs.writeFileSync(ctx.manifestFile, output, 'utf8');
  console.log(`Production manifest written: ${path.relative(process.cwd(), ctx.manifestFile)} (${origin})`);
  return { target: ctx.manifestFile, origin };
}

module.exports = { buildManifest };

if (require.main === module) {
  try {
    buildManifest(getBuildContext(process.env), { strict: process.argv.includes('--strict') });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
