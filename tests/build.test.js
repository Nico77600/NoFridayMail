'use strict';

// Real build of the "example" environment (deliberately different rules: Monday+Tuesday blocked,
// suggestions at 09:30...): checks the served bundle, the manifest and the zip artifact. Slow (webpack).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');

const repo = path.join(__dirname, '..');
const root = path.join(repo, 'package'); // the product
const BASE = 'https://example-staging.azurestaticapps.net';
const dist = path.join(root, 'dist', 'example');
const zipFile = path.join(root, 'out', 'NoFridayMail-example-1.0.0.0.zip');

function build(env, extra) {
  return spawnSync(process.execPath, [path.join(root, 'tools', 'build.js'), '--env', 'example'], {
    cwd: root,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { ADDIN_BASE_URL: BASE }, extra, env)
  });
}

test('build:prod --env without ADDIN_BASE_URL or with an unknown environment: immediate failure', () => {
  const noUrl = spawnSync(process.execPath, [path.join(root, 'tools', 'build.js'), '--env', 'example'], {
    cwd: root,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { ADDIN_BASE_URL: '' })
  });
  assert.notEqual(noUrl.status, 0);
  assert.match(noUrl.stderr, /ADDIN_BASE_URL is required/);
  const unknown = spawnSync(process.execPath, [path.join(root, 'tools', 'build.js'), '--env', 'nimporte'], {
    cwd: root, encoding: 'utf8', env: Object.assign({}, process.env, { ADDIN_BASE_URL: BASE })
  });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /not found/);
  const dev = spawnSync(process.execPath, [path.join(root, 'tools', 'build.js'), '--dev', '--env', 'example'], {
    cwd: root, encoding: 'utf8', env: Object.assign({}, process.env, { ADDIN_BASE_URL: BASE })
  });
  assert.match(dev.stderr, /incompatible/);
});

test('build:prod --env example: injected rules, manifest, artifact', { timeout: 280000 }, () => {
  const result = build({}, {});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Environment: example/);
  assert.match(result.stdout, /launchevent\.js is compliant/);

  // --- manifest
  const manifest = fs.readFileSync(path.join(dist, 'manifest.prod.xml'), 'utf8');
  assert.match(manifest, /<Id>11111111-2222-4333-8444-555555555555<\/Id>/);
  assert.match(manifest, /<Version>1\.0\.0\.0<\/Version>/);
  assert.match(manifest, /NoFridayMail \(Staging\)/);
  assert.equal(manifest.includes('localhost'), false);
  assert.equal(manifest.includes('2178c516'), false);
  assert.match(manifest, new RegExp(`${BASE}/launchevent\\.js`));

  // --- site
  for (const f of ['launchevent.js', 'taskpane.js', 'taskpane.html', 'commands.html', 'index.html', 'staticwebapp.config.json']) {
    assert.ok(fs.existsSync(path.join(dist, f)), f);
  }
  assert.equal(fs.existsSync(path.join(dist, 'preview.html')), false);

  // --- the served bundle applies the environment rules (run with a fake Office)
  const code = fs.readFileSync(path.join(dist, 'launchevent.js'), 'utf8');
  function run(now, lang) {
    const RealDate = Date;
    class FakeDate extends RealDate {
      constructor(...a) { super(...(a.length ? a : [now])); }
      static now() { return now; }
    }
    const handlers = {};
    const out = {};
    vm.runInNewContext(code, {
      Date: FakeDate,
      Office: {
        onReady() {},
        actions: { associate: (n, f) => { handlers[n] = f; } },
        AsyncResultStatus: { Succeeded: 'succeeded', Failed: 'failed' },
        context: {
          displayLanguage: lang,
          requirements: { isSetSupported: () => true },
          mailbox: { item: { delayDeliveryTime: { getAsync: (o, cb) => cb({ status: 'succeeded', value: 0, asyncContext: o.asyncContext }) } } }
        }
      }
    });
    handlers.onMessageSendHandler({ completed: (o) => { out.mail = o; } });
    handlers.onAppointmentSendHandler({ completed: (o) => { out.appt = o; } });
    return out;
  }
  const monday = run(new Date(2026, 10, 2, 10, 0).getTime());
  assert.equal(monday.mail.allowEvent, false, 'Monday blocked in "example"');
  assert.match(monday.mail.errorMessage, /interdit le lundi et le mardi/);
  assert.match(monday.mail.errorMessage, /mercredi ou jeudi à 09:30/, 'send time 09:30 injected, Wednesday and Thursday proposed');
  assert.match(monday.appt.errorMessage, /à partir de mercredi/);
  assert.equal(run(new Date(2026, 10, 3, 10, 0).getTime()).mail.allowEvent, false, 'Tuesday blocked');
  // (objects from another vm context: compared by serialization)
  assert.equal(JSON.stringify(run(new Date(2026, 9, 30, 10, 0).getTime()).mail), JSON.stringify({ allowEvent: true }), 'Friday is NOT blocked in "example"');
  assert.match(run(new Date(2026, 10, 2, 10, 0).getTime(), 'en-US').mail.errorMessage, /not allowed on Mondays and Tuesdays/);

  // --- zip artifact: site + manifest + DEPLOY.txt
  const zip = new AdmZip(zipFile);
  const names = zip.getEntries().map((e) => e.entryName);
  for (const n of ['site/launchevent.js', 'site/taskpane.html', 'site/manifest.prod.xml', 'manifest.xml', 'DEPLOY.txt']) {
    assert.ok(names.includes(n), `${n} in the zip (${names.join(', ')})`);
  }
  assert.equal(zip.readAsText('manifest.xml'), manifest);
  const deployText = zip.readAsText('DEPLOY.txt');
  assert.match(deployText, /11111111-2222-4333-8444-555555555555/);
  assert.match(deployText, /Blocked days\s+: Monday \(1\), Tuesday \(2\)/);
  assert.match(deployText, /Integrated apps/);
  // DEPLOY.txt says where to put the token (variable name) but holds no secret value.
  assert.doesNotMatch(deployText, /apiKey|SWA_CLI_DEPLOYMENT_TOKEN\s*=\s*\S|token\s*:\s*\S/i, 'no secret in DEPLOY.txt');
});

