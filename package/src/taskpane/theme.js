'use strict';

/*
 * Task pane theme: pure colour calculations (testable under Node, no DOM).
 * By default, the Fluent 2 light/dark palette lives in the CSS of taskpane.html
 * (variables --bg, --fg ...) with a prefers-color-scheme fallback. When Outlook provides
 * Office.context.officeTheme, deriveTheme() computes the variables that depend on it,
 * provided the AA contrast (4.5:1) is still met; otherwise null (default palette).
 */

var BRAND_LIGHT = '#0F6CBD';
var BRAND_DARK = '#479EF5';

/** "#RGB" / "#RRGGBB" -> [r, g, b] or null. */
function parseColor(text) {
  if (typeof text !== 'string') {
    return null;
  }
  var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.replace(/^\s+|\s+$/g, ''));
  if (!m) {
    return null;
  }
  var h = m[1];
  if (h.length === 3) {
    h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
  }
  return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)];
}

function toHex(rgb) {
  var out = '#';
  var i;
  for (i = 0; i < 3; i += 1) {
    var v = Math.max(0, Math.min(255, Math.round(rgb[i])));
    out += (v < 16 ? '0' : '') + v.toString(16);
  }
  return out;
}

/** WCAG relative luminance of a "#rrggbb" colour. */
function luminance(color) {
  var rgb = parseColor(color);
  var lin = [];
  var i;
  for (i = 0; i < 3; i += 1) {
    var c = rgb[i] / 255;
    lin.push(c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  }
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast ratio between two colours (1 to 21). */
function contrast(a, b) {
  var la = luminance(a);
  var lb = luminance(b);
  var hi = Math.max(la, lb);
  var lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Blend: t = share of `top` (0..1) over `base`. */
function mix(base, top, t) {
  var a = parseColor(base);
  var b = parseColor(top);
  return toHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

function isDark(background) {
  return luminance(background) < 0.4;
}

/**
 * CSS variables derived from Office.context.officeTheme, or null if the theme is missing,
 * unreadable or does not guarantee AA contrast.
 * Returns { dark: boolean, vars: { '--bg': '#...', ... } }.
 */
function deriveTheme(officeTheme) {
  if (!officeTheme) {
    return null;
  }
  var bg = officeTheme.bodyBackgroundColor;
  var fg = officeTheme.bodyForegroundColor;
  if (!parseColor(bg) || !parseColor(fg)) {
    return null;
  }
  bg = toHex(parseColor(bg));
  fg = toHex(parseColor(fg));
  var dark = isDark(bg);
  var brandFg = dark ? BRAND_DARK : BRAND_LIGHT;
  var fg2 = mix(bg, fg, 0.8);
  var surface = parseColor(officeTheme.controlBackgroundColor)
    ? toHex(parseColor(officeTheme.controlBackgroundColor))
    : mix(bg, fg, 0.04);
  var selected = mix(bg, brandFg, 0.08);
  var hdr1 = mix(bg, brandFg, 0.06);
  var hdr2 = mix(bg, brandFg, 0.12);

  if (
    contrast(fg, bg) < 4.5 ||
    contrast(fg2, bg) < 4.5 ||
    contrast(fg, surface) < 4.5 ||
    contrast(fg2, surface) < 4.5 ||
    contrast(brandFg, bg) < 4.5 ||
    contrast(brandFg, selected) < 4.5 ||
    contrast(fg, hdr2) < 4.5 ||
    contrast(fg2, hdr2) < 4.5
  ) {
    return null;
  }
  return {
    dark: dark,
    vars: {
      '--bg': bg,
      '--fg': fg,
      '--fg2': fg2,
      '--surface': surface,
      '--hover': mix(surface, fg, 0.06),
      '--border': mix(bg, fg, 0.22),
      '--selected': selected,
      '--hdr1': hdr1,
      '--hdr2': hdr2
    }
  };
}

module.exports = {
  parseColor: parseColor,
  luminance: luminance,
  contrast: contrast,
  mix: mix,
  isDark: isDark,
  deriveTheme: deriveTheme
};
