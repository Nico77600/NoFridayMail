'use strict';

/*
 * Manifest generation from manifest.xml (development template, https://localhost:3000).
 *  - always: replaces the development origin with the public origin;
 *  - with an environment: also applies Id, Version, ProviderName, DisplayName (+ en-US / en-GB labels),
 *    SupportUrl, the ribbon group label, and the Description and button tooltip texts, which name the blocked days
 *    of the environment (same day names and phrasing fragments as the user interface, src/shared/config.js).
 * Each replacement must hit exactly one occurrence: otherwise the template changed and the build fails.
 */

const config = require('../src/shared/config');

const DEV_ORIGIN = 'https://localhost:3000';

/** Days in the order of the week the user sees (Monday first, Sunday last). */
const weekOrder = (days) => days.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));

/** "a, b and c" with the language's own conjunction. */
function joinNatural(items, and) {
  return items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + and + items[items.length - 1];
}

/**
 * Description and button tooltip of the manifest for the blocked days of an environment, in the three locales
 * (French is the default value, en-US and en-GB carry the English text). Manifest limits: Description 250
 * characters, tooltip 250 characters.
 */
function manifestTexts(rules) {
  const blocked = weekOrder(rules.blockedDays);
  // "Another working day" unless the environment also proposes weekend days.
  const weekdaysOnly = rules.workingDays.every((d) => d >= 1 && d <= 5);
  const text = (lang) => {
    const s = config.languages[lang];
    const phrase = s.daysIntro + joinNatural(blocked.map((d) => s.daysPrefix.replace('{day}', s.dayNames[d])), s.daysAnd);
    const single = joinNatural(blocked.map((d) => s.manifestTooltipDay.replace('{day}', s.dayNames[d])), s.manifestOr);
    return {
      description: s.manifestDescription.replace('{days}', phrase).replace('{otherDay}', weekdaysOnly ? s.manifestOtherWorkingDay : s.manifestOtherDay),
      tooltip: s.manifestTooltip.replace('{days}', single)
    };
  };
  const fr = text('fr');
  const en = text('en');
  return { description: { fr: fr.description, en: en.description }, tooltip: { fr: fr.tooltip, en: en.tooltip } };
}

function replaceOnce(text, pattern, replacement, label) {
  const matches = text.match(new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g'));
  if (!matches || matches.length !== 1) {
    throw new Error(`manifest.xml: "${label}" must appear exactly once (found: ${matches ? matches.length : 0}).`);
  }
  return text.replace(pattern, () => replacement);
}

/** HTTPS origin without a path, from a base URL (ADDIN_BASE_URL). */
function normalizeOrigin(base) {
  const trimmed = String(base || '').trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(trimmed);
  } catch (e) {
    throw new Error(`ADDIN_BASE_URL is invalid: ${trimmed}`);
  }
  if (url.protocol !== 'https:' || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('ADDIN_BASE_URL must be an HTTPS origin without a path (e.g. https://<name>.azurestaticapps.net).');
  }
  return url.origin;
}

function renderManifest(source, origin, env) {
  if (!source.includes(DEV_ORIGIN)) {
    throw new Error(`manifest.xml does not contain ${DEV_ORIGIN}.`);
  }
  let out = source.split(DEV_ORIGIN).join(origin);
  if (env) {
    const name = env.displayName;
    out = replaceOnce(out, /<Id>[^<]*<\/Id>/, `<Id>${env.addinId.toLowerCase()}</Id>`, 'Id');
    out = replaceOnce(out, /<Version>[^<]*<\/Version>/, `<Version>${env.version}</Version>`, 'Version');
    out = replaceOnce(out, /<ProviderName>[^<]*<\/ProviderName>/, `<ProviderName>${env.providerName}</ProviderName>`, 'ProviderName');
    out = replaceOnce(
      out,
      /<DisplayName DefaultValue="[^"]*">[\s\S]*?<\/DisplayName>/,
      `<DisplayName DefaultValue="${name}">\n    <Override Locale="en-US" Value="${name}" />\n    <Override Locale="en-GB" Value="${name}" />\n  </DisplayName>`,
      'DisplayName'
    );
    out = replaceOnce(out, /<SupportUrl DefaultValue="[^"]*" \/>/, `<SupportUrl DefaultValue="${env.supportUrl}" />`, 'SupportUrl');
    out = replaceOnce(out, /<bt:String id="GroupLabel" DefaultValue="[^"]*" \/>/, `<bt:String id="GroupLabel" DefaultValue="${name}" />`, 'GroupLabel');
    const texts = manifestTexts(env.rules);
    out = replaceOnce(
      out,
      /<Description DefaultValue="[^"]*">[\s\S]*?<\/Description>/,
      `<Description DefaultValue="${texts.description.fr}">\n    <Override Locale="en-US" Value="${texts.description.en}" />\n    <Override Locale="en-GB" Value="${texts.description.en}" />\n  </Description>`,
      'Description'
    );
    out = replaceOnce(
      out,
      /<bt:String id="TaskpaneButton\.Tooltip" DefaultValue="[^"]*">[\s\S]*?<\/bt:String>/,
      `<bt:String id="TaskpaneButton.Tooltip" DefaultValue="${texts.tooltip.fr}">\n            <bt:Override Locale="en-US" Value="${texts.tooltip.en}" />\n            <bt:Override Locale="en-GB" Value="${texts.tooltip.en}" />\n          </bt:String>`,
      'TaskpaneButton.Tooltip'
    );
  }
  if (out.includes('localhost')) {
    throw new Error('The generated manifest still contains "localhost".');
  }
  return out;
}

module.exports = { DEV_ORIGIN, normalizeOrigin, renderManifest, manifestTexts };
