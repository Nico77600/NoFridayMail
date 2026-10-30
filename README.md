<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme-banner-dark.png">
    <img alt="NoFridayMail: an Outlook add-in that stops mail and meeting invitations from leaving on the days you choose, Friday by default, and offers the next working day instead; an optional justified exceptional send is protected by multi-factor authentication" src="docs/images/readme-banner-light.png">
  </picture>
</p>

<p align="center">
  <a href="#quick-start"><b>Quick start</b></a> &nbsp;&middot;&nbsp;
  <a href="#how-it-works"><b>How it works</b></a> &nbsp;&middot;&nbsp;
  <a href="#reports"><b>Reports</b></a> &nbsp;&middot;&nbsp;
  <a href="#requirements"><b>Requirements</b></a> &nbsp;&middot;&nbsp;
  <a href="docs/NoFridayMail-UserGuide.md"><b>User guide</b></a> &nbsp;&middot;&nbsp;
  <a href="docs/NoFridayMail-Guide.md"><b>Guide</b></a>
</p>

> [!IMPORTANT]
> Files downloaded from the Internet may be blocked by Windows and fail to run. Before using this project, unblock every file in the downloaded folder:
>
> ```powershell
> Get-ChildItem "C:\Chemin\Du\Dossier" -Recurse -File -Force | Unblock-File
> ```
>
> Replace the example path with the folder where you downloaded or extracted this project.

## Why

Mail sent on the wrong day is hard to take back: a report that lands in every inbox on a Friday evening, an invitation sent before a long weekend. NoFridayMail is an Outlook add-in by Nicolas Fabert that checks the **delivery day** of every message and meeting invitation at the moment you press **Send**. On a blocked day (Friday by default, any days you choose) the send is stopped with a clear explanation, and a small pane offers the next working days and hours instead. The mail then leaves by itself, on the day you picked.

- **Mail** is rescheduled in two clicks. A delayed delivery that lands on a blocked day is stopped too, so the check cannot be bypassed with Outlook's own *Delay delivery*.
- **Meeting invitations** cannot be delayed: on a blocked day they are stopped with an explanation and can be sent on the next allowed day.
- **Exceptional send** is an option, off by default: the user writes a justification, proves their identity with multi-factor authentication through Microsoft Entra ID, and the mail carries a signed receipt that an Exchange transport rule can authorize and audit.
- **French and English**, light and dark, following the language and theme of Outlook.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme-flow-dark.png">
  <img alt="One send: the user presses Send on a mail or meeting invitation, the add-in checks the effective delivery day. On an allowed day the mail leaves. On a blocked day a Smart Alerts dialog explains the rule and opens the schedule pane, where the user picks the next working day. Optionally the exceptional send checks a written justification and multi-factor authentication, the API returns a signed receipt, and an Exchange transport rule authorizes and audits it" src="docs/images/readme-flow-light.png">
</picture>

## How it works

- **A classic Outlook add-in, with Smart Alerts.** The add-in handles the *on send* events (`OnMessageSend`, `OnAppointmentSend`). The effective delivery time is the delayed delivery of the message when it is set and in the future, otherwise now, in the local time of the client. If that day is blocked, Outlook shows the add-in's dialog instead of sending.
- **Rules per environment.** One JSON file per environment (`deploy/environments`) holds the add-in name, its unique Id, the version, the Azure resources and the rules: blocked days, proposed working days, the hours offered and the default language. The build injects them into the bundle and generates the manifest. Nothing else is configured.
- **A static site on Azure Static Web Apps.** The task pane, `launchevent.js` and the pages are static files. `tools/Deploy-NoFridayMail.ps1` creates the resources if needed, builds, deploys and checks the served site. It never writes the deployment token to disk or to the console, and `-WhatIf` changes nothing.
- **Installed by Microsoft 365.** For one person, sideload the generated manifest in Outlook. For everyone, upload it once in the Microsoft 365 admin center (Integrated apps) and choose the users or groups; propagation can take up to 24 hours.
- **The optional exceptional send has a server side.** The add-in cannot know whether the user is authorized: the managed API (`api/`) validates the Entra token and the justification and returns a signed receipt, and an Exchange transport rule authorizes by group and audits. See the [Guide](docs/NoFridayMail-Guide.md).

## Reports

Every exceptional send leaves traces in four places, from the request to the message. Nothing is kept by the add-in itself.

| Where | What you find |
|---|---|
| Application Insights | One `NFM_BYPASS` line per accepted request and `NFM_BYPASS_DENIED` per refusal: who, when, the justification, the token identifier (never the token) |
| Microsoft Entra sign-in logs | The multi-factor sign-in behind the receipt, joined with the API line by the token identifier |
| Exchange message trace | The message and the transport rule that authorized it |
| Microsoft Purview DLP | One alert or incident report line per message carrying the header |

A receipt can also be verified offline with `tools/verify-receipt.js`. The queries, the five-minute freshness window and the rule are in the [Guide](docs/NoFridayMail-Guide.md).

## Limits

