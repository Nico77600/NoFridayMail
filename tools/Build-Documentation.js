#!/usr/bin/env node
'use strict';

/*
 * Builds the HTML guides (package/docs/NoFridayMail-UserGuide.html, package/docs/NoFridayMail-Guide.html) from their Markdown source.
 *
 * The Markdown guides stay readable as plain text (and on GitHub). This script turns each one into a structured,
 * self-contained HTML page (a port of the reference generator tools/Build-Documentation.ps1, with its own small
 * Markdown converter so that no npm dependency is needed):
 *
 *   - hero header (title, version, author, date) built from the front matter,
 *   - sticky sidebar with the parts and chapters, highlighting the chapter being read,
 *   - each chapter ("## ...") in its own card, with an icon and a number badge,
 *   - callouts from GitHub alerts (> [!NOTE], [!TIP], [!IMPORTANT], [!WARNING], [!CAUTION]),
 *   - "### 1 · Title" headings shown with the number badge of the guided path,
 *   - custom blocks written as fenced code in the Markdown:
 *       ```cards   icon | title | text          (grid of small cards)
 *       ```steps   title | text                 (numbered timeline)
 *       ```flow    icon | title | subtitle      (diagram; "arrow | label | text" = connector)
 *       ```path    the guided path: a trunk of numbered steps, then branches
 *                  group | icon | title           (header of a group: the first group is the trunk)
 *                  group | n | title | text       (a numbered step of that group)
 *   - code blocks with a language label and a Copy button,
 *   - images embedded (the HTML file can be sent alone) with a zoom on click,
 *   - light / dark theme (?theme=dark|light forces it), print layout.
 *
 * No external resource is used (fonts, scripts, images are inline). Section icons: put <!-- icon: name --> on the
 * line before a "## " heading; the names are the keys of ICONS below. A link to the other guide is written with its
 * GitHub anchor (NoFridayMail-Guide.md#9-exceptional-send): in the HTML page it points to the HTML file and to the id
 * of the same heading (the ids of the page drop the chapter number).
 *
 * The output is deterministic (no build date: the footer shows the "updated" date of the front matter).
 *
 * Usage:  node tools/Build-Documentation.js            write both HTML guides   (npm run docs)
 *         node tools/Build-Documentation.js --check    fail if an HTML file is out of date   (npm run docs:check)
 */
const fs = require('fs');
const path = require('path');

const docsDir = path.join(__dirname, '..', 'package', 'docs');
const GUIDES = ['NoFridayMail-UserGuide', 'NoFridayMail-Guide'];

// ---- Icons (24x24, stroke) ---------------------------------------------------------------------------
const ICONS = {
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/><path d="M8 7h7M8 11h5"/>',
  flow: '<rect x="3" y="4" width="7" height="5" rx="1.5"/><rect x="14" y="15" width="7" height="5" rx="1.5"/><path d="M6.5 9v4a2 2 0 0 0 2 2H14"/>',
  lightbulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
  checklist: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="m3.5 6 1.5 1.5L8 4.5M3.5 12l1.5 1.5L8 10.5M3.5 18l1.5 1.5L8 16.5"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  chart: '<path d="M3 20h18"/><path d="M6 16v-5M11 16V6M16 16v-8"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  wrench: '<path d="M15 4a5 5 0 0 0-4.6 6.9L3 18.3 5.7 21l7.4-7.4A5 5 0 0 0 20 9l-3 1-3-3 1-3z"/>',
  beaker: '<path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/><path d="M7 15h10"/>',
  lifebuoy: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="m5.6 5.6 3.6 3.6M14.8 14.8l3.6 3.6M18.4 5.6l-3.6 3.6M9.2 14.8l-3.6 3.6"/>',
  compare: '<rect x="3" y="4" width="7" height="16" rx="1.5"/><rect x="14" y="4" width="7" height="16" rx="1.5"/><path d="M6.5 9h0M17.5 9h0"/>',
  database: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8" r="1.5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  file: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.5a5 5 0 0 1 5.5 5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  server: '<rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  send: '<path d="M21 3 3 10.5l7 3 3 7z"/><path d="m10 13.5 5-5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/><path d="M12 15.5v2"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01"/>'
};

// GitHub alert icons (16x16, stroke).
const ALERT_ICONS = {
  note: '<circle cx="8" cy="8" r="6.25"/><path d="M8 7.25v4M8 4.75v.01"/>',
  tip: '<path d="M6 12.5h4M6.5 14.5h3"/><path d="M8 1.5a4.5 4.5 0 0 0-2.7 8.1c.5.4.7.9.7 1.4h4c0-.5.2-1 .7-1.4A4.5 4.5 0 0 0 8 1.5z"/>',
  important: '<path d="M2 2.5h12v8H8.5L5 13.5v-3H2z"/><path d="M8 4.75v2.5M8 8.6v.01"/>',
  warning: '<path d="M8 1.75 14.75 13.5H1.25z"/><path d="M8 6.25v3.5M8 11.6v.01"/>',
  caution: '<path d="M5.2 1.75h5.6l3.45 3.45v5.6l-3.45 3.45H5.2L1.75 10.8V5.2z"/><path d="M8 4.75v3.5M8 10.1v.01"/>'
};
const ALERT_TITLES = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };

const LANGUAGES = { powershell: 'PowerShell', sql: 'SQL', text: 'Text', json: 'JSON', jsonc: 'JSON', csv: 'CSV', kusto: 'Kusto', xml: 'XML', '': 'Code' };

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/**
 * Text content of an HTML fragment produced by inline(): every "<" up to the next ">" belongs to a tag (inline() escapes
 * literal angle brackets), so a single scan removes the markup. No replacement pass: a replacement can leave a new tag
 * behind (`<scr<b>ipt>`), a scan cannot.
 */
