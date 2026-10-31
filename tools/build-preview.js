'use strict';

/*
 * Task pane preview WITHOUT Outlook (development tool, npm run preview).
 * The manifest references none of this and `npm run build` / `build:prod` do not produce these
 * files (no test page published in production).
 *
 * Produces, from dist/taskpane.html and dist/taskpane.js (real) + tools/preview/fake-office.js:
 *   (first rebuilds the task pane in dist/ with BYPASS_ENABLED=true)
 *   dist/preview.html             the real task pane with a fake Office, configurable by query string:
 *                                 ?theme=dark&lang=en&state=chosen|scheduled|error|sending|nodelay|blocked
 *   dist/preview-fake-office.js   the fake Office (loaded by preview.html)
 *   dist/preview-gallery.html     gallery of iframes pointing to preview.html (dev server / hosting)
 *   previews/taskpane-preview.html  STANDALONE file (inline CSS and JS): light/dark x fr/en at 340 px,
 *                                 plus a few states and the 280 px column. Publishable as is.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkgRoot = path.join(root, 'package'); // the product: webpack.config.js, src, dist
const dist = path.join(pkgRoot, 'dist');
// The preview task pane is built with the exceptional send enabled (BYPASS_ENABLED, see tools/env-config.js)
// to show the section; this build is never deployed (dist/ is not an environment).
const webpackCli = require.resolve('webpack-cli/bin/cli.js', { paths: [pkgRoot] });
const built = spawnSync(process.execPath, [webpackCli, '--mode', 'production'], {
  cwd: pkgRoot,
  stdio: 'inherit',
  env: Object.assign({}, process.env, { NFM_ENV: '', BYPASS_ENABLED: 'true' })
});
if (built.status !== 0) {
  console.error('webpack failed.');
  process.exit(1);
}

const paneHtml = fs.readFileSync(path.join(dist, 'taskpane.html'), 'utf8');
const paneJs = fs.readFileSync(path.join(dist, 'taskpane.js'), 'utf8');
const fakeJs = fs.readFileSync(path.join(__dirname, 'preview', 'fake-office.js'), 'utf8');

const OFFICE_TAG = '<script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script>';
const PANE_TAG = '<script defer="defer" src="taskpane.js"></script>';
for (const [name, tag] of [['office.js', OFFICE_TAG], ['taskpane.js', PANE_TAG]]) {
  if (!paneHtml.includes(tag)) {
    console.error(`dist/taskpane.html: ${name} tag not found (did the webpack output format change?)`);
    process.exit(1);
  }
}

const noScriptEnd = (code) => code.replace(/<\/script/gi, '<\\/script');
const withoutOffice = paneHtml.replace(OFFICE_TAG, '<meta name="robots" content="noindex" />');

/** Task pane page with external scripts (dist/preview.html). */
function externalPane() {
  return withoutOffice.replace(PANE_TAG, '<script src="preview-fake-office.js"></script>' + PANE_TAG);
}

/** Fully standalone task pane page, configuration injected (for srcdoc). */
function inlinePane(config) {
  const scripts =
    '<script>window.__PREVIEW__=' + JSON.stringify(config) + ';' + noScriptEnd(fakeJs) + '</script>' +
    '<script>' + noScriptEnd(paneJs) + '</script>';
  return withoutOffice.replace(PANE_TAG, () => scripts);
}

const LANG_LABEL = { fr: 'French', en: 'English' };
const THEME_LABEL = { light: 'Light', dark: 'Dark' };
const STATE_LABEL = {
  default: 'Initial state',
  scheduled: 'After "Schedule send" (without 1.15)',
  chosen: 'Day and time chosen',
  blocked: 'Send already scheduled on a Friday',
  sending: 'Sending in progress (spinner)',
  error: 'Automatic send failed',
  nodelay: 'Outlook without Mailbox 1.13',
  bypass: 'Exceptional send: section open, valid input',
  bypasserror: 'Exceptional send: justification too short',
  bypasssaved: 'Exceptional send: justification already saved'
};

