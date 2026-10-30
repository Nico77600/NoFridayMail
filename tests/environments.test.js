'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const envConfig = require('../tools/env-config');
const { renderManifest, normalizeOrigin } = require('../tools/manifest-lib');
const { checkLaunchEvent } = require('../tools/check-bundle');

const root = path.join(__dirname, '..');
// The tests NEVER read the operator environment files (deploy/environments.local): only example.json (template) is read as is
// from deploy/environments. Everything else goes through tests/fixtures/environments (including lab-frozen, a protected
// environment with neutral values) thanks to NFM_ENVIRONMENTS_DIR (tools/env-config.js), active for this whole file;
// real() temporarily switches it to the git-tracked folder.
const FIXTURES = path.join(root, 'tests', 'fixtures', 'environments');
const REAL = path.join(root, 'deploy', 'environments');
process.env.NFM_ENVIRONMENTS_DIR = FIXTURES;
function real(fn) {
  const saved = process.env.NFM_ENVIRONMENTS_DIR;
  process.env.NFM_ENVIRONMENTS_DIR = REAL;
  try {
    return fn();
  } finally {
    process.env.NFM_ENVIRONMENTS_DIR = saved;
  }
}
const FROZEN = ['example'];
const readEnv = (name) => JSON.parse(fs.readFileSync(path.join(FROZEN.includes(name) ? REAL : FIXTURES, `${name}.json`), 'utf8'));
const loadFrozen = (name) => (FROZEN.includes(name) ? real(() => envConfig.loadEnvironment(name)) : envConfig.loadEnvironment(name));
const readReal = (name) => JSON.parse(fs.readFileSync(path.join(REAL, `${name}.json`), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const manifestSource = fs.readFileSync(path.join(root, 'manifest.xml'), 'utf8');

// ------------------------------------------------------------------ validity of the shipped files

test('operator files: schema-valid (values not checked); validate:env accepts the folder', () => {
  real(() => {
    const names = envConfig.listEnvironmentNames();
    for (const name of ['example', 'prod']) assert.ok(names.includes(name), name);
    for (const name of names) {
      assert.deepEqual(envConfig.validateEnvironment(readReal(name), name), [], name);
      assert.doesNotThrow(() => envConfig.loadEnvironment(name), name);
    }
    assert.deepEqual(envConfig.validateAll().errors, []);
  });
});

test('fixtures: tests/fixtures/environments is a valid folder of unique environments', () => {
  assert.deepEqual(envConfig.listEnvironmentNames(), ['base', 'bypass-v1', 'lab-frozen', 'mfa-filled', 'mfa-placeholder']);
  assert.deepEqual(envConfig.validateAll().errors, []);
  assert.equal(readEnv('base').bypass, undefined);
  assert.equal(readEnv('bypass-v1').bypass.mfa, undefined);
  assert.equal(readEnv('mfa-filled').bypass.mfa.required, true);
  assert.equal(readEnv('mfa-placeholder').bypass.mfa.tenantId, envConfig.PLACEHOLDER_GUID);
});

test('lab-frozen (fixture): protected environment with neutral values', () => {
  const lab = readEnv('lab-frozen');
  assert.equal(lab.addinId, '2178c516-c0d6-4b65-bbca-ef763a06ba16');
  assert.equal(lab.azure.staticWebAppName, 'swa-nfm-fixture-lab-frozen');
  assert.equal(lab.azure.resourceGroup, 'rg-nfm-fixtures');
  assert.deepEqual(lab.rules.blockedDays, [3, 4]);
  assert.equal(lab.protected, true);
  assert.match(lab.description, /do not redeploy without agreement/i);
  // The development manifest (manifest.xml) carries the Id of the frozen protected environment: same Id.
  assert.match(manifestSource, new RegExp(`<Id>${lab.addinId}</Id>`));
});

test('distinct GUIDs: lab-frozen, prod and example can coexist in one tenant', () => {
  const all = [readEnv('lab-frozen'), readReal('prod'), readReal('example')];
  assert.equal(new Set(all.map((e) => e.addinId.toLowerCase())).size, 3);
  assert.equal(new Set(all.map((e) => e.azure.staticWebAppName)).size, 3);
});

test('uniqueness: a duplicate addinId or SWA resource is detected', () => {
  const a = readEnv('base');
  const b = Object.assign(clone(a), { name: 'autre' });
  const errors = envConfig.uniquenessErrors([{ name: 'base', env: a }, { name: 'autre', env: b }]);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /addinId is the same as/);
  assert.match(errors[1], /same Static Web Apps resource/);
  b.addinId = '99999999-2222-4333-8444-555555555555';
  b.azure.resourceGroup = 'rg-ailleurs';
  assert.deepEqual(envConfig.uniquenessErrors([{ name: 'base', env: a }, { name: 'autre', env: b }]), []);
  b.addinId = a.addinId.toUpperCase();
  assert.match(envConfig.uniquenessErrors([{ name: 'base', env: a }, { name: 'autre', env: b }])[0], /addinId is the same as/, 'case-insensitive');
});

// ------------------------------------------------------------------ invalid cases

function mutate(fn) {
  const env = clone(readEnv('base'));
  fn(env);
  return envConfig.validateEnvironment(env, 'base');
}

test('invalid: structure (missing field, unknown property, types)', () => {
  assert.match(mutate((e) => { delete e.addinId; }).join('|'), /addinId/);
  assert.match(mutate((e) => { delete e.azure; }).join('|'), /azure/);
  assert.match(mutate((e) => { delete e.rules.blockedDays; }).join('|'), /blockedDays/);
  assert.match(mutate((e) => { e.inconnu = 1; }).join('|'), /unknown property "inconnu"/);
  assert.match(mutate((e) => { e.rules.extra = 1; }).join('|'), /unknown property "extra"/);
  assert.notDeepEqual(mutate((e) => { e.displayName = 42; }), []);
  assert.deepEqual(envConfig.validateEnvironment(null, 'base').length, 1);
  assert.deepEqual(envConfig.validateEnvironment([], 'base').length, 1);
});

test('invalid: GUID, version, names and URL', () => {
  for (const bad of ['pas-un-guid', '2178c516-c0d6-4b65-bbca', '2178c516-c0d6-4b65-bbca-ef763a06ba1z', '']) {
    assert.notDeepEqual(mutate((e) => { e.addinId = bad; }), [], `addinId ${bad}`);
  }
  assert.notDeepEqual(mutate((e) => { e.azure.subscriptionId = 'xyz'; }), []);
  for (const bad of ['1.1.0', '1.1.0.0.0', 'a.b.c.d', '1.1.0.-1', '']) {
    assert.notDeepEqual(mutate((e) => { e.version = bad; }), [], `version ${bad}`);
  }
  assert.match(mutate((e) => { e.version = '0.9.0.0'; }).join('|'), /at least 1\.0\.0\.0/);
  assert.match(mutate((e) => { e.version = '1.70000.0.0'; }).join('|'), /65535|version/);
  assert.notDeepEqual(mutate((e) => { e.supportUrl = 'http://exemple.fr'; }), []);
  assert.notDeepEqual(mutate((e) => { e.displayName = 'Nom <b>'; }), []);
  assert.notDeepEqual(mutate((e) => { e.providerName = ''; }), []);
  assert.notDeepEqual(mutate((e) => { e.azure.staticWebAppName = 'x'; }), []);
  assert.notDeepEqual(mutate((e) => { e.azure.staticWebAppName = '-mauvais-'; }), []);
  assert.notDeepEqual(mutate((e) => { e.azure.location = 'West Europe'; }), []);
  assert.notDeepEqual(mutate((e) => { e.azure.sku = 'Premium'; }), []);
  assert.notDeepEqual(mutate((e) => { e.defaultLanguage = 'de'; }), []);
  assert.match(envConfig.validateEnvironment(Object.assign(clone(readEnv('base')), { name: 'autre' }), 'base').join('|'), /name .* must equal the file name/);
  assert.notDeepEqual(mutate((e) => { e.name = 'Prod!'; }), []);
});

test('invalid: blocked and working days', () => {
  for (const bad of [[7], [-1], [1.5], ['5'], [], [5, 5], [0, 1, 2, 3, 4, 5, 6]]) {
    assert.notDeepEqual(mutate((e) => { e.rules.blockedDays = bad; }), [], `blockedDays ${JSON.stringify(bad)}`);
  }
  for (const bad of [[7], [], [1, 1], ['1']]) {
    assert.notDeepEqual(mutate((e) => { e.rules.workingDays = bad; }), [], `workingDays ${JSON.stringify(bad)}`);
  }
  // Consistency: at least one unblocked working day.
  const all = mutate((e) => { e.rules.workingDays = [5]; e.rules.blockedDays = [5]; });
  assert.match(all.join('|'), /at least one working day/);
  assert.match(mutate((e) => { e.rules.workingDays = [1, 2]; e.rules.blockedDays = [1, 2, 3]; }).join('|'), /at least one working day/);
  assert.deepEqual(mutate((e) => { e.rules.workingDays = [1, 2]; e.rules.blockedDays = [1]; }), []);
  assert.deepEqual(mutate((e) => { e.rules.blockedDays = [0, 6]; }), [], 'blocked weekend (working days intact): valid');
});

test('invalid: times (sendHour, sendMinute, slotTimes, dayCount)', () => {
  for (const bad of ['9:00', '24:00', '12:60', 'midi', '08:00:00', '']) {
    assert.notDeepEqual(mutate((e) => { e.rules.slotTimes = ['08:00', bad]; }), [], `slotTimes ${bad}`);
  }
  assert.notDeepEqual(mutate((e) => { e.rules.slotTimes = []; }), []);
  assert.notDeepEqual(mutate((e) => { e.rules.slotTimes = ['08:00', '08:00']; }), [], 'duplicate');
  assert.notDeepEqual(mutate((e) => { e.rules.slotTimes = ['01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00', '08:00', '09:00']; }), [], 'more than 8');
  for (const bad of [24, -1, 8.5, '8']) {
    assert.notDeepEqual(mutate((e) => { e.rules.sendHour = bad; }), [], `sendHour ${bad}`);
  }
  assert.notDeepEqual(mutate((e) => { e.rules.sendMinute = 60; }), []);
  for (const bad of [0, 11, 2.5]) {
    assert.notDeepEqual(mutate((e) => { e.rules.dayCount = bad; }), [], `dayCount ${bad}`);
  }
  assert.deepEqual(mutate((e) => { e.rules.slotTimes = ['00:00', '23:59']; e.rules.sendHour = 23; e.rules.sendMinute = 59; }), []);
});

// ------------------------------------------------------------------ exceptional send (bypass)

test('bypass: absent from the protected environment and the template (disabled); fixtures: v1 without mfa, filled / placeholder mfa', () => {
  assert.equal(readEnv('lab-frozen').bypass, undefined, 'lab-frozen does not change');
  assert.equal(readEnv('example').bypass, undefined);
  assert.equal(readEnv('base').bypass, undefined);
  assert.deepEqual(readEnv('bypass-v1').bypass, { enabled: true, minLength: 20, maxLength: 200, minWords: 3, minDistinctChars: 6 });
  assert.deepEqual(envConfig.validateEnvironment(readEnv('bypass-v1'), 'bypass-v1'), []);
  assert.deepEqual(envConfig.validateEnvironment(readEnv('mfa-filled'), 'mfa-filled'), []);
  assert.deepEqual(envConfig.validateEnvironment(readEnv('mfa-placeholder'), 'mfa-placeholder'), []);
});

test('bypass: valid (complete, partial, disabled object); rules injected only when present', () => {
  const withBypass = (b) => mutate((e) => { e.bypass = b; });
  assert.deepEqual(withBypass({ enabled: true }), []);
  assert.deepEqual(withBypass({ enabled: false }), []);
  assert.deepEqual(withBypass({ enabled: true, minLength: 20, maxLength: 100, minWords: 2, minDistinctChars: 4 }), []);
  assert.deepEqual(withBypass({ enabled: true, minWords: 0, minDistinctChars: 0 }), [], '0 disables the checks');
  assert.deepEqual(withBypass({ enabled: true, minLength: 5, maxLength: 500 }), []);

  // protected environment / prod: the injected output is the one from before bypass existed (no key added)
  for (const name of ['lab-frozen', 'base', 'example']) {
    const rules = envConfig.resolveRules(loadFrozen(name), {});
    assert.equal(Object.prototype.hasOwnProperty.call(rules, 'bypass'), false, name);
    assert.deepEqual(
      Object.keys(rules),
      Object.keys(envConfig.DEFAULT_RULES),
      `${name}: same keys as the default rules`
    );
  }
  assert.equal(Object.prototype.hasOwnProperty.call(envConfig.resolveRules(null, {}), 'bypass'), false);
  assert.deepEqual(envConfig.resolveRules(envConfig.loadEnvironment('mfa-filled'), {}).bypass, readEnv('mfa-filled').bypass);

  // defaults filled in, stable key order (the bundle check depends on it)
  const env = Object.assign(clone(readEnv('base')), { bypass: { enabled: true } });
  const resolved = envConfig.resolveRules(env, {});
  assert.deepEqual(resolved.bypass, { enabled: true, minLength: 20, maxLength: 200, minWords: 3, minDistinctChars: 6 });
  assert.deepEqual(Object.keys(resolved.bypass), ['enabled', 'minLength', 'maxLength', 'minWords', 'minDistinctChars']);
  env.bypass = { minDistinctChars: 8, maxLength: 80, minWords: 4, minLength: 30, enabled: false };
  assert.equal(
    JSON.stringify(envConfig.resolveRules(env, {}).bypass),
    '{"enabled":false,"minLength":30,"maxLength":80,"minWords":4,"minDistinctChars":8}'
  );
});

test('bypass: invalid (types, bounds, unknown property, min > max)', () => {
  const withBypass = (b) => mutate((e) => { e.bypass = b; });
  for (const bad of [true, 'oui', 1, [], null]) {
    assert.notDeepEqual(withBypass(bad), [], `bypass ${JSON.stringify(bad)}`);
  }
  assert.match(withBypass({}).join('|'), /enabled/, 'enabled is required');
  assert.match(withBypass({ minLength: 15 }).join('|'), /enabled/);
  for (const enabled of ['true', 1, null]) {
    assert.notDeepEqual(withBypass({ enabled }), [], `enabled ${JSON.stringify(enabled)}`);
  }
  for (const minWords of [-1, 11, 2.5, '3']) {
    assert.notDeepEqual(withBypass({ enabled: true, minWords }), [], 'minWords ' + JSON.stringify(minWords));
  }
  for (const minDistinctChars of [-1, 21, 5.5, '6']) {
    assert.notDeepEqual(withBypass({ enabled: true, minDistinctChars }), [], 'minDistinctChars ' + JSON.stringify(minDistinctChars));
  }
  for (const minLength of [4, 201, 15.5, '15', 0, -1]) {
    assert.notDeepEqual(withBypass({ enabled: true, minLength }), [], `minLength ${JSON.stringify(minLength)}`);
  }
  for (const maxLength of [19, 501, 200.5, '200']) {
    assert.notDeepEqual(withBypass({ enabled: true, maxLength }), [], `maxLength ${JSON.stringify(maxLength)}`);
  }
  assert.match(withBypass({ enabled: true, extra: 1 }).join('|'), /unknown property "extra"/);
  assert.match(withBypass({ enabled: true, minLength: 100, maxLength: 50 }).join('|'), /bypass: minLength \(100\) cannot exceed maxLength \(50\)/);
  assert.deepEqual(withBypass({ enabled: true, minLength: 200 }), [], 'min = default max: accepted');
  assert.match(withBypass({ enabled: true, maxLength: 20, minLength: 21 }).join('|'), /cannot exceed/);
  assert.deepEqual(withBypass({ enabled: true, minLength: 20, maxLength: 20 }), []);
});

test('bypass: BYPASS_ENABLED override (preview) is strict and has no effect when empty', () => {
  const prod = envConfig.loadEnvironment('base');
  assert.equal(envConfig.resolveRules(prod, { BYPASS_ENABLED: '' }).bypass, undefined);
  assert.deepEqual(envConfig.resolveRules(prod, { BYPASS_ENABLED: 'true' }).bypass, { enabled: true, minLength: 20, maxLength: 200, minWords: 3, minDistinctChars: 6 });
  assert.deepEqual(envConfig.resolveRules(null, { BYPASS_ENABLED: ' TRUE ' }).bypass, { enabled: true, minLength: 20, maxLength: 200, minWords: 3, minDistinctChars: 6 });
  assert.equal(envConfig.resolveRules(envConfig.loadEnvironment('mfa-filled'), { BYPASS_ENABLED: 'false' }).bypass.enabled, false);
  assert.equal(envConfig.resolveRules(envConfig.loadEnvironment('mfa-filled'), { BYPASS_ENABLED: 'false' }).bypass.minLength, 20);
  assert.throws(() => envConfig.resolveRules(prod, { BYPASS_ENABLED: 'oui' }), /BYPASS_ENABLED is invalid/);
});

test('bundle: checkLaunchEvent requires bypass when the environment defines it (Terser !0 / !1 accepted)', () => {
  const rules = envConfig.resolveRules(envConfig.loadEnvironment('mfa-filled'), {});
  const fx = readEnv('mfa-filled').bypass.mfa;
  const MFA = `,mfa:{required:!0,tenantId:"${fx.tenantId}",clientId:"${fx.clientId}",authContext:"c1"}`;
  const base = [
    'Office.onReady();',
    'var BUILD={blockedDays:[5],sendHour:8,sendMinute:0,workingDays:[1,2,3,4,5],',
    "slotTimes:['08:00','09:00','10:00','11:00','14:00','16:00'],dayCount:10,defaultLanguage:'fr',",
    '%BYPASS%};',
    'Office.actions.associate("onMessageSendHandler",a);Office.actions.associate("onAppointmentSendHandler",b);'
  ].join('\n');
  const bundle = (b) => base.replace('%BYPASS%', b);
  assert.deepEqual(checkLaunchEvent(bundle('bypass:{enabled:!0,minLength:20,maxLength:200,minWords:3,minDistinctChars:6' + MFA + '}'), rules), []);
  assert.deepEqual(checkLaunchEvent(bundle('bypass:{enabled:true,minLength:20,maxLength:200,minWords:3,minDistinctChars:6' + MFA.replace('required:!0', 'required:true') + '}'), rules), []);
  assert.match(checkLaunchEvent(bundle('bypass:{enabled:!1,minLength:20,maxLength:200,minWords:3,minDistinctChars:6' + MFA + '}'), rules).join('|'), /bypass/);
  assert.match(checkLaunchEvent(bundle('bypass:{enabled:!0,minLength:20,maxLength:200,minWords:2,minDistinctChars:6' + MFA + '}'), rules).join('|'), /bypass/);
  assert.match(checkLaunchEvent(bundle("x:1"), rules).join('|'), /rule bypass/);
  assert.match(checkLaunchEvent(bundle('bypass:{enabled:!0,minLength:20,maxLength:200,minWords:3,minDistinctChars:6}'), rules).join('|'), /bypass/, 'mfa missing');
  assert.match(checkLaunchEvent(bundle('bypass:{enabled:!0,minLength:20,maxLength:200,minWords:3,minDistinctChars:6' + MFA.replace('c1', 'c2') + '}'), rules).join('|'), /bypass/, 'different context');
  // MSAL has no place in the event runtime
  assert.match(checkLaunchEvent(bundle('bypass:{enabled:!0,minLength:20,maxLength:200,minWords:3,minDistinctChars:6' + MFA + '}') + '\nvar x=require("@azure/msal-browser");', rules).join('|'), /MSAL/);
  assert.match(checkLaunchEvent(bundle('bypass:{enabled:!0,minLength:20,maxLength:200,minWords:3,minDistinctChars:6' + MFA + '}') + '\nvar PublicClientApplication={};/*msal*/', rules).join('|'), /MSAL/);
  // without bypass in the environment, nothing is required
  const lab = envConfig.resolveRules(loadFrozen('lab-frozen'), {});
  const labBundle = base.replace('blockedDays:[5]', 'blockedDays:[3,4]').replace(',\n%BYPASS%', '');
  assert.deepEqual(checkLaunchEvent(labBundle, lab), []);
});

test('loadEnvironment: invalid name, not found, errors listed', () => {
  assert.throws(() => envConfig.loadEnvironment('../etc/passwd'), /Invalid environment name/);
  assert.throws(() => envConfig.loadEnvironment('Prod'), /Invalid environment name/);
  assert.throws(() => envConfig.loadEnvironment('inexistant'), /not found.*Available: base, bypass-v1, lab-frozen, mfa-filled, mfa-placeholder/);
});

// ------------------------------------------------------------------ injected rules

test('resolveRules: defaults, environment file, BLOCKED_DAYS / WORKING_DAYS overrides', () => {
  assert.deepEqual(envConfig.resolveRules(null, {}), envConfig.DEFAULT_RULES);
  const lab = envConfig.resolveRules(loadFrozen('lab-frozen'), {});
  assert.deepEqual(lab.blockedDays, [3, 4]);
  assert.equal(lab.defaultLanguage, 'fr');
  const ex = envConfig.resolveRules(loadFrozen('example'), {});
  assert.deepEqual([ex.blockedDays, ex.sendHour, ex.sendMinute, ex.slotTimes, ex.dayCount], [[1, 2], 9, 30, ['09:30', '11:00', '14:00', '16:30'], 8]);
  // overrides (compatibility)
  assert.deepEqual(envConfig.resolveRules(null, { BLOCKED_DAYS: '3,4' }).blockedDays, [3, 4]);
  assert.deepEqual(envConfig.resolveRules(envConfig.loadEnvironment('base'), { BLOCKED_DAYS: '1', WORKING_DAYS: '1,2,3' }).workingDays, [1, 2, 3]);
  assert.deepEqual(envConfig.resolveRules(null, { BLOCKED_DAYS: '  ' }).blockedDays, [5], 'empty: ignored');
  assert.throws(() => envConfig.resolveRules(null, { BLOCKED_DAYS: '9' }), /BLOCKED_DAYS is invalid/);
  assert.throws(() => envConfig.resolveRules(null, { WORKING_DAYS: 'x' }), /WORKING_DAYS is invalid/);
  assert.throws(() => envConfig.resolveRules(null, { WORKING_DAYS: '5' }), /every working day/);
  // the default object is never modified by a resolution
  const r = envConfig.resolveRules(null, {});
  r.blockedDays.push(9);
  assert.deepEqual(envConfig.DEFAULT_RULES.blockedDays, [5]);
});

test('getBuildContext: output folder per environment, explicit errors', () => {
  const legacy = envConfig.getBuildContext({});
  assert.equal(legacy.envName, null);
  assert.equal(legacy.outDir, path.join(root, 'dist'));
  assert.equal(legacy.manifestFile, path.join(root, 'dist', 'manifest.prod.xml'));
  const prod = envConfig.getBuildContext({ NFM_ENV: 'base' });
  assert.equal(prod.outDir, path.join(root, 'dist', 'base'));
  assert.equal(prod.manifestFile, path.join(root, 'dist', 'base', 'manifest.prod.xml'));
  assert.deepEqual(prod.rules.blockedDays, [5]);
  assert.throws(() => envConfig.getBuildContext({ NFM_ENV: 'nimporte' }), /not found/);
  assert.throws(() => envConfig.getBuildContext({ NFM_ENV: '../x' }), /Invalid environment name/);
});

test('bundle: checkLaunchEvent requires the injected rules (blockedDays, times, language...)', () => {
  const rules = envConfig.resolveRules(loadFrozen('lab-frozen'), {});
  const good = [
    'Office.onReady();',
    'var BUILD={blockedDays:[3,4],sendHour:8,sendMinute:0,workingDays:[1,2,3,4,5],',
    "slotTimes:['08:00','09:00','10:00','11:00','14:00','16:00'],dayCount:10,defaultLanguage:'fr'};",
    'Office.actions.associate("onMessageSendHandler",a);Office.actions.associate("onAppointmentSendHandler",b);'
  ].join('\n');
  // onReady must precede associate; here "Office.actions.associate" comes after.
  assert.deepEqual(checkLaunchEvent(good, rules), []);
  const wrongDays = good.replace('blockedDays:[3,4]', 'blockedDays:[5]');
  assert.match(checkLaunchEvent(wrongDays, rules).join('|'), /blockedDays:\[3,4\] is missing/);
  assert.match(checkLaunchEvent(good.replace('sendHour:8', 'sendHour:9'), rules).join('|'), /sendHour:8 is missing/);
  assert.match(checkLaunchEvent(good.replace("defaultLanguage:'fr'", "defaultLanguage:'en'"), rules).join('|'), /defaultLanguage/);
  assert.match(checkLaunchEvent(good + '\nvar é=1', rules).join('|'), /non-ASCII/);
  assert.match(checkLaunchEvent(good + '\nwindow.x=1', rules).join('|'), /DOM/);
});

// ------------------------------------------------------------------ generated manifest

test('manifest: Id, name (+ en-US/en-GB), version, provider, support, URL, no localhost', () => {
  const prod = envConfig.loadEnvironment('base');
  const out = renderManifest(manifestSource, 'https://example-prod.azurestaticapps.net', prod);
  assert.match(out, new RegExp(`<Id>${prod.addinId}</Id>`));
  assert.match(out, /<Version>1\.1\.0\.0<\/Version>/);
  assert.match(out, /<ProviderName>Nicolas Fabert<\/ProviderName>/);
  assert.match(out, /<DisplayName DefaultValue="NoFridayMail">\s*<Override Locale="en-US" Value="NoFridayMail" \/>\s*<Override Locale="en-GB" Value="NoFridayMail" \/>/);
  assert.match(out, /<SupportUrl DefaultValue="https:\/\/github\.com\/Nico77600\/NoFridayMail" \/>/);
  assert.match(out, /id="GroupLabel" DefaultValue="NoFridayMail"/);
  assert.equal(out.includes('localhost'), false);
  assert.equal(out.includes('2178c516'), false, 'the development manifest Id does not appear in the prod manifest');
  assert.equal((out.match(/https:\/\/example-prod\.azurestaticapps\.net/g) || []).length > 5, true);
  assert.match(out, /Control xsi:type="Button" id="msgComposeSchedulePaneButton"/);
});

test('manifest: custom name (example) propagated everywhere', () => {
  const ex = loadFrozen('example');
  const out = renderManifest(manifestSource, 'https://x.azurestaticapps.net', ex);
  assert.match(out, /DefaultValue="NoFridayMail \(Staging\)">\s*<Override Locale="en-US" Value="NoFridayMail \(Staging\)"/);
  assert.match(out, /id="GroupLabel" DefaultValue="NoFridayMail \(Staging\)"/);
  assert.match(out, /<ProviderName>My Organization<\/ProviderName>/);
  assert.match(out, /<Id>11111111-2222-4333-8444-555555555555<\/Id>/);
});

test('manifest: lab-frozen reproduces the development manifest (Id, name, version, provider) except the blocked-day texts', () => {
  const lab = loadFrozen('lab-frozen');
  const origin = 'https://lab-frozen.example.azurestaticapps.net';
  // The Description and the tooltip name the blocked days of the environment (Wednesday and Thursday here).
  const withoutDayTexts = (xml) => xml.replace(/<Description DefaultValue="[^"]*">[\s\S]*?<\/Description>/, '').replace(/<bt:String id="TaskpaneButton\.Tooltip"[\s\S]*?<\/bt:String>/, '');
  assert.equal(withoutDayTexts(renderManifest(manifestSource, origin, lab)), withoutDayTexts(renderManifest(manifestSource, origin, null)));
  assert.match(renderManifest(manifestSource, origin, lab), /le mercredi et le jeudi et propose/);
});

test('manifest: safeguards (modified template, invalid origin)', () => {
  const prod = envConfig.loadEnvironment('base');
  assert.throws(() => renderManifest(manifestSource.replace('<ProviderName>Nicolas Fabert</ProviderName>', ''), 'https://a.example', prod), /ProviderName/);
  assert.throws(() => renderManifest('<OfficeApp/>', 'https://a.example', null), /does not contain/);
  assert.equal(normalizeOrigin('https://a.azurestaticapps.net/'), 'https://a.azurestaticapps.net');
  assert.throws(() => normalizeOrigin('http://a.example'), /HTTPS/);
  assert.throws(() => normalizeOrigin('https://a.example/chemin'), /without a path/);
  assert.throws(() => normalizeOrigin('not a url'), /is invalid/);
});

// ------------------------------------------------------------------ MFA step (bypass.mfa)

const GUID_A = '11111111-2222-4333-8444-555555555555';
const GUID_B = '99999999-2222-4333-8444-555555555555';
const withMfa = (mfa, extra) => mutate((e) => { e.bypass = Object.assign({ enabled: true, mfa }, extra || {}); });

test('mfa: valid (complete, required false without identifiers), classified for deployment', () => {
  assert.deepEqual(withMfa({ required: true, tenantId: GUID_A, clientId: GUID_B, authContext: 'c1' }), []);
  assert.deepEqual(withMfa({ required: true, tenantId: GUID_A, clientId: GUID_B, authContext: 'c99' }), []);
  assert.deepEqual(withMfa({ required: false }), []);
  assert.deepEqual(withMfa({ required: true, tenantId: envConfig.PLACEHOLDER_GUID, clientId: envConfig.PLACEHOLDER_GUID, authContext: 'c1' }), [], 'placeholder values stay valid (build, tests)');
});

test('mfa: invalid (fields required when required, GUID, authContext, unknown, enabled)', () => {
  assert.match(withMfa({ required: true }).join('|'), /tenantId/);
  assert.match(withMfa({ required: true, tenantId: GUID_A, clientId: GUID_B }).join('|'), /authContext/);
  assert.match(withMfa({}).join('|'), /required/);
  for (const bad of ['pas-un-guid', '', GUID_A.slice(1), 42]) {
    assert.notDeepEqual(withMfa({ required: true, tenantId: bad, clientId: GUID_B, authContext: 'c1' }), [], 'tenantId ' + bad);
    assert.notDeepEqual(withMfa({ required: true, tenantId: GUID_A, clientId: bad, authContext: 'c1' }), [], 'clientId ' + bad);
  }
  for (const bad of ['c0', 'c100', 'C1', 'c', '1', 'c01', 'c-1', 'x1', '']) {
    assert.notDeepEqual(withMfa({ required: true, tenantId: GUID_A, clientId: GUID_B, authContext: bad }), [], 'authContext ' + bad);
  }
  assert.match(withMfa({ required: true, tenantId: GUID_A, clientId: GUID_B, authContext: 'c1', extra: 1 }).join('|'), /unknown property "extra"/);
  assert.notDeepEqual(withMfa({ required: 'oui' }), []);
  const disabled = mutate((e) => { e.bypass = { enabled: false, mfa: { required: true, tenantId: GUID_A, clientId: GUID_B, authContext: 'c1' } }; });
  assert.match(disabled.join('|'), /bypass\.mfa\.required requires bypass\.enabled/);
});

test('mfa: injected rules (stable key order), apiEnabled, protected environment / prod unchanged', () => {
  const env = Object.assign(clone(readEnv('base')), { bypass: { enabled: true, mfa: { authContext: 'c2', clientId: GUID_B, required: true, tenantId: GUID_A } } });
  const rules = envConfig.resolveRules(env, {});
  assert.equal(
    JSON.stringify(rules.bypass.mfa),
    JSON.stringify({ required: true, tenantId: GUID_A, clientId: GUID_B, authContext: 'c2' })
  );
  assert.equal(envConfig.apiEnabled(rules), true);
  assert.equal(envConfig.apiEnabled(envConfig.resolveRules(envConfig.loadEnvironment('base'), {})), false);
  assert.equal(envConfig.apiEnabled(envConfig.resolveRules(loadFrozen('lab-frozen'), {})), false);
  assert.equal(envConfig.apiEnabled(envConfig.resolveRules(null, {})), false);
  env.bypass.mfa.required = false;
  assert.equal(envConfig.apiEnabled(envConfig.resolveRules(env, {})), false);
  env.bypass = { enabled: false, mfa: { required: true, tenantId: GUID_A, clientId: GUID_B, authContext: 'c1' } };
  assert.equal(envConfig.apiEnabled(envConfig.resolveRules(env, {})), false, 'bypass disabled: no API');
  // BYPASS_ENABLED=false also turns the API off
  assert.equal(envConfig.apiEnabled(envConfig.resolveRules(envConfig.loadEnvironment('mfa-filled'), { BYPASS_ENABLED: 'false' })), false);
  assert.equal(envConfig.apiEnabled(envConfig.resolveRules(envConfig.loadEnvironment('mfa-filled'), {})), true);
});

test('mfa: deployErrors refuses placeholder identifiers with an explanation', () => {
  const placeholder = envConfig.loadEnvironment('mfa-placeholder');
  const errors = envConfig.deployErrors(placeholder);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /00000000-0000-0000-0000-000000000000/);
  assert.match(errors[0], /tenant ID/);
  assert.match(errors[0], /mfa-placeholder\.json/);
  assert.match(errors[0], /docs\/NoFridayMail-Guide\.md/);
  const filled = clone(placeholder);
  filled.bypass.mfa.tenantId = GUID_A;
  assert.equal(envConfig.deployErrors(filled).length, 1, 'a single placeholder identifier is enough to refuse (client)');
  assert.deepEqual(envConfig.deployErrors(envConfig.loadEnvironment('mfa-filled')), [], 'identifiers filled in: deployable');
});