function textOf(html) {
  let out = '';
  let inTag = false;
  for (const ch of String(html)) {
    if (ch === '<') inTag = true;
    else if (ch === '>' && inTag) inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

const decode = (t) => String(t).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function icon(name, cls) {
  const body = ICONS[name] || ICONS.info;
  return `<svg class="${cls || 'icon'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

// ---- Identifiers -------------------------------------------------------------------------------------
/** GitHub anchor of a heading (what the Markdown links use): "9. Exceptional send" -> "9-exceptional-send". */
function githubSlug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}
/** Identifier of a heading in the HTML page: leading non-letters dropped, runs of other characters become "-". */
function pageSlug(text) {
  let s = String(text).toLowerCase().replace(/^[^\p{L}]+/u, '');
  s = s.replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return s || 'section';
}
/** Link in the Markdown (GitHub anchor) -> id in the page: the chapter number goes, "--" becomes "-". */
function anchorToId(anchor) {
  return anchor.replace(/^\d+-/, '').replace(/-{2,}/g, '-');
}

// ---- Inline Markdown ---------------------------------------------------------------------------------
const INLINE_TAGS = /<(\/?)(kbd|br|sub|sup|b|i|em|strong|u|mark)(\s[^>]*)?\/?>/gi;

function inline(source) {
  const stash = [];
  const hold = (html) => {
    stash.push(html);
    return `\u0001${stash.length - 1}\u0002`;
  };
  let t = String(source);
  // code spans
  t = t.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (m, ticks, body) => {
    let code = body.replace(/\n/g, ' ');
    if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
    return hold(`<code>${esc(code)}</code>`);
  });
  // backslash escapes
  t = t.replace(/\\([!-/:-@[-`{-~])/g, (m, ch) => hold(esc(ch)));
  // images, links
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (m, alt, src) => hold(`<img src="${esc(src)}" alt="${esc(alt)}" />`));
  const linkRe = /\[((?:[^\[\]]|\[[^\]]*\])+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  t = t.replace(linkRe, (m, label, href) => hold(`<a href="${esc(href)}">${inline(label)}</a>`));
  // autolinks
  t = t.replace(/<(https?:\/\/[^>\s]+)>/g, (m, url) => hold(`<a href="${esc(url)}">${esc(url)}</a>`));
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<>)\]"]+[^\s<>)\]".,;:!?])/g, (m, pre, url) => pre + hold(`<a href="${esc(url)}">${esc(url)}</a>`));
  // allowed inline HTML, then escape the rest
  t = t.replace(INLINE_TAGS, (m) => hold(m));
  t = t.replace(/&(?!#?\w+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // emphasis
  t = t.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(?<![\w_])__(?=\S)([\s\S]*?\S)__(?![\w_])/g, '<strong>$1</strong>');
  t = t.replace(/(?<![*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\w])/g, '<em>$1</em>');
  t = t.replace(/(?<![\w_])_(?=[^\s_])([^_]*?[^\s_])_(?![\w_])/g, '<em>$1</em>');
  t = t.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  // hard line breaks
  t = t.replace(/ {2,}\n/g, '<br />\n').replace(/\\\n/g, '<br />\n');
  // resolve the stash (placeholders may nest)
  for (let guard = 0; guard < 8 && /\u0001\d+\u0002/.test(t); guard++) {
    t = t.replace(/\u0001(\d+)\u0002/g, (m, n) => stash[Number(n)]);
  }
  return t;
}

/** Inline Markdown for a custom block field (no paragraph wrapper). */
const inlineField = (text) => inline(String(text).trim());

// ---- Block Markdown ----------------------------------------------------------------------------------
const RE = {
  fence: /^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/,
  heading: /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/,
  hr: /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/,
  quote: /^ {0,3}>\s?/,
  bullet: /^( {0,3})([-*+])\s+(.*)$/,
  ordered: /^( {0,3})(\d{1,9})([.)])\s+(.*)$/,
  tableDelimiter: /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/,
  // One complete HTML comment alone on its line (the body never contains "-->", so a second comment or markup cannot follow).
  comment: /^\s*<!--(?:(?!-->)[\s\S])*-->\s*$/,
  commentOpen: /^\s*<!--/,
  htmlBlock: /^\s*<\/?(p|div|picture|source|img|details|summary|table|center|a)(\s|>|\/)/i
};

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  const cells = [];
  let cell = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '`') {
      inCode = !inCode;
      cell += ch;
    } else if (ch === '\\' && s[i + 1] === '|') {
      cell += inCode ? '|' : '\\|';
      i++;
    } else if (ch === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell.trim() !== '' || !s.trimEnd().endsWith('|')) cells.push(cell.trim());
  return cells;
}

/**
 * Index of the line that closes the HTML comment opened on line `start` (possibly the same line), or -1 when the comment
 * is unterminated or has content after its closing "-->".
 */
function commentEnd(lines, start) {
  for (let j = start; j < lines.length; j++) {
    const text = j === start ? lines[j].replace(RE.commentOpen, '') : lines[j];
    const close = text.indexOf('-->');
    if (close >= 0) return text.slice(close + 3).trim() === '' ? j : -1;
  }
  return -1;
}

function startsBlock(line, next) {
  return (
    RE.fence.test(line) || RE.heading.test(line) || RE.hr.test(line) || RE.quote.test(line) || RE.comment.test(line) ||
    RE.bullet.test(line) || /^ {0,3}1[.)]\s+/.test(line) ||
    (line.includes('|') && next !== undefined && RE.tableDelimiter.test(next) && next.includes('-') && next.includes('|'))
  );
}