function cell(item, mode) {
  const query = `theme=${item.theme}&lang=${item.lang}&state=${item.state}`;
  const caption = `${THEME_LABEL[item.theme]} · ${LANG_LABEL[item.lang]} · ${item.width} px`;
  const detail = STATE_LABEL[item.state];
  let frame;
  if (mode === 'inline') {
    const doc = inlinePane({ theme: item.theme, lang: item.lang, state: item.state });
    const escaped = doc.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    frame = `<iframe title="${caption}" style="width:${item.width}px;height:${item.height || 640}px" srcdoc="${escaped}"></iframe>`;
  } else {
    frame = `<iframe title="${caption}" style="width:${item.width}px;height:${item.height || 560}px" src="preview.html?${query}"></iframe>`;
  }
  return `<figure><figcaption><strong>${caption}</strong><br>${detail}</figcaption>${frame}</figure>`;
}

const combos = (state) =>
  [
    { theme: 'light', lang: 'fr' }, { theme: 'light', lang: 'en' },
    { theme: 'dark', lang: 'fr' }, { theme: 'dark', lang: 'en' }
  ].map((c) => Object.assign({ width: 340, state }, c));

const ROWS = [
  { title: 'Light / dark × French / English, 340 px (initial state)', items: combos('default') },
  { title: 'Day and time chosen: the button summarizes the choice', items: combos('chosen') },
  {
    title: 'States',
    items: [
      { theme: 'light', lang: 'fr', state: 'scheduled', width: 340 },
      { theme: 'dark', lang: 'en', state: 'sending', width: 340 },
      { theme: 'light', lang: 'en', state: 'error', width: 340 },
      { theme: 'dark', lang: 'fr', state: 'blocked', width: 340 },
      { theme: 'light', lang: 'fr', state: 'nodelay', width: 340, height: 360 }
    ]
  },
  {
    title: 'Exceptional send (section collapsed under the scheduling, secondary button)',
    items: [
      { theme: 'light', lang: 'fr', state: 'bypass', width: 340, height: 900 },
      { theme: 'dark', lang: 'en', state: 'bypass', width: 340, height: 900 },
      { theme: 'light', lang: 'fr', state: 'bypasserror', width: 320, height: 900 },
      { theme: 'dark', lang: 'fr', state: 'bypasssaved', width: 320, height: 900 }
    ]
  },
  {
    title: 'Narrow column, 280 px',
    items: [
      { theme: 'dark', lang: 'en', state: 'default', width: 280 },
      { theme: 'light', lang: 'fr', state: 'chosen', width: 280 }
    ]
  }
];

function gallery(mode) {
  const rows = ROWS.map((row) =>
    `<section><h2>${row.title}</h2><div class="row">${row.items.map((i) => cell(i, mode)).join('')}</div></section>`
  ).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>NoFridayMail - task pane preview</title>
<style>
  :root { color-scheme: light dark; --page: #f3f2f1; --text: #242424; --muted: #616161; --line: #d1d1d1; }
  @media (prefers-color-scheme: dark) { :root { --page: #1b1b1b; --text: #ffffff; --muted: #adadad; --line: #424242; } }
  body { margin: 0; padding: 24px 16px 48px; background: var(--page); color: var(--text); font: 14px/20px "Segoe UI Variable", "Segoe UI", system-ui, sans-serif; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p.lead { margin: 0 0 24px; color: var(--muted); max-width: 70ch; }
  h2 { font-size: 16px; margin: 32px 0 12px; }
  .row { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
  figure { margin: 0; }
  figcaption { margin-bottom: 8px; font-size: 12px; line-height: 16px; color: var(--muted); }
  figcaption strong { color: var(--text); }
  iframe { display: block; border: 1px solid var(--line); border-radius: 4px; background: transparent; }
</style>
</head>
<body>
<h1>NoFridayMail — task pane preview ("Schedule send")</h1>
<p class="lead">The real task pane code (taskpane.js) runs here with a fake Office: simulated clock on Wednesday 28 October 2026 at 10:00, blocked days: Friday. The Smart Alerts dialog is not shown: it is drawn by Outlook and cannot be customized.</p>
${rows}
</body>
</html>
`;
}

fs.writeFileSync(path.join(dist, 'preview.html'), externalPane());
fs.writeFileSync(path.join(dist, 'preview-fake-office.js'), fakeJs);
fs.writeFileSync(path.join(dist, 'preview-gallery.html'), gallery('external'));
fs.mkdirSync(path.join(root, 'previews'), { recursive: true });
const standalone = path.join(root, 'previews', 'taskpane-preview.html');
fs.writeFileSync(standalone, gallery('inline'));

console.log('dist/preview.html, dist/preview-gallery.html, dist/preview-fake-office.js written');
console.log(`previews/taskpane-preview.html written (${fs.statSync(standalone).size} bytes, standalone)`);
