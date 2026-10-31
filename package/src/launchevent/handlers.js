'use strict';

/*
 * OnMessageSend / OnAppointmentSend handlers (Smart Alerts).
 *
 * Run in the JavaScript-only runtime of classic Outlook on Windows:
 * no DOM, no localStorage, no Intl, no ES imports. The final bundle
 * (launchevent.js) is a single classic file produced by webpack.
 * The global `Office` is read at call time (never at import time) so this
 * module stays testable under Node with a fake `Office`.
 *
 * Language: read on each call (Office.context.displayLanguage); every function
 * receives `cfg = config.forLang()` (settings + strings in the user's language).
 */

var config = require('../shared/config');
var rules = require('../shared/rules');
var bypass = require('../shared/bypass');

function isSetSupported(version) {
  try {
    return !!(
      Office.context &&
      Office.context.requirements &&
      Office.context.requirements.isSetSupported('Mailbox', version)
    );
  } catch (e) {
    return false;
  }
}

/**
 * Exceptional send: enabled in the environment AND Internet headers readable (Mailbox 1.8, message being
 * composed). An appointment has no internetHeaders and never goes through here anyway.
 */
function headersAvailable(item) {
  return !!(
    isSetSupported('1.8') &&
    item &&
    item.internetHeaders &&
    typeof item.internetHeaders.getAsync === 'function'
  );
}

/** item.sessionData (Mailbox 1.11): shared between the task pane and this runtime for the same message being composed. */
function sessionAvailable(item) {
  return !!(
    isSetSupported('1.11') &&
    item &&
    item.sessionData &&
    typeof item.sessionData.getAsync === 'function'
  );
}

function bypassAvailable(cfg, item) {
  return !!(cfg.bypass && cfg.bypass.enabled && (headersAvailable(item) || sessionAvailable(item)));
}

/**
 * Decides the exceptional send: done({ allowed, code }) is called exactly once.
 *   1. X-NoFriday-Bypass header (name compared case-insensitively);
 *   2. otherwise (missing, malformed or unreadable), the sessionData fallback "nfm-bypass" (Mailbox 1.11), written by
 *      the task pane with the same value: the event runtime may not see the written header right away.
 * Same acceptance rule for both (bypass.classifyHeaderValue): a well-formed "v1; ..." or "v2; ...; r=<receipt>"
 * with a justification that passes bypass.validateJustification; with bypass.mfa.required, ONLY "v2", with a
 * receipt of the right shape dated less than a day ago. The receipt signature is NOT verifiable here (no client-side
 * secret): it is verified server-side (API log, tools/verify-receipt.js). The Internet header remains
 * required by the Exchange transport rule: sessionData only helps the client-side decision.
 * Support code in the dialog ONLY when a value was actually found but refused:
 * B2 malformed or weak, B3 receipt malformed or too old. Missing value or refused read (OWA fails
 * for a nonexistent key): no code, normal first request; only a console.warn trace. Real authorisation (group) is checked server-side.
 */
function readBypass(event, cfg, item, done) {
  var finished = false;
  var present = null; // 'malformed' | 'receipt': value present but refused
  var readError = false;
  function finish(verdict) {
    if (!finished) {
      finished = true;
      done(verdict);
    }
  }
  function refuse() {
    var code = present === 'receipt' ? 'B3' : present === 'malformed' ? 'B2' : null;
    if (!code) {
      // Nothing usable (missing or read refused): no code, just a trace for support.
      try {
        console.warn('NoFridayMail: no readable justification (' + (readError ? 'read refused or failed' : 'absent') + ')');
      } catch (e) {
        // console unavailable in this runtime: nothing else to do
      }
    }
    finish({ allowed: false, code: code });
  }
  // Returns true if the value is accepted; otherwise records the most informative reason (B3 before B2).
  function accept(value) {
    var kind = bypass.classifyHeaderValue(value, cfg.bypass, new Date().getTime());
    if (kind === 'ok') {
      finish({ allowed: true, code: null });
      return true;
    }
    if (kind === 'receipt' || (kind === 'malformed' && present !== 'receipt')) {
      present = kind;
    }
    return false;
  }
  function trySession() {
    if (!sessionAvailable(item)) {
      refuse();
      return;
    }
    try {
      item.sessionData.getAsync(bypass.SESSION_KEY, function (result) {
        try {
          if (!result || result.status === Office.AsyncResultStatus.Failed) {
            readError = true;
          } else if (accept(result.value)) {
            return;
          }
        } catch (e) {
          readError = true;
        }
        refuse();
      });
    } catch (e) {
      readError = true;
      refuse();
    }
  }
  if (!headersAvailable(item)) {
    trySession();
    return;
  }
  try {
    item.internetHeaders.getAsync([bypass.HEADER_NAME], { asyncContext: event }, function (result) {
      try {
        if (!result || result.status === Office.AsyncResultStatus.Failed) {
          readError = true;
        } else if (accept(bypass.lookupHeader(result.value, bypass.HEADER_NAME))) {
          return;
        }
      } catch (e) {
        readError = true;
      }
      trySession();
    });
  } catch (e) {
    readError = true;
    trySession();
  }
}