function customBlock(kind, body) {
  const lines = body.split('\n').filter((l) => l.trim());
  if (kind === 'cards') {
    const items = lines.map((l) => {
      const [ic, title, ...rest] = l.split('|').map((x) => x.trim());
      const text = rest.join('|').trim();
      return `<div class="card-item"><div class="card-icon">${icon(ic)}</div><div><div class="card-title">${inlineField(title)}</div><div class="card-text">${inlineField(text)}</div></div></div>`;
    });
    return `<div class="cards">${items.join('')}</div>`;
  }
  if (kind === 'steps') {
    let n = 0;
    const items = lines.map((l) => {
      n++;
      const idx = l.indexOf('|');
      const title = l.slice(0, idx).trim();
      const text = l.slice(idx + 1).trim();
      return `<li><span class="step-num">${n}</span><div class="step-body"><div class="step-title">${inlineField(title)}</div><div class="step-text">${inlineField(text)}</div></div></li>`;
    });
    return `<ol class="steps">${items.join('')}</ol>`;
  }
  if (kind === 'flow') {
    const items = lines.map((l) => {
      const [ic, title, ...rest] = l.split('|').map((x) => x.trim());
      const sub = rest.join('|').trim();
      if (ic === 'arrow') {
        return `<div class="flow-arrow"><span class="flow-label">${esc(title)}</span><svg viewBox="0 0 40 12" aria-hidden="true"><path d="M0 6h36M31 1l6 5-6 5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg><span class="flow-sub">${esc(sub)}</span></div>`;
      }
      return `<div class="flow-node"><div class="flow-icon">${icon(ic)}</div><div class="flow-title">${esc(title)}</div><div class="flow-text">${esc(sub)}</div></div>`;
    });
    return `<div class="flow">${items.join('')}</div>`;
  }
  // path: groups in their order of appearance; the first is the trunk (horizontal), the others the branches.
  const groups = new Map();
  for (const l of lines) {
    const parts = l.split('|').map((x) => x.trim());
    const g = parts[0];
    if (!groups.has(g)) groups.set(g, { icon: 'flow', title: g, steps: [] });
    const grp = groups.get(g);
    if (parts.length >= 4 && /^\d+$/.test(parts[1])) grp.steps.push({ n: parts[1], title: parts[2], text: parts.slice(3).join('|') });
    else {
      grp.icon = parts[1];
      grp.title = parts.slice(2).join('|');
    }
  }
  const keys = Array.from(groups.keys());
  const trunk = groups.get(keys[0]);
  const arrow = '<div class="path-arrow"><svg viewBox="0 0 12 40" aria-hidden="true"><path d="M2 6l6 14-6 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>';
  const node = (s) => `<div class="path-node"><span class="path-num">${s.n}</span><div><div class="path-title">${inlineField(s.title)}</div><div class="path-sub">${inlineField(s.text)}</div></div></div>`;
  let out = `<!--path--><div class="path"><div class="path-caption">${icon(trunk.icon, 'icon-sm')}<span>${inlineField(trunk.title)}</span></div><div class="path-row">${trunk.steps.map(node).join(arrow)}</div>`;
  if (keys.length > 1) {
    const down = '<div><svg viewBox="0 0 14 26" aria-hidden="true"><path d="M7 1v22M2 18l5 6 5-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>';
    out += `<div class="path-fork">${down.repeat(keys.length - 1)}</div><div class="path-branches">`;
    for (const k of keys.slice(1)) {
      const grp = groups.get(k);
      const steps = grp.steps
        .map((s) => `<li><span class="path-num">${s.n}</span><div><div class="path-title">${inlineField(s.title)}</div><div class="path-sub">${inlineField(s.text)}</div></div></li>`)
        .join('');
      out += `<div class="path-branch"><div class="path-head"><span class="path-letter">${esc(k)}</span><span class="path-icon">${icon(grp.icon, 'icon-sm')}</span><span>${inlineField(grp.title)}</span></div><ol class="path-steps">${steps}</ol></div>`;
    }
    out += '</div>';
  }
  return `${out}</div><!--/path-->`;
}

function codeBlock(lang, body) {
  const label = Object.prototype.hasOwnProperty.call(LANGUAGES, lang) ? LANGUAGES[lang] : lang;
  return `<div class="code"><div class="code-head"><span>${esc(label)}</span><button type="button" class="copy">${icon('copy', 'icon-sm')}<span>Copy</span></button></div><pre><code>${esc(body)}</code></pre></div>`;
}

/** Parses Markdown blocks; `ctx` collects the heading identifiers of the page. */
function blocks(lines, ctx, tight) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m;
    // fenced code (and the custom blocks)
    if ((m = RE.fence.exec(line))) {
      const fence = m[2];
      const body = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(fence[0].repeat(fence.length)) && /^\s*[`~]+\s*$/.test(lines[i]))) {
        body.push(m[1] ? lines[i].replace(new RegExp(`^ {0,${m[1].length}}`), '') : lines[i]);
        i++;
      }
      i++;
      const lang = m[3].toLowerCase();
      const text = body.join('\n');
      out.push(['cards', 'steps', 'flow', 'path'].includes(lang) ? customBlock(lang, text) : codeBlock(lang, text));
      continue;
    }
    if ((m = RE.heading.exec(line))) {
      const level = m[1].length;
      const inner = inline(m[2]);
      const plain = decode(textOf(inner));
      let id = pageSlug(plain);
      if (ctx.ids.has(id)) {
        let n = 1;
        while (ctx.ids.has(`${id}-${n}`)) n++;
        id = `${id}-${n}`;
      }
      ctx.ids.add(id);
      out.push(`<h${level} id="${id}">${inner}</h${level}>`);
      i++;
      continue;
    }
    if (RE.commentOpen.test(line)) {
      const end = commentEnd(lines, i);
      if (end >= 0) {
        out.push(lines.slice(i, end + 1).map((l) => l.trim()).join('\n'));
        i = end + 1;
        continue;
      }
      // Unterminated comment (or markup after "-->"): ordinary text, escaped like any paragraph.
    }
    if (RE.hr.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }
    if (RE.htmlBlock.test(line)) {
      const body = [];
      while (i < lines.length && lines[i].trim()) body.push(lines[i++]);
      out.push(body.join('\n'));
      continue;
    }
    // blockquote and GitHub alerts
    if (RE.quote.test(line)) {
      const body = [];
      while (i < lines.length && (RE.quote.test(lines[i]) || (lines[i].trim() && body.length && !startsBlock(lines[i], lines[i + 1])))) {
        body.push(lines[i].replace(RE.quote, ''));
        i++;
      }
      const alert = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(body[0] || '');
      if (alert) {
        const kind = alert[1].toLowerCase();
        out.push(
          `<div class="markdown-alert markdown-alert-${kind}">\n<p class="markdown-alert-title"><svg class="icon-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ALERT_ICONS[kind]}</svg>${ALERT_TITLES[kind]}</p>\n${blocks(body.slice(1), ctx)}\n</div>`
        );
      } else {
        out.push(`<blockquote>\n${blocks(body, ctx)}\n</blockquote>`);
      }
      continue;
    }
    // table
    if (line.includes('|') && i + 1 < lines.length && RE.tableDelimiter.test(lines[i + 1]) && lines[i + 1].includes('-') && lines[i + 1].includes('|')) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':');
        const r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
      });
      const cell = (tag, text, k) => {
        const a = align[k] ? ` style="text-align: ${align[k]};"` : '';
        return `<${tag}${a}>${inline(text)}</${tag}>`;
      };
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = splitRow(lines[i]);
        rows.push(`<tr>${head.map((_, k) => cell('td', cells[k] || '', k)).join('')}</tr>`);
        i++;
      }
      out.push(`<table>\n<thead>\n<tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr>\n</thead>\n<tbody>\n${rows.join('\n')}\n</tbody>\n</table>`);
      continue;
    }
    // lists
    const bullet = RE.bullet.exec(line);
    const ordered = RE.ordered.exec(line);
    if (bullet || ordered) {
      const isOrdered = !!ordered;
      const marker = isOrdered ? ordered[3] : bullet[2];
      const start = isOrdered ? Number(ordered[2]) : 1;
      const items = [];
      let loose = false;
      while (i < lines.length) {
        const first = lines[i];
        const mm = isOrdered ? RE.ordered.exec(first) : RE.bullet.exec(first);
        if (!mm || (isOrdered ? mm[3] : mm[2]) !== marker) break;
        const lead = isOrdered ? mm[1].length + mm[2].length + mm[3].length : mm[1].length + 1;
        const textStart = first.length - (isOrdered ? mm[4] : mm[3]).length;
        const contentIndent = textStart;
        const body = [first.slice(contentIndent)];
        i++;
        let sawBlank = false;
        while (i < lines.length) {
          const next = lines[i];
          if (!next.trim()) {
            // a blank line keeps the item open only if an indented line follows
            let j = i;
            while (j < lines.length && !lines[j].trim()) j++;
            if (j < lines.length && /^\s/.test(lines[j]) && lines[j].search(/\S/) >= contentIndent) {
              sawBlank = true;
              for (; i < j; i++) body.push('');
              continue;
            }
            break;
          }
          if (next.search(/\S/) >= contentIndent) {
            body.push(next.slice(contentIndent));
            i++;
          } else if (!RE.ordered.test(next) && !RE.bullet.test(next) && !startsBlock(next, lines[i + 1]) && body[body.length - 1] !== '' && !/^\s/.test(next)) {
            // lazy paragraph continuation
            body.push(next);
            i++;
          } else break;
        }
        if (sawBlank) loose = true;
        items.push(body);
      }
      const rendered = items.map((body) => {
        const inner = blocks(body, ctx, !loose);
        return `<li>${inner}</li>`;
      });
      const tag = isOrdered ? 'ol' : 'ul';
      const startAttr = isOrdered && start !== 1 ? ` start="${start}"` : '';
      out.push(`<${tag}${startAttr}>\n${rendered.join('\n')}\n</${tag}>`);
      continue;
    }
    // paragraph
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) {
      para.push(lines[i]);
      i++;
    }
    const html = inline(para.map((l, k) => (k < para.length - 1 ? l.replace(/^\s+/, '') : l.trim())).join('\n'));
    out.push(tight ? html : `<p>${html}</p>`);
  }
  return out.join('\n');
}

