#!/usr/bin/env node
'use strict';

/*
 * Renders the images of the GitHub README (package/docs/images/readme-*.png) from the HTML guides.
 *
 * GitHub renders Markdown only: the custom blocks of the guides (cards, flow, path) and their theme are lost. This tool
 * renders them as images, with the CSS and the icons of tools/Build-Documentation.js, in a light and a dark version at 2x
 * resolution (2160 px wide), so that the README and the guides always look the same. The README picks the version with
 * <picture>. A port of the reference tool tools/New-DocumentationImages.ps1: same palette, same components, same method
 * (headless Microsoft Edge).
 *
 *   readme-banner          the hero of the guides, with the icon of the add-in and three key figures
 *   readme-why             what the add-in answers (cards)
 *   readme-path            the guided path of the user guide, chapter 1: set up once, then A or B
 *   readme-how             one send, from the Send button to the delivery, and the three outcomes
 *   readme-pane            the real task pane (package/dist/taskpane.js, fake Office of tools/preview), "Schedule send"
 *   readme-pane-bypass     the same pane with the "Exceptional send" section open
 *   readme-dialog          the Smart Alerts dialog, drawn with the real texts of the add-in (Outlook draws the real one)
 *   readme-console-whatif  Deploy-NoFridayMail.ps1 -WhatIf: the real output (tools/doc-assets/deploy-whatif.ansi) as a terminal
 *
 * The output is deterministic for a given machine (fixed clock in the preview, no date, no random value). Sample data is
 * neutral (contoso, C:\Tools\NoFridayMail); the saved console transcript holds no private name.
 *
 * Usage:  npm run images   (rebuilds the preview task pane first: node tools/build-preview.js)
 *         node tools/New-DocumentationImages.js [--only banner,why,path,how,pane,dialog,console] [--keep-work] [--out <folder>]
 * Browser: Microsoft Edge (or Chrome/Chromium); set NFM_BROWSER to its path when it is not found.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const gen = require('./Build-Documentation');
const config = require('../package/src/shared/config');
const rules = require('../package/src/shared/rules');

const root = path.join(__dirname, '..');
const pkgRoot = path.join(root, 'package'); // the product: sources, docs, build output
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const outDir = path.resolve(option('--out') || path.join(pkgRoot, 'docs', 'images'));
const only = option('--only') ? option('--only').split(',') : null;
const want = (name) => !only || only.includes(name);
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));

// ---- Browser -----------------------------------------------------------------------------------------
function findBrowser() {
  const candidates = [
    process.env.NFM_BROWSER,
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ].filter(Boolean);
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) {
    console.error('Microsoft Edge not found: it takes the screenshots (headless mode). Set NFM_BROWSER to the browser executable.');
    process.exit(1);
  }
  return found;
}
const BROWSER = findBrowser();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nfm-doc-'));
const profile = path.join(work, 'profile');
fs.mkdirSync(outDir, { recursive: true });

// A local web server hands the pages to the browser: Edge opens file:// pages in the already running browser session (and
// then draws nothing), and --dump-dom prints nothing from a GUI process. The pages report their height to the server.
const heights = new Map();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/__h') {
    heights.set(url.searchParams.get('n'), Number(url.searchParams.get('h')));
    res.end('ok');
    return;
  }
  const file = path.join(work, path.basename(url.pathname));
  if (!fs.existsSync(file)) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(file));
});
let base = '';

// Every browser process this tool starts is tracked and its whole process tree is ended when it is done, on a timeout, on
// an error, on Ctrl+C and at exit: headless Edge leaves helper processes (GPU, crashpad, utility) behind otherwise.
const active = new Set();

/** Ends a process and its children: taskkill /PID <pid> /T /F on Windows, the process group elsewhere. Never by name. */
function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch (err) {
    // Already gone.
  }
}

