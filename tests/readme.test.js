'use strict';

/*
 * The README graphics (docs/images/readme-*.png) are rendered by tools/New-DocumentationImages.js (npm run images).
 * They must exist in a light and a dark version, the README must pick them with <picture>, and every image needs an
 * alternative text. Light and dark pictures have the same size, the graphics are 2160 px wide (1080 CSS px at 2x).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const imagesDir = path.join(root, 'package', 'docs', 'images');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');

/** Width and height of a PNG file (IHDR chunk). */
function pngSize(file) {
  const buffer = fs.readFileSync(file);
  assert.equal(buffer.subarray(1, 4).toString('latin1'), 'PNG', `${path.basename(file)} is a PNG file`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const pictures = Array.from(readme.matchAll(/<picture>([\s\S]*?)<\/picture>/g)).map((m) => {
  const dark = /<source media="\(prefers-color-scheme: dark\)" srcset="([^"]+)">/.exec(m[1]);
  const img = /<img\b[^>]*>/.exec(m[1]);
  return {
    html: m[0],
    dark: dark && dark[1],
    src: img && /\bsrc="([^"]+)"/.exec(img[0]) && /\bsrc="([^"]+)"/.exec(img[0])[1],
    alt: img && /\balt="([^"]*)"/.exec(img[0]) && /\balt="([^"]*)"/.exec(img[0])[1]
  };
});

test('README images: every <picture> has a dark source and a light image of the same name', () => {
  assert.ok(pictures.length >= 7, 'the README uses the generated pictures');
  for (const p of pictures) {
    assert.ok(p.dark, `a dark source in ${p.html.slice(0, 80)}`);
    assert.ok(p.src, 'a light image');
    assert.match(p.src, /^package\/docs\/images\/readme-[a-z-]+-light\.png$/, `${p.src}: light file name`);
    assert.equal(p.dark, p.src.replace(/-light\.png$/, '-dark.png'), `${p.src}: the dark source is the -dark twin`);
  }
});

test('README images: every image referenced by the README exists, with an alternative text', () => {
  const imgs = Array.from(readme.matchAll(/<img\b[^>]*>/gi)).map((m) => m[0]);
  assert.ok(imgs.length >= pictures.length);
  for (const tag of imgs) {
    const src = /\bsrc="([^"]+)"/.exec(tag);
    assert.ok(src, `an src in ${tag.slice(0, 60)}`);
    assert.ok(fs.existsSync(path.join(root, src[1])), `README.md: missing ${src[1]}`);
    const alt = /\balt="([^"]+)"/.exec(tag);
    assert.ok(alt && alt[1].length >= 20, `an alternative text for ${src[1]}`);
  }
  for (const m of readme.matchAll(/srcset="([^"]+)"/g)) assert.ok(fs.existsSync(path.join(root, m[1])), `README.md: missing ${m[1]}`);
  for (const m of readme.matchAll(/href="(package\/docs\/images\/[^"?]+)(?:\?raw=true)?"/g)) assert.ok(fs.existsSync(path.join(root, m[1])), `README.md: missing ${m[1]}`);
});

test('README images: no readme-* picture is left unused, no light picture lacks its dark twin', () => {
  const files = fs.readdirSync(imagesDir).filter((f) => /^readme-.*\.png$/.test(f));
  for (const f of files) {
    assert.ok(readme.includes(`package/docs/images/${f}`), `package/docs/images/${f} is not referenced by the README (remove it or use it)`);
    if (/-light\.png$/.test(f)) assert.ok(files.includes(f.replace(/-light\.png$/, '-dark.png')), `${f} has no -dark twin`);
    if (/-dark\.png$/.test(f)) assert.ok(files.includes(f.replace(/-dark\.png$/, '-light.png')), `${f} has no -light twin`);
  }
  // The graphics and screenshots the README is built on.
  for (const name of ['banner', 'why', 'path', 'how', 'pane', 'pane-bypass', 'dialog']) {
    assert.ok(files.includes(`readme-${name}-light.png`) && files.includes(`readme-${name}-dark.png`), `readme-${name} in light and dark`);
  }
  assert.ok(files.includes('readme-console-whatif.png'), 'the console screenshot');
});

