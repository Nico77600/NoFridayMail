'use strict';

// The Description and the button tooltip of the generated manifest name the blocked days of the environment
// (a "NoTuesdayEmail" deployment must not say Friday). The development manifest.xml carries the Friday default text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderManifest, manifestTexts } = require('../tools/manifest-lib');
const config = require('../src/shared/config');

const root = path.join(__dirname, '..');
const manifestSource = fs.readFileSync(path.join(root, 'manifest.xml'), 'utf8');
const base = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'environments', 'base.json'), 'utf8'));

const WEEKDAYS = [1, 2, 3, 4, 5];
const withRules = (blockedDays, workingDays) =>
  Object.assign({}, base, { rules: Object.assign({}, base.rules, { blockedDays, workingDays: workingDays || WEEKDAYS }) });
const render = (env) => renderManifest(manifestSource, 'https://x.azurestaticapps.net', env);
const descriptionBlock = (xml) => /<Description DefaultValue="[^"]*">[\s\S]*?<\/Description>/.exec(xml)[0];
const tooltipBlock = (xml) => /<bt:String id="TaskpaneButton\.Tooltip"[\s\S]*?<\/bt:String>/.exec(xml)[0];
const FRIDAY_WORDS = /vendredi|Friday|samedi|Saturday/i;

test('manifest texts: blocked day [2] names Tuesday in French, en-US and en-GB and never Friday or the weekend', () => {
  const xml = render(withRules([2]));
  const description = descriptionBlock(xml);
  const tooltip = tooltipBlock(xml);
  assert.match(description, /DefaultValue="Bloque l'envoi des e-mails et des invitations le mardi et propose de planifier l'envoi un autre jour ouvré\."/);
  assert.match(description, /Locale="en-US" Value="Blocks sending emails and meeting invitations on Tuesdays and offers to schedule them for another working day\."/);
  assert.match(description, /Locale="en-GB" Value="Blocks sending emails and meeting invitations on Tuesdays/);
  assert.match(tooltip, /DefaultValue="Planifie l'envoi du message un autre jour que le mardi /);
  assert.match(tooltip, /Locale="en-US" Value="Schedules the message to be sent on a day other than Tuesday /);
  assert.doesNotMatch(description, FRIDAY_WORDS);
  assert.doesNotMatch(tooltip, FRIDAY_WORDS);
});

test('manifest texts: several blocked days are joined naturally, in week order', () => {
  const texts = manifestTexts(withRules([5, 1]).rules);
  assert.match(texts.description.fr, /le lundi et le vendredi et propose/);
  assert.match(texts.description.en, /on Mondays and Fridays and offers/);
  assert.match(texts.tooltip.fr, /un autre jour que le lundi ou le vendredi /);
  assert.match(texts.tooltip.en, /a day other than Monday or Friday /);
  const three = manifestTexts(withRules([1, 3, 5]).rules);
  assert.match(three.description.fr, /le lundi, le mercredi et le vendredi/);
  assert.match(three.description.en, /on Mondays, Wednesdays and Fridays/);
  assert.match(three.tooltip.en, /Monday, Wednesday or Friday/);
});

test('manifest texts: "working day" only when weekend days are not proposed', () => {
  const weekdays = manifestTexts(withRules([5]).rules);
  assert.match(weekdays.description.fr, /un autre jour ouvré\.$/);
  assert.match(weekdays.description.en, /for another working day\.$/);
  const weekend = manifestTexts(withRules([5], [1, 2, 3, 4, 5, 6]).rules);
  assert.match(weekend.description.fr, /un autre jour\.$/);
  assert.match(weekend.description.en, /for another day\.$/);
});

test('manifest texts: stay within the manifest limits (250 characters) whatever the blocked days', () => {
  const combos = [[0], [1], [2], [3], [4], [5], [6], [0, 1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 6]];
  for (const days of combos) {
    for (const working of [WEEKDAYS, [0, 1, 2, 3, 4, 5, 6]]) {
      if (working.every((d) => days.includes(d))) continue;
      const texts = manifestTexts(withRules(days, working).rules);
      for (const [kind, byLang] of Object.entries(texts)) {
        for (const [lang, text] of Object.entries(byLang)) {
          assert.ok(text.length <= 250, `${kind} ${lang} ${days}: ${text.length} characters`);
          assert.doesNotMatch(text, /[<>&"]/, `${kind} ${lang}: safe inside an XML attribute`);
        }
      }
    }
  }
});

test('manifest texts: the development manifest.xml carries exactly the text generated for the default (Friday)', () => {
  const texts = manifestTexts({ blockedDays: config.blockedDays, workingDays: config.workingDays });
  assert.deepEqual(config.blockedDays, [5]);
  assert.ok(manifestSource.includes(`<Description DefaultValue="${texts.description.fr}">`));
  assert.ok(manifestSource.includes(`<Override Locale="en-US" Value="${texts.description.en}" />`));
  assert.ok(manifestSource.includes(`<bt:String id="TaskpaneButton.Tooltip" DefaultValue="${texts.tooltip.fr}">`));
  assert.ok(manifestSource.includes(`<bt:Override Locale="en-GB" Value="${texts.tooltip.en}" />`));
  // An environment that keeps the default rules produces the development text unchanged.
  const friday = render(withRules([5]));
  assert.equal(descriptionBlock(friday).replace(/\s+/g, ' '), descriptionBlock(manifestSource).replace(/\s+/g, ' '));
  assert.equal(tooltipBlock(friday).replace(/\s+/g, ' '), tooltipBlock(manifestSource).replace(/\s+/g, ' '));
});

test('manifest texts: the manifest of a "NoTuesdayEmail" environment says Tuesday everywhere a day is named', () => {
  const env = Object.assign(withRules([2]), { displayName: 'NoTuesdayEmail' });
  const xml = render(env);
  assert.match(xml, /<DisplayName DefaultValue="NoTuesdayEmail">/);
  assert.match(xml, /id="GroupLabel" DefaultValue="NoTuesdayEmail"/);
  const dayText = xml.match(/(?:Value|DefaultValue)="[^"]*\b(?:vendredi|samedi|Friday|Saturday)s?\b[^"]*"/gi) || [];
  assert.deepEqual(dayText, [], 'no text of the generated manifest names Friday or Saturday');
});