/** Helpers that outlived their launcher cannot be reached through it: end those whose command line holds our private profile folder. */
function killProfileOrphans() {
  for (let round = 0; round < 10; round++) {
    let pids = [];
    try {
      if (process.platform === 'win32') {
        const script = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:NFM_PROFILE) } | ForEach-Object { $_.ProcessId }';
        const found = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: Object.assign({}, process.env, { NFM_PROFILE: profile }) });
        pids = String(found.stdout || '').split(/\s+/).filter((p) => /^\d+$/.test(p) && Number(p) !== process.pid);
        for (const pid of pids) killTree({ pid: Number(pid) });
      } else {
        const found = spawnSync('pgrep', ['-f', '--', profile], { encoding: 'utf8' });
        pids = String(found.stdout || '').split(/\s+/).filter((p) => /^\d+$/.test(p) && Number(p) !== process.pid);
        for (const pid of pids) killTree({ pid: Number(pid) });
      }
    } catch (err) {
      return; // Best effort.
    }
    if (!pids.length) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); // give the processes time to disappear, then check again
  }
}

function killAll() {
  for (const child of active) killTree(child);
  active.clear();
}
process.on('exit', killAll);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    killAll();
    process.exit(130);
  });
}

function browser(extra) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      BROWSER,
      ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--run-all-compositor-stages-before-draw', ...extra],
      { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' }
    );
    active.add(child);
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Only a launcher still running is killed (its PID could be reused once it has exited); helpers left behind by one that
      // exited are ended by killProfileOrphans() at the end.
      if (child.exitCode === null && child.signalCode === null) killTree(child);
      active.delete(child);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Browser timeout')), 120000);
    child.on('exit', () => finish());
    child.on('error', (err) => finish(err));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(file) {
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) await sleep(100);
  if (!fs.existsSync(file)) throw new Error(`Screenshot not written: ${file}`);
  // The browser may still be writing the file.
  let size = -1;
  for (let i = 0; i < 50 && fs.statSync(file).size !== size; i++) {
    size = fs.statSync(file).size;
    await sleep(100);
  }
}

/** Height of the element .canvas: the page reports it to the server (/__h). */
async function measure(page, width) {
  heights.delete(page);
  const junk = path.join(work, page + '.measure.png');
  await browser([`--window-size=${width},2600`, '--virtual-time-budget=4000', `--screenshot=${junk}`, `${base}/${page}.html`]);
  await waitFor(junk);
  if (!heights.has(page)) throw new Error(`Height not measured: ${page}`);
  return heights.get(page);
}

async function screenshot(page, png, width, height) {
  if (fs.existsSync(png)) fs.rmSync(png);
  await browser([`--window-size=${width},${height}`, '--force-device-scale-factor=2', '--virtual-time-budget=4000', `--screenshot=${png}`, `${base}/${page}.html`]);
  await waitFor(png);
}

const MEASURE_SCRIPT = "var h=Math.ceil(document.querySelector('.canvas').getBoundingClientRect().height);document.body.setAttribute('data-h',h);new Image().src='/__h?n='+encodeURIComponent(PAGE)+'&h='+h;";

/** One page per theme -> height measured by the browser -> 2x screenshot. A single theme renders one image (no theme suffix). */
async function render(name, body, { width = 1080, themes = ['light', 'dark'], css = '' } = {}) {
  const pages = {};
  for (const theme of themes) {
    pages[theme] = `${name}-${theme}`;
    const html =
      `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><style>${gen.CSS}
${GRAPHICS_CSS}
${css}</style></head>` +
      `<body><div class="canvas" style="width:${width}px">${typeof body === 'function' ? body(theme) : body}</div>` +
      `<script>var PAGE=${JSON.stringify(pages[theme])};addEventListener('load',function(){setTimeout(function(){${MEASURE_SCRIPT}},300);});</script></body></html>`;
    fs.writeFileSync(path.join(work, pages[theme] + '.html'), html, 'utf8');
  }
  const height = await measure(pages[themes[0]], width);
  for (const theme of themes) {
    const file = themes.length > 1 ? `${name}-${theme}.png` : `${name}.png`;
    await screenshot(pages[theme], path.join(outDir, file), width, height);
  }
  console.log(`  ${name} (${themes.length > 1 ? 'light, dark' : 'single'}) ${width}x${height} @2x`);
}

// ---- Components of the guide, reused --------------------------------------------------------------------
const ic = (name, cls) => gen.icon(name, cls);
const inline = (t) => gen.inlineField(t);
const e = gen.esc;

