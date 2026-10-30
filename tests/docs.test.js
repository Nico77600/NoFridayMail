'use strict';

/*
 * The HTML guides (docs/*.html) are generated from the Markdown guides by tools/Build-Documentation.js.
 * After any change to docs/NoFridayMail-UserGuide.md or docs/NoFridayMail-Guide.md, run:  npm run docs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const docs = path.join(root, 'docs');
const generator = require('../tools/Build-Documentation');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const withoutCode = (markdown) => markdown.replace(/^( {0,3})(```+|~~~+)[^\n]*\n[\s\S]*?^\1\2[ \t]*$/gm, '').replace(/`[^`\n]*`/g, '');
const headingsOf = (markdown) => Array.from(withoutCode(markdown).matchAll(/^#{1,6}\s+(.*?)\s*#*$/gm)).map((m) => m[1].replace(/[*_`]/g, ''));
const linksOf = (markdown) => Array.from(withoutCode(markdown).matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)).map((m) => m[1]);

test('docs : the HTML guides are up to date (run "npm run docs" after changing the Markdown)', () => {
  for (const name of generator.GUIDES) {
    const file = path.join(docs, `${name}.html`);
    assert.ok(fs.existsSync(file), `docs/${name}.html exists (npm run docs)`);
    const committed = fs.readFileSync(file, 'utf8');
    assert.equal(committed, generator.buildGuide(name), `docs/${name}.html is out of date: run "npm run docs"`);
    assert.equal(committed.includes('\r'), false, 'LF line endings');
  }
});

test('docs : generation is deterministic (no build date, no machine-specific content)', () => {
  for (const name of generator.GUIDES) {
    assert.equal(generator.buildGuide(name), generator.buildGuide(name));
    const html = fs.readFileSync(path.join(docs, `${name}.html`), 'utf8');
    assert.doesNotMatch(html, /[A-Z]:\\Scripts|file:\/\/\/|\\Users\\/i);
  }
});

test('docs : front matter is complete and the version matches package.json', () => {
  for (const name of generator.GUIDES) {
    const { meta, hasFrontMatter } = generator.parseFrontMatter(read(path.join(docs, `${name}.md`)));
    assert.ok(hasFrontMatter, `${name}.md has a front matter`);
    for (const key of ['title', 'subtitle', 'version', 'author', 'updated']) assert.ok(meta[key], `${name}.md front matter: ${key}`);
    assert.equal(meta.author, 'Nicolas Fabert');
    assert.equal(meta.version, pkg.version, `${name}.md version = package.json version`);
    assert.match(meta.updated, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('docs : the User guide follows the reference form (H1, intro quote, numbered chapters)', () => {
  const md = read(path.join(docs, 'NoFridayMail-UserGuide.md'));
  assert.match(md, /^# NoFridayMail — User guide$/m);
  assert.match(md, /^> Follow the path, one step after the other\. Each step says \*\*what to do\*\*, gives the command to copy, says \*\*what you should see\*\*, and \*\*what to do if not\*\*\./m);
  assert.match(md, /^> \[!IMPORTANT\]$/m);
  assert.match(md, /^> \[!WARNING\]$/m);
  assert.match(md, /^> \[!NOTE\]$/m);
  const chapters = Array.from(md.matchAll(/^## (\d+)\. (.*)$/gm)).map((m) => Number(m[1]));
  assert.deepEqual(chapters, chapters.map((_, i) => i + 1), 'chapters are numbered 1..N');
  assert.ok(chapters.length >= 8);
});

test('docs : the HTML files are self-contained (no external script, style, font or image)', () => {
  for (const name of generator.GUIDES) {
    const html = fs.readFileSync(path.join(docs, `${name}.html`), 'utf8');
    assert.doesNotMatch(html, /<link\b/i, 'no <link>');
    assert.doesNotMatch(html, /<script[^>]+\bsrc=/i, 'no external script');
    assert.doesNotMatch(html, /@import|url\(\s*["']?https?:/i, 'no external CSS');
    assert.doesNotMatch(html, /<img[^>]+src="(?!data:)/i, 'images are embedded');
    // The only absolute URLs are links in the content.
    const absolute = Array.from(html.matchAll(/\b(?:src|href|action)="(https?:\/\/[^"]+)"/g));
    for (const m of absolute) assert.match(html.slice(Math.max(0, m.index - 12), m.index), /<a /, `only anchors use absolute URLs (${m[1]})`);
    assert.match(html, /prefers-color-scheme/);
    assert.match(html, /@media print/);
    assert.doesNotMatch(html, /scoutTheme/);
  }
});

test('docs : every custom block is rendered (no raw fence, no leftover Markdown syntax)', () => {
  for (const name of generator.GUIDES) {
    const html = fs.readFileSync(path.join(docs, `${name}.html`), 'utf8');
    assert.doesNotMatch(html, /```/);
    assert.doesNotMatch(html, /language-(cards|steps|flow|path)/);
    assert.doesNotMatch(html, /\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/);
    assert.doesNotMatch(html, /<p>\s*[-*] |<p>\s*\d+\. /, 'no list rendered as text');
    assert.doesNotMatch(html, /\*\*[^<*\n]{2,60}\*\*/, 'no unrendered bold');
    assert.doesNotMatch(html, /<!-- icon:/, 'icon comments are consumed');
    const md = read(path.join(docs, `${name}.md`));
    const blocks = (kind) => (md.match(new RegExp(`^\`\`\`${kind}$`, 'gm')) || []).length;
    assert.equal((html.match(/<div class="cards">/g) || []).length, blocks('cards'), 'cards');
    assert.equal((html.match(/<ol class="steps">/g) || []).length, blocks('steps'), 'steps');
    assert.equal((html.match(/<div class="flow">/g) || []).length, blocks('flow'), 'flow');
    assert.equal((html.match(/<!--path-->/g) || []).length, blocks('path'), 'path');
    // every icon name used by a block or a chapter comment exists in the icon table
    const fence = '`'.repeat(3);
    const used = [];
    for (const kind of ['cards', 'flow', 'path']) {
      for (const part of md.split(new RegExp(`^${fence}${kind}$`, 'm')).slice(1)) {
        for (const line of part.split(`\n${fence}`)[0].split('\n').filter((l) => l.trim())) {
          const f = line.split('|').map((x) => x.trim());
          if (kind === 'path') {
            if (!/^\d+$/.test(f[1])) used.push(f[1]);
          } else if (!(kind === 'flow' && f[0] === 'arrow')) used.push(f[0]);
        }
      }
    }
    for (const m of md.matchAll(/<!-- icon: ([\w-]+) -->/g)) used.push(m[1]);
    for (const ic of used) assert.ok(generator.ICONS[ic], `${name}.md: unknown icon "${ic}"`);
  }
});

