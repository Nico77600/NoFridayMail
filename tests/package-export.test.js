'use strict';

// What the public can download ("Download ZIP", `git archive`, release ZIP): the package folder, i.e. the strict
// minimum to deploy and use the add-in. The repository is copied into a snapshot (tracked and non-ignored files,
// working-tree content) outside the real repository, then `git archive` runs there: the test does not depend on the
// current commits. No network access (npm ci is not run: package/node_modules is linked from the repository).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');

const root = path.join(__dirname, '..');
const git = (cwd, args, extra) => spawnSync('git', args, Object.assign({ cwd, encoding: 'utf8' }, extra));
const hasGit = git(root, ['--version']).status === 0 && git(root, ['rev-parse', '--git-dir']).status === 0;
const pwshVersion = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
const [major, minor] = pwshVersion.status === 0 ? pwshVersion.stdout.trim().split('.').map(Number) : [0, 0];
const hasPwsh = major > 7 || (major === 7 && minor >= 4);

let sandbox;
let snapshot;
let extracted;

function makeSnapshot(dir) {
  const listed = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  assert.equal(listed.status, 0, listed.stderr);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of listed.stdout.split('\0').filter(Boolean)) {
    const from = path.join(root, file);
    if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
    const to = path.join(dir, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Nicolas Fabert'],
    ['config', 'user.email', '195452170+Nico77600@users.noreply.github.com'], ['config', 'core.autocrlf', 'false'],
    ['add', '-A'], ['commit', '-q', '-m', 'snapshot']]) {
    const r = git(dir, args);
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  }
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/** Files of the download, as seen from the package root (the archive holds them under package/). */
const packageFiles = () => listFiles(extracted).map((f) => f.slice('package/'.length));

function envWithoutAz() {
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const kept = String(process.env[key] || '')
    .split(path.delimiter)
    .filter((dir) => !['az', 'az.cmd', 'az.exe', 'az.ps1', 'az.bat'].some((f) => fs.existsSync(path.join(dir, f))));
  return Object.assign({}, process.env, { [key]: kept.join(path.delimiter) });
}

test.before(() => {
  if (!hasGit) return;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nfm-export-'));
  snapshot = path.join(sandbox, 'repo');
  makeSnapshot(snapshot);
  const zipFile = path.join(sandbox, 'archive.zip');
  const archived = git(snapshot, ['archive', '--format=zip', '-o', zipFile, 'HEAD']);
  assert.equal(archived.status, 0, archived.stderr);
  extracted = path.join(sandbox, 'download');
  new AdmZip(zipFile).extractAllTo(extracted, true);
});