test('README images: light and dark have the same size; the graphics are 2160 px wide (2x)', () => {
  for (const name of ['banner', 'why', 'path', 'how']) {
    const light = pngSize(path.join(imagesDir, `readme-${name}-light.png`));
    const dark = pngSize(path.join(imagesDir, `readme-${name}-dark.png`));
    assert.deepEqual(light, dark, `readme-${name}: same size in light and dark`);
    assert.equal(light.width, 2160, `readme-${name}: 2160 px wide`);
  }
  for (const name of ['pane', 'pane-bypass', 'dialog']) {
    const light = pngSize(path.join(imagesDir, `readme-${name}-light.png`));
    const dark = pngSize(path.join(imagesDir, `readme-${name}-dark.png`));
    assert.deepEqual(light, dark, `readme-${name}: same size in light and dark`);
    assert.ok(light.width >= 700 && light.height >= 400, `readme-${name}: 2x screenshot`);
  }
});

test('README images: the old hand-made banner and flow assets are gone', () => {
  assert.equal(fs.existsSync(path.join(root, 'package', 'assets', 'doc')), false, 'no assets/doc folder');
  assert.equal(fs.existsSync(path.join(imagesDir, 'readme-flow-light.png')), false);
  assert.doesNotMatch(readme, /readme-flow-/);
});

test('README: house structure (banner, navigation, guided path, details with screenshots)', () => {
  assert.match(readme, /^<p align="center">\n  <picture>/, 'the centered picture banner comes first');
  const nav = Array.from(readme.matchAll(/<a href="([^"]+)"><b>([^<]+)<\/b><\/a>/g)).map((m) => m[2]);
  assert.deepEqual(nav, ['Get started', 'How it works', 'Exceptional send', 'Reports', 'Requirements', 'User guide', 'Developer guide']);
  assert.match(readme, /^> \[!IMPORTANT\]\n> Files downloaded from the Internet/m);
  for (const heading of ['Why', 'Get started', 'How it works', 'Exceptional send', 'Reports', 'Requirements', 'Documentation', 'Disclaimer']) {
    assert.match(readme, new RegExp(`^## ${heading}$`, 'm'), `## ${heading}`);
  }
  for (const heading of ['Set up once · 1 to 4', 'A · Try it yourself (local) · 5 to 7', 'B · Deploy for everyone (centralized) · 5 to 7']) {
    assert.ok(readme.includes(`### ${heading}\n`), `### ${heading}`);
  }
  assert.ok((readme.match(/<details>\n<summary><b>/g) || []).length >= 3, 'details blocks with a bold summary');
  assert.ok(!/technical guide/i.test(readme), 'the technical guide is the developer guide');
});

test('README: the example uses neutral names only', () => {
  assert.match(readme, /C:\\Tools\\NoFridayMail/);
  assert.match(readme, /-Environment contoso/);
  assert.doesNotMatch(readme, /azurestaticapps\.net|prod\.json\b.*resourceGroup/);
});

test('the image tool renders from the guides and is not part of the download', () => {
  // The whole /tools folder of the repository root is outside package/, so outside every download.
  const attributes = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
  assert.match(attributes, /^\/tools export-ignore$/m);
  assert.ok(fs.existsSync(path.join(root, 'tools', 'New-DocumentationImages.js')));
  assert.equal(fs.existsSync(path.join(root, 'package', 'tools', 'New-DocumentationImages.js')), false, 'the image tool is not in the package');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.images, /New-DocumentationImages\.js/);
  const transcript = fs.readFileSync(path.join(root, 'tools', 'doc-assets', 'deploy-whatif.ansi'), 'utf8');
  assert.doesNotMatch(transcript, /[A-Z]:\\Users\\|\\Scripts\\|nfabert/i, 'the console transcript holds no private path or name');
  assert.match(transcript, /simulation \(-WhatIf\): nothing is written/);
});

test('the image tool always ends the browser process tree it starts and removes its profile', () => {
  const source = fs.readFileSync(path.join(root, 'tools', 'New-DocumentationImages.js'), 'utf8');
  assert.match(source, /taskkill/);
  assert.match(source, /'\/PID', String\(child\.pid\), '\/T', '\/F'/, 'taskkill by PID of the child it spawned, whole tree');
  assert.doesNotMatch(source, /\/IM\b|killall|Stop-Process\s+-Name|child\.kill\(\)/, 'never by name, never the launcher alone');
  assert.match(source, /process\.on\('exit', killAll\)/, 'children ended at exit');
  assert.match(source, /'SIGINT', 'SIGTERM'/, 'children ended on interruption');
  assert.match(source, /finally \{\s*killAll\(\);\s*killProfileOrphans\(\);/, 'children ended in finally');
  assert.match(source, /fs\.rmSync\(work, \{ recursive: true, force: true, maxRetries: 10/, 'temp profile folder removed (with retries)');
});