function pill(text, tone) {
  return `<span class="rb-pill" style="--tone: var(--cp-${tone})">${e(text)}</span>`;
}

function cards(lines, cls) {
  const items = lines.map((l) => {
    const [i, title, ...rest] = l.split('|').map((x) => x.trim());
    return `<div class="card-item"><div class="card-icon">${ic(i)}</div><div><div class="card-title">${inline(title)}</div><div class="card-text">${inline(rest.join('|'))}</div></div></div>`;
  });
  return `<div class="cards ${cls || ''}">${items.join('')}</div>`;
}

/** Vertical flow: nodes stacked (icon on the left), a downward arrow with its label between them. */
function verticalFlow(lines) {
  const items = lines.map((l) => {
    const [i, title, ...rest] = l.split('|').map((x) => x.trim());
    const sub = rest.join('|').trim();
    if (i === 'arrow') {
      const note = sub ? `<span class="flow-sub">${e(sub)}</span>` : '';
      return `<div class="rb-varrow"><svg viewBox="0 0 12 30"><path d="M6 1v26M1 21l5 6 5-6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg><span class="flow-label">${e(title)}</span>${note}</div>`;
    }
    return `<div class="rb-vnode"><div class="flow-icon">${ic(i)}</div><div><div class="flow-title">${e(title)}</div><div class="flow-text">${e(sub)}</div></div></div>`;
  });
  return `<div class="flow rb-vflow">${items.join('')}</div>`;
}

