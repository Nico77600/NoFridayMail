'use strict';

// Operator-facing and source text is English. French is allowed only as user-interface data: the string literals of
// src/shared/config.js (languages.fr), the French text asserted by the tests, and the visible text of the pages.
// Everything else (tooling, API, deployment, schemas, workflows, scripts, code comments, test titles) must hold no French
// accented letter.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const acorn = require('acorn');

const root = path.join(__dirname, '..');
const FRENCH = /[àâäçéèêëîïôöùûüœÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŒ]/;

function trackedFiles() {
  const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  if (git.status === 0 && git.stdout) {
    return git.stdout.split('\0').filter(Boolean).filter((f) => fs.existsSync(path.join(root, f)));
  }
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
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// Files that must hold no French accented letter at all.
const WHOLE_FILE = (f) =>
  /^(tools|api\/src|deploy|\.github)\//.test(f) ||
  /^(package\.json|webpack\.config\.js|staticwebapp\.config\.json|CHANGELOG\.md|api\/package\.json|api\/host\.json)$/.test(f) ||
  /^assets\/.*\.svg$/.test(f) ||
  /^tests\/.*\.ps1$/.test(f) ||
  /^tests\/fixtures\//.test(f);

// Files where only the comments (and test titles) are checked: they also hold French user-interface text.
const COMMENTS_ONLY_JS = (f) => /^(src|tests)\/.*\.js$/.test(f) && !f.startsWith('src/taskpane/msal');
const COMMENTS_ONLY_MARKUP = (f) => /^(src\/.*\.html|manifest\.xml)$/.test(f);

function jsComments(code) {
  const comments = [];
  const tryParse = (sourceType) => acorn.parse(code, { ecmaVersion: 'latest', sourceType, allowHashBang: true, allowReturnOutsideFunction: true, onComment: comments });
  let ast;
  try {
    ast = tryParse('script');
  } catch (e) {
    comments.length = 0;
    ast = tryParse('module');
  }
  return { ast, comments };
}

function testTitles(ast) {
  const titles = [];
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression') {
      const callee = node.callee;
      const name = callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' && callee.object.type === 'Identifier' ? callee.object.name : '';
      const first = node.arguments[0];
      if (['test', 'describe', 'it', 'suite'].includes(name) && first) {
        if (first.type === 'Literal' && typeof first.value === 'string') titles.push({ text: first.value, pos: first.start });
        if (first.type === 'TemplateLiteral') titles.push({ text: first.quasis.map((q) => q.value.cooked).join(''), pos: first.start });
      }
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value.type === 'string') visit(value);
    }
  };
  visit(ast);
  return titles;
}

test('English only: operator-facing files hold no French accented letter', () => {
  const targets = files.filter(WHOLE_FILE).filter((f) => !/\.(png|ico|zip)$/i.test(f));
  assert.ok(targets.length > 25, `files checked: ${targets.length}`);
  const hits = [];
  for (const f of targets) {
    read(f).split('\n').forEach((line, i) => {
      if (FRENCH.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('English only: code comments and test titles hold no French accented letter (UI strings excluded)', () => {
  const targets = files.filter(COMMENTS_ONLY_JS);
  assert.ok(targets.length > 20, `files checked: ${targets.length}`);
  const hits = [];
  for (const f of targets) {
    const code = read(f);
    const { ast, comments } = jsComments(code);
    for (const c of comments) {
      if (FRENCH.test(c.value)) hits.push(`${f}:${lineOf(code, c.start)}: ${c.value.trim().split('\n').find((l) => FRENCH.test(l)).trim().slice(0, 100)}`);
    }
    if (f.startsWith('tests/')) {
      for (const t of testTitles(ast)) {
        if (FRENCH.test(t.text)) hits.push(`${f}:${lineOf(code, t.pos)}: test title "${t.text.slice(0, 80)}"`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

test('English only: comments of the pages and of the manifest hold no French accented letter', () => {
  const hits = [];
  for (const f of files.filter(COMMENTS_ONLY_MARKUP)) {
    const text = read(f);
    for (const m of text.matchAll(/<!--([\s\S]*?)-->|\/\*([\s\S]*?)\*\//g)) {
      if (FRENCH.test(m[0])) hits.push(`${f}:${lineOf(text, m.index)}: ${m[0].split('\n').find((l) => FRENCH.test(l)).trim().slice(0, 100)}`);
    }
    for (const m of text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      const { comments } = jsComments(m[1]);
      for (const c of comments) {
        if (FRENCH.test(c.value)) hits.push(`${f}:${lineOf(text, m.index)}: script comment "${c.value.trim().slice(0, 80)}"`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

test('English only: French is confined to the languages.fr block of src/shared/config.js (no French in the English block or in code)', () => {
  const code = read('src/shared/config.js');
  const { ast } = jsComments(code);
  const frenchLiterals = [];
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Literal' && typeof node.value === 'string' && FRENCH.test(node.value)) frenchLiterals.push(node.start);
    if (node.type === 'TemplateElement' && FRENCH.test(node.value.cooked || '')) frenchLiterals.push(node.start);
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value.type === 'string') visit(value);
    }
  };
  visit(ast);
  assert.ok(frenchLiterals.length > 5, 'the French UI strings are in config.js');
  const frStart = code.indexOf('fr: {');
  const enStart = code.indexOf('en: {');
  assert.ok(frStart !== -1 && enStart !== -1, 'languages.fr and languages.en blocks found');
  const [from, to] = frStart < enStart ? [frStart, enStart] : [frStart, code.length];
  for (const pos of frenchLiterals) assert.ok(pos > from && pos < to, `French literal outside languages.fr at line ${lineOf(code, pos)}`);
});

test('no private environment names in published text (tracked files)', () => {
  const hits = files
    .filter((f) => !/\.(png|ico|zip)$/i.test(f))
    .filter((f) => new RegExp('rec' + 'ette', 'i').test(read(f)));
  assert.deepEqual(hits, []);
});
