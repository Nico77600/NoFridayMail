'use strict';

/*
 * Public safety: the files tracked by git (plus new untracked files that are not ignored) are what is published.
 * They must hold no private data of the owner or customers: tenant/subscription/app identifiers, real
 * *.azurestaticapps.net hosts, private user names, private resource groups, operator environment files.
 *
 * The private strings are NOT written here (this file is published too). They are matched by SHA-256 of lowercase
 * "words" (runs of letters and digits), and every GUID found in the tree must be on the allow-list below.
 * To publish a new GUID (a placeholder, or the public production add-in Id), add it to ALLOWED_GUIDS knowingly.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

// SHA-256 of private words (user names and resource group, host suffixes, first GUID groups of private identifiers).
const FORBIDDEN_WORD_HASHES = new Set([
  'a7be2cc6ffcfdfd34d64acea6f0da5334072127a68f9283cd7b9d8e8d005ac5c',
  'b8f5ce0d52517685fab2144094b5925e21e21184d896e649ad684d253fd0ad6e',
  '60549ac4c40d3ed69ab2e0bf8c31abeb5727b06839258b16654de45e17a20e9f',
  '599f0ce1588905fa3e5ccd9fac6937f69d06d5a28e2adc809005b10f9fc4e419',
  '143dc69932ab8ab118062f1b90406f4d500a6d14f473ee034808740a41792dbd',
  '135170e8e695e98c4f8e3075b1fe3c531d013720731639412a1d441de8d7082a',
  '19f9d407d520a40f70736eee5790632d423fabb927d75beb9bd2ddb2c8978113',
  '097b5743c70d1c430f2afe49890dade3a446a083b2f60f78fda4f29b38549d10',
  '090f6ece8c1d6bc520bd5a4cdfa39436a874a9cad811ca031e74181090c7df9a',
  '370adad4e32fe29f1b6777d589d1e66117cf2c405faa7185ada7e7f75965280a',
  '6eb8bcace3e5eacd7c94ba8b80c8bbf6f8c2cb2d729f8039c906cc51d250ed7b',
  'b89dab25add72d4b61d94682bf4b66efd3c89923826a15e52f21dd87a1ddff4d'
]);

// Placeholders, fixtures, the development manifest Id and the public production add-in Id (safe to publish).
const ALLOWED_GUIDS = new Set([
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-000000000001',
  '11111111-2222-4333-8444-555555555555',
  '99999999-2222-4333-8444-555555555555',
  'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  'c0a1f001-0000-4000-8000-000000000001',
  'c0a1f001-0000-4000-8000-000000000002',
  'c0a1f001-0000-4000-8000-000000000003',
  'c0a1f001-0000-4000-8000-000000000004',
  '2178c516-c0d6-4b65-bbca-ef763a06ba16', // development manifest (manifest.xml) and the lab-frozen fixture
  'e0a93350-84f0-44c9-a8d7-4c3bad350724' // production add-in Id (public)
]);

// Everything that is published sits under one of these roots; a new top-level entry must be added knowingly.
const ALLOWED_TOP_LEVEL = new Set([
  '.github', '.gitattributes', '.gitignore', 'AGENTS.md', 'CHANGELOG.md', 'LICENSE', 'PROVENANCE.md', 'README.md',
  'SECURITY.md', 'assets', 'package', 'package-lock.json', 'package.json', 'tests', 'tools'
]);

const BINARY = /\.(png|jpg|jpeg|gif|ico|zip|pfx|woff2?)$/i;

function publishedFiles() {
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

const files = publishedFiles();
const textFiles = files.filter((f) => !BINARY.test(f));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const sha = (w) => crypto.createHash('sha256').update(w).digest('hex');

test('public safety : the published tree is not empty and has only known top-level entries', () => {
  assert.ok(files.length > 20, 'tree found');
  const unknown = Array.from(new Set(files.map((f) => f.split('/')[0]))).filter((top) => !ALLOWED_TOP_LEVEL.has(top));
  assert.deepEqual(unknown, [], 'unexpected top-level entries (add them to ALLOWED_TOP_LEVEL knowingly)');
});

test('public safety : no operator environment, secret or certificate file is published', () => {
  const bad = files.filter(
    (f) =>
      /(^|\/)deploy\/environments\.local\//.test('/' + f) ||
      /(^|\/)lab\.json$/.test(f) ||
      /(^|\/)\.env(\..*)?$/.test(f) ||
      /\.(pfx|pem|key|p12)$/i.test(f) ||
      /(^|\/)api\/(shared|config\.json|node_modules)/.test(f)
  );
  assert.deepEqual(bad, []);
  const envs = files.filter((f) => /^package\/deploy\/environments\/[^/]+\.json$/.test(f)).map((f) => path.basename(f, '.json')).sort();
  assert.deepEqual(envs, ['example', 'prod'], 'only the template and the production template are published');
});

test('public safety : no private word (user names, resource group, host suffixes, identifier prefixes)', () => {
  const hits = [];
  const scan = (label, text) => {
    for (const word of new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4))) {
      if (FORBIDDEN_WORD_HASHES.has(sha(word))) hits.push(label);
    }
  };
  files.forEach((f) => scan(f + ' (path)', f));
  textFiles.forEach((f) => scan(f, read(f)));
  assert.deepEqual(hits, [], 'private strings found in these files (value withheld)');
});

test('public safety : every GUID is a known placeholder or public identifier', () => {
  const unknown = [];
  textFiles.forEach((f) => {
    for (const guid of read(f).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []) {
      if (!ALLOWED_GUIDS.has(guid.toLowerCase())) unknown.push(`${f}: ${guid}`);
    }
  });
  assert.deepEqual(unknown, [], 'unknown GUIDs (add a placeholder to ALLOWED_GUIDS only if it is safe to publish)');
});

test('public safety : no Azure-generated Static Web Apps host and no tenant domain', () => {
  const generated = /\b[a-z]+-[a-z]+-[0-9a-f]{9}(\.\d+)?\.azurestaticapps\.net/i;
  const tenant = /\b[a-z0-9-]+\.onmicrosoft\.com\b/i;
  const hits = textFiles.filter((f) => {
    const text = read(f);
    return generated.test(text) || tenant.test(text);
  });
  assert.deepEqual(hits, []);
});

test('public safety : no credential-looking material (private keys, bearer tokens, deployment tokens)', () => {
  const hits = textFiles.filter((f) => {
    if (f === 'tests/public-safety.test.js') return false;
    const text = read(f);
    return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) || /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/.test(text);
  });
  assert.deepEqual(hits, []);
});