const GRAPHICS_CSS = `
html, body { background: #ffffff; }
html[data-theme="dark"], html[data-theme="dark"] body { background: #0d1117; }
:root { --cp-info: #0078d4; --cp-violet: #7c3aed; --cp-teal: #0d9488; }
html[data-theme="dark"] { --cp-info: #4da6ff; --cp-violet: #a78bfa; --cp-teal: #2dd4bf; }
body { display: block; margin: 0; padding: 0; }
.canvas { padding: 6px; }
.rb-pill { display: inline-block; padding: 1px 10px; margin: 8px 6px 0 0; border-radius: 999px; font-size: 11.5px; font-weight: 600; line-height: 1.6;
  color: var(--tone); background: color-mix(in srgb, var(--tone) 11%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 38%, transparent); }
.rb-caption { font-size: 11.5px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--cp-accent); margin: 0 0 8px 4px; }
.rb-caption span { color: var(--cp-text-muted); font-weight: 600; letter-spacing: 0.04em; text-transform: none; font-size: 12.5px; }
/* Banner */
.rb-hero { margin: 0; padding: 32px 36px 30px; }
.rb-hero-grid { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 270px; gap: 34px; align-items: center; }
.rb-hero h1 { font-size: 35px; }
.rb-hero .lead { margin: 18px 0 0; font-size: 17px; max-width: none; }
.rb-hero .badges { margin: 20px 0 0; }
.rb-hero .hero-logo { background: none; width: 60px; height: 60px; border-radius: 16px; overflow: hidden; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18); }
.rb-hero .hero-logo svg { width: 60px; height: 60px; display: block; }
.rb-stats { position: relative; display: grid; gap: 10px; }
.rb-stat { display: flex; align-items: center; gap: 14px; padding: 12px 16px; border-radius: 14px; background: var(--cp-panel-strong); border: 1px solid var(--cp-border); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }
.rb-stat b { font-size: 28px; line-height: 1; color: var(--cp-accent); font-weight: 750; min-width: 76px; text-align: center; white-space: nowrap; }
.rb-stat span { font-size: 13px; color: var(--cp-text-muted); line-height: 1.35; }
.rb-stat strong { display: block; color: var(--cp-text); font-size: 14px; }
/* Cards and flows */
.cards { margin: 0; }
.rb-cards3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.rb-cards3 .card-item { flex-direction: column; gap: 12px; }
.rb-cards3 .card-title { font-size: 16.5px; }
.rb-cards3 .card-text { font-size: 14.5px; line-height: 1.55; }
/* How it works: vertical pipeline and the three outcomes */
.rb-hiw { display: grid; grid-template-columns: minmax(0, 1.02fr) minmax(0, 1fr); gap: 16px; align-items: stretch; }
.rb-col { display: flex; flex-direction: column; }
.rb-vflow { flex: 1; flex-direction: column; flex-wrap: nowrap; align-items: stretch; justify-content: center; gap: 0; margin: 0; padding: 16px 18px; }
.rb-vnode { display: flex; align-items: center; gap: 14px; padding: 11px 16px; border-radius: 12px; background: var(--cp-surface); border: 1px solid var(--cp-border); }
.rb-vnode .flow-icon { margin: 0; flex-shrink: 0; }
.rb-vnode .flow-text { margin-top: 1px; }
.rb-varrow { display: flex; align-items: center; gap: 10px; min-height: 34px; padding-left: 31px; }
.rb-varrow svg { width: 12px; height: 28px; color: var(--cp-accent); flex-shrink: 0; }
.rb-varrow .flow-sub { max-width: none; font-size: 12px; }
.rb-modes { flex: 1; display: flex; flex-direction: column; gap: 10px; }
.rb-modes .card-item { flex: 1; align-items: center; }
.rb-modes .card-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rb-chip { font-size: 11px; font-weight: 600; padding: 0 8px; border-radius: 999px; border: 1px solid var(--cp-border); color: var(--cp-text-muted); }
.rb-chip.hot { color: var(--cp-accent-fg); background: var(--cp-accent); border-color: var(--cp-accent); }
/* Product screenshots */
.rb-shot { padding: 30px 34px 40px; }
.rb-pane { display: block; margin: 0 auto; border: 1px solid var(--cp-border); border-radius: 10px; overflow: hidden; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16); }
.rb-pane iframe { display: block; border: 0; width: 100%; }
.rb-dialog { margin: 0 auto; width: 456px; max-width: 100%; border-radius: 10px; border: 1px solid var(--cp-border); background: var(--cp-surface); box-shadow: 0 16px 44px rgba(0, 0, 0, 0.22); overflow: hidden; }
.rb-dialog-bar { display: flex; align-items: center; gap: 10px; padding: 14px 20px 0; }
.rb-dialog-bar img, .rb-dialog-bar svg { width: 22px; height: 22px; border-radius: 5px; display: block; }
.rb-dialog-bar b { font-size: 15px; font-weight: 600; }
.rb-dialog-bar i { margin-left: auto; font-style: normal; color: var(--cp-text-muted); font-size: 18px; line-height: 1; }
.rb-dialog-body { padding: 14px 20px 6px; font-size: 14px; line-height: 1.5; }
.rb-dialog-body p { margin: 0 0 10px; }
.rb-dialog-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px 18px; }
.rb-btn { font: inherit; font-size: 13.5px; font-weight: 600; padding: 6px 16px; border-radius: 5px; border: 1px solid var(--cp-border-strong); background: var(--cp-surface); color: var(--cp-text); }
.rb-btn.primary { background: #0f6cbd; border-color: #0f6cbd; color: #ffffff; }
html[data-theme="dark"] .rb-btn.primary { background: #479ef5; border-color: #479ef5; color: #0b0b0b; }
`;

// ---- Data ----------------------------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(pkgRoot, rel), 'utf8').replace(/\r\n/g, '\n');

function guideBlock(file, kind, first) {
  const md = read(file);
  for (const m of md.matchAll(new RegExp('^```' + kind + '\\n([\\s\\S]*?)\\n```', 'gm'))) {
    if (!first || m[1].split('\n')[0].includes(first)) return m[1];
  }
  throw new Error(`${file}: block "${kind}" not found`);
}

