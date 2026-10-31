'use strict';

/*
 * Build orchestrator.
 *
 *   node tools/build.js                    "historical" production build (dist/, manifest.prod.xml)
 *   node tools/build.js --dev              development build
 *   node tools/build.js --strict           production: ADDIN_BASE_URL is mandatory
 *   node tools/build.js --strict --env prod   production for the environment deploy/environments/prod.json
 *   NFM_ENV=prod node tools/build.js --strict equivalent
 *
 * With an environment: strictly validates the JSON, injects all the rules (webpack DefinePlugin),
 * generates dist/<env>/ (site + manifest.prod.xml), checks the bundle and produces the artifact
 * out/NoFridayMail-<env>-<version>.zip (site/, manifest.xml, DEPLOY.txt).
 * The BLOCKED_DAYS / WORKING_DAYS variables remain optional overrides.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const { getBuildContext, apiEnabled, deployErrors } = require('./env-config');
const { prepareApi } = require('./prepare-api');
const { buildManifest } = require('./build-manifest');
const { checkLaunchEvent } = require('./check-bundle');
const { deployText } = require('./deploy-text');

function parseArgs(argv) {
  const opts = { dev: false, strict: false, env: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dev') opts.dev = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--env') {
      opts.env = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--env=')) opts.env = a.slice(6);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (opts.env !== null && !opts.env) {
    throw new Error('--env expects an environment name (e.g. --env prod).');
  }
  return opts;
}

function runWebpack(mode) {
  const cli = require.resolve('webpack-cli/bin/cli.js');
  const result = spawnSync(process.execPath, [cli, '--mode', mode], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    throw new Error('webpack failed.');
  }
}

function makeArtifact(ctx, origin) {
  const outRoot = path.join(ctx.root, 'out');
  fs.mkdirSync(outRoot, { recursive: true });
  const file = path.join(outRoot, `NoFridayMail-${ctx.envName}-${ctx.env.version}.zip`);
  const zip = new AdmZip();
  zip.addLocalFolder(ctx.outDir, 'site');
  zip.addLocalFile(ctx.manifestFile, '', 'manifest.xml');
  zip.addFile('DEPLOY.txt', Buffer.from(deployText(ctx, origin), 'utf8'));
  zip.writeZip(file);
  return file;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.env) {
    process.env.NFM_ENV = opts.env;
  }
  const ctx = getBuildContext(process.env); // validates the environment and the overrides
  // A build for an environment is always "strict": it produces a deployable artifact.
  const strict = opts.strict || !!ctx.envName;
  if (ctx.envName && opts.dev) {
    throw new Error('--dev and --env are incompatible.');
  }

  if (strict && !String(process.env.ADDIN_BASE_URL || '').trim()) {
    // Fail immediately, before the long webpack work.
    throw new Error('ADDIN_BASE_URL is required (e.g. https://<name>.azurestaticapps.net).');
  }

  if (ctx.env) {
    // Placeholder add-in Id or Entra identifiers: the build is still possible (staging, tests), the
    // deployment is not (Deploy-NoFridayMail.ps1 refuses them).
    deployErrors(ctx.env).forEach((message) => console.warn(`WARNING: ${message}`));
  }
  if (ctx.env && apiEnabled(ctx.rules)) {
    const out = prepareApi(ctx.rules, ctx.envName);
    console.log(`API prepared: ${path.relative(ctx.root, out.copy)}, ${path.relative(ctx.root, out.config)}`);
  }

  runWebpack(opts.dev ? 'development' : 'production');
  const { origin } = buildManifest(ctx, { strict });

  if (!opts.dev) {
    const file = path.join(ctx.outDir, 'launchevent.js');
    const problems = checkLaunchEvent(fs.readFileSync(file, 'utf8'), ctx.rules);
    const rel = path.relative(ctx.root, file).replace(/\\/g, '/');
    if (problems.length) {
      throw new Error(`${rel} is not compliant: ${problems.join('; ')}`);
    }
    console.log(`${rel} is compliant (classic, ASCII, no DOM, environment rules injected).`);
  }

  if (ctx.envName) {
    const artifact = makeArtifact(ctx, origin);
    console.log(`Artifact: ${path.relative(process.cwd(), artifact)}`);
  }
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