test('mfa: deployErrors, edge cases (single placeholder, mfa not required, environments without MFA)', () => {
  const placeholder = envConfig.loadEnvironment('mfa-placeholder');
  const half = clone(placeholder);
  half.bypass.mfa.tenantId = GUID_A;
  assert.match(envConfig.deployErrors(half)[0], /bypass\.mfa\.clientId/);
  assert.doesNotMatch(envConfig.deployErrors(half)[0], /tenantId/);
  half.bypass.mfa.clientId = GUID_B;
  assert.deepEqual(envConfig.deployErrors(half), []);
  const notRequired = clone(placeholder);
  notRequired.bypass.mfa.required = false;
  assert.deepEqual(envConfig.deployErrors(notRequired), []);
  for (const name of ['base', 'bypass-v1', 'mfa-filled']) assert.deepEqual(envConfig.deployErrors(envConfig.loadEnvironment(name)), [], name);
  assert.deepEqual(envConfig.deployErrors(loadFrozen('lab-frozen')), [], 'lab-frozen');
});

test('mfa: CLI --deploy refuses placeholder values and accepts the rest; without --deploy they stay valid', () => {
  const { spawnSync } = require('node:child_process');
  const run = (dir, ...args) =>
    spawnSync(process.execPath, [path.join(root, 'tools', 'env-config.js'), ...args], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { NFM_ENVIRONMENTS_DIR: dir })
    });
  const refused = run(FIXTURES, 'mfa-placeholder', '--deploy');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /not deployable/);
  assert.match(refused.stderr, /placeholder value/);
  assert.equal(run(FIXTURES, 'mfa-placeholder').status, 0);
  assert.equal(run(FIXTURES, 'mfa-filled', '--deploy').status, 0);
  assert.equal(run(FIXTURES, 'base', '--deploy').status, 0);
  assert.equal(run(FIXTURES, 'bypass-v1', '--deploy').status, 0);
  assert.equal(run(FIXTURES, 'lab-frozen', '--deploy').status, 0);
  assert.equal(run(REAL, 'prod', '--deploy').status, 0);
  // NFM_ENVIRONMENTS_DIR: an environment absent from the alternate folder is not found
  const missing = run(FIXTURES, 'lab');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not found.*Available: base, bypass-v1, lab-frozen, mfa-filled, mfa-placeholder/);
});