- **Outlook on Android and iOS is not covered.** Smart Alerts is not supported there: a message sent from a phone is not checked.
- **Smart Alerts is a safeguard, not a security boundary.** In `SoftBlock` mode, if the add-in cannot load, Outlook lets the message go. For a hard guarantee, add an Exchange transport rule ([Guide](docs/NoFridayMail-Guide.md)).
- Public holidays are not handled: only the day of the week is checked. The time zone is the one of the client, not the recipient's.

## Requirements

| Item | Requirement |
|---|---|
| Outlook | Outlook on the web, new Outlook for Windows, classic Outlook for Windows (2206 or later, 2412 for the custom *Schedule send* button), Outlook for Mac (new interface). Mailbox requirement set 1.12 or later |
| Microsoft 365 | Exchange Online mailboxes. Smart Alerts add-ins run only when deployed by an administrator or sideloaded for a test: the *Global Administrator* or *Exchange Administrator* role to publish the manifest |
| PowerShell | 7.4 or later, to run the deploy script |
| Node.js | 22 or later with npm (the build uses webpack; the managed API runs on Node 22) |
| Azure | Azure CLI signed in (`az login`) and a subscription where you can create a resource group and a Static Web App (*Contributor*); the `Microsoft.Web` provider registered. The Free plan is enough |
| Optional exceptional send | A Microsoft Entra app registration, a Conditional Access authentication context requiring MFA every time, an Exchange transport rule and, for traces, Application Insights |

## Quick start

One path for everyone: download the **release ZIP** (recommended, it holds exactly what is needed to deploy and use the add-in, with an integrity manifest), unblock the files as shown above, then follow the [user guide](docs/NoFridayMail-UserGuide.md) step by step. Each step gives the command to copy, what you should see and what to do if not.

```powershell
# In PowerShell 7, in the folder where you unpacked the release ZIP
cd C:\Tools\NoFridayMail

# 1 · Name the Azure resources: edit resourceGroup and staticWebAppName in deploy\environments\prod.json
#     (for your own environment: .\tools\New-NoFridayMailEnvironment.ps1 -Name <name>, which generates its add-in Id once)
notepad .\deploy\environments\prod.json

# 2 · Sign in to Azure
az login

# 3 · Simulate: shows the checklist and every step, changes nothing
pwsh .\tools\Deploy-NoFridayMail.ps1 -Environment prod -WhatIf

# 4 · Deploy the site (creates the Azure resources if needed, builds, deploys, checks)
pwsh .\tools\Deploy-NoFridayMail.ps1 -Environment prod

# 5 · Install the add-in: the script prints the manifest path and the two ways to install it
#     A · for one person (test): sideload the manifest in Outlook on the web
#     B · for everyone: Microsoft 365 admin center > Settings > Integrated apps > Upload custom apps
```

On a blocked day, send a test message: the add-in dialog must appear. The user guide has the checks and a troubleshooting table.

## Documentation

The release ZIP and the repository hold the same guides, as Markdown and as one HTML file each, with a light and a dark theme.

| Guide | Content |
|---|---|
| **[User guide](docs/NoFridayMail-UserGuide.md)** ([HTML](docs/NoFridayMail-UserGuide.html)) | **The guided path**, step by step: install the tools, deploy the site, install the add-in for one person or for everyone, check it, keep it running and change the settings. |
| **[Guide](docs/NoFridayMail-Guide.md)** ([HTML](docs/NoFridayMail-Guide.html)) | Everything else: how the rules work, every setting of an environment, the exceptional send and its server side, deployment operations, troubleshooting, how to modify and validate the project. |

See also [CHANGELOG.md](CHANGELOG.md).

## Tests

```powershell
npm ci
npm test                         # unit tests (node --test), no Outlook, Azure or Exchange needed
npm run build                    # bundle and production manifest
npm run validate:env             # schema and consistency of the environment files
Invoke-Pester -Path .\tests      # deploy script and package integrity (Pester 5 or later)
```

The tests, the continuous integration and the development tools live in the repository only: they are not part of the release ZIP or of "Download ZIP". GitHub Actions runs them on a disposable Windows runner, without Azure, Exchange, secrets or a signing certificate. `tests/public-safety.test.js` fails if a tenant, subscription or application identifier or a laboratory host name reaches the repository.

## Data handling

The add-in reads only the delivery time of the item being sent and the clock; it does not read message content or recipients and stores nothing. With the exceptional send enabled, the justification and the identity of the user go to the managed API of your own Azure Static Web App, which logs them to your Application Insights. Nothing is sent to the author. The hosted files are static: serve them over HTTPS only, and protect the deployment token and who can change `main`.

The release ZIP carries `PackageIntegrity.psd1`, the SHA-256 of every file, and the deploy script checks it before running when it is present. Releases are signed by the owner with Authenticode; a package built by CI is unsigned and is not for deployment. Obtain releases only from the official repository.

## License

[MIT](LICENSE). The npm packages bundled in the site and the API keep their own licenses: see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Disclaimer

This Script is a Personal project.
It's provided "AS-IS". It's not an official Microsoft product so no support can be expected from Microsoft.

As any scripts you must read carefully the documentation and test it first in a Test environment before any run in Production.

NoFridayMail does not cover Outlook on Android and iOS, and in `SoftBlock` mode Outlook lets a message go when the add-in cannot load: it is a safeguard against accidental sends, not a guarantee. Use an Exchange transport rule if a hard guarantee is required.
