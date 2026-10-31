'use strict';

// Self-contained API package for `swa deploy` (tools/package-api.js): the SWA CLI runs no Oryx build, so the
// package must hold the code, the environment configuration and (installed by the deploy script) the node_modules.
// These tests stay offline: node_modules is simulated with fake modules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repo = path.join(__dirname, '..');
const root = path.join(repo, 'package'); // the product
const envConfig = require('../package/tools/env-config');
const { packageApi, packageDir, verifyPackage } = require('../package/tools/package-api');

const FIXTURES = path.join(repo, 'tests', 'fixtures', 'environments');
process.env.NFM_ENVIRONMENTS_DIR = FIXTURES;
const rules = envConfig.resolveRules(envConfig.loadEnvironment('mfa-filled'), {});

function listing(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)}|${fs.statSync(p).size}`);
    }
  };
  walk(dir);
  // api/shared and api/config.json are generated (git-ignored) by the builds, possibly in parallel.
  return out.filter((l) => !/^(shared[\\/]|config\.json)/.test(l)).sort().join('\n');
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfm-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Fake node_modules: @azure/functions (app.http) and jose, enough to load the function. */
function fakeModules(dir) {
  const write = (name, code) => {
    const d = path.join(dir, 'node_modules', ...name.split('/'));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name, version: '0.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(d, 'index.js'), code);
  };
  write('@azure/functions', 'exports.app = { http() {} };');
  write('jose', 'exports.createRemoteJWKSet = () => () => {}; exports.jwtVerify = async () => { throw new Error("stub"); };');
}

test('package: code, environment configuration and copy of bypass.js; source api/ never modified', (t) => {
  const apiBefore = listing(path.join(root, 'api'));
  const target = path.join(tempDir(t), 'pkg');
  const dir = packageApi(rules, 'mfa-filled', target);
  assert.equal(dir, target);
  for (const f of ['package.json', 'package-lock.json', 'host.json', 'config.json', 'shared/bypass.js', 'src/functions/bypass.js', 'src/lib/bypass-handler.js', 'src/lib/token.js', 'src/lib/receipt.js']) {
    assert.ok(fs.existsSync(path.join(dir, f)), f);
  }
  assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false, 'node_modules: installed by npm ci in the package, not copied');
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(config.environment, 'mfa-filled');
  assert.equal(config.tenantId, '11111111-2222-4333-8444-555555555555');
  assert.equal(config.clientId, '99999999-2222-4333-8444-555555555555');
  assert.equal(config.authContext, 'c1');
  assert.equal(fs.readFileSync(path.join(dir, 'shared', 'bypass.js'), 'utf8'), fs.readFileSync(path.join(root, 'src', 'shared', 'bypass.js'), 'utf8'));
  assert.equal(listing(path.join(root, 'api')), apiBefore, 'the source api/ folder is unchanged (no node_modules, no extra generated file)');
  assert.equal(fs.existsSync(path.join(root, 'api', 'node_modules')), false, 'never npm ci in api/');
});

test('package: rebuilt from scratch (stale files removed) and one folder per environment under out/api-pkg', (t) => {
  const target = path.join(tempDir(t), 'pkg');
  fs.mkdirSync(path.join(target, 'src'), { recursive: true });
  fs.writeFileSync(path.join(target, 'src', 'stale.js'), 'x');
  packageApi(rules, 'mfa-filled', target);
  assert.equal(fs.existsSync(path.join(target, 'src', 'stale.js')), false);
  assert.equal(packageDir('mfa-filled'), path.join(root, 'out', 'api-pkg', 'mfa-filled'));
  assert.equal(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8').includes('out/'), true, 'out/ is ignored by git');
});

test('verification: refuses a package without node_modules; accepts a package where the function loads and registers', (t) => {
  const dir = packageApi(rules, 'mfa-filled', path.join(tempDir(t), 'pkg'));
  const missing = verifyPackage(dir);
  assert.equal(missing.ok, false);
  assert.match(missing.output, /npm ci --omit=dev/);
  fakeModules(dir);
  const ok = verifyPackage(dir);
  assert.equal(ok.ok, true, ok.output);
  assert.match(ok.output, /API OK : bypass bypass, jose, shared\/bypass\.js, config\.json \(mfa-filled\)/);
});

test('verification: fails when the function does not register or the configuration is incomplete', (t) => {
  const dir = packageApi(rules, 'mfa-filled', path.join(tempDir(t), 'pkg'));
  fakeModules(dir);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ environment: 'x' }));
  const incomplete = verifyPackage(dir);
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.output, /config\.json is incomplete/);
  packageApi(rules, 'mfa-filled', dir);
  fakeModules(dir);
  fs.writeFileSync(path.join(dir, 'src', 'functions', 'bypass.js'), '// does not register\n');
  const silent = verifyPackage(dir);
  assert.equal(silent.ok, false);
  assert.match(silent.output, /function not registered/);
});

test('api/package.json: production dependencies only, lockfile present (reproducible npm ci --omit=dev)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'api', 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@azure/functions', 'jose']);
  assert.equal(pkg.devDependencies, undefined);
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'api', 'package-lock.json'), 'utf8'));
  assert.ok(lock.packages['node_modules/jose'], 'jose in the lockfile');
  assert.ok(lock.packages['node_modules/@azure/functions'], '@azure/functions in the lockfile');
  // host.json: no extensionBundle (unneeded for a Node v4 HTTP function without an extension binding)
  const host = JSON.parse(fs.readFileSync(path.join(root, 'api', 'host.json'), 'utf8'));
  assert.equal(host.extensionBundle, undefined);
  assert.equal(host.version, '2.0');
});