test('azure.appInsights: optional name validated', () => {
  const withAi = (name) => mutate((e) => { e.azure.appInsights = name; });
  assert.deepEqual(withAi('appi-nofridaymail-prod'), []);
  for (const bad of ['', '-x', 'a'.repeat(300), 'a b', 42]) {
    assert.notDeepEqual(withAi(bad), [], String(bad));
  }
});

test('staticwebapp.config.json: copied as is without MFA, anonymous no-cache /api/* route with MFA', () => {
  const { staticWebAppConfig, withApi } = require('../tools/swa-config');
  const source = fs.readFileSync(path.join(root, 'staticwebapp.config.json'));
  assert.equal(staticWebAppConfig(source, false), source, 'same content, byte for byte');
  const out = JSON.parse(staticWebAppConfig(source, true));
  const base = JSON.parse(source);
  assert.deepEqual(out.globalHeaders, base.globalHeaders, 'existing headers kept');
  assert.deepEqual(out.mimeTypes, base.mimeTypes);
  assert.deepEqual(out.routes, [{ route: '/api/*', allowedRoles: ['anonymous'], headers: { 'Cache-Control': 'no-store' } }]);
  assert.deepEqual(out.platform, { apiRuntime: 'node:22' });
  assert.deepEqual(JSON.parse(JSON.stringify(withApi(out))).routes.length, 1, 'idempotent: a single route');
  assert.equal(fs.readFileSync(path.join(root, 'staticwebapp.config.json'), 'utf8').includes('/api'), false, 'the repository file does not change');
});
