'use strict';

/*
 * Configuration shared by the event runtime and the task pane.
 *
 * Constraints: this file is bundled into launchevent.js, run by the
 * JavaScript-only runtime of classic Outlook on Windows (no DOM, no ES
 * imports, no localStorage, no Intl). Keep to plain ES5.
 *
 * Languages: fr (default, the product language) and en. The language is read ON EVERY CALL
 * (Office.context.displayLanguage) through detectLang() then forLang(): any fr*
 * gives fr, any other language gives en, a missing language gives DEFAULT_LANG.
 * Both string sets have exactly the same keys and the same {placeholders}
 * (checked by tests/i18n.test.js). Smart Alerts limits: message <= 500 characters,
 * cancelLabel <= 20 characters, in each language.
 */

/*
 * Rules injected at build time: webpack DefinePlugin replaces __NFM_RULES__ with the JSON object of the
 * environment rules (deploy/environments/<name>.json, then BLOCKED_DAYS / WORKING_DAYS overrides), see
 * tools/env-config.js. Under Node (tests) or without injection, the identifier does not exist and the defaults
 * below apply (same as DEFAULT_RULES in tools/env-config.js).
 */
var BUILD = typeof __NFM_RULES__ !== 'undefined' ? __NFM_RULES__ : null;

var bypass = require('./bypass');

// Fallback language when Outlook does not provide the display language.
var DEFAULT_LANG = BUILD && BUILD.defaultLanguage === 'en' ? 'en' : 'fr';

