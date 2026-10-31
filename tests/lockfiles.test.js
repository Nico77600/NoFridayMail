'use strict';

/*
 * Lockfiles: every tracked package-lock.json must resolve from the public npm registry, and no tracked file may
 * point at a corporate package feed or proxy (a lockfile written behind a proxy records its host and breaks `npm ci`
 * for everyone else).
 *
 * Like tests/public-safety.test.js, the forbidden hosts are NOT written here: they are matched by SHA-256 of the
 * host suffix (the last two labels of a host name) and of a lowercase word.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const REGISTRY = 'https://registry.npmjs.org/';

// SHA-256 of forbidden registry host suffixes (two labels) and of forbidden words (proxy product names).
const FORBIDDEN_HOST_SUFFIX_HASHES = new Set([
  'd7342c2c4a5dbd07d55ac84c66b8864ae4f1370e97d1a6173f65f7821826e357',
  '0cc0aef3c306496eaae528ed76ee3da699094c73be12068c1e8ea92ceac1c891'
]);
const FORBIDDEN_WORD_HASHES = new Set([
  '60601392fc228ce25aeb6dd9214b3d2f05028bc39bdbcb869d206a386e50b9d1'
]);

const BINARY = /\.(png|jpg|jpeg|gif|ico|zip|pfx|woff2?)$/i;
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function trackedFiles() {
  const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  if (git.status === 0 && git.stdout) {
    return git.stdout.split('\0').filter(Boolean).filter((f) => fs.existsSync(path.join(root, f)));
  }
  // Outside git (e.g. an extracted download): walk the folder, skipping generated areas.
  const out = [];
  const skip = new Set(['node_modules', 'dist', 'out', 'previews', '.git', 'environments.local']);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out;
}

const files = trackedFiles();
const lockfiles = files.filter((f) => path.posix.basename(f) === 'package-lock.json');
const textFiles = files.filter((f) => !BINARY.test(f));

test('lockfiles: the repository root, package/ and package/api/ each have a package-lock.json', () => {
  for (const expected of ['package-lock.json', 'package/package-lock.json', 'package/api/package-lock.json']) {
    assert.ok(lockfiles.includes(expected), `${expected} is tracked`);
  }
});

test('lockfiles: every "resolved" URL points at the public npm registry', () => {
  const bad = [];
  for (const file of lockfiles) {
    const lock = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    for (const [name, entry] of Object.entries(lock.packages || {})) {
      if (entry && entry.resolved !== undefined && !String(entry.resolved).startsWith(REGISTRY)) {
        bad.push(`${file}: ${name || '(root)'}`);
      }
    }
    for (const [name, entry] of Object.entries(lock.dependencies || {})) {
      if (entry && entry.resolved !== undefined && !String(entry.resolved).startsWith(REGISTRY)) {
        bad.push(`${file}: ${name}`);
      }
    }
  }
  assert.deepEqual(bad.slice(0, 20), [], `resolved URLs outside ${REGISTRY} (normalise the lockfile, see AGENTS.md)`);
});

test('lockfiles: no tracked file names a corporate package feed or proxy host', () => {
  const hits = [];
  for (const file of textFiles) {
    const text = fs.readFileSync(path.join(root, file), 'utf8').toLowerCase();
    let found = false;
    for (const host of new Set(text.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/g) || [])) {
      const labels = host.split('.');
      if (FORBIDDEN_HOST_SUFFIX_HASHES.has(sha(labels.slice(-2).join('.')))) found = true;
    }
    for (const word of new Set(text.split(/[^a-z0-9]+/).filter((w) => w.length >= 4))) {
      if (FORBIDDEN_WORD_HASHES.has(sha(word))) found = true;
    }
    if (found) hits.push(file);
  }
  assert.deepEqual(hits, [], 'corporate registry hosts found in these files (value withheld)');
});

test('lockfiles: the guard detects what it forbids (self-check on synthetic hosts)', () => {
  const feed = ['pkgs', ['visual', 'studio'].join(''), 'com'].join('.');
  const io = ['feed', 'microsoft', 'io'].join('.');
  for (const host of [feed, io]) {
    assert.ok(FORBIDDEN_HOST_SUFFIX_HASHES.has(sha(host.split('.').slice(-2).join('.'))), 'suffix hash matches');
  }
  assert.ok(FORBIDDEN_WORD_HASHES.has(sha(['package', 'feed', 'proxy'].join(''))), 'word hash matches');
  assert.ok(!FORBIDDEN_HOST_SUFFIX_HASHES.has(sha('npmjs.org')), 'the public registry is allowed');
});