test.after(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

const skipGit = !hasGit && 'git missing';

test('archive: "Download ZIP" ships the package folder only', { skip: skipGit }, () => {
  const files = listFiles(extracted);
  assert.ok(files.length > 50, 'files found');
  assert.deepEqual(files.filter((f) => !f.startsWith('package/')), [], 'nothing outside package/ is downloaded');
});

test('archive: only the files needed to deploy and use the add-in are shipped', { skip: skipGit }, () => {
  const files = packageFiles();
  const forbidden = [
    /^tests\//, /^\.github\//, /^tools\/preview\//, /^tools\/make-icons\.js$/, /^tools\/build-preview\.js$/, /^tools\/run-tests\.js$/,
    /^tools\/New-NoFridayMailPackage\.ps1$/, /^tools\/Build-Documentation\.js$/, /^tools\/New-DocumentationImages\.js$/, /^tools\/doc-assets\//,
    /^AGENTS\.md$/, /^PROVENANCE\.md$/, /^CHANGELOG\.md$/, /^SECURITY\.md$/, /^\.gitattributes$/, /^\.gitignore$/, /^assets\/.*\.svg$/,
    /^previews\//, /^dist\//, /^out\//, /node_modules\//, /^deploy\/environments\.local\//, /(^|\/)\.env/, /\.(pfx|pem|key)$/
  ];
  for (const file of files) {
    for (const pattern of forbidden) assert.doesNotMatch(file, pattern, `file that must not ship in the archive: ${file}`);
  }
  // Only the example and the production template ship: never an operator environment.
  assert.deepEqual(files.filter((f) => f.startsWith('deploy/environments/')), ['deploy/environments/example.json', 'deploy/environments/prod.json']);
  const required = [
    'package.json', 'package-lock.json', 'webpack.config.js', 'manifest.xml', 'staticwebapp.config.json',
    'deploy/environment.schema.json', 'api/package.json', 'api/host.json', 'src/shared/config.js',
    'tools/Deploy-NoFridayMail.ps1', 'tools/New-NoFridayMailEnvironment.ps1', 'tools/lib/Deploy-Checks.ps1', 'tools/Test-PackageIntegrity.ps1', 'tools/build.js',
    'tools/verify-receipt.js', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'
  ];
  for (const file of required) assert.ok(files.includes(file), `required file missing from the archive: ${file}`);
  assert.ok(files.some((f) => /^docs\/.+\.md$/.test(f)), 'Markdown documentation shipped');
  assert.ok(files.some((f) => /^docs\/.+\.html$/.test(f)), 'HTML documentation shipped');
  assert.ok(files.some((f) => /^assets\/icon-\d+\.png$/.test(f)), 'PNG icons shipped');
});

test('archive: combined gitattributes rules (-text on scripts to sign, export-ignore outside package/)', { skip: skipGit }, () => {
  const attr = (name, file) => git(snapshot, ['check-attr', name, '--', file]).stdout.trim().split(': ').pop();
  for (const signed of ['package/tools/Deploy-NoFridayMail.ps1', 'package/tools/New-NoFridayMailEnvironment.ps1', 'package/tools/lib/Deploy-Checks.ps1', 'package/tools/Test-PackageIntegrity.ps1']) {
    assert.equal(attr('text', signed), 'unset', `${signed}: exact bytes (-text)`);
    assert.notEqual(attr('export-ignore', signed), 'set', `${signed} must ship`);
  }
  // Documents hashed in the integrity manifest keep their exact bytes; the developer files (unsigned) do not.
  for (const exact of ['package/README.md', 'package/THIRD-PARTY-NOTICES.md', 'package/docs/NoFridayMail-Guide.html', 'CHANGELOG.md']) {
    assert.equal(attr('text', exact), 'unset', `${exact}: exact bytes (-text)`);
  }
  for (const dev of ['tools/New-NoFridayMailPackage.ps1', 'tests/Deploy.Tests.ps1', '.github/scripts/Invoke-CI.ps1']) {
    assert.notEqual(attr('text', dev), 'unset', `${dev}: not signed, no exact-bytes rule`);
  }
  // Every entry of the repository root except package/ is outside the download.
  const tracked = git(snapshot, ['ls-files', '-z']).stdout.split('\0').filter(Boolean);
  for (const top of new Set(tracked.map((f) => f.split('/')[0]))) {
    if (top === 'package') continue;
    // The rule is on the root entry itself (a directory rule prunes the whole subtree from the archive).
    assert.equal(attr('export-ignore', top), 'set', `${top}: export-ignore (outside package/)`);
  }
  assert.notEqual(attr('export-ignore', 'package/README.md'), 'set');
});

test('archive: every relative require() in the tools and webpack resolves to a shipped file', { skip: skipGit }, () => {
  const files = new Set(packageFiles());
  const sources = [...files].filter((f) => /^(tools\/.+|webpack\.config)\.js$/.test(f));
  assert.ok(sources.length >= 10);
  const resolves = (from, request) => {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), request));
    return [base, `${base}.js`, `${base}.json`, `${base}/index.js`].some((c) => files.has(c));
  };
  for (const source of sources) {
    const text = fs.readFileSync(path.join(extracted, 'package', source), 'utf8');
    // `= require('./x')` only: package-api.js also holds require() calls in the text of a generated script.
    for (const m of text.matchAll(/=\s*require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      assert.ok(resolves(source, m[1]), `${source}: require('${m[1]}') not found in the archive`);
    }
  }
});

test('archive: the npm build and validation scripts point to shipped files, development scripts are not shipped', { skip: skipGit }, () => {
  const files = new Set(packageFiles());
  const scripts = JSON.parse(fs.readFileSync(path.join(extracted, 'package', 'package.json'), 'utf8')).scripts;
  for (const name of ['build', 'build:prod', 'build:dev', 'validate:prod', 'validate:env']) {
    assert.ok(scripts[name], name);
    for (const m of scripts[name].matchAll(/node\s+(\S+\.js)/g)) assert.ok(files.has(m[1]), `npm run ${name}: ${m[1]} missing from the archive`);
  }
  // Development scripts belong to the root package.json (tests, documentation, images, icons, preview), not to the package.
  const development = ['test', 'icons', 'images', 'docs', 'docs:check', 'preview'];
  const rootScripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  for (const name of development) {
    assert.equal(scripts[name], undefined, `${name} is a development script, not a package script`);
    assert.ok(rootScripts[name], `root npm run ${name}`);
  }
  // webpack reads the icons and the site pages: everything it copies exists.
  for (const file of ['src/taskpane/taskpane.html', 'src/commands/commands.html', 'src/index.html', 'src/launchevent/launchevent.js']) {
    assert.ok(files.has(file), file);
  }
});