test('BLOCKED_DAYS remains a possible override of an environment build', { timeout: 280000 }, () => {
  const result = build({}, { BLOCKED_DAYS: '4' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Thursday \(\[4\]\) \[BLOCKED_DAYS\]/);
  const code = fs.readFileSync(path.join(dist, 'launchevent.js'), 'utf8');
  assert.ok(code.replace(/\s/g, '').includes('blockedDays:[4]'));
  // restore the normal "example" build for the other reads
  assert.equal(build({}, {}).status, 0);
});

// Builds of fixture environments (tests/fixtures/environments, via NFM_ENVIRONMENTS_DIR): never the operator files
// (deploy/environments.local). Only example.json (template) is built as is.
const FIXTURES = path.join(repo, 'tests', 'fixtures', 'environments');
function buildEnv(name, base, dir) {
  const env = Object.assign({}, process.env, { ADDIN_BASE_URL: base });
  if (dir) env.NFM_ENVIRONMENTS_DIR = dir;
  else delete env.NFM_ENVIRONMENTS_DIR;
  return spawnSync(process.execPath, [path.join(root, 'tools', 'build.js'), '--env', name], { cwd: root, encoding: 'utf8', env });
}
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('build mfa-filled (MFA step): MSAL only in the task pane, API prepared, /api/* route, no warning', { timeout: 280000 }, () => {
  const r = buildEnv('mfa-filled', 'https://swa-nfm-fixture-mfa-filled.azurestaticapps.net', FIXTURES);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /launchevent\.js is compliant/);
  assert.match(r.stdout, /API prepared: api[\\/]shared[\\/]bypass\.js/);
  assert.doesNotMatch(r.stderr, /WARNING/, 'identifiers filled in: no warning');
  const dist = path.join('dist', 'mfa-filled');
  const launch = read(dist, 'launchevent.js');
  const pane = read(dist, 'taskpane.js');
  assert.doesNotMatch(launch, /msal|@azure|acquireToken|NestedAppAuth/i, 'the event runtime does not contain MSAL');
  assert.match(pane, /interaction_in_progress/, 'the task pane embeds MSAL');
  assert.ok(pane.length > 200000, 'MSAL (large) in the task pane');
  assert.ok(
    launch.replace(/\s/g, '').includes('mfa:{required:!0,tenantId:"11111111-2222-4333-8444-555555555555",clientId:"99999999-2222-4333-8444-555555555555",authContext:"c1"}'),
    'MFA settings injected'
  );
  const swa = JSON.parse(read(dist, 'staticwebapp.config.json'));
  assert.deepEqual(swa.routes, [{ route: '/api/*', allowedRoles: ['anonymous'], headers: { 'Cache-Control': 'no-store' } }]);
  assert.equal(swa.platform.apiRuntime, 'node:22');
  assert.equal(swa.globalHeaders['X-Content-Type-Options'], 'nosniff', 'existing headers kept');
  const apiConfig = JSON.parse(read('api', 'config.json'));
  assert.equal(apiConfig.environment, 'mfa-filled');
  assert.equal(apiConfig.tenantId, '11111111-2222-4333-8444-555555555555');
  assert.equal(apiConfig.clientId, '99999999-2222-4333-8444-555555555555');
  assert.equal(apiConfig.authContext, 'c1');
  assert.deepEqual(apiConfig.bypass, { minLength: 20, maxLength: 200, minWords: 3, minDistinctChars: 6 });
  assert.equal(read('api', 'shared', 'bypass.js'), read('src', 'shared', 'bypass.js'));
  const deployText = new AdmZip(path.join(root, 'out', 'NoFridayMail-mfa-filled-1.1.0.0.zip')).readAsText('DEPLOY.txt');
  assert.match(deployText, /Exceptional send/);
  assert.match(deployText, /MFA step\s+: required/);
});