/** Inline SVG of the add-in icon (assets/icon.svg), sized by CSS. */
function addinIcon() {
  return fs
    .readFileSync(path.join(root, 'assets', 'icon.svg'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<svg([^>]*)>/, (m, attrs) => '<svg' + attrs.replace(/\s(width|height)="\d+"/g, '') + ' aria-hidden="true">');
}

// ---- Graphics -------------------------------------------------------------------------------------------
async function banner() {
  const logo = addinIcon();
  const badges = [
    `<span class="badge badge-accent">Version ${e(pkg.version)}</span>`,
    `<span class="badge">${ic('mail', 'icon-sm')}Outlook web &middot; new &middot; classic</span>`,
    `<span class="badge">${ic('shield', 'icon-sm')}Signed scripts</span>`,
    `<span class="badge">${ic('tag', 'icon-sm')}MIT license</span>`
  ].join('');
  const stats = [
    ['Fri', 'blocked by default', 'any day you choose'],
    ['1 click', 'schedule and send', 'next working day'],
    ['MFA', 'exceptional send', 'optional, justified, traced']
  ]
    .map(([v, t, s]) => `<div class="rb-stat"><b>${e(v)}</b><span><strong>${e(t)}</strong>${e(s)}</span></div>`)
    .join('');
  const body =
    `<header class="hero rb-hero"><div class="rb-hero-grid"><div>` +
    `<div class="hero-top"><div class="hero-logo">${logo}</div><div><div class="eyebrow">Outlook add-in &middot; Smart Alerts</div><h1>NoFridayMail</h1></div></div>` +
    `<p class="lead">An Outlook add-in that <strong>stops mail and meeting invitations</strong> on the days you choose, <strong>Friday by default</strong>, and offers the <strong>next working day</strong> instead; an optional <strong>justified exceptional send</strong> is protected by <strong>multi-factor authentication</strong>.</p>` +
    `<div class="badges">${badges}</div></div><div class="rb-stats">${stats}</div></div></header>`;
  await render('readme-banner', body);
}

async function why() {
  const lines = [
    "mail | Mail and invitations on blocked days | The delivery day is checked at the moment you press **Send**. A blocked day stops the message with a clear explanation, instead of a report landing in every inbox on a Friday evening.",
    'calendar | Scheduled for the next working day | A small pane offers the **next working days and hours**. Two clicks, and the mail leaves by itself on the day you picked. Invitations are stopped and sent on the next allowed day.',
    'key | Exceptional send, traced | Optional and off by default: a **written justification** and **multi-factor authentication** give a signed receipt. Exchange authorizes it, and every one leaves a trace.'
  ];
  await render('readme-why', cards(lines, 'rb-cards3'));
}

async function guidedPath() {
  const block = guideBlock('docs/NoFridayMail-UserGuide.md', 'path', 'Set up once');
  await render('readme-path', gen.customBlock('path', block));
}

async function how() {
  const flow = [
    'mail | You press Send | a mail or a meeting invitation',
    'arrow | checks | the delivery day',
    'calendar | The add-in checks the day | the delayed delivery and the clock, never the content',
    'arrow | blocked day | Smart Alerts',
    'window | A dialog explains the rule | "Schedule send" opens the pane',
    'arrow | pick | the next working day and hour',
    'clock | The schedule pane | days, hours, two clicks',
    'arrow | scheduled | Outlook delayed delivery',
    'send | The mail leaves by itself | on the day and hour you chose'
  ];
  const outcomes = [
    { icon: 'check', name: 'Allowed day', chip: '<span class="rb-chip">nothing to do</span>', text: 'The mail or invitation leaves at once. The add-in only reads the delivery time, never the content or the recipients.', pills: pill('Allowed', 'success') },
    { icon: 'ban', name: 'Blocked day', chip: '<span class="rb-chip hot">Smart Alerts</span>', text: 'The send is stopped with an explanation. A mail is rescheduled in two clicks; an invitation is sent from the next allowed day.', pills: pill('Stopped', 'danger') + pill('Rescheduled', 'warning') + pill('Delivered', 'success') },
    { icon: 'lock', name: 'Exceptional send', chip: '<span class="rb-chip">option, off by default</span>', text: 'A written justification, then multi-factor authentication through Microsoft Entra ID. A signed receipt lets an Exchange transport rule authorize the message, and every one is traced.', pills: pill('Justification', 'info') + pill('MFA', 'violet') + pill('Signed receipt', 'success') + pill('Transport rule + DLP', 'teal') }
  ];
  const cardHtml = outcomes
    .map((o) => `<div class="card-item"><div class="card-icon">${ic(o.icon)}</div><div><div class="card-title">${o.name} ${o.chip}</div><div class="card-text">${o.text}</div><div>${o.pills}</div></div></div>`)
    .join('');
  const body =
    `<div class="rb-hiw"><div class="rb-col"><div class="rb-caption">One send <span>&middot; from the Send button to the delivery</span></div>${verticalFlow(flow.map((x) => x))}</div>` +
    `<div class="rb-col"><div class="rb-caption">Three outcomes <span>&middot; the day decides</span></div><div class="rb-modes">${cardHtml}</div></div></div>`;
  await render('readme-how', body);
}

// ---- Product screenshots --------------------------------------------------------------------------------
// The task pane: the real code, a fake Office, a fixed clock (Friday 30 October 2026, 16:30).
function paneSource() {
  const dist = path.join(pkgRoot, 'dist');
  const need = ['taskpane.html', 'taskpane.js'].map((f) => path.join(dist, f));
  if (need.some((f) => !fs.existsSync(f))) {
    console.error('dist/taskpane.html or dist/taskpane.js missing: run "npm run images" (it builds the preview first) or "npm run preview".');
    process.exit(1);
  }
  const OFFICE_TAG = '<script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script>';
  const PANE_TAG = '<script defer="defer" src="taskpane.js"></script>';
  const html = fs.readFileSync(need[0], 'utf8');
  if (!html.includes(OFFICE_TAG) || !html.includes(PANE_TAG)) throw new Error('dist/taskpane.html: script tags not found (did the webpack output change?)');
  const js = fs.readFileSync(need[1], 'utf8');
  const fake = fs.readFileSync(path.join(__dirname, 'preview', 'fake-office.js'), 'utf8');
  const noScriptEnd = (code) => code.replace(/<\/script/gi, '<\\/script');
  return (cfg) =>
    html
      .replace(OFFICE_TAG, '<meta name="robots" content="noindex" />')
      .replace(PANE_TAG, () => '<script>window.__PREVIEW__=' + JSON.stringify(cfg) + ';' + noScriptEnd(fake) + '</script><script>' + noScriptEnd(js) + '</script>');
}

async function paneShot(name, state, height) {
  const pane = paneSource();
  await render(
    name,
    (theme) => {
      const doc = pane({ theme, lang: 'en', state, now: '2026-10-30T16:30' });
      const srcdoc = doc.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return `<div class="rb-shot"><div class="rb-pane" style="width:340px"><iframe title="Task pane" style="height:${height}px" srcdoc="${srcdoc}"></iframe></div></div>`;
    },
    { width: 420 }
  );
}

// The Smart Alerts dialog: Outlook draws it. Texts are the real ones (config.js, English, errorMessageMarkdown).
function dialogText() {
  const cfg = config.forLang('en');
  const now = new Date(2026, 9, 30, 16, 30, 0, 0);
  const vars = {
    days: rules.blockedDaysLabel(cfg),
    suggestions: rules.suggestionsLabel(rules.nextAllowedSuggestions(now, cfg), cfg),
    time: rules.sendTimeLabel(cfg)
  };
  return { markdown: rules.fill(cfg.strings.messageBlockedMd, vars), cancel: cfg.strings.cancelLabel };
}

async function dialog() {
  const { markdown, cancel } = dialogText();
  const logo = addinIcon();
  const paragraphs = markdown
    .split('\n\n')
    .map((p) => `<p>${e(p).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`)
    .join('');
  const body =
    `<div class="rb-shot"><div class="rb-dialog"><div class="rb-dialog-bar">${logo}<b>NoFridayMail</b><i>&times;</i></div>` +
    `<div class="rb-dialog-body">${paragraphs}</div>` +
    `<div class="rb-dialog-foot"><span class="rb-btn primary">${e(cancel)}</span><span class="rb-btn">Don't send</span></div></div></div>`;
  await render('readme-dialog', body, { width: 540 });
}

// ---- Console ---------------------------------------------------------------------------------------------
const ANSI_BASIC = ['#0c0c0c', '#c50f1f', '#13a10e', '#c19c00', '#0037da', '#881798', '#3a96dd', '#cccccc', '#767676', '#e74856', '#16c60c', '#f9f1a5', '#3b78ff', '#b4009e', '#61d6d6', '#f2f2f2'];

function ansiToHtml(text) {
  const out = [];
  let st = { bold: false, fg: null, bg: null };
  const open = () => {
    const css = [];
    if (st.bold) css.push('font-weight:700');
    if (st.fg) css.push(`color:${st.fg}`);
    if (st.bg) css.push(`background:${st.bg}`);
    return css.length ? `<span style="${css.join(';')}">` : '';
  };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    let html = '';
    let last = 0;
    let span = open();
    const re = /\x1b\[([0-9;]*)m/g;
    let m;
    const flush = (chunk) => {
      if (!chunk) return;
      html += span ? `${span}${e(chunk)}</span>` : e(chunk);
    };
    while ((m = re.exec(line))) {
      flush(line.slice(last, m.index));
      last = re.lastIndex;
      const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0) st = { bold: false, fg: null, bg: null };
        else if (c === 1) st.bold = true;
        else if (c === 22) st.bold = false;
        else if (c === 39) st.fg = null;
        else if (c === 49) st.bg = null;
        else if (c >= 30 && c <= 37) st.fg = ANSI_BASIC[c - 30];
        else if (c >= 90 && c <= 97) st.fg = ANSI_BASIC[c - 90 + 8];
        else if (c >= 40 && c <= 47) st.bg = ANSI_BASIC[c - 40];
        else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
          const rgb = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
          if (c === 38) st.fg = rgb;
          else st.bg = rgb;
          i += 4;
        }
      }
      span = open();
    }
    flush(line.slice(last));
    out.push(html);
  }
  return out.join('\n');
}