function markdownToHtml(markdown, ctx) {
  return blocks(markdown.replace(/\r\n/g, '\n').split('\n'), ctx || { ids: new Set() });
}

// ---- Page --------------------------------------------------------------------------------------------
const CSS = `:root {
  color-scheme: light;
  --cp-bg: #f7f4ef; --cp-bg-elevated: #fcfbf8; --cp-surface: #ffffff; --cp-surface-soft: #f5f5f5;
  --cp-border: #dedede; --cp-border-strong: #919191; --cp-text: #242424; --cp-text-muted: #5c5c5c; --cp-text-soft: #6f6f6f;
  --cp-accent: #b11f4b; --cp-accent-hover: #9a1a41; --cp-accent-soft: rgba(177, 31, 75, 0.08); --cp-accent-fg: #ffffff;
  --cp-success: #16a34a; --cp-danger: #dc2626; --cp-warning: #f59e0b; --cp-link: #0078d4;
  --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.12); --cp-overlay: rgba(255, 255, 255, 0.8);
  --cp-panel: rgba(255, 255, 255, 0.86); --cp-panel-strong: rgba(255, 255, 255, 0.96); --cp-sheen: rgba(255, 255, 255, 0.55);
  --cp-highlight: rgba(177, 31, 75, 0.12);
}
html[data-theme="dark"] {
  color-scheme: dark;
  --cp-bg: #3d3b3a; --cp-bg-elevated: #343231; --cp-surface: #292929; --cp-surface-soft: #2e2e2e;
  --cp-border: #474747; --cp-border-strong: #5f5f5f; --cp-text: #dedede; --cp-text-muted: #919191; --cp-text-soft: #b0b0b0;
  --cp-accent: #fd8ea1; --cp-accent-hover: #fb7b91; --cp-accent-soft: rgba(253, 142, 161, 0.14); --cp-accent-fg: #1a1a1a;
  --cp-success: #4ade80; --cp-danger: #f87171; --cp-warning: #fbbf24; --cp-link: #4da6ff;
  --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.32); --cp-overlay: rgba(41, 41, 41, 0.88);
  --cp-panel: rgba(41, 41, 41, 0.72); --cp-panel-strong: rgba(41, 41, 41, 0.96); --cp-sheen: rgba(255, 255, 255, 0.04);
  --cp-highlight: rgba(253, 142, 161, 0.12);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 24px; }
body { margin: 0; background: var(--cp-bg); color: var(--cp-text); font: 15.5px/1.7 "Segoe UI", Aptos, Calibri, -apple-system, BlinkMacSystemFont, sans-serif; display: grid; grid-template-columns: 300px minmax(0, 1fr); }
a { color: var(--cp-link); text-decoration: none; } a:hover { text-decoration: underline; }
.icon { width: 22px; height: 22px; } .icon-sm { width: 16px; height: 16px; flex-shrink: 0; } .icon-xs { width: 12px; height: 12px; }
button { font: inherit; color: var(--cp-text); background: var(--cp-surface); border: 1px solid var(--cp-border); border-radius: 0.625rem; cursor: pointer; }
button:hover { border-color: var(--cp-accent); color: var(--cp-accent); }
:focus-visible { outline: 2px solid var(--cp-accent); outline-offset: 2px; }

/* ---- Sidebar -------------------------------------------------------------------- */
aside { position: sticky; top: 0; height: 100vh; overflow-y: auto; background: var(--cp-bg-elevated); border-right: 1px solid var(--cp-border); padding: 24px 16px 32px; }
.brand { display: flex; gap: 12px; align-items: center; padding: 4px 8px 20px; border-bottom: 1px solid var(--cp-border); margin-bottom: 12px; }
.brand-logo { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: var(--cp-accent); color: var(--cp-accent-fg); }
.brand-name { font-weight: 700; font-size: 15px; line-height: 1.2; } .brand-sub { font-size: 12px; color: var(--cp-text-muted); }
.nav-part { margin: 20px 8px 6px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--cp-accent); }
.nav-part span { color: var(--cp-text-muted); font-weight: 600; letter-spacing: 0.04em; }
aside a { display: flex; align-items: center; gap: 10px; padding: 6px 8px; margin: 1px 0; border-radius: 0.625rem; color: var(--cp-text); font-size: 13.5px; line-height: 1.35; border-left: 3px solid transparent; }
aside a:hover { background: var(--cp-accent-soft); text-decoration: none; }
aside a.active { background: var(--cp-accent-soft); border-left-color: var(--cp-accent); font-weight: 600; }
.nav-badge { flex-shrink: 0; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: 11.5px; font-weight: 700; background: var(--cp-surface-soft); color: var(--cp-text-muted); border: 1px solid var(--cp-border); }
aside a.active .nav-badge { background: var(--cp-accent); color: var(--cp-accent-fg); border-color: var(--cp-accent); }

/* ---- Main -------------------------------------------------------------------------- */
main { padding: 40px 56px 80px; max-width: 1080px; width: 100%; }
.hero { position: relative; overflow: hidden; border: 1px solid var(--cp-border); border-top: 4px solid var(--cp-accent); border-radius: 16px; padding: 36px 40px 32px; margin-bottom: 40px; background: linear-gradient(125deg, var(--cp-surface) 40%, var(--cp-accent-soft)); }
.hero::before { content: ""; position: absolute; width: 320px; height: 320px; right: -110px; top: -170px; border: 44px solid var(--cp-highlight); border-radius: 50%; pointer-events: none; }
.hero-top { position: relative; display: flex; align-items: center; gap: 18px; }
.hero-logo { width: 60px; height: 60px; border-radius: 16px; display: grid; place-items: center; background: var(--cp-accent); color: var(--cp-accent-fg); flex-shrink: 0; }
.hero-logo .icon { width: 32px; height: 32px; }
.eyebrow, .section-eyebrow { font-size: 11.5px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--cp-accent); }
.hero h1 { font-size: 38px; font-weight: 700; letter-spacing: -0.025em; line-height: 1.1; margin: 4px 0 0; }
#theme { margin-left: auto; padding: 8px 10px; display: grid; place-items: center; }
.badges { position: relative; display: flex; flex-wrap: wrap; gap: 8px; margin: 22px 0 18px; }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px; font-size: 12.5px; background: var(--cp-surface); border: 1px solid var(--cp-border); color: var(--cp-text-muted); }
.badge-accent { background: var(--cp-accent); color: var(--cp-accent-fg); border-color: var(--cp-accent); font-weight: 600; }
.lead { position: relative; font-size: 17.5px; line-height: 1.6; max-width: 760px; margin: 0 0 24px; }

.part { display: flex; align-items: baseline; gap: 14px; margin: 56px 0 20px; padding-bottom: 10px; border-bottom: 2px solid var(--cp-accent); }
.part-label { font-size: 13px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--cp-accent); }
.part-name { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }

.section { background: var(--cp-surface); border: 1px solid var(--cp-border); border-radius: 16px; padding: 32px 40px 28px; margin: 0 0 28px; box-shadow: 0 0 2px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.14); }
.section-head { display: flex; align-items: center; gap: 16px; padding-bottom: 18px; margin-bottom: 8px; border-bottom: 1px solid var(--cp-border); }
.section-icon { width: 48px; height: 48px; border-radius: 14px; display: grid; place-items: center; background: var(--cp-accent-soft); color: var(--cp-accent); flex-shrink: 0; }
.section-icon .icon { width: 26px; height: 26px; }
.section h2 { font-size: 25px; font-weight: 700; letter-spacing: -0.02em; margin: 2px 0 0; line-height: 1.2; }
.section-body > :first-child { margin-top: 16px; }
h3 { font-size: 17.5px; font-weight: 650; margin: 36px 0 12px; padding-left: 12px; border-left: 3px solid var(--cp-accent); line-height: 1.3; }
h3.step-h { display: flex; align-items: center; gap: 12px; padding-left: 0; border-left: 0; margin-top: 32px; }
h3.step-h .path-num { width: 32px; height: 32px; font-size: 14.5px; }
p { margin: 12px 0; } ul, ol { padding-left: 22px; } li { margin: 6px 0; } li::marker { color: var(--cp-accent); }
strong { font-weight: 650; }
code { font-family: Consolas, "Courier New", Courier, monospace; font-size: 0.88em; background: var(--cp-surface-soft); border: 1px solid var(--cp-border); padding: 1px 6px; border-radius: 6px; }
kbd { font-family: Consolas, monospace; font-size: 0.85em; padding: 1px 7px; border: 1px solid var(--cp-border-strong); border-bottom-width: 2px; border-radius: 6px; background: var(--cp-surface-soft); }
hr { border: 0; border-top: 1px solid var(--cp-border); margin: 28px 0; }

/* Tables */
.table-wrap { overflow-x: auto; margin: 16px 0 20px; border: 1px solid var(--cp-border); border-radius: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; line-height: 1.55; }
th { text-align: left; font-weight: 650; font-size: 12.5px; letter-spacing: 0.02em; color: var(--cp-text-muted); background: var(--cp-surface-soft); padding: 11px 16px; border-bottom: 1px solid var(--cp-border); }
td { padding: 11px 16px; border-bottom: 1px solid var(--cp-border); vertical-align: top; }
td:first-child { font-weight: 600; }
tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: var(--cp-accent-soft); }
td code { white-space: nowrap; }

/* Code */
.code { margin: 16px 0 20px; border: 1px solid var(--cp-border); border-radius: 12px; overflow: hidden; background: var(--cp-surface-soft); }
.code-head { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px 6px 16px; border-bottom: 1px solid var(--cp-border); font-size: 12px; font-weight: 600; color: var(--cp-text-muted); letter-spacing: 0.04em; text-transform: uppercase; }
.copy { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; font-size: 12px; text-transform: none; letter-spacing: 0; }
.copy.done { color: var(--cp-success); border-color: var(--cp-success); }
.code pre { margin: 0; padding: 16px 18px; overflow-x: auto; font-size: 13.5px; line-height: 1.6; }
.code pre code { background: none; border: 0; padding: 0; font-size: inherit; }

/* Callouts */
.markdown-alert { --tone: var(--cp-link); margin: 18px 0; padding: 14px 18px; border: 1px solid color-mix(in srgb, var(--tone) 35%, var(--cp-border)); border-left: 4px solid var(--tone); border-radius: 12px; background: color-mix(in srgb, var(--tone) 7%, var(--cp-surface)); }
.markdown-alert p { margin: 6px 0; }
.markdown-alert-title { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--tone); margin: 0 0 4px !important; }
.markdown-alert-tip { --tone: var(--cp-success); } .markdown-alert-important { --tone: var(--cp-accent); }
.markdown-alert-warning { --tone: var(--cp-warning); } .markdown-alert-caution { --tone: var(--cp-danger); }

/* Cards */
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; margin: 18px 0 22px; position: relative; }
.card-item { display: flex; gap: 14px; padding: 16px 18px; border: 1px solid var(--cp-border); border-radius: 14px; background: var(--cp-surface); transition: transform 160ms ease, border-color 160ms ease; }
.card-item:hover { transform: translateY(-2px); border-color: var(--cp-accent); }
.card-icon { width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center; background: var(--cp-accent-soft); color: var(--cp-accent); flex-shrink: 0; }
.card-title { font-weight: 700; font-size: 14.5px; line-height: 1.3; margin: 2px 0 4px; }
.card-text { font-size: 13.5px; line-height: 1.5; color: var(--cp-text-muted); }

/* Steps */
.steps { list-style: none; padding: 0; margin: 18px 0 22px; position: relative; }
.steps li { position: relative; display: flex; gap: 16px; margin: 0; padding: 0 0 18px; }
.steps li:not(:last-child)::before { content: ""; position: absolute; left: 16px; top: 36px; bottom: 2px; width: 2px; background: var(--cp-border); }
.step-num { flex-shrink: 0; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 14px; background: var(--cp-accent); color: var(--cp-accent-fg); box-shadow: 0 0 0 4px var(--cp-accent-soft); }
.step-body { padding-top: 5px; } .step-title { font-weight: 700; font-size: 15px; line-height: 1.35; }
.step-text { color: var(--cp-text-muted); font-size: 14.5px; margin-top: 2px; }

/* Flow */
.flow { display: flex; align-items: stretch; flex-wrap: wrap; gap: 6px; margin: 20px 0 24px; padding: 20px; border-radius: 14px; background: var(--cp-surface-soft); border: 1px dashed var(--cp-border-strong); }
.flow-node { flex: 1 1 130px; min-width: 120px; text-align: center; padding: 16px 12px; border-radius: 12px; background: var(--cp-surface); border: 1px solid var(--cp-border); }
.flow-icon { width: 42px; height: 42px; margin: 0 auto 8px; border-radius: 12px; display: grid; place-items: center; background: var(--cp-accent-soft); color: var(--cp-accent); }
.flow-title { font-weight: 700; font-size: 14px; line-height: 1.3; } .flow-text { font-size: 12.5px; color: var(--cp-text-muted); line-height: 1.4; margin-top: 4px; }
.flow-arrow { flex: 0 0 auto; min-width: 70px; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--cp-border-strong); padding: 0 2px; }
.flow-arrow svg { width: 44px; height: 14px; color: var(--cp-accent); }
.flow-label { font-size: 12px; font-weight: 700; color: var(--cp-accent); } .flow-sub { font-size: 11px; color: var(--cp-text-muted); text-align: center; max-width: 110px; line-height: 1.3; }

/* Path (guided path: trunk, then branches) */
.path { margin: 20px 0 26px; padding: 20px 22px 22px; border-radius: 16px; background: var(--cp-surface-soft); border: 1px dashed var(--cp-border-strong); }
.path-caption { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--cp-accent); }
.path-row { display: flex; align-items: stretch; }
.path-node { flex: 1 1 0; min-width: 0; display: flex; gap: 10px; align-items: flex-start; padding: 12px; border-radius: 12px; background: var(--cp-surface); border: 1px solid var(--cp-border); }
.path-arrow { flex: 0 0 18px; display: grid; place-items: center; color: var(--cp-accent); }
.path-arrow svg { width: 10px; height: 34px; }
.path-num { flex-shrink: 0; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 13px; line-height: 1; background: var(--cp-accent); color: var(--cp-accent-fg); box-shadow: 0 0 0 3px var(--cp-accent-soft); }
.path-title { font-weight: 700; font-size: 13.5px; line-height: 1.3; padding-top: 3px; }
.path-sub { font-size: 12.5px; line-height: 1.4; color: var(--cp-text-muted); margin-top: 3px; }
.path-sub code { font-size: 0.92em; padding: 0 4px; }
.path-fork { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 16px; color: var(--cp-accent); }
.path-fork > div { display: grid; place-items: center; height: 34px; }
.path-fork svg { width: 14px; height: 26px; }
.path-branches { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 16px; }
.path-branch { border: 1px solid var(--cp-border); border-top: 3px solid var(--cp-accent); border-radius: 14px; background: var(--cp-surface); padding: 14px 16px 6px; }
.path-head { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15.5px; margin: 0 0 12px; }
.path-letter { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; font-size: 14px; background: var(--cp-text); color: var(--cp-surface); }
.path-icon { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; background: var(--cp-accent-soft); color: var(--cp-accent); }
.path-steps { list-style: none; padding: 0; margin: 0; }
.path-steps li { position: relative; display: flex; gap: 12px; margin: 0; padding: 0 0 12px; }
.path-steps li:not(:last-child)::before { content: ""; position: absolute; left: 13px; top: 30px; bottom: 0; width: 2px; background: var(--cp-border); }
@media (max-width: 900px) { .path-row { flex-direction: column; } .path-arrow { transform: rotate(90deg); height: 18px; } .path-branches, .path-fork { grid-auto-flow: row; } }

/* Figures */
figure { margin: 18px 0 24px; }
figure img { display: block; max-width: 100%; border: 1px solid var(--cp-border); border-radius: 12px; box-shadow: 0 0 2px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.14); cursor: zoom-in; }
figcaption { font-size: 13px; color: var(--cp-text-muted); margin-top: 8px; text-align: center; }
dialog#zoom { border: 0; padding: 0; background: transparent; max-width: 96vw; max-height: 96vh; }
dialog#zoom::backdrop { background: rgba(0, 0, 0, 0.7); }
dialog#zoom img { max-width: 96vw; max-height: 94vh; border-radius: 12px; cursor: zoom-out; display: block; }

#to-top { position: fixed; right: 24px; bottom: 24px; width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: var(--cp-accent); color: var(--cp-accent-fg); border: 0; box-shadow: var(--cp-shadow); opacity: 0; pointer-events: none; transition: opacity 200ms; }
#to-top.visible { opacity: 1; pointer-events: auto; } #to-top:hover { background: var(--cp-accent-hover); color: var(--cp-accent-fg); }
footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--cp-border); font-size: 12.5px; color: var(--cp-text-muted); text-align: center; }

/* Long inline code (paths, commands) must wrap inside cards, steps and path nodes instead of overflowing them. */
.card-item > div, .step-body, .flow-node, .path-node > div, .path-steps li > div { min-width: 0; }
.card-text code, .step-text code, .path-sub code, .flow-text code, .path-title code { overflow-wrap: anywhere; }
.path-title, .path-sub, .card-title, .card-text, .step-title, .step-text { overflow-wrap: anywhere; }

@media (max-width: 1000px) {
  body { display: block; }
  aside { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--cp-border); }
  main { padding: 24px 16px 60px; } .section { padding: 24px 20px; } .hero { padding: 28px 22px; }
}
@media (max-width: 520px) {
  code { overflow-wrap: anywhere; } .code pre code { overflow-wrap: normal; }
  main { padding: 16px 10px 48px; } .hero { padding: 22px 16px 20px; } .section { padding: 20px 14px 18px; border-radius: 14px; }
  .hero-top { gap: 12px; } .hero-top > div:nth-child(2) { min-width: 0; flex: 1 1 0; }
  .hero-logo { width: 44px; height: 44px; border-radius: 12px; } .hero-logo .icon { width: 24px; height: 24px; }
  .hero h1 { font-size: 26px; overflow-wrap: anywhere; } .lead { font-size: 16px; }
  #theme { align-self: flex-start; flex-shrink: 0; }
  .section-head { gap: 12px; } .section-icon { width: 40px; height: 40px; } .section h2 { font-size: 21px; overflow-wrap: anywhere; }
  .part-name { font-size: 22px; } .part { flex-wrap: wrap; gap: 6px 14px; }
  .code pre { padding: 12px 14px; font-size: 12.5px; } .cards { grid-template-columns: 1fr; }
  th, td { padding: 9px 12px; } td code { overflow-wrap: normal; }
  .markdown-alert { padding: 12px 14px; } .flow { padding: 12px; } .path { padding: 14px 12px 14px; }
  .flow { flex-direction: column; align-items: stretch; gap: 0; } .flow-node { flex: 0 0 auto; }
  .flow-arrow { min-width: 0; padding: 2px 0; } .flow-arrow svg { transform: rotate(90deg); margin: 15px 0; } .flow-sub { max-width: none; }
}
@media print {
  body { display: block; background: #fff; } aside, #to-top, #theme, .copy { display: none !important; }
  main { padding: 0; max-width: none; } .section { break-inside: avoid-page; box-shadow: none; } .part { break-before: page; }
}
`;