var STRINGS = {
  fr: {
    dayNames: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
    monthNames: [
      'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
      'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'
    ],

    // Short forms (day cards, button summary).
    dayShort: ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'],
    monthShort: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
    summaryFormat: '{weekday} {day} {month} à {time}',
    dayFullFormat: '{weekday} {day} {month}',

    // Date format (French ordinal for the first of the month).
    dateFormat: '{weekday} {day} {month} {year} à {time}',
    firstSuffix: 'er',
    time12h: false,

    // Label of the dialog button (20 characters maximum, Microsoft docs).
    cancelLabel: "Planifier l'envoi",

    // Fragments (placeholders: {days}, {date}, {suggestions}, {time}, {day}, {nextDay}).
    daysIntro: '',
    daysPrefix: 'le {day}',
    daysAnd: ' et ',
    suggestionOr: '{a} ou {b}',

    // Texts of the generated manifest (tools/manifest-lib.js): description and button tooltip name the blocked days.
    manifestDescription: "Bloque l'envoi des e-mails et des invitations {days} et propose de planifier l'envoi {otherDay}.",
    manifestTooltip: "Planifie l'envoi du message un autre jour que {days} (jour proposé ou date personnalisée).",
    manifestTooltipDay: 'le {day}',
    manifestOr: ' ou ',
    manifestOtherDay: 'un autre jour',
    manifestOtherWorkingDay: 'un autre jour ouvré',

    // Emails: dialog messages (500 characters maximum).
    // The Markdown variants (Mailbox 1.15) use bold only.
    messageBlocked:
      "L'envoi de messages est interdit {days}. Utilisez « Planifier l'envoi » pour envoyer le message {suggestions} à {time}.",
    messageBlockedMd:
      "L'envoi de messages est **interdit {days}**.\n\nUtilisez « Planifier l'envoi » pour envoyer le message **{suggestions}** à {time}.",
    messageBlockedDelayed:
      "L'envoi est planifié {date}, un jour où l'envoi est interdit ({days}). Utilisez « Planifier l'envoi » pour choisir un autre jour : {suggestions} à {time}.",
    messageBlockedDelayedMd:
      "L'envoi est planifié **{date}**, un jour où l'envoi est **interdit** ({days}).\n\nUtilisez « Planifier l'envoi » pour choisir un autre jour : **{suggestions}** à {time}.",
    messageBlockedNoDelayApi:
      "L'envoi de messages est interdit {days}. Ce complément ne peut pas planifier l'envoi dans votre version d'Outlook : utilisez l'option native « Différer la remise » (onglet Options) pour choisir un autre jour.",
    messageBlockedNoDelayApiMd:
      "L'envoi de messages est **interdit {days}**.\n\nCe complément ne peut pas planifier l'envoi dans votre version d'Outlook : utilisez l'option native **Différer la remise** (onglet Options) pour choisir un autre jour.",
    messageBlockedNoDay:
      "L'envoi de messages est interdit {days} et aucun autre jour ouvré n'est disponible. Contactez votre administrateur.",
    messageBlockedNoDayMd:
      "L'envoi de messages est **interdit {days}** et aucun autre jour ouvré n'est disponible.\n\nContactez votre administrateur.",
    messageCheckFailed:
      "Impossible de vérifier la date de remise planifiée du message. Réessayez d'envoyer ; si le problème persiste, contactez votre administrateur.",
    // Appended to the messages above only if the exceptional send is enabled (bypass.enabled).
    messageBypassHint:
      "Envoi exceptionnel : ouvrez « Planifier l'envoi », section « Envoi exceptionnel » (demande journalisée, soumise à autorisation).",
    messageBypassHintMd:
      "**Envoi exceptionnel** : ouvrez « Planifier l'envoi », section « Envoi exceptionnel » (demande journalisée, soumise à autorisation).",
    // Support codes appended only when a justification was found but refused (see handlers.js).
    messageBypassCodeB2: 'code NFM-B2 : justification mal formée',
    messageBypassCodeB3: 'code NFM-B3 : reçu invalide ou trop ancien',

    // Meetings: no deferral possible.
    appointmentBlocked:
      "Les invitations ne peuvent pas être envoyées {days}. La réunion n'a pas été envoyée : envoyez-la à partir de {nextDay}.",
    appointmentBlockedMd:
      "Les invitations **ne peuvent pas être envoyées {days}**.\n\nLa réunion n'a pas été envoyée : envoyez-la à partir de **{nextDay}**.",
    appointmentBlockedNoDay:
      "Les invitations ne peuvent pas être envoyées {days} et aucun autre jour ouvré n'est disponible. La réunion n'a pas été envoyée.",
    appointmentBlockedNoDayMd:
      "Les invitations **ne peuvent pas être envoyées {days}** et aucun autre jour ouvré n'est disponible.\n\nLa réunion n'a pas été envoyée.",

    // Task pane.
    tpTitle: "Planifier l'envoi",
    tpIntro: 'Les envois sont interdits {days}. Choisissez quand ce message doit partir.',
    tpRemove: 'Retirer la planification',
    tpSuggestions: 'Suggestions',
    tpDays: 'Choisir un jour',
    tpTimes: 'Heure',
    tpPickDayFirst: "Choisissez d'abord un jour.",
    tpToday: "Aujourd'hui",
    tpTomorrow: 'Demain',
    tpOption: '{day} à {time}',
    tpNoDays: 'Aucun jour ouvré disponible.',
    tpCtaNone: 'Choisissez un jour et une heure',
    tpCtaPickTime: 'Choisissez une heure',
    tpCtaSchedule: "Planifier l'envoi · {summary}",
    tpCtaSend: 'Planifier et envoyer · {summary}',
    tpSummary: 'Envoi prévu : {date}',
    tpSummaryNone: 'Aucun créneau choisi.',
    tpCurrentNone: 'Aucun envoi planifié : le message partira dès que vous cliquerez sur Envoyer.',
    tpCurrentDelayed: 'Envoi actuellement planifié : {date}.',
    tpCurrentDelayedBlocked: 'Envoi actuellement planifié : {date}. Ce jour est interdit, choisissez une autre date.',
    // {day} = chosen day (all French day names are masculine, hence the masculine article).
    tpBlockedCustom: "Le {day} n'est pas autorisé, choisissez un autre jour",
    tpInvalidCustom: 'Date ou heure invalide.',
    tpPastCustom: 'La date doit être dans le futur.',
    tpSending: 'Envoi planifié pour {date}, envoi en cours…',
    tpSendFailed: "L'envoi automatique a échoué ({error}). L'envoi est planifié : cliquez sur Envoyer.",
    tpVerifyFailed:
      "La planification n'a pas pu être vérifiée : le message n'a pas été envoyé. Réessayez ou utilisez « Différer la remise » (onglet Options).",
    tpScheduled: 'Envoi planifié — cliquez de nouveau sur Envoyer ({date}).',
    tpRemoved: 'Planification retirée. Le message partira dès que vous cliquerez sur Envoyer.',
    tpRemoveFailed:
      "Impossible de retirer la planification depuis ce complément. Utilisez « Différer la remise » dans l'onglet Options d'Outlook.",
    tpScheduleFailed: 'La planification a échoué : {error}',
    tpNoDelayApi:
      "Votre version d'Outlook ne permet pas de planifier l'envoi depuis ce complément. Utilisez l'option native « Différer la remise » (onglet Options) pour choisir un autre jour que {days}.",
    tpNotCompose: 'Ouvrez ce volet depuis un message en cours de rédaction.',

    // Justified exceptional send (only if bypass.enabled and Mailbox 1.8: internetHeaders).
    // Authorisation is verified server-side: the task pane cannot know whether the user is entitled.
    tpBypassTitle: 'Envoi exceptionnel',
    tpBypassIntro:
      "Si ce message ne peut pas attendre, indiquez pourquoi. Votre demande est journalisée pour la conformité ; le message peut être refusé si vous n'y êtes pas autorisé.",
    tpBypassLabel: 'Justification (obligatoire)',
    tpBypassCounter: '{count} / {max} caractères (minimum {min})',
    // One message per refusal reason of bypass.validateJustification (shown live under the field).
    tpBypassEmpty: "Expliquez en quelques mots pourquoi l'envoi ne peut pas attendre (au moins {words} mots).",
    tpBypassTooShort: 'Justification trop courte : {min} caractères minimum.',
    tpBypassTooLong: 'Justification trop longue : {max} caractères maximum.',
    tpBypassWords: "Utilisez au moins {words} mots de 3 lettres ou plus pour expliquer pourquoi l'envoi ne peut pas attendre.",
    tpBypassDistinct: 'Cette justification semble répétitive : décrivez la situation avec vos propres mots.',
    tpBypassRepeat: 'Évitez de répéter le même caractère plus de 4 fois de suite.',
    tpBypassSend: 'Envoyer avec justification',
    tpBypassSending: 'Justification enregistrée, envoi en cours…',
    tpBypassSendFailed: "L'envoi automatique a échoué ({error}). La justification est enregistrée : cliquez sur Envoyer.",
    tpBypassReady: "Justification enregistrée — cliquez sur Envoyer. Le message sera refusé si vous n'y êtes pas autorisé.",
    tpBypassFailed: "La justification n'a pas pu être enregistrée : {error}. Le message n'a pas été envoyé.",
    tpBypassVerifyFailed:
      "La justification n'a pas pu être vérifiée : le message n'a pas été envoyé. Réessayez.",
    tpBypassDelayFailed:
      "La planification en cours n'a pas pu être retirée : le message n'a pas été envoyé. Utilisez « Retirer la planification » puis réessayez.",
    tpBypassSaved: 'Justification enregistrée : « {text} »',
    tpBypassRemove: 'Retirer la justification',
    tpBypassRemoved: 'Justification retirée.',
    tpBypassRemoveFailed: "La justification n'a pas pu être retirée : {error}",

    // MFA step (bypass.mfa.required): identity verified by Entra ID, receipt issued by the site API.
    tpBypassMfaIntro:
      "Si ce message ne peut pas attendre, indiquez pourquoi, puis validez votre identité (authentification multifacteur). Votre demande est journalisée pour la conformité ; le message peut être refusé si vous n'y êtes pas autorisé.",
    tpBypassMfaSend: 'Valider mon identité et envoyer',
    tpBypassMfaReuse: "La vérification d'identité peut être réutilisée pendant 5 minutes.",
    tpBypassMfaChecking: 'Vérification de votre identité…',
    tpBypassMfaSending: 'Identité vérifiée, envoi…',
    tpBypassMfaReady:
      "Identité vérifiée, justification enregistrée — cliquez sur Envoyer. Le message sera refusé si vous n'y êtes pas autorisé.",
    tpBypassMfaCancelled: "Vérification annulée. Le message n'a pas été envoyé.",
    tpBypassMfaPopupBlocked:
      "La fenêtre de vérification d'identité a été bloquée. Autorisez les fenêtres contextuelles pour Outlook dans votre navigateur, puis réessayez.",
    tpBypassMfaPreparing: 'Préparation de la vérification… réessayez dans un instant.',
    tpBypassMfaClaimsRetry: 'Une nouvelle vérification est nécessaire : cliquez sur « Réessayer la vérification ».',
    tpBypassMfaRetry: 'Réessayer la vérification',
    tpBypassMfaFailed: "La validation de votre identité a échoué ({error}). Le message n'a pas été envoyé.",
    tpBypassMfaRejected: 'Justification refusée par le service : {reason}',
    tpBypassUnauthorized:
      "Votre identité n'a pas pu être validée (authentification multifacteur requise) : le message n'a pas été envoyé.",
    tpBypassTokenRejected: "Jeton refusé par le serveur (diagnostic dans le journal de l'API). Le message n'a pas été envoyé.",
    tpBypassNetwork:
      "Le service de justification est injoignable : vérifiez votre connexion. Le message n'a pas été envoyé.",
    tpBypassServerError: "Le service de justification a répondu par une erreur ({status}). Le message n'a pas été envoyé.",
    tpBypassMfaUnsupported: "Votre version d'Outlook ne permet pas l'envoi exceptionnel."
  },

  en: {
    dayNames: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    monthNames: [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ],

    dayShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    monthShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    summaryFormat: '{weekday}, {month} {day} at {time}',
    dayFullFormat: '{weekday}, {month} {day}',

    // Date format: "Saturday, October 31, 2026 at 8:00 AM".
    dateFormat: '{weekday}, {month} {day}, {year} at {time}',
    firstSuffix: '',
    time12h: true,

    cancelLabel: 'Schedule send',

    daysIntro: 'on ',
    daysPrefix: '{day}s',
    daysAnd: ' and ',
    suggestionOr: '{a} or {b}',

    manifestDescription: 'Blocks sending emails and meeting invitations {days} and offers to schedule them for {otherDay}.',
    manifestTooltip: 'Schedules the message to be sent on a day other than {days} (a proposed day or a custom date).',
    manifestTooltipDay: '{day}',
    manifestOr: ' or ',
    manifestOtherDay: 'another day',
    manifestOtherWorkingDay: 'another working day',

    messageBlocked:
      "Sending messages is not allowed {days}. Use \"Schedule send\" to send the message on {suggestions} at {time}.",
    messageBlockedMd:
      "Sending messages is **not allowed {days}**.\n\nUse \"Schedule send\" to send the message on **{suggestions}** at {time}.",
    messageBlockedDelayed:
      "Sending is scheduled for {date}, a day when sending is not allowed ({days}). Use \"Schedule send\" to pick another day: {suggestions} at {time}.",
    messageBlockedDelayedMd:
      "Sending is scheduled for **{date}**, a day when sending is **not allowed** ({days}).\n\nUse \"Schedule send\" to pick another day: **{suggestions}** at {time}.",
    messageBlockedNoDelayApi:
      "Sending messages is not allowed {days}. This add-in cannot schedule sending in your version of Outlook: use the built-in \"Delay Delivery\" option (Options tab) to pick another day.",
    messageBlockedNoDelayApiMd:
      "Sending messages is **not allowed {days}**.\n\nThis add-in cannot schedule sending in your version of Outlook: use the built-in **Delay Delivery** option (Options tab) to pick another day.",
    messageBlockedNoDay:
      "Sending messages is not allowed {days} and no other working day is available. Contact your administrator.",
    messageBlockedNoDayMd:
      "Sending messages is **not allowed {days}** and no other working day is available.\n\nContact your administrator.",
    messageCheckFailed:
      "Unable to check the scheduled delivery time of the message. Try sending again; if the problem persists, contact your administrator.",
    messageBypassHint:
      "Exceptional send: open \"Schedule send\", \"Exceptional send\" section (request is logged and subject to authorization).",
    messageBypassHintMd:
      "**Exceptional send**: open \"Schedule send\", \"Exceptional send\" section (request is logged and subject to authorization).",
    messageBypassCodeB2: 'code NFM-B2: justification malformed',
    messageBypassCodeB3: 'code NFM-B3: receipt invalid or too old',

    appointmentBlocked:
      "Meeting invitations cannot be sent {days}. The meeting was not sent: send it starting {nextDay}.",
    appointmentBlockedMd:
      "Meeting invitations **cannot be sent {days}**.\n\nThe meeting was not sent: send it starting **{nextDay}**.",
    appointmentBlockedNoDay:
      "Meeting invitations cannot be sent {days} and no other working day is available. The meeting was not sent.",
    appointmentBlockedNoDayMd:
      "Meeting invitations **cannot be sent {days}** and no other working day is available.\n\nThe meeting was not sent.",

    tpTitle: 'Schedule send',
    tpIntro: 'Sending is not allowed {days}. Choose when this message should go out.',
    tpRemove: 'Remove scheduling',
    tpSuggestions: 'Suggestions',
    tpDays: 'Choose a day',
    tpTimes: 'Time',
    tpPickDayFirst: 'Choose a day first.',
    tpToday: 'Today',
    tpTomorrow: 'Tomorrow',
    tpOption: '{day} at {time}',
    tpNoDays: 'No working day available.',
    tpCtaNone: 'Choose a day and time',
    tpCtaPickTime: 'Choose a time',
    tpCtaSchedule: 'Schedule send · {summary}',
    tpCtaSend: 'Schedule and send · {summary}',
    tpSummary: 'Scheduled for: {date}',
    tpSummaryNone: 'No time slot chosen.',
    tpCurrentNone: 'No scheduled send: the message goes out as soon as you click Send.',
    tpCurrentDelayed: 'Currently scheduled to send: {date}.',
    tpCurrentDelayedBlocked: 'Currently scheduled to send: {date}. Sending is not allowed that day, choose another date.',
    tpBlockedCustom: '{day} is not allowed, choose another day',
    tpInvalidCustom: 'Invalid date or time.',
    tpPastCustom: 'The date must be in the future.',
    tpSending: 'Send scheduled for {date}, sending now…',
    tpSendFailed: 'Automatic sending failed ({error}). The send is scheduled: click Send.',
    tpVerifyFailed:
      "The scheduling could not be verified: the message was not sent. Try again or use \"Delay Delivery\" (Options tab).",
    tpScheduled: 'Send scheduled — click Send again ({date}).',
    tpRemoved: 'Scheduling removed. The message goes out as soon as you click Send.',
    tpRemoveFailed:
      "Unable to remove the scheduling from this add-in. Use \"Delay Delivery\" on the Options tab in Outlook.",
    tpScheduleFailed: 'Scheduling failed: {error}',
    tpNoDelayApi:
      "Your version of Outlook does not allow this add-in to schedule sending. Use the built-in \"Delay Delivery\" option (Options tab) to pick a day other than {days}.",
    tpNotCompose: 'Open this pane from a message you are composing.',

    tpBypassTitle: 'Exceptional send',
    tpBypassIntro:
      "If this message cannot wait, explain why. Your request is logged for compliance; the message may be rejected if you are not authorized.",
    tpBypassLabel: 'Justification (required)',
    tpBypassCounter: '{count} / {max} characters (minimum {min})',
    tpBypassEmpty: 'Explain in a few words why this message cannot wait (at least {words} words).',
    tpBypassTooShort: 'Justification too short: {min} characters minimum.',
    tpBypassTooLong: 'Justification too long: {max} characters maximum.',
    tpBypassWords: 'Use at least {words} words of 3 letters or more to explain why this message cannot wait.',
    tpBypassDistinct: 'This justification looks repetitive: describe the situation in your own words.',
    tpBypassRepeat: 'Avoid repeating the same character more than 4 times in a row.',
    tpBypassSend: 'Send with justification',
    tpBypassSending: 'Justification saved, sending now…',
    tpBypassSendFailed: 'Automatic sending failed ({error}). The justification is saved: click Send.',
    tpBypassReady: 'Justification saved — click Send. The message will be rejected if you are not authorized.',
    tpBypassFailed: 'The justification could not be saved: {error}. The message was not sent.',
    tpBypassVerifyFailed: 'The justification could not be verified: the message was not sent. Try again.',
    tpBypassDelayFailed:
      'The current scheduling could not be removed: the message was not sent. Use "Remove scheduling", then try again.',
    tpBypassSaved: 'Justification saved: "{text}"',
    tpBypassRemove: 'Remove justification',
    tpBypassRemoved: 'Justification removed.',
    tpBypassRemoveFailed: 'The justification could not be removed: {error}',

    tpBypassMfaIntro:
      'If this message cannot wait, explain why, then confirm your identity (multi-factor authentication). Your request is logged for compliance; the message may be rejected if you are not authorized.',
    tpBypassMfaSend: 'Confirm my identity and send',
    tpBypassMfaReuse: 'Identity verification may be reused for 5 minutes.',
    tpBypassMfaChecking: 'Checking your identity…',
    tpBypassMfaSending: 'Identity confirmed, sending…',
    tpBypassMfaReady:
      'Identity confirmed, justification saved — click Send. The message will be rejected if you are not authorized.',
    tpBypassMfaCancelled: 'Verification cancelled. The message was not sent.',
    tpBypassMfaPopupBlocked:
      'The identity verification pop-up was blocked. Allow pop-ups for Outlook in your browser, then try again.',
    tpBypassMfaPreparing: 'Preparing the verification… try again in a moment.',
    tpBypassMfaClaimsRetry: 'A new verification is required: click "Retry verification".',
    tpBypassMfaRetry: 'Retry verification',
    tpBypassMfaFailed: 'Identity confirmation failed ({error}). The message was not sent.',
    tpBypassMfaRejected: 'Justification rejected by the service: {reason}',
    tpBypassUnauthorized:
      'Your identity could not be confirmed (multi-factor authentication required): the message was not sent.',
    tpBypassTokenRejected: 'Token rejected by the server (diagnostic in the API log). The message was not sent.',
    tpBypassNetwork: 'The justification service is unreachable: check your connection. The message was not sent.',
    tpBypassServerError: 'The justification service returned an error ({status}). The message was not sent.',
    tpBypassMfaUnsupported: 'Your version of Outlook does not support exceptional send.'
  }
};