async function consoleShot() {
  // The image stops before the "Next steps" box: the guides give those steps in full.
  const full = fs.readFileSync(path.join(__dirname, 'doc-assets', 'deploy-whatif.ansi'), 'utf8');
  const lines = full.split('\n');
  const cut = lines.findIndex((l) => l.includes('Next steps'));
  const transcript = lines.slice(0, cut).join('\n').trimEnd();
  const prompt = String.raw`C:\Tools\NoFridayMail`;
  const css = `
html, body { background: #ffffff; }
.term { border-radius: 10px; overflow: hidden; background: #0c0c0c; color: #cccccc; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22); border: 1px solid #2b2b2b; }
.term-bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: #1f1f1f; color: #d8d8d8; font: 13px "Segoe UI", sans-serif; }
.dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
.term-bar .t { margin-left: 8px; }
.term pre { margin: 0; padding: 16px 20px 18px; font: 13.5px/1.45 "Cascadia Mono", Consolas, "Courier New", monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.ps { color: #61d6d6; }
`;
  const body =
    `<div class="term"><div class="term-bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="t">PowerShell 7 &mdash; ${e(prompt)}</span></div>` +
    `<pre><span class="ps">PS ${e(prompt)}&gt;</span> .\\tools\\Deploy-NoFridayMail.ps1 -Environment contoso -WhatIf\n\n${ansiToHtml(transcript)}</pre></div>`;
  await render('readme-console-whatif', body, { width: 1040, themes: ['light'], css });
}

// ---- Main ------------------------------------------------------------------------------------------------
async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`Rendering the README images in ${path.relative(root, outDir) || '.'} (2x)...`);
  try {
    if (want('banner')) await banner();
    if (want('why')) await why();
    if (want('path')) await guidedPath();
    if (want('how')) await how();
    if (want('pane')) {
      await paneShot('readme-pane', 'chosen', 680);
      await paneShot('readme-pane-bypass', 'bypass', 860);
    }
    if (want('dialog')) await dialog();
    if (want('console')) await consoleShot();
  } finally {
    killAll();
    killProfileOrphans();
    server.close();
    if (flag('--keep-work')) console.log(`Work folder: ${work}`);
    else {
      try {
        fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch (err) {
        // Browser helper processes can hold the profile folder for a moment: the temp folder is cleaned by the system.
      }
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
