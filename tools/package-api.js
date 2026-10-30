'use strict';

/*
 * SELF-CONTAINED API package for `swa deploy` (MFA step, bypass.mfa.required).
 *
 * The SWA CLI (StaticSitesClient) sends the API folder as is: it runs NO Oryx build, so neither
 * @azure/functions nor jose would be installed and no function would register (404 on /api/bypass).
 * This package therefore holds everything needed, node_modules included (installed by the deploy script with
 * "npm ci --omit=dev" IN THIS FOLDER, never in api/, which stays clean for git):
 *
 *   out/api-pkg/<env>/package.json, package-lock.json, host.json, src/   copied from api/
 *   out/api-pkg/<env>/shared/bypass.js, config.json                      generated for the environment
 *   out/api-pkg/<env>/node_modules/                                      npm ci --omit=dev (deploy script)
 *
 *   node tools/package-api.js <environment>             creates the package (without node_modules)
 *   node tools/package-api.js <environment> --verify    checks the installed package: the function loads and
 *                                                       registers (app.http "bypass"), jose and the copy of
 *                                                       bypass.js load, config.json is readable
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { prepareApi } = require('./prepare-api');

const root = path.join(__dirname, '..');
const apiDir = path.join(root, 'api');

/** Package folder of an environment. */
function packageDir(envName) {
  return path.join(root, 'out', 'api-pkg', envName);
}

/** (Re)creates the package without node_modules; returns the folder. `source`: source api/ folder (tests). */
function packageApi(rules, envName, target, source) {
  const dir = target || packageDir(envName);
  const from = source || apiDir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'host.json']) {
    fs.copyFileSync(path.join(from, file), path.join(dir, file));
  }
  fs.cpSync(path.join(from, 'src'), path.join(dir, 'src'), { recursive: true });
  prepareApi(rules, envName, dir); // shared/bypass.js and config.json of this environment
  return dir;
}

const CHECK = `
const path = require('path');
const functions = require('@azure/functions');
const registered = [];
const original = functions.app.http;
functions.app.http = function (name, options) { registered.push(name + ' ' + options.route); return original.call(this, name, options); };
require('./src/functions/bypass.js');
if (registered.join() !== 'bypass bypass') throw new Error('function not registered: ' + registered.join());
require('jose');
require('./shared/bypass.js');
const config = JSON.parse(require('fs').readFileSync('config.json', 'utf8'));
if (!config.tenantId || !config.clientId || !config.authContext) throw new Error('config.json is incomplete');
console.log('API OK : ' + registered.join() + ', jose, shared/bypass.js, config.json (' + config.environment + ')');
`;

/** Loads the function from the installed package. Returns { ok, output }. */
function verifyPackage(dir) {
  if (!fs.existsSync(path.join(dir, 'node_modules', '@azure', 'functions')) || !fs.existsSync(path.join(dir, 'node_modules', 'jose'))) {
    return { ok: false, output: 'node_modules is incomplete: run "npm ci --omit=dev" in ' + dir };
  }
  const r = spawnSync(process.execPath, ['-e', CHECK], { cwd: dir, encoding: 'utf8' });
  return { ok: r.status === 0, output: ((r.stdout || '') + (r.stderr || '')).trim() };
}

module.exports = { packageApi, packageDir, verifyPackage };

if (require.main === module) {
  try {
    const { loadEnvironment, resolveRules, apiEnabled } = require('./env-config');
    const name = process.argv[2];
    if (!name) {
      throw new Error('Usage: node tools/package-api.js <environment> [--verify]');
    }
    if (process.argv.includes('--verify')) {
      const result = verifyPackage(packageDir(name));
      console.log(result.output);
      process.exit(result.ok ? 0 : 1);
    }
    const rules = resolveRules(loadEnvironment(name), process.env);
    if (!apiEnabled(rules)) {
      throw new Error(`Environment "${name}" does not require the MFA step (bypass.mfa.required): no API to package.`);
    }
    const dir = packageApi(rules, name);
    console.log(`API package created: ${path.relative(root, dir)} (without node_modules)`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