function complete(event, options) {
  try {
    event.completed(options);
  } catch (e) {
    // Nothing else to do: a failure here lets Outlook apply the SoftBlock mode.
  }
}

/**
 * Builds the event.completed options for a blocked email.
 * canDelay: Mailbox 1.13 is available (delayDeliveryTime), so the task
 * pane can schedule the send.
 */
function buildMessageBlockOptions(cfg, evaluation, canDelay, withBypassHint, supportCode) {
  var s = cfg.strings;
  // Suggestions computed from the effective time: the first two working, non-blocked days after it.
  var suggestions = rules.nextAllowedSuggestions(evaluation.effective, cfg);
  var vars = {
    days: rules.blockedDaysLabel(cfg),
    date: rules.formatDate(evaluation.effective, cfg),
    suggestions: rules.suggestionsLabel(suggestions, cfg),
    time: rules.sendTimeLabel(cfg)
  };
  var plainKey;
  var mdKey;
  var noDay = !suggestions.first;
  if (noDay) {
    // No working, non-blocked day: nothing to propose, so no "Schedule" button.
    plainKey = 'messageBlockedNoDay';
    mdKey = 'messageBlockedNoDayMd';
  } else if (!canDelay) {
    plainKey = 'messageBlockedNoDelayApi';
    mdKey = 'messageBlockedNoDelayApiMd';
  } else if (evaluation.delayed) {
    plainKey = 'messageBlockedDelayed';
    mdKey = 'messageBlockedDelayedMd';
  } else {
    plainKey = 'messageBlocked';
    mdKey = 'messageBlockedMd';
  }

  var options = {
    allowEvent: false,
    errorMessage: rules.fill(s[plainKey], vars)
  };
  // The exceptional send is mentioned only when enabled (the 500-character limit is checked
  // by tests/i18n.test.js with this addition).
  var hint = withBypassHint ? s.messageBypassHint : '';
  if (hint) {
    options.errorMessage += ' ' + hint;
  }
  // Support code (B2 or B3) when a justification was found but refused: "(code NFM-B2: malformed justification)".
  var codeText = supportCode ? s['messageBypassCode' + supportCode] : '';
  if (codeText) {
    options.errorMessage += ' (' + codeText + ')';
  }
  // cancelLabel / commandId: Mailbox 1.14 (task pane). Without 1.13 the task pane cannot schedule anything.
  if (canDelay && !noDay && isSetSupported('1.14')) {
    options.cancelLabel = s.cancelLabel;
    options.commandId = cfg.taskPaneCommandId;
  }
  // errorMessageMarkdown: Mailbox 1.15; errorMessage remains the plain-text fallback.
  if (isSetSupported('1.15')) {
    options.errorMessageMarkdown = rules.fill(s[mdKey], vars);
    if (hint) {
      options.errorMessageMarkdown += '\n\n' + s.messageBypassHintMd;
    }
    if (codeText) {
      options.errorMessageMarkdown += '\n\n(' + codeText + ')';
    }
  }
  return options;
}

function decideMessage(event, cfg, now, delay, canDelay, item) {
  var evaluation = rules.evaluateSend(now, delay, cfg);
  if (!evaluation.blocked) {
    complete(event, { allowEvent: true });
    return;
  }
  if (!bypassAvailable(cfg, item)) {
    complete(event, buildMessageBlockOptions(cfg, evaluation, canDelay, false));
    return;
  }
  // Blocked day with exceptional send enabled: a valid justification header lets the message go
  // (the task pane's sendAsync re-triggers OnMessageSend, which comes through here and reads the header again).
  // Otherwise normal block, with the mention of the option.
  readBypass(event, cfg, item, function (verdict) {
    try {
      if (verdict.allowed) {
        complete(event, { allowEvent: true });
        return;
      }
      // The task pane (hence the exceptional-send section) requires Mailbox 1.13: without it, no mention of the option;
      // the support code is always added (the read was attempted).
      complete(event, buildMessageBlockOptions(cfg, evaluation, canDelay, canDelay, verdict.code));
    } catch (e) {
      failSafeMessage(event, cfg, now);
    }
  });
}