const PAGE_SCRIPT = `(() => {
  "use strict";
  // Theme toggle (no storage: the choice lasts for the page).
  document.getElementById("theme").addEventListener("click", () => {
    const root = document.documentElement;
    root.setAttribute("data-theme", root.getAttribute("data-theme") === "dark" ? "light" : "dark");
  });
  // Highlight the chapter being read in the sidebar.
  const links = new Map(Array.from(document.querySelectorAll("aside a[data-target]")).map(a => [a.dataset.target, a]));
  const observer = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      links.forEach(a => a.classList.remove("active"));
      const link = links.get(e.target.id);
      if (link) { link.classList.add("active"); link.scrollIntoView({ block: "nearest" }); }
    }
  }, { rootMargin: "-20% 0px -70% 0px" });
  document.querySelectorAll("section.section").forEach(s => observer.observe(s));
  // Copy buttons.
  document.querySelectorAll(".code .copy").forEach(button => button.addEventListener("click", async () => {
    const text = button.closest(".code").querySelector("pre").innerText;
    try { await navigator.clipboard.writeText(text); }
    catch { const r = document.createRange(); r.selectNodeContents(button.closest(".code").querySelector("pre")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand("copy"); s.removeAllRanges(); }
    const label = button.querySelector("span"); label.textContent = "Copied"; button.classList.add("done");
    setTimeout(() => { label.textContent = "Copy"; button.classList.remove("done"); }, 1600);
  }));
  // Image zoom.
  const zoom = document.getElementById("zoom");
  document.querySelectorAll("figure img").forEach(img => img.addEventListener("click", () => { zoom.querySelector("img").src = img.src; zoom.showModal(); }));
  zoom.addEventListener("click", () => zoom.close());
  // Back to top.
  const top = document.getElementById("to-top");
  addEventListener("scroll", () => top.classList.toggle("visible", scrollY > 600), { passive: true });
  top.addEventListener("click", () => scrollTo({ top: 0 }));
})();
`;