test('archive: package/tools/Deploy-NoFridayMail.ps1 -WhatIf runs without tests/ (build announced, no failure)', { skip: skipGit || (!hasPwsh && 'PowerShell 7.4 missing') || (!fs.existsSync(path.join(root, 'package', 'node_modules')) && 'package/node_modules missing (npm ci not run)'), timeout: 180000 }, () => {
  const pkgDir = path.join(extracted, 'package');
  assert.equal(fs.existsSync(path.join(pkgDir, 'tests')), false, 'tests/ is not shipped');
  // npm ci needs the network: node_modules is linked from the repository (junction), only for the environment validation.
  fs.symlinkSync(path.join(root, 'package', 'node_modules'), path.join(pkgDir, 'node_modules'), 'junction');
  try {
    const script = path.join(pkgDir, 'tools', 'Deploy-NoFridayMail.ps1');
    // "example" is a template refused by the script: the production template `prod` serves as the smoke test.
    const env = envWithoutAz();
    delete env.NFM_ENVIRONMENTS_DIR;
    const r = spawnSync('pwsh', ['-NoProfile', '-File', script, '-Environment', 'prod', '-WhatIf', '-SkipInfra'], { encoding: 'utf8', env, cwd: pkgDir });
    const all = `${r.stdout}\n${r.stderr}`;
    assert.equal(r.status, 0, all);
    assert.match(all, /build:prod/, 'the build step is announced');
    assert.doesNotMatch(all, /ENOENT|Cannot find path|is not recognized|Unhandled|npm error/i, 'no failure caused by the missing tests/ folder');
    assert.match(all, /tests\/[^\n]*not/i, 'the script explains that tests/ is not shipped');
    assert.doesNotMatch(all, /what if[^\n]*npm test/i, 'npm test is not run without tests/');
    // The simulation creates no file.
    assert.equal(fs.existsSync(path.join(pkgDir, 'dist')), false);
    assert.equal(fs.existsSync(path.join(pkgDir, 'out')), false);
  } finally {
    fs.unlinkSync(path.join(pkgDir, 'node_modules'));
  }
});

test('release ZIP: inventory = package folder of the git archive + CHANGELOG.md + PackageIntegrity.psd1 only', { skip: skipGit || (!hasPwsh && 'PowerShell 7.4 missing'), timeout: 180000 }, () => {
  const out = path.join(sandbox, 'release');
  const stage = path.join(out, 'stage');
  const r = spawnSync('pwsh', ['-NoProfile', '-File', path.join(snapshot, 'tools', 'New-NoFridayMailPackage.ps1'), '-Unsigned', '-Destination', stage, '-OutputDirectory', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package', 'package.json'), 'utf8')).version;
  const zipFile = path.join(out, `NoFridayMail-${version}-unsigned.zip`);
  assert.ok(fs.existsSync(zipFile), zipFile);
  const zipped = new AdmZip(zipFile).getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName).sort();
  const archived = packageFiles();
  assert.deepEqual(zipped.filter((f) => f !== 'PackageIntegrity.psd1' && f !== 'CHANGELOG.md'), archived, 'the ZIP root is the package folder');
  assert.ok(zipped.includes('PackageIntegrity.psd1'));
  // The root change log is not downloaded (export-ignore) but ships in the release ZIP, byte for byte.
  assert.ok(!archived.includes('CHANGELOG.md'), 'Download ZIP does not carry CHANGELOG.md');
  assert.ok(zipped.includes('CHANGELOG.md'), 'the release ZIP carries CHANGELOG.md');
  assert.ok(new AdmZip(zipFile).readFile('CHANGELOG.md').equals(fs.readFileSync(path.join(snapshot, 'CHANGELOG.md'))), 'CHANGELOG.md: bytes modified');
  assert.ok(zipped.includes('tools/Deploy-NoFridayMail.ps1') && zipped.every((f) => !f.startsWith('package/')));
  // Bytes identical to the git archive (no file rewritten).
  const zip = new AdmZip(zipFile);
  for (const file of archived) {
    assert.ok(zip.readFile(file).equals(fs.readFileSync(path.join(extracted, 'package', file))), `${file}: bytes modified`);
  }
  // The manifest lists everything except itself, and the ZIP verifier accepts the unpacked package (unsigned).
  const manifest = zip.readAsText('PackageIntegrity.psd1');
  const listed = [...manifest.matchAll(/Path = '([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, archived.concat('CHANGELOG.md').sort());
  const check = spawnSync('pwsh', ['-NoProfile', '-File', path.join(stage, 'tools', 'Test-PackageIntegrity.ps1'), '-Root', stage, '-AllowUnsigned'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const strict = spawnSync('pwsh', ['-NoProfile', '-File', path.join(stage, 'tools', 'Test-PackageIntegrity.ps1'), '-Root', stage], { encoding: 'utf8' });
  assert.notEqual(strict.status, 0, 'an unsigned package is refused without -AllowUnsigned');
});
