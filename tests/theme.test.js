'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const theme = require('../src/taskpane/theme');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'taskpane', 'taskpane.html'), 'utf8');

function palette(selectorStart) {
  const start = html.indexOf(selectorStart);
  assert.ok(start >= 0, selectorStart);
  const block = html.slice(start, html.indexOf('}', start));
  const vars = {};
  for (const m of block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    vars[m[1]] = m[2];
  }
  return vars;
}

const light = palette(':root {');
const dark = palette(':root[data-theme="dark"] {');
const darkMedia = palette(':root:not([data-theme="light"]) {');

test('light, dark and prefers-color-scheme palettes have the same tokens', () => {
  const keys = Object.keys(light).filter((k) => k !== '--shadow').sort();
  assert.deepEqual(Object.keys(dark).sort(), keys);
  assert.deepEqual(darkMedia, dark, 'forced dark and automatic dark are identical');
  assert.ok(keys.length >= 24);
});

test('AA contrast (>= 4.5:1) of text/background pairs, light and dark themes', () => {
  const pairs = [
    ['--fg', '--bg'], ['--fg2', '--bg'], ['--fg', '--surface'], ['--fg2', '--surface'], ['--fg', '--hover'],
    ['--fg2', '--hover'], ['--fg', '--selected'], ['--fg2', '--selected'], ['--brand-fg', '--bg'],
    ['--brand-fg', '--surface'], ['--brand-fg', '--selected'], ['--on-brand', '--brand'],
    ['--on-brand', '--brand-hover'], ['--on-brand', '--brand-pressed'], ['--error-fg', '--error-bg'],
    ['--error-fg', '--bg'], ['--error-fg', '--surface'], ['--success-fg', '--success-bg'],
    ['--fg', '--info-bg'], ['--fg', '--error-bg'], ['--fg', '--success-bg'],
    // gradient header, day cards, chips, badge
    ['--fg', '--hdr1'], ['--fg2', '--hdr1'], ['--fg', '--hdr2'], ['--fg2', '--hdr2'],
    ['--fg2', '--selected'], ['--brand-fg', '--surface'], ['--fg', '--hover']
  ];
  for (const [name, p] of [['light', light], ['dark', dark]]) {
    for (const [fg, bg] of pairs) {
      const ratio = theme.contrast(p[fg], p[bg]);
      assert.ok(ratio >= 4.5, `${name} ${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
    }
  }
});

test('non-text contrast: radio circle and field border >= 3:1', () => {
  for (const [name, p] of [['light', light], ['dark', dark]]) {
    for (const [fg, bg] of [['--border-strong', '--bg'], ['--border-strong', '--surface'], ['--brand-fg', '--selected']]) {
      const ratio = theme.contrast(p[fg], p[bg]);
      assert.ok(ratio >= 3, `${name} ${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
    }
  }
});

test('color math: parse, luminance, contrast, mix', () => {
  assert.deepEqual(theme.parseColor('#fff'), [255, 255, 255]);
  assert.deepEqual(theme.parseColor(' #0F6CBD '), [15, 108, 189]);
  assert.equal(theme.parseColor('rgb(0,0,0)'), null);
  assert.equal(theme.parseColor(undefined), null);
  assert.equal(Math.round(theme.contrast('#000000', '#ffffff')), 21);
  assert.equal(theme.contrast('#777777', '#777777'), 1);
  assert.equal(theme.mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(theme.isDark('#1f1f1f'), true);
  assert.equal(theme.isDark('#ffffff'), false);
});

test('deriveTheme: dark, light, missing, invalid, insufficient contrast', () => {
  const dark1 = theme.deriveTheme({ bodyBackgroundColor: '#1f1f1f', bodyForegroundColor: '#ffffff', controlBackgroundColor: '#2b2b2b' });
  assert.equal(dark1.dark, true);
  assert.equal(dark1.vars['--bg'], '#1f1f1f');
  assert.equal(dark1.vars['--surface'], '#2b2b2b');
  const light1 = theme.deriveTheme({ bodyBackgroundColor: '#ffffff', bodyForegroundColor: '#242424' });
  assert.equal(light1.dark, false);
  assert.equal(light1.vars['--surface'], theme.mix('#ffffff', '#242424', 0.04), 'surface computed without controlBackgroundColor');
  assert.equal(theme.deriveTheme(undefined), null);
  assert.equal(theme.deriveTheme({}), null);
  assert.equal(theme.deriveTheme({ bodyBackgroundColor: 'red', bodyForegroundColor: 'blue' }), null);
  assert.equal(theme.deriveTheme({ bodyBackgroundColor: '#777777', bodyForegroundColor: '#808080' }), null);
});

test('common Outlook themes: light, dark gray, black, brand blue', () => {
  const themes = [
    { bodyBackgroundColor: '#ffffff', bodyForegroundColor: '#242424', controlBackgroundColor: '#ffffff' },
    { bodyBackgroundColor: '#242424', bodyForegroundColor: '#ffffff', controlBackgroundColor: '#292929' },
    { bodyBackgroundColor: '#000000', bodyForegroundColor: '#ffffff', controlBackgroundColor: '#141414' },
    { bodyBackgroundColor: '#faf9f8', bodyForegroundColor: '#323130', controlBackgroundColor: '#ffffff' }
  ];
  for (const t of themes) {
    const derived = theme.deriveTheme(t);
    assert.ok(derived, JSON.stringify(t));
    assert.ok(theme.contrast(derived.vars['--fg2'], derived.vars['--bg']) >= 4.5);
    assert.ok(theme.contrast(derived.vars['--fg'], derived.vars['--hover']) >= 4.5);
  }
});

test('page structure: accessibility and narrow layout', () => {
  assert.equal((html.match(/role="radiogroup"/g) || []).length, 3, 'suggestions, days and hours');
  assert.equal((html.match(/role="radio"/g) || []).length, 2 + 10 + 8, 'suggestions + days + hour chips');
  assert.doesNotMatch(html, /datetime-local|type="date"|<input/i, 'no native picker');
  assert.match(html, /\.footer \{[^}]*position: sticky;[^}]*bottom: 0/, 'sticky action footer');
  assert.match(html, /scroll-snap-type: x/, 'day row with scroll snapping');
  assert.match(html, /\.days \{[^}]*overflow-x: auto/, 'horizontal scrolling contained in the row');
  assert.match(html, /id="summary"[^>]*aria-live="polite"/);
  assert.match(html, /linear-gradient\(135deg, var\(--hdr1\), var\(--hdr2\)\)/, 'gradient header');
  assert.match(html, /border-radius: 8px/);
  assert.match(html, /id="status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /overflow-x: hidden/);
  assert.doesNotMatch(html, /\b(?:min-)?width:\s*(?:[3-9]\d\d|\d{4,})px/, 'no fixed width >= 300 px');
});

test('exceptional send: collapsed, accessible section, secondary button, no fixed width', () => {
  const section = html.slice(html.indexOf('id="bypass-section"'), html.indexOf('</main>'));
  assert.match(section, /id="bypass-section"[^>]*\shidden/, 'hidden until taskpane.js enables it');
  assert.match(section, /id="bypass-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="bypass-panel"/);
  assert.match(section, /id="bypass-panel"[^>]*\shidden/, 'collapsed initially');
  assert.match(section, /<label[^>]*for="bypass-text"/, 'label associated with the field');
  assert.match(section, /<textarea id="bypass-text"[^>]*aria-describedby="bypass-counter bypass-error"[^>]*aria-required="true"/);
  assert.match(section, /id="bypass-error"[^>]*aria-live="polite"/);
  assert.match(section, /<button type="button" id="bypass-send" class="btn" disabled>/, 'secondary (no primary class), disabled while the input is invalid');
  assert.doesNotMatch(section, /primary/);
  assert.match(html, /\.bypass-panel \{/);
  assert.match(html, /\.disclosure:focus-visible/);
  assert.match(html, /#bypass-text \{[^}]*width: 100%[^}]*min-width: 0/, 'fits in 320 px');
  assert.match(html, /\.counter\.err, \.field-error \{ color: var\(--error-fg\)/, 'error: existing AA token');
  // No new color token: the pairs already checked by the contrast tests are enough.
  const css = html.slice(html.indexOf('.bypass {'), html.indexOf('@keyframes spin'));
  const tokens = new Set((css.match(/var\(--[a-z0-9-]+\)/g) || []).map((v) => v.slice(4, -1)));
  const defined = new Set((html.match(/--[a-z0-9-]+(?=:)/g) || []));
  for (const token of tokens) assert.ok(defined.has(token), `${token} defined in the palettes`);
});

test('preview tools: never referenced by the manifest nor produced by build/build:prod', () => {
  const root = path.join(__dirname, '..');
  const manifest = fs.readFileSync(path.join(root, 'manifest.xml'), 'utf8');
  assert.doesNotMatch(manifest, /preview|fake-office/i);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const name of ['build', 'build:prod', 'build:dev']) {
    assert.doesNotMatch(pkg.scripts[name], /preview/, name);
  }
  assert.match(pkg.scripts.preview, /build-preview\.js/);
  const webpackConfig = fs.readFileSync(path.join(root, 'webpack.config.js'), 'utf8');
  assert.doesNotMatch(webpackConfig, /preview|fake-office/i);
});

test('preview fake Office: valid syntax and minimal contract', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'tools', 'preview', 'fake-office.js'), 'utf8');
  assert.doesNotThrow(() => new Function(code));
  for (const needle of ['displayLanguage', 'officeTheme', 'delayDeliveryTime', 'sendAsync', 'isSetSupported', 'onReady', 'internetHeaders', 'bypass-toggle']) {
    assert.ok(code.includes(needle), needle);
  }
});

test('MFA step: the form is grouped and an "unsupported" message exists, no fixed width', () => {
  const section = html.slice(html.indexOf('id="bypass-section"'), html.indexOf('</main>'));
  assert.match(section, /id="bypass-unsupported"[^>]*role="alert"[^>]*\shidden/);
  assert.match(section, /<div class="bypass-form" id="bypass-form">/);
  const form = section.slice(section.indexOf('id="bypass-form"'));
  for (const id of ['bypass-saved', 'bypass-label', 'bypass-text', 'bypass-counter', 'bypass-error', 'bypass-send']) {
    assert.ok(form.includes(`id="${id}"`), `${id} in the form`);
  }
  assert.equal(section.slice(0, section.indexOf('id="bypass-form"')).includes('id="bypass-send"'), false, 'the button is hidden with the form');
  assert.match(html, /\.bypass-panel, \.bypass-form \{ display: flex; flex-direction: column/);
});