function parseFrontMatter(markdown) {
  const meta = { title: 'Guide', subtitle: '', version: '', author: '', updated: '' };
  const front = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (!front) return { meta, body: markdown, hasFrontMatter: false };
  for (const line of front[1].split('\n')) {
    const kv = /^\s*(\w+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: markdown.slice(front[0].length), hasFrontMatter: true };
}

/** Builds the HTML page of one guide. `name` is the base name without extension; images resolve against docs/. */
function buildGuide(name, dir) {
  const base = dir || docsDir;
  const source = path.join(base, `${name}.md`);
  const markdown = fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n');
  const { meta, body } = parseFrontMatter(markdown);
  let html = markdownToHtml(body);

  // Numbered steps of the guided path: "### 1 · List the servers" gets the number badge of the path.
  html = html.replace(/<h3 id="([^"]*)">(\d{1,2}) (?:·|&middot;|&#183;) ([\s\S]*?)<\/h3>/g, '<h3 id="$1" class="step-h"><span class="path-num">$2</span><span>$3</span></h3>');

  // Tables, images, links.
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
  html = html.replace(/<p><img src="([^"]+)" alt="([^"]*)" \/><\/p>/g, (m, src, alt) => {
    const file = path.join(base, decodeURIComponent(src));
    const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif' };
    const type = types[path.extname(file).toLowerCase()];
    const data = fs.existsSync(file) && type ? `data:${type};base64,${fs.readFileSync(file).toString('base64')}` : src;
    return `<figure><img loading="lazy" src="${data}" alt="${alt}" title="Click to enlarge"><figcaption>${alt}</figcaption></figure>`;
  });
  html = html.replace(/<a href="(https?:\/\/[^"]+)"/g, '<a href="$1" target="_blank" rel="noopener"');
  // Link to the other guide: its HTML file and the id of the heading in that page. Same-page anchors: the id of the page.
  html = html.replace(/<a href="(NoFridayMail-(?:User)?Guide)\.md(?:#([^"]*))?"/g, (m, guide, anchor) => `<a href="${guide}.html${anchor ? `#${anchorToId(anchor)}` : ''}"`);
  const ids = new Set(Array.from(html.matchAll(/ id="([^"]+)"/g)).map((x) => x[1]));
  html = html.replace(/<a href="#([^"]+)"/g, (m, anchor) => `<a href="#${ids.has(anchor) ? anchor : anchorToId(anchor)}"`);

  // Parts and chapters.
  const pattern = /(?:<!-- icon: ([\w-]+) -->\s*)?<h([12]) id="([^"]*)">([\s\S]*?)<\/h\2>/g;
  const headings = Array.from(html.matchAll(pattern));
  let hero = '';
  let bodyHtml = '';
  let nav = '';
  let sectionOpen = false;
  headings.forEach((m, i) => {
    const end = i + 1 < headings.length ? headings[i + 1].index : html.length;
    let content = html.slice(m.index + m[0].length, end);
    const level = m[2];
    const id = m[3];
    const text = m[4];
    if (i === 0 && level === '1') {
      let lead = '';
      const quote = /^\s*<blockquote>\s*<p>([\s\S]*?)<\/p>\s*<\/blockquote>/.exec(content) || /^\s*<blockquote>\s*([\s\S]*?)\s*<\/blockquote>/.exec(content);
      if (quote) {
        lead = quote[1];
        content = content.slice(quote[0].length);
      }
      const badges = [
        `<span class="badge badge-accent">Version ${esc(meta.version)}</span>`,
        `<span class="badge">${icon('calendar', 'icon-sm')}Updated ${esc(meta.updated)}</span>`,
        `<span class="badge">${icon('user', 'icon-sm')}${esc(meta.author)}</span>`,
        `<span class="badge">${icon('terminal', 'icon-sm')}PowerShell 7.4+</span>`,
        `<span class="badge">${icon('mail', 'icon-sm')}Outlook Smart Alerts</span>`
      ].join('');
      hero =
        `<header class="hero" id="top"><div class="hero-top"><div class="hero-logo">${icon('mail')}</div><div><div class="eyebrow">${esc(meta.subtitle)}</div><h1>${esc(meta.title)}</h1></div>` +
        `<button type="button" id="theme" class="ghost" title="Light / dark">${icon('moon', 'icon-sm')}</button></div>` +
        `<div class="badges">${badges}</div><p class="lead">${lead}</p>${content}</header>`;
      return;
    }
    if (sectionOpen) {
      bodyHtml += '</div></section>';
      sectionOpen = false;
    }
    if (level === '1') {
      const [label, ...rest] = text.split(' · ');
      const name2 = rest.join(' · ');
      const partName = name2 ? `<span class="part-name">${name2}</span>` : '';
      const navName = name2 ? ` <span>${name2}</span>` : '';
      bodyHtml += `<div class="part" id="${id}"><span class="part-label">${label}</span>${partName}</div>`;
      nav += `<div class="nav-part">${label}${navName}</div>`;
      bodyHtml += content;
      return;
    }
    const iconName = m[1] || 'play';
    let badge = '';
    let eyebrow = '';
    let title = text;
    const numbered = /^(\d+)\.\s+([\s\S]*)$/.exec(text);
    const annex = /^Annex ([A-Z]) — ([\s\S]*)$/.exec(text);
    if (numbered) {
      badge = numbered[1];
      title = numbered[2];
    } else if (annex) {
      badge = annex[1];
      title = annex[2];
      eyebrow = `Annex ${badge}`;
    }
    const eyebrowHtml = eyebrow ? `<div class="section-eyebrow">${eyebrow}</div>` : badge ? `<div class="section-eyebrow">Chapter ${badge}</div>` : '<div class="section-eyebrow">Start here</div>';
    bodyHtml += `<section class="section" id="${id}"><div class="section-head"><div class="section-icon">${icon(iconName)}</div><div>${eyebrowHtml}<h2>${title}</h2></div></div><div class="section-body">`;
    bodyHtml += content;
    sectionOpen = true;
    const navBadge = badge || icon('play', 'icon-xs');
    nav += `<a href="#${id}" data-target="${id}"><span class="nav-badge">${navBadge}</span><span class="nav-text">${title}</span></a>`;
  });
  if (sectionOpen) bodyHtml += '</div></section>';

  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title)} - ${esc(meta.subtitle)}</title>
