'use strict';

/* Content of DEPLOY.txt placed in the artifact out/NoFridayMail-<env>-<version>.zip (no secret). */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dayList(days) {
  return days.map((d) => `${DAY_NAMES[d]} (${d})`).join(', ');
}

function deployText(ctx, origin) {
  const e = ctx.env;
  const r = ctx.rules;
  return [
    `NoFridayMail - deployment artifact - environment "${e.name}"`,
    '='.repeat(64),
    '',
    `Display name       : ${e.displayName}`,
    `Add-in Id          : ${e.addinId}`,
    `Manifest version   : ${e.version}`,
    `Site (SWA)         : ${origin}`,
    `Blocked days       : ${dayList(r.blockedDays)}`,
    `Proposed days      : ${dayList(r.workingDays.filter((d) => r.blockedDays.indexOf(d) === -1))}`,
    ...(r.bypass
      ? [`Exceptional send : ${r.bypass.enabled ? 'enabled' : 'disabled'} (justification of ${r.bypass.minLength} to ${r.bypass.maxLength} characters, ${r.bypass.minWords} words, ${r.bypass.minDistinctChars} distinct letters; authorization is checked server-side, see docs/NoFridayMail-Guide.md)`,
        ...(r.bypass.mfa
          ? [
              `MFA step           : ${r.bypass.mfa.required ? 'required' : 'not required'} (context ${r.bypass.mfa.authContext}, tenant ${r.bypass.mfa.tenantId}, application ${r.bypass.mfa.clientId}): ` +
                (r.bypass.mfa.required ? 'the API (api/) is deployed, the NFM_RECEIPT_KEY setting is created if missing' : 'no API')
            ]
          : [])
      ]
      : []),
    `Proposed times     : ${r.slotTimes.join(', ')} (suggestions at ${String(r.sendHour).padStart(2, '0')}:${String(r.sendMinute).padStart(2, '0')})`,
    '',
    'Contents',
    '--------',
    '  site/          static files to publish on Azure Static Web Apps (task pane, launchevent.js, pages, icons)',
    '  manifest.xml   add-in manifest to upload in the Microsoft 365 admin center',
    '  DEPLOY.txt     this file',
    '',
    'Deploy the site',
    '---------------',
    '  Recommended: tools/Deploy-NoFridayMail.ps1 -Environment ' + e.name + ' (see docs/NoFridayMail-Guide.md).',
    '  Manual     : npx @azure/static-web-apps-cli deploy ./site --env production (deployment token of the Static Web Apps',
    '               resource in the SWA_CLI_DEPLOYMENT_TOKEN variable; never write it to a file).',
    '',
    'Publish the manifest (Microsoft 365 administrator)',
    '--------------------------------------------------',
    '  1. Microsoft 365 admin center > Settings > Integrated apps > Upload custom apps.',
    '  2. App type: Office Add-in; choose the manifest.xml file of this artifact.',
    '  3. Choose the users or groups, accept the permissions (ReadWriteItem), finish.',
    '  4. Propagation: up to 24 hours. A manifest change (name, version, URL) requires a new consent.',
    '  The add-in Id above identifies this environment for good: keep it unchanged across redeployments, so that',
    '  Outlook updates the same add-in instead of installing a second one.',
    '',
    'Rollback',
    '--------',
    '  Redeploy the zip of the previous version (site/ folder) with the same procedure.',
    ''
  ].join('\r\n');
}

module.exports = { deployText };