test('build mfa-placeholder: the build succeeds but warns about placeholder values', { timeout: 280000 }, () => {
  const r = buildEnv('mfa-placeholder', 'https://swa-nfm-fixture-mfa-placeholder.azurestaticapps.net', FIXTURES);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /WARNING: bypass\.mfa\.tenantId and bypass\.mfa\.clientId: placeholder value/);
  assert.ok(read('dist', 'mfa-placeholder', 'launchevent.js').replace(/\s/g, '').includes('tenantId:"00000000-0000-0000-0000-000000000000"'));
});

test('build without MFA (bypass-v1) and protected environment: no MSAL, no API, site configuration file unchanged', { timeout: 280000 }, () => {
  const v1 = buildEnv('bypass-v1', 'https://swa-nfm-fixture-bypass-v1.azurestaticapps.net', FIXTURES);
  assert.equal(v1.status, 0, v1.stdout + v1.stderr);
  assert.doesNotMatch(v1.stdout, /API prepared/);
  assert.doesNotMatch(read('dist', 'bypass-v1', 'taskpane.js'), /interaction_in_progress/);
  assert.equal(read('dist', 'bypass-v1', 'staticwebapp.config.json'), read('staticwebapp.config.json'));
  assert.ok(read('dist', 'bypass-v1', 'launchevent.js').replace(/\s/g, '').includes('bypass:{enabled:!0,minLength:20,maxLength:200,minWords:3,minDistinctChars:6}'));

  // protected environment (lab-frozen): no MSAL, no API, no bypass injected, site configuration file copied as is
  const lab = buildEnv('lab-frozen', 'https://swa-nfm-fixture-lab-frozen.azurestaticapps.net', FIXTURES);
  assert.equal(lab.status, 0, lab.stdout + lab.stderr);
  assert.doesNotMatch(lab.stdout, /API prepared/);
  assert.equal(read('dist', 'lab-frozen', 'staticwebapp.config.json'), read('staticwebapp.config.json'), 'staticwebapp.config.json of the protected environment copied as is');
  assert.doesNotMatch(read('dist', 'lab-frozen', 'taskpane.js'), /interaction_in_progress/, 'no MSAL in the task pane of the protected environment');
  assert.equal(read('dist', 'lab-frozen', 'launchevent.js').replace(/\s/g, '').includes('bypass:{'), false, 'no bypass injected for the protected environment');
});