<script>
  (() => {
    const param = new URLSearchParams(window.location.search).get("theme");
    const theme = param === "dark" || param === "light" ? param : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
  })();
</script>
<style>
${CSS}</style></head><body>
<aside><div class="brand"><div class="brand-logo">${icon('mail')}</div><div><div class="brand-name">${esc(meta.title)}</div><div class="brand-sub">${esc(meta.subtitle)} · v${esc(meta.version)}</div></div></div>
<nav aria-label="Contents">${nav}</nav></aside>
<main>${hero}${bodyHtml}
<footer>${esc(meta.title)} ${esc(meta.version)} · ${esc(meta.author)} · updated ${esc(meta.updated)} · generated from ${esc(`${name}.md`)}</footer></main>
<button type="button" id="to-top" title="Back to top">${icon('up', 'icon-sm')}</button>
<dialog id="zoom"><img alt=""></dialog>
<script>
${PAGE_SCRIPT}</script>
</body></html>
`;
}

function main(argv) {
  const check = argv.includes('--check');
  let stale = 0;
  for (const name of GUIDES) {
    const target = path.join(docsDir, `${name}.html`);
    const html = buildGuide(name);
    if (check) {
      const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      if (current !== html) {
        console.error(`Out of date: package/docs/${name}.html (run: npm run docs)`);
        stale++;
      }
    } else {
      fs.writeFileSync(target, html, 'utf8');
      console.log(`Written: package/docs/${name}.html (${Math.round(Buffer.byteLength(html) / 1024)} KB)`);
    }
  }
  if (check) {
    if (stale) process.exit(1);
    console.log('The HTML guides are up to date.');
  }
}

module.exports = { ICONS, GUIDES, CSS, icon, esc, inlineField, customBlock, buildGuide, markdownToHtml, parseFrontMatter, githubSlug, pageSlug, anchorToId };

if (require.main === module) main(process.argv.slice(2));