/** OnMessageSend: blocks if the effective delivery time falls on a blocked day. */
function onMessageSendHandler(event) {
  var now = new Date();
  var cfg = config.forLang();
  try {
    var item = Office.context.mailbox.item;
    var canDelay = !!(
      isSetSupported('1.13') &&
      item &&
      item.delayDeliveryTime &&
      typeof item.delayDeliveryTime.getAsync === 'function'
    );
    if (!canDelay) {
      decideMessage(event, cfg, now, null, false, item);
      return;
    }
    item.delayDeliveryTime.getAsync({ asyncContext: event }, function (result) {
      var ev = result && result.asyncContext ? result.asyncContext : event;
      try {
        if (!result || result.status === Office.AsyncResultStatus.Failed) {
          // The delayed delivery cannot be determined: for safety, the message is not allowed to go
          // (a native delayed delivery on a Friday would otherwise go unnoticed).
          complete(ev, { allowEvent: false, errorMessage: cfg.strings.messageCheckFailed });
          return;
        }
        decideMessage(ev, cfg, now, result.value, true, item);
      } catch (e) {
        failSafeMessage(ev, cfg, now);
      }
    });
  } catch (e) {
    failSafeMessage(event, cfg, now);
  }
}

// Unexpected error: at least apply the rule to the current time.
function failSafeMessage(event, cfg, now) {
  if (rules.isBlocked(now, cfg)) {
    complete(event, {
      allowEvent: false,
      errorMessage: rules.fill(cfg.strings.messageBlockedNoDelayApi, {
        days: rules.blockedDaysLabel(cfg)
      })
    });
  } else {
    complete(event, { allowEvent: true });
  }
}

/**
 * Name of the first proposed day (working and not blocked) after `now`, without going through nextAllowedSuggestions
 * (used when that call failed). null if no day can be proposed within 21 days.
 */
function nextAllowedDayName(cfg, now) {
  var offset;
  for (offset = 1; offset <= 21; offset += 1) {
    var day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12, 0, 0, 0);
    if (rules.isProposable(day, cfg)) {
      return cfg.strings.dayNames[day.getDay()];
    }
  }
  return null;
}

/** OnAppointmentSend: no deferral possible, the rule applies to the current time. */
function onAppointmentSendHandler(event) {
  var cfg = config.forLang();
  try {
    var now = new Date();
    if (!rules.isBlocked(now, cfg)) {
      complete(event, { allowEvent: true });
      return;
    }
    var suggestions = rules.nextAllowedSuggestions(now, cfg);
    var vars = {
      days: rules.blockedDaysLabel(cfg),
      // First proposed day (working, not blocked) after today: not necessarily Monday.
      nextDay: suggestions.first ? cfg.strings.dayNames[suggestions.first.getDay()] : ''
    };
    var noDay = !suggestions.first;
    var options = {
      allowEvent: false,
      errorMessage: rules.fill(noDay ? cfg.strings.appointmentBlockedNoDay : cfg.strings.appointmentBlocked, vars)
    };
    if (isSetSupported('1.15')) {
      options.errorMessageMarkdown = rules.fill(
        noDay ? cfg.strings.appointmentBlockedNoDayMd : cfg.strings.appointmentBlockedMd,
        vars
      );
    }
    complete(event, options);
  } catch (e) {
    var blocked = rules.isBlocked(new Date(), cfg);
    if (!blocked) {
      complete(event, { allowEvent: true });
      return;
    }
    var fallbackDay = nextAllowedDayName(cfg, new Date());
    complete(event, {
      allowEvent: false,
      errorMessage: rules.fill(fallbackDay ? cfg.strings.appointmentBlocked : cfg.strings.appointmentBlockedNoDay, {
        days: rules.blockedDaysLabel(cfg),
        nextDay: fallbackDay || ''
      })
    });
  }
}

module.exports = {
  onMessageSendHandler: onMessageSendHandler,
  onAppointmentSendHandler: onAppointmentSendHandler
};
