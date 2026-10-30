'use strict';

// Deployment script: static analysis + real run in simulation mode (-WhatIf) when PowerShell 7 is present.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const script = path.join(root, 'tools', 'Deploy-NoFridayMail.ps1');
const text = fs.readFileSync(script, 'utf8');

const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
const hasPwsh = pwsh.status === 0 && Number(pwsh.stdout.trim()) >= 7;

// Fixture environments (tests/fixtures/environments): the tests never read the operator files
// (deploy/environments.local). Only example.json (template) is read from deploy/environments.
const FIXTURES = path.join(root, 'tests', 'fixtures', 'environments');
const withFixtures = () => Object.assign(envWithoutAz(), { NFM_ENVIRONMENTS_DIR: FIXTURES });

/**
 * Child process environment WITHOUT Azure CLI on the PATH: simulations stay offline (no Azure call, even read-only)
 * and the script falls back to its assumed values.
 */
function envWithoutAz() {
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const kept = String(process.env[key] || '')
    .split(path.delimiter)
    .filter((dir) => !['az', 'az.cmd', 'az.exe', 'az.ps1', 'az.bat'].some((f) => fs.existsSync(path.join(dir, f))));
  return Object.assign({}, process.env, { [key]: kept.join(path.delimiter) });
}

function snapshot() {
  const out = [];
  const walk = (dir, only) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p, only);
      else if (!only || only.test(entry.name)) out.push(`${p}|${fs.statSync(p).mtimeMs}|${fs.statSync(p).size}`);
    }
  };
  // dist/base and the base artifact only: the other environments are written in parallel by tests/build.test.js.
  ['dist/base', 'deploy', 'src', 'tools'].forEach((d) => walk(path.join(root, d)));
  walk(path.join(root, 'out'), /NoFridayMail-base-/);
  ['package.json', 'package-lock.json', 'manifest.xml'].forEach((f) => {
    const p = path.join(root, f);
    out.push(`${p}|${fs.statSync(p).mtimeMs}`);
  });
  return out.sort().join('\n');
}

