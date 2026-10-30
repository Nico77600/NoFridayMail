'use strict';

/*
 * Checks that launchevent.js can be used by the JavaScript-only runtime of classic Outlook
 * for Windows: a classic script, pure ASCII, no DOM and no ES import/export,
 * that associates the handlers declared in the manifest, and that contains the environment
 * rules injected by webpack (blocked days, working days, times, etc.).
 */
const fs = require('fs');
const path = require('path');
const { getBuildContext } = require('./env-config');

/** Expected form in the minified bundle: no whitespace, double quotes. */
function normalize(code) {
  return code.replace(/\s/g, '').replace(/'/g, '"');
}

/** List of problems (empty = compliant); `rules` = expected rules (see env-config.resolveRules). */
function checkLaunchEvent(code, rules) {
  const problems = [];
  if (/[^\x00-\x7f]/.test(code)) problems.push('non-ASCII characters');
  if (/(^|[;}\s])(import|export)\s*[\w{*"']/.test(code)) problems.push('ES import/export statement');
  if (/\b(document|window|localStorage|sessionStorage|Intl)\b/.test(code)) problems.push('browser API (DOM / storage / Intl)');
  if (/=>|\b(const|let|class)\s/.test(code)) problems.push('ES2015+ syntax that was not transpiled');
  for (const name of ['onMessageSendHandler', 'onAppointmentSendHandler']) {
    if (!new RegExp(`associate\\(["']${name}["']`).test(code)) problems.push(`Office.actions.associate is missing for ${name}`);
  }

  // The browser runtime does not invoke the handlers without Office.onReady() before the associate calls.
  const onReadyAt = code.indexOf('Office.onReady');
  const associateAt = code.indexOf('Office.actions.associate');
  if (onReadyAt === -1 || associateAt === -1 || onReadyAt > associateAt) {
    problems.push('Office.onReady() must come before Office.actions.associate');
  }

  // Every build rule must be in the bundle (DefinePlugin).
  const flat = normalize(code);
  for (const key of ['blockedDays', 'workingDays', 'sendHour', 'sendMinute', 'slotTimes', 'dayCount', 'defaultLanguage']) {
    const expected = `${key}:${JSON.stringify(rules[key])}`;
    if (!flat.includes(expected)) {
      problems.push(`rule ${expected} is missing from the bundle`);
    }
  }
  // Exceptional send: checked only when the environment defines `bypass` (otherwise nothing is injected).
  // Terser writes the booleans as !0 / !1; true / false are also accepted (development build).
  if (rules.bypass) {
    const flag = rules.bypass.enabled ? '(?:!0|true)' : '(?:!1|false)';
    const expected = new RegExp(
      `bypass:\\{enabled:${flag},minLength:${rules.bypass.minLength},maxLength:${rules.bypass.maxLength},` +
        `minWords:${rules.bypass.minWords},minDistinctChars:${rules.bypass.minDistinctChars}` +
        (rules.bypass.mfa
          ? `,mfa:\\{required:${rules.bypass.mfa.required ? '(?:!0|true)' : '(?:!1|false)'},` +
            `tenantId:"${rules.bypass.mfa.tenantId}",clientId:"${rules.bypass.mfa.clientId}",` +
            `authContext:"${rules.bypass.mfa.authContext}"\\}`
          : '') +
        '\\}'
    );
    if (!expected.test(flat)) {
      problems.push(`rule bypass:${JSON.stringify(rules.bypass)} is missing from the bundle`);
    }
  }
  // MSAL (Entra authentication) must NEVER enter the JavaScript-only events runtime: it
  // belongs to the task pane (taskpane.js).
  if (/msal|@azure\//i.test(code)) problems.push('MSAL / @azure in the events bundle (reserved for the task pane)');
  return problems;
}

module.exports = { checkLaunchEvent, normalize };

if (require.main === module) {
  try {
    const ctx = getBuildContext(process.env);
    const file = path.join(ctx.outDir, 'launchevent.js');
    const code = fs.readFileSync(file, 'utf8');
    const problems = checkLaunchEvent(code, ctx.rules);
    const rel = path.relative(ctx.root, file).replace(/\\/g, '/');
    if (problems.length) {
      console.error(`${rel} is not compliant: ${problems.join('; ')}`);
      process.exit(1);
    }
    console.log(
      `${rel} is compliant (${code.length} bytes, classic, ASCII, no DOM, blocked days ${JSON.stringify(ctx.rules.blockedDays)}, working days ${JSON.stringify(ctx.rules.workingDays)}).`
    );
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