/** Language handled for a displayLanguage value: fr* -> fr, other -> en, missing -> DEFAULT_LANG. */
function resolveLang(lang) {
  if (typeof lang !== 'string' || lang.replace(/\s/g, '') === '') {
    return DEFAULT_LANG;
  }
  return /^fr([-_]|$)/i.test(lang.replace(/^\s+/, '')) ? 'fr' : 'en';
}

/** String set for a language (see resolveLang). */
function pickStrings(lang) {
  return STRINGS[resolveLang(lang)];
}

/** Outlook display language, read at call time; undefined if unavailable. */
function detectLang() {
  try {
    return Office.context.displayLanguage;
  } catch (e) {
    return undefined;
  }
}

var config = {
  // Blocked days, as in Date.getDay(): 0 = Sunday ... 5 = Friday ... 6 = Saturday. Default [5].
  blockedDays: BUILD ? BUILD.blockedDays : [5],

  // Time proposed for a scheduled send (client local time). Default 08:00.
  sendHour: BUILD ? BUILD.sendHour : 8,
  sendMinute: BUILD ? BUILD.sendMinute : 0,

  // Working days proposed (Date.getDay()): weekends are not BLOCKED (a manual send on a Saturday or
  // a native delayed delivery on a Saturday remains allowed) but are never proposed. Default [1,2,3,4,5].
  // Proposed days = working AND not blocked.
  workingDays: BUILD ? BUILD.workingDays : [1, 2, 3, 4, 5],

  // Task pane: proposed time slots (HH:MM, 8 at most) and number of allowed days shown.
  slotTimes: BUILD ? BUILD.slotTimes : ['08:00', '09:00', '10:00', '11:00', '14:00', '16:00'],
  dayCount: BUILD ? BUILD.dayCount : 10,

  // Justified exceptional send (X-NoFriday-Bypass header, see bypass.js). Disabled when the build
  // does not inject a bypass object: { enabled, minLength, maxLength }.
  bypass: bypass.normalizeSettings(BUILD ? BUILD.bypass : null),

  // Id of the task pane button in manifest.xml (Control id).
  // It is reused as the commandId of the Smart Alerts dialog.
  taskPaneCommandId: 'msgComposeSchedulePaneButton',

  DEFAULT_LANG: DEFAULT_LANG,
  languages: STRINGS,

  // Strings of the default language (fr): convenient for pure functions and tests.
  strings: STRINGS[DEFAULT_LANG],

  resolveLang: resolveLang,
  pickStrings: pickStrings,
  detectLang: detectLang,

  /**
   * Configuration to use for a call: same settings, strings in the requested language.
   * `lang` omitted: Outlook display language. Settings are read again on each call.
   */
  forLang: function (lang) {
    var effective = arguments.length === 0 ? detectLang() : lang;
    return {
      blockedDays: config.blockedDays,
      sendHour: config.sendHour,
      sendMinute: config.sendMinute,
      workingDays: config.workingDays,
      slotTimes: config.slotTimes,
      dayCount: config.dayCount,
      bypass: config.bypass,
      taskPaneCommandId: config.taskPaneCommandId,
      lang: resolveLang(effective),
      strings: pickStrings(effective)
    };
  }
};

module.exports = config;