test('docs : the Markdown guides link only to existing files and headings (GitHub anchors)', () => {
  const sources = [...generator.GUIDES.map((n) => path.join(docs, `${n}.md`)), path.join(root, 'README.md')];
  for (const file of sources) {
    const md = read(file);
    const dir = path.dirname(file);
    for (const target of linksOf(md)) {
      if (/^(https:|mailto:)/i.test(target)) continue;
      assert.doesNotMatch(target, /^[a-z]+:/i, `${path.basename(file)}: unsupported link ${target}`);
      const [rel, anchor] = target.split('#');
      const targetFile = rel ? path.resolve(dir, decodeURIComponent(rel)) : file;
      assert.ok(fs.existsSync(targetFile), `${path.basename(file)}: missing file for ${target}`);
      if (anchor && targetFile.endsWith('.md')) {
        const slugs = headingsOf(read(targetFile)).map(generator.githubSlug);
        assert.ok(slugs.includes(anchor), `${path.basename(file)}: no heading for #${anchor} in ${path.basename(targetFile)}`);
      }
    }
  }
});

test('docs : README relative HTML links and images exist', () => {
  const readme = read(path.join(root, 'README.md'));
  for (const m of readme.matchAll(/\b(?:src|srcset|href)="([^"#:]+)"/g)) {
    assert.ok(fs.existsSync(path.join(root, m[1])), `README.md: missing ${m[1]}`);
  }
});

test('docs : every link of the HTML guides resolves to an id of the right page', () => {
  const pages = Object.fromEntries(generator.GUIDES.map((n) => [n, fs.readFileSync(path.join(docs, `${n}.html`), 'utf8')]));
  const idsOf = (html) => new Set(Array.from(html.matchAll(/\sid="([^"]+)"/g)).map((m) => m[1]));
  for (const [name, html] of Object.entries(pages)) {
    for (const m of html.matchAll(/<a href="([^"]+)"/g)) {
      const href = m[1];
      if (/^https?:/.test(href)) continue;
      const [page, anchor] = href.split('#');
      const targetName = page ? page.replace(/\.html$/, '') : name;
      assert.ok(pages[targetName], `${name}.html: link to an unknown page ${href}`);
      if (anchor) assert.ok(idsOf(pages[targetName]).has(anchor), `${name}.html: no id "${anchor}" in ${targetName}.html (${href})`);
    }
  }
});

test('docs : no reference to a French documentation folder or to operator-only files', () => {
  const files = [...generator.GUIDES.flatMap((n) => [`docs/${n}.md`, `docs/${n}.html`]), 'README.md', 'AGENTS.md'];
  for (const rel of files) {
    const text = fs.existsSync(path.join(root, rel)) ? read(path.join(root, rel)) : '';
    assert.doesNotMatch(text, /docs\/fr\b|docs\\fr\b/, `${rel}: no docs/fr`);
    assert.doesNotMatch(text, /\blab\.json\b/, `${rel}: no operator environment file names`);
  }
  assert.equal(fs.existsSync(path.join(docs, 'fr')), false, 'no docs/fr folder');
});

test('docs generator : Markdown converter essentials (lists, tables, alerts, anchors, escaping)', () => {
  const html = generator.markdownToHtml(
    [
      '## 3. Set up',
      '',
      '1. First **bold** and `a|b`',
      '2. Second',
      '   - nested one',
      '   - nested two',
      '3. Third',
      '',
      '| Name | Value |',
      '|---|:-:|',
      '| `x` | 1 \\| 2 |',
      '',
      '> [!WARNING]',
      '> Careful <name> & more.',
      '',
      '### 1 · Step title',
      ''
    ].join('\n')
  );
  assert.match(html, /<h2 id="set-up">3\. Set up<\/h2>/);
  assert.match(html, /<ol>\n<li>First <strong>bold<\/strong> and <code>a\|b<\/code><\/li>\n<li>Second\n<ul>/);
  assert.match(html, /<li>Third<\/li>/);
  assert.doesNotMatch(html, /<ol start=/, 'one single ordered list');
  assert.match(html, /<th>Name<\/th><th style="text-align: center;">Value<\/th>/);
  assert.match(html, /<td style="text-align: center;">1 \| 2<\/td>/);
  assert.match(html, /<div class="markdown-alert markdown-alert-warning">/);
  assert.match(html, /Careful &lt;name&gt; &amp; more\./);
  assert.match(html, /<h3 id="step-title">1 · Step title<\/h3>/);
  assert.equal(generator.githubSlug('Annex A — Troubleshooting'), 'annex-a--troubleshooting');
  assert.equal(generator.anchorToId('annex-a--troubleshooting'), 'annex-a-troubleshooting');
  assert.equal(generator.anchorToId('9-exceptional-send'), 'exceptional-send');
});

test('docs generator : HTML comments (single-line, multi-line, unterminated) never let markup through', () => {
  // A complete comment, on one or several lines, is kept as is.
  assert.equal(generator.markdownToHtml('<!-- icon: key -->\n'), '<!-- icon: key -->');
  assert.match(generator.markdownToHtml('<!-- first line\nsecond line\n-->\n\nText\n'), /^<!-- first line\nsecond line\n-->\n<p>Text<\/p>/);
  // An unterminated comment is ordinary text: escaped, and it swallows nothing that follows.
  const open = generator.markdownToHtml('<!-- <script>alert(1)</script>\n\n## Next\n');
  assert.doesNotMatch(open, /<script|<!--/);
  assert.match(open, /&lt;!-- &lt;script&gt;/);
  assert.match(open, /<h2 id="next">Next<\/h2>/);
  // Markup after the closing "-->" (same line or after a multi-line comment) is escaped as well.
  assert.doesNotMatch(generator.markdownToHtml('<!-- a --> <script>x</script>\n'), /<script/);
  assert.doesNotMatch(generator.markdownToHtml('<!-- a\nb --><script>x</script>\n'), /<script/);
  assert.doesNotMatch(generator.markdownToHtml('<!-- a --> b --> <script>x</script>\n'), /<script/);
});

test('docs generator : heading identifiers come from text, markup in a heading cannot survive', () => {
  const html = generator.markdownToHtml('## Title <scr<b>ipt>alert(1)</scr</b>ipt> end\n\n## **Bold** and `code`\n');
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /<h2 id="bold-and-code"><strong>Bold<\/strong> and <code>code<\/code><\/h2>/);
  assert.equal(/<h2 id="([^"]*)"/.exec(html)[1].includes('<'), false, 'no angle bracket in an id');
});