test('script: help, WhatIf, protected-environment guard, token never written, SWA CLI pinned', () => {
  assert.match(text, /^#Requires -Version 7\.4/);
  assert.match(text, /\.SYNOPSIS\s+NoFridayMail - /);
  assert.ok((text.match(/^\.EXAMPLE/gm) || []).length >= 5, 'at least 5 examples');
  for (const stage of ['1. CHECK', '2. INFRA', '3. BUILD', '4. API PACKAGE', '5. DEPLOY', '6. VERIFY', 'PUBLISH (manual)']) assert.ok(text.includes(stage), stage);
  assert.doesNotMatch(text, /[^\x00-\x7f]/, 'script is ASCII only (signed later)');
  assert.match(text, /\.SYNOPSIS/);
  assert.match(text, /SupportsShouldProcess/);
  for (const p of ['-Environment', '-SkipInfra', '-SkipTests', '-ConfirmLab']) {
    assert.ok(text.includes(p.slice(1)), p);
  }
  assert.match(text, /\$SwaCliVersion = '\d+\.\d+\.\d+'/, 'SWA CLI version pinned');
  assert.doesNotMatch(text, /static-web-apps-cli@latest/);
  // The token goes through the child process environment: never on disk nor in the log.
  assert.match(text, /SWA_CLI_DEPLOYMENT_TOKEN/);
  assert.doesNotMatch(text, /Out-File|Set-Content|Add-Content|Export-Clixml|Tee-Object|Start-Transcript/);
  assert.doesNotMatch(text, /Write-(Host|Info|Verbose|Output|Debug)[^\n]*\$token/i);
  assert.doesNotMatch(text, /--deployment-token/, 'no token as a command-line argument');
  assert.match(text, /-eq 'lab'/);
  assert.match(text, /-not \$ConfirmLab/);
  assert.match(text, /secrets', 'list'/);
});

test('script: no automated Exchange publication and no Azure write outside ShouldProcess', () => {
  // Every az command that writes is inside a ShouldProcess block.
  for (const verb of ["'group', 'create'", "'staticwebapp', 'create'"]) {
    const at = text.indexOf(verb);
    assert.ok(at > 0, verb);
    const before = text.slice(Math.max(0, at - 400), at);
    assert.match(before, /ShouldProcess/, `${verb} guarded by ShouldProcess`);
  }
  assert.doesNotMatch(text, /New-App|Set-App|Enable-OrganizationApp/);
});

test('script (pwsh): a protected environment (lab-frozen) is refused without -ConfirmLab, even in simulation', { skip: !hasPwsh && 'PowerShell 7 missing' }, () => {
  const r = spawnSync('pwsh', ['-NoProfile', '-File', script, '-Environment', 'lab-frozen', '-WhatIf'], { encoding: 'utf8', env: withFixtures() });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /protected|ConfirmLab/);
  assert.match(r.stdout + r.stderr, /-ConfirmLab/);
});

test('script (pwsh): "example" (template), unknown or invalid environment refused', { skip: !hasPwsh && 'PowerShell 7 missing' }, () => {
  const ex = spawnSync('pwsh', ['-NoProfile', '-File', script, '-Environment', 'example', '-WhatIf'], { encoding: 'utf8' });
  assert.notEqual(ex.status, 0);
  assert.match(ex.stdout + ex.stderr, /is a template/);
  const unknown = spawnSync('pwsh', ['-NoProfile', '-File', script, '-Environment', 'nimporte', '-WhatIf'], { encoding: 'utf8' });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stdout + unknown.stderr, /not found/);
  const invalid = spawnSync('pwsh', ['-NoProfile', '-File', script, '-Environment', 'Pas Valide', '-WhatIf'], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
});

test('script (pwsh): fixture base -WhatIf -SkipInfra writes NOTHING and describes the steps', { skip: !hasPwsh && 'PowerShell 7 missing', timeout: 120000 }, () => {
  const before = snapshot();
  const r = spawnSync('pwsh', ['-NoProfile', '-File', script, '-Environment', 'base', '-WhatIf', '-SkipInfra'], { encoding: 'utf8', env: withFixtures() });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = r.stdout;
  assert.match(out, /simulation/i);
  assert.match(out, /ADDIN_BASE_URL = https:\/\//);
  assert.match(out, /npm ci/);
  assert.match(out, /npm run build:prod/);
  assert.match(out, /SWA CLI \d+\.\d+\.\d+/);
  assert.match(out, /Integrated apps/);
  for (const step of ['1/6', '2/6', '3/6', '4/6', '5/6', '6/6']) assert.ok(out.includes(step), step);
  assert.match(out, /Not needed: this environment has no API/);
  assert.doesNotMatch(out, /apiKey|SWA_CLI_DEPLOYMENT_TOKEN\s*=/);
  assert.equal(snapshot(), before, 'no file created or modified');
});

test('script: API (SWA CLI), NFM_RECEIPT_KEY, Application Insights and 401 check - secrets never displayed', () => {
  // API deployment: only with the MFA step, flags checked against SWA CLI 2.1.0 (deploy --help).
  assert.match(text, /\$apiEnabled/);
  assert.match(text, /\$apiLocation = "\.\/out\/api-pkg\/\$Environment"/, 'self-contained package, never api/ directly');
  assert.match(text, /\$deployArguments \+= @\('--api-location', \$apiLocation, '--api-language', 'node', '--api-version', '22'\)/);
  assert.match(text, /'--swa-config-location', "\.\/dist\/\$Environment"/, 'site configuration generated for the environment');
  assert.doesNotMatch(text, /'--api-location', '\.\/api'/);
  // The SWA CLI runs no Oryx build: dependencies are installed in the package, inside ShouldProcess, never in api/.
  const packAt = text.indexOf("'tools/package-api.js', $Environment)");
  assert.ok(packAt > 0);
  assert.match(text.slice(Math.max(0, packAt - 500), packAt), /ShouldProcess/);
  assert.match(text, /Push-Location \$apiPackageDir[\s\S]{0,200}'ci', '--omit=dev'/);
  assert.match(text, /'tools\/package-api\.js', \$Environment, '--verify'/);
  assert.match(text, /node_modules is missing/);
  // Receipt secret: created only when missing, 32 random bytes, through ShouldProcess, value never displayed.
  assert.match(text, /NFM_RECEIPT_KEY/);
  assert.match(text, /RandomNumberGenerator\]::GetBytes\(32\)/);
  assert.match(text, /keys\(properties\)/, 'reads the setting NAMES, never their values');
  assert.doesNotMatch(text, /appsettings', 'list'[^\n]*properties\.NFM_RECEIPT_KEY/);
  assert.match(text, /-contains 'NFM_RECEIPT_KEY'/);
  const setAt = text.indexOf("'staticwebapp', 'appsettings', 'set'");
  assert.ok(setAt > 0);
  assert.match(text.slice(Math.max(0, setAt - 900), setAt), /ShouldProcess/, 'write guarded by ShouldProcess (-WhatIf)');
  assert.match(text, /Invoke-NativeSecret/);
  assert.match(text, /'--output', 'none'/);
  assert.doesNotMatch(text, /Write-(Host|Info|Verbose|Output|Debug|Warning)[^\n]*\$(receiptKey|connection)\b/i);
  assert.doesNotMatch(text, /\$receiptKey[^\n]*\|\s*(Out-File|Set-Content|Tee-Object)/);
  assert.match(text, /\$receiptKey = \$null/);
  assert.match(text, /\$connection = \$null/);
  const secretFn = text.slice(text.indexOf('function Invoke-NativeSecret'), text.indexOf('function ConvertTo-FlatText'));
  assert.doesNotMatch(secretFn, /\$Arguments -join/, 'the error message does not repeat the arguments (secret)');
  assert.match(secretFn, /2>\$null \| Out-Null/);
  // Application Insights: optional, created / linked, connection string never displayed.
  assert.match(text, /appInsights/);
  assert.match(text, /'monitor', 'app-insights', 'component', 'create'/);
  assert.match(text, /APPLICATIONINSIGHTS_CONNECTION_STRING/);
  // Post-deployment check: POST /api/bypass without a token -> 401.
  assert.match(text, /\/api\/bypass/);
  assert.match(text, /-SkipHttpErrorCheck/);
  assert.match(text, /\$apiStatus -ne 401/);
  // Placeholder identifiers refused (warning only in simulation).
  assert.match(text, /env-config\.js', \$Environment, '--deploy'|env-config\.js \$Environment --deploy/);
  assert.match(text, /Write-DryWarning \(\(\$deployCheck/);
  assert.doesNotMatch(text, /--deployment-token/);
  assert.doesNotMatch(text, /Out-File|Set-Content|Add-Content|Export-Clixml|Tee-Object|Start-Transcript/);
});

test('script (pwsh): mfa-filled -WhatIf (offline) announces the API and the receipt secret, without warning', { skip: !hasPwsh && 'PowerShell 7 missing', timeout: 120000 }, () => {
  const r = spawnSync('pwsh', ['-NoProfile', '-File', script, '-Environment', 'mfa-filled', '-WhatIf', '-SkipInfra'], { encoding: 'utf8', env: withFixtures() });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const all = r.stdout + r.stderr;
  assert.match(all, /simulation/i);
  assert.doesNotMatch(all, /placeholder value|not deployable/, 'identifiers filled in: no placeholder warning');
  assert.match(all, /MFA step: the API \(api\/\) will be deployed/);
  assert.ok(all.includes('API package (./out/api-pkg/mfa-filled)'));
  // Exact SWA CLI command line: self-contained API package AND configuration generated for the environment.
  const command = all.split(/\r?\n/).find((l) => l.includes('Command: npx'));
  assert.equal(command.slice(command.indexOf('Command: npx')).trim(), 'Command: npx --yes @azure/static-web-apps-cli@2.1.0 deploy ./dist/mfa-filled --env production --swa-config-location ./dist/mfa-filled --api-location ./out/api-pkg/mfa-filled --api-language node --api-version 22');
  assert.match(all, /NFM_RECEIPT_KEY/);
  assert.match(all, /npm run build:prod/);
  assert.match(all, /SWA CLI \d+\.\d+\.\d+/);
  assert.doesNotMatch(all, /apiKey|SWA_CLI_DEPLOYMENT_TOKEN\s*=/);
  // a random 32-byte secret in base64 (44 characters) appears nowhere
  assert.doesNotMatch(all, /[A-Za-z0-9+\/]{43}=/);
});

test('script (pwsh): mfa-placeholder -WhatIf warns about placeholder values without interrupting the simulation', { skip: !hasPwsh && 'PowerShell 7 missing', timeout: 120000 }, () => {
  const r = spawnSync('pwsh', ['-NoProfile', '-File', script, '-Environment', 'mfa-placeholder', '-WhatIf', '-SkipInfra'], { encoding: 'utf8', env: withFixtures() });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const all = r.stdout + r.stderr;
  assert.match(all, /placeholder value \(00000000-0000-0000-0000-000000000000\)/, 'warning in simulation');
  assert.match(all, /MFA step: the API \(api\/\) will be deployed/);
});

test('script (pwsh): real mfa-placeholder run (without -WhatIf) refused BEFORE any action while mfa has placeholder values', { skip: !hasPwsh && 'PowerShell 7 missing', timeout: 120000 }, () => {
  const r = spawnSync('pwsh', ['-NoProfile', '-File', script, '-Environment', 'mfa-placeholder', '-SkipInfra', '-SkipTests'], { encoding: 'utf8', env: withFixtures() });
  assert.notEqual(r.status, 0);
  // The PowerShell error message is wrapped to the terminal width ("|" at the start of a line).
  const all = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '').replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+\|\s+/g, ' ').replace(/\s+/g, ' ');
  assert.match(all, /ERROR:/);
  assert.match(all, /not deployable/);
  assert.match(all, /placeholder value/);
  assert.match(all, /tenant ID/);
  assert.match(all, /NoFridayMail-Guide\.md/);
  assert.doesNotMatch(all, /2\/6|3\/6|5\/6/, 'no step after the refusal');
});

test('script (pwsh): NFM_ENVIRONMENTS_DIR - an environment absent from the folder is not found, the list comes from the folder', { skip: !hasPwsh && 'PowerShell 7 missing', timeout: 120000 }, () => {
  const r = spawnSync('pwsh', ['-NoProfile', '-File', script, '-Environment', 'staging', '-WhatIf'], { encoding: 'utf8', env: withFixtures() });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /not found/);
  assert.match(r.stdout + r.stderr, /base, bypass-v1, lab-frozen, mfa-filled, mfa-placeholder/);
});

test('script (pwsh): fixture base (no MFA) -WhatIf announces neither an API nor a receipt secret', { skip: !hasPwsh && 'PowerShell 7 missing', timeout: 120000 }, () => {
  const r = spawnSync('pwsh', ['-NoProfile', '-File', script, '-Environment', 'base', '-WhatIf', '-SkipInfra'], { encoding: 'utf8', env: withFixtures() });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /MFA|NFM_RECEIPT_KEY|placeholder value/);
  const command = r.stdout.split(/\r?\n/).find((l) => l.includes('Command: npx'));
  assert.equal(command.slice(command.indexOf('Command: npx')).trim(), 'Command: npx --yes @azure/static-web-apps-cli@2.1.0 deploy ./dist/base --env production --swa-config-location ./dist/base');
  assert.doesNotMatch(r.stdout, /--api-location|API package \(/);
});

test('script (pwsh): redirected output = pure ASCII, no color; NFM_FORCE_COLOR and NO_COLOR', { skip: !hasPwsh && 'PowerShell 7 missing', timeout: 120000 }, () => {
  // The child environment is explicit: ambient NO_COLOR, NFM_FORCE_COLOR, NFM_ICONS and TERM never leak into a case.
  const clean = () => {
    const env = withFixtures();
    for (const key of Object.keys(env)) {
      if (['NO_COLOR', 'NFM_FORCE_COLOR', 'NFM_ICONS', 'TERM'].includes(key.toUpperCase())) delete env[key];
    }
    return env;
  };
  const run = (extra) => spawnSync('pwsh', ['-NoProfile', '-File', script, '-Environment', 'base', '-WhatIf', '-SkipInfra'], { encoding: 'utf8', env: Object.assign(clean(), extra) });
  // The "What if" lines are written by PowerShell in the system language: they are filtered out.
  const own = (out) => out.split(/\r?\n/).filter((l) => !/^what if/i.test(l)).join('\n');
  const plain = run({});
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.doesNotMatch(own(plain.stdout), /[^\x00-\x7f]/, 'pure ASCII when the output is redirected');
  assert.doesNotMatch(plain.stdout, /\x1b\[/, 'no color when the output is redirected');
  assert.match(plain.stdout, /\+-{20,}\+/, 'ASCII frame');
  assert.match(plain.stdout, /v\d+\.\d+\.\d+ - Nicolas Fabert/);
  const colored = run({ NFM_FORCE_COLOR: '1' });
  assert.match(colored.stdout, /\x1b\[/);
  assert.match(run({ NFM_FORCE_COLOR: '1', NO_COLOR: '1' }).stdout, /\x1b\[/, 'NFM_FORCE_COLOR wins over NO_COLOR');
  assert.doesNotMatch(own(colored.stdout.replace(/\x1b\[[0-9;]*m/g, '')), /[^\x00-\x7f]/, 'colors forced, frame still ASCII');
  assert.doesNotMatch(run({ NO_COLOR: '1' }).stdout, /\x1b\[/);
});

test('script (pwsh): without a tests/ folder (downloaded package), npm test is skipped with an explanation', { skip: !hasPwsh && 'PowerShell 7 missing', timeout: 180000 }, () => {
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfm-notests-'));
  try {
    for (const name of ['tools', 'src', 'deploy']) fs.cpSync(path.join(root, name), path.join(tmp, name), { recursive: true });
    fs.rmSync(path.join(tmp, 'deploy', 'environments.local'), { recursive: true, force: true });
    fs.copyFileSync(path.join(root, 'package.json'), path.join(tmp, 'package.json'));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');
    const env = envWithoutAz();
    delete env.NFM_ENVIRONMENTS_DIR;
    const r = spawnSync('pwsh', ['-NoProfile', '-File', path.join(tmp, 'tools', 'Deploy-NoFridayMail.ps1'), '-Environment', 'prod', '-WhatIf', '-SkipInfra'], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Tests not run: the tests\/ folder is not part of the downloaded package/);
    assert.match(r.stdout, /npm run build:prod would build/, 'the build and the validation are announced');
    assert.doesNotMatch(r.stdout, /npm test would run/);
    assert.match(r.stdout, /Simulation finished/);
  } finally {
    try { fs.unlinkSync(path.join(tmp, 'node_modules')); } catch (e) { /* junction already gone */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
