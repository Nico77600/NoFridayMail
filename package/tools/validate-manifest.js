'use strict';

/*
 * Validates the generated production manifest (office-addin-manifest):
 *   without an environment: dist/manifest.prod.xml; with NFM_ENV=<name> or --env <name>: dist/<name>/manifest.prod.xml.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getBuildContext } = require('./env-config');

const argv = process.argv.slice(2);
const i = argv.indexOf('--env');
if (i !== -1 && argv[i + 1]) {
  process.env.NFM_ENV = argv[i + 1];
}

try {
  const ctx = getBuildContext(process.env);
  if (!fs.existsSync(ctx.manifestFile)) {
    throw new Error(`Manifest not found: ${path.relative(ctx.root, ctx.manifestFile)} (run npm run build:prod first).`);
  }
  const cli = require.resolve('office-addin-manifest/cli.js');
  const result = spawnSync(process.execPath, [cli, 'validate', ctx.manifestFile], { stdio: 'inherit' });
  process.exit(result.status === null ? 1 : result.status);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
