---
title: NoFridayMail
subtitle: Technical guide
version: 1.1.0
author: Nicolas Fabert
updated: 2026-10-30
---

# NoFridayMail — Technical guide

> An Outlook add-in (**Smart Alerts**, event-based activation) that stops e-mails and meeting invitations from leaving on a **blocked day** (Friday by default), offers to schedule the send for the next allowed day, and — as an option — lets an authorized person send anyway with a **written justification** and an **identity check (MFA)**. It is hosted as a small static website on Azure Static Web Apps and published with the Microsoft 365 admin center.

> [!IMPORTANT]
> Files downloaded from the Internet may be blocked by Windows and fail to run. Before using this project, unblock every file in the downloaded folder:
>
> ```powershell
> Get-ChildItem "C:\Chemin\Du\Dossier" -Recurse -File -Force | Unblock-File
> ```
>
> Replace the example path with the folder where you downloaded or extracted this project.

> [!NOTE]
> This is the **technical guide**: how the add-in works, every setting of an environment file, how it is built, deployed and verified, the exceptional-send architecture and how to maintain the project. For the step-by-step installation, read the [user guide](NoFridayMail-UserGuide.md).

```cards
target | What it answers | "Can this message leave today?" — and, if not, "when can it?".
download | Where the rules live | In **one small JSON file per environment**: blocked days, offered days, hours, name, Azure resources.
database | What it keeps | Nothing in Outlook. The website is static. Only the optional MFA level has an API that writes a log line per request.
file | What it produces | A website folder, a **manifest** to publish, and a ZIP per environment (`out/NoFridayMail-<env>-<version>.zip`).
```

## Quick start

```path
Set up once | settings | Set up once: then the website is online
Set up once | 1 | Get the tools | PowerShell 7.4, Node.js 22, Azure CLI, `az login`
Set up once | 2 | Prepare your environment | `New-NoFridayMailEnvironment.ps1 -Name <name>` creates `deploy/environments.local/<name>.json`
Set up once | 3 | Simulate | `Deploy-NoFridayMail.ps1 -WhatIf`
Set up once | 4 | Deploy | site online, checks passed
A | user | Install for one person (local)
A | 5 | Sideload the manifest | `https://aka.ms/olksideload`, Add from file
A | 6 | Test | block today in a test environment
B | people | Deploy for everyone (centralized)
B | 5 | Upload the manifest | admin center › Integrated apps
B | 6 | Pilot group | then widen the audience
```

Every step with its exact command: [user guide, chapters 3 to 5](NoFridayMail-UserGuide.md#1-start-here).

> [!IMPORTANT]
> The add-in is a **safeguard against accidental sends**, not a security control. It uses the Smart Alerts `SoftBlock` mode: if Outlook cannot load it, the message is sent. For a hard guarantee, use an Exchange Online transport rule. The add-in runs in the Outlook client: it reads the delivery time of the item being sent and the clock, makes no network call of its own (except the optional MFA level) and stores nothing.

> [!WARNING]
> Keep the deployment token of the Static Web App secret, and restrict who can change the repository. A compromised website could change the behavior of the add-in for every user.

> [!NOTE]
> The exceptional send is **off** unless an environment file has a `bypass` block. The server side (Exchange transport rule, Purview DLP, and for the MFA level the Entra registration) must exist **before** you turn it on in production.

# Part I · Understand

<!-- icon: target -->
## 1. Purpose

On a blocked day, an e-mail or a meeting invitation must not leave. The add-in hooks the **send** event of Outlook (`OnMessageSend`, `OnAppointmentSend`), computes the day on which the message would **really be delivered**, and blocks the send if that day is blocked. For an e-mail it offers to schedule the delivery on an allowed day.

```cards
mail | E-mail | Blocked on a blocked day, unless the delivery is delayed to an allowed day. A **schedule pane** helps to choose the day and the time.
calendar | Meeting invitation | Cannot be delayed: blocked with an explanation, to be sent on an allowed day. Never bypassed.
key | Exceptional send | Optional. A justification header, validated by Exchange (group) and logged. Mail only.
layers | Environments | Several installations (test, production, another company) from one source tree, each with its own identity and rules.
```

<!-- icon: flow -->
## 2. How it works

```flow
mail | Send clicked | Outlook raises the send event of the add-in
arrow | effective delivery time | delayed delivery if set and in the future, otherwise now
filter | Rules | blocked day? allowed day? (pure date logic, no Office dependency)
arrow | blocked | Smart Alerts dialog
calendar | Schedule pane | suggestions, row of days, time chips, one sticky action
arrow | delivery time set | the message leaves at the chosen time
mail | Exchange | optional transport rule as the strict layer
```

### 2.1 The rule

A send is blocked if its **effective delivery time** falls on a blocked day, in the **local time of the client**.

- Effective time = the delayed delivery of the message (`delayDeliveryTime`) if it is set and in the future, otherwise now.
- Thursday evening delayed to Friday: **blocked**. Friday delayed to Saturday or Monday: **allowed**.
- A delayed delivery set through Outlook's own feature ("Delay delivery") on a Friday is blocked too: the send handler is the final safeguard.
- Meetings: an invitation cannot be delayed. On a blocked day the send is blocked with an explanation; the meeting is not sent and can be sent from the next allowed day.
- The blocked day is refused at three levels: the pane, `validateCustomDate()` in `src/shared/rules.js`, and the `OnMessageSend` handler.

**Blocked days and offered days.** `blockedDays` (default Friday) forbid sending. `workingDays` (default Monday to Friday) only control which days are **offered**. A day is offered if it is a working day **and** not blocked. Weekends are never blocked and never offered: a manual send on a Saturday is allowed. If no day qualifies, the pane says "No working day available." and the messages say so, without a *Schedule* button.

### 2.2 The user journey

1. The user clicks **Send** on a blocked day (or with a delivery time that falls on one).
2. A dialog (French or English according to the language of Outlook) explains that the send is not allowed and offers **Schedule send** (a custom *Take Action* button).
3. The task pane offers, with the full date displayed ("Saturday, October 31, 2026 at 8:00 AM"): **Suggestions** (the first two offered days after today, at the configured time), **Choose a day** (a scrolling row of the next offered days with "Today" / "Tomorrow") and **Time** (chips from `slotTimes`, without past hours today). Choosing a suggestion clears the day and time, and the other way round. Clicking a card never sends.
4. One sticky action, whose label summarizes the choice ("Schedule and send · Fri, Oct 30 at 9:00 AM"), disabled with an explicit text until something is chosen. With Outlook **Mailbox 1.15** (`item.sendAsync`) it schedules, checks that the delivery time is set on an allowed day, then sends; otherwise it schedules and asks to click Send again.
5. **Remove the schedule** (never sends) appears if a delivery time is already set.
6. At send time the delivery falls on an allowed day: the message leaves at the planned time.

### 2.3 Languages

French (the product language, default) and English. The display language of Outlook (`Office.context.displayLanguage`) is read at each call: `fr*` gives French, anything else English, a missing language French. The dialog button is "Planifier l'envoi" / "Schedule send" (20 characters at most). The manifest keeps `DefaultLocale` fr-FR and adds `en-US` and `en-GB` labels. All strings live in `src/shared/config.js` as `languages.fr` / `languages.en` with the same keys and `{placeholders}`, checked by `tests/i18n.test.js`.

### 2.4 Degradation by Outlook version

| Mailbox requirement set | Feature |
|---|---|
| 1.12 (minimum) | Blocking with a plain-text `errorMessage` |
| 1.13 | Reading the delayed delivery; scheduling from the pane. Without 1.13 the message points to the native "Delay delivery" |
| 1.14 | Custom button (`cancelLabel`) opening the pane (`commandId`) |
| 1.15 | Formatted message (`errorMessageMarkdown`); programmatic send (`sendAsync`) |
| 1.8 | Optional **Exceptional send** (`item.internetHeaders`), only if `bypass.enabled` |
| 1.11 | `item.sessionData` fallback channel of the exceptional send |
| NestedAppAuth 1.1 | MFA step of the exceptional send (`bypass.mfa.required`), otherwise the message "does not allow the exceptional send" |

### 2.5 Runtimes

Classic Outlook for Windows has no DOM, no `localStorage` and no ES modules for event handlers. The code reachable from `src/launchevent/` is bundled into **one classic `launchevent.js`** (ES5, ASCII, no import at runtime), which `npm run build` verifies with `tools/check-bundle.js`. The browser runtime (web, new Outlook, Mac) loads the same bundle from `commands.html`. The task pane is hand-written Fluent 2 CSS with light and dark tokens (contrast AA enforced by `tests/theme.test.js`), no UI library.

<!-- icon: lightbulb -->
## 3. Things to know

```cards
shield | SoftBlock | If the add-in cannot load, Outlook lets the message go. The `Block` mode is not allowed in the marketplaces.
people | Deployed by an administrator | Event-based add-ins fire only when deployed by an administrator (or sideloaded on a test mailbox).
clock | Local time of the client | No time zone of the recipient. No public holidays.
mail | Mobile not covered | Smart Alerts are not supported on Outlook for Android and iOS.
```

- **Meetings cannot be delayed**: on a blocked day the invitation is only blocked.
- **Offline**: Smart Alerts need a connection. To enforce the check even offline, see the `OnSendAddinsEnabled` (web, new Outlook) and `OnSendAddinsWaitForLoad` (Mac) policies in the Microsoft documentation.
- **A delayed delivery set by the add-in is handled by the server**: in classic Outlook for Windows the message is not in the Outbox and can no longer be edited; in other clients it stays in Drafts until the planned time.
- **No API clears `delayDeliveryTime` explicitly**: "Remove the schedule" uses `setAsync(new Date(0))` (observed in Outlook on the web: `getAsync` then returns 0) and checks; on failure the user is sent to the native "Delay delivery". `setAsync(0)` and `setAsync(null)` throw.
- **One `OnMessageSend` and one `OnAppointmentSend` per add-in.**
- **Per-mailbox server installation** with `New-App -Mailbox` did **not** activate the Smart Alerts in Outlook on the web in our tests. Use the sideload (one person) or the centralized deployment.
- Feature detection: Mailbox 1.13, 1.14 and 1.15 are tested with `Office.context.requirements.isSetSupported`; `Office` is read at call time, never at import time.

# Part II · Set up

<!-- icon: checklist -->
## 4. Prerequisites

| Item | Requirement |
|---|---|
| PowerShell | **7.4 or later** (`pwsh`) for the deploy script. |
| Node.js | **22 or later**, with `npm` (`engines` in `package.json`). |
| Azure CLI | `az`, signed in (`az login`), on the right subscription. The `application-insights` extension is installed by the script when the MFA level needs it. |
| Azure rights | **Contributor** on the subscription to create a resource group and a Static Web App (not needed with `-SkipInfra`). The `Microsoft.Web` provider must be registered (`az provider register --namespace Microsoft.Web`). |
| Microsoft 365 rights | **Global Administrator** or **Exchange Administrator** to publish the manifest in *Integrated apps*. |
| Outlook | Web, new Outlook for Windows, classic Outlook for Windows 2206 or later (2412 for the *Take Action* button), Outlook for Mac (new interface). Exchange Online mailbox for production (Exchange 2019 CU12+ or 2016 CU22+ with classic Outlook, see the Smart Alerts documentation). |
| Entra ID (MFA level only) | An app registration, an authentication context and a Conditional Access policy: Microsoft Entra ID **P1**. See chapter 9. |

The deploy script prints this as a **checklist** at the start (step 1/6) and, for every missing item, a *What to do* line. In simulation (`-WhatIf`) a missing Azure item is a warning; a missing Node.js or npm always stops the script.

<!-- icon: settings -->
## 5. Environments and settings

An **environment** is one JSON file that describes a complete installation: display name, **add-in Id** (a GUID unique per environment), manifest version, Azure resources, rules and fallback language. The schema is `deploy/environment.schema.json`; the checks are in `tools/env-config.js`.

### 5.1 Where the files are

| Folder | Content |
|---|---|
| `deploy/environments/` | Files shipped with the project: `example.json` (the template that `New-NoFridayMailEnvironment.ps1` copies; never deployed as is) and `prod.json` (a production template with placeholder Azure names). |
| `deploy/environments.local/` | **Your** files (test, production, other companies). Never published (git-ignored). A file here wins over a file of the same name in `deploy/environments/`. |
| `NFM_ENVIRONMENTS_DIR` | Variable that replaces both folders by a single one (used by the tests with `tests/fixtures/environments`). |

`npm run validate:env` validates every file (schema, coherence, unique `addinId`, unique Static Web App). `node tools/env-config.js <name> --deploy` additionally refuses a template `addinId` and the placeholder Entra identifiers of the MFA level.

### 5.1.1 One environment = one add-in identity

The `addinId` is the identity Outlook knows the add-in by. It follows two rules:

- **Stable.** An environment keeps the same `addinId` for its whole life. The same Id means Outlook *updates* the add-in your users already have; a new Id on every deployment would install a *second* add-in for every user.
- **Unique.** Two environments never share an `addinId`, otherwise they replace each other in the same Microsoft 365 tenant.

So the Id is generated **once**, when the environment is created, and never at deployment time:

```powershell
.\tools\New-NoFridayMailEnvironment.ps1 -Name staging -WhatIf   # simulate: writes nothing
.\tools\New-NoFridayMailEnvironment.ps1 -Name staging           # creates deploy\environments.local\staging.json
```

The script (PowerShell 7.4, house console format, `-WhatIf` supported) copies `example.json`, generates the Id with `[guid]::NewGuid()`, refuses an Id already used by a known environment, validates the content with the same code as the build (`node tools/env-config.js <name> --stdin`) and only then writes the file.

| Parameter | Default | Meaning |
|---|---|---|
| `-Name` (required) | | Environment name = file name: lowercase letters, digits, dashes. Not `example`, not a name that already exists. |
| `-DisplayName` | `NoFridayMail (<Name>)` | Name shown in Outlook. |
| `-ResourceGroup`, `-StaticWebAppName` | `rg-nofridaymail-<Name>`, `swa-nofridaymail-<Name>` | Azure names. |
| `-Location` | `westeurope` | Azure region. |
| `-SubscriptionId` | none | Optional; otherwise the deployment uses the subscription of `az`. |
| `-BlockedDays` | `5` | Forbidden days (`-BlockedDays 1,2`). |
| `-Path` | `deploy/environments.local/` | Folder that receives `<Name>.json`. |
| `-AddinId` | generated | Rarely needed: reuse the Id of an add-in that is already installed. A template value or an Id used by another environment is refused. |
| `-Force` | off | Rewrites an existing file from the template and **keeps its Id**: an existing environment never changes identity. |

Running it again for the same name without `-Force` refuses and leaves the file untouched.

`Deploy-NoFridayMail.ps1` never generates an Id. It stops, even with `-WhatIf`, when `addinId` is a template value (`11111111-2222-4333-8444-555555555555` of `example.json`, or the all-zero GUID) and prints the fix: create the environment with `New-NoFridayMailEnvironment.ps1`, or put the output of `[guid]::NewGuid()` in `addinId`. It also stops when another environment uses the same Id.

### 5.2 Days are numbers

| Number | Day |
|:---:|---|
| **0** | Sunday |
| **1** | Monday |
| **2** | Tuesday |
| **3** | Wednesday |
| **4** | Thursday |
| **5** | Friday |
| **6** | Saturday |

### 5.3 Every setting

| Setting | Meaning |
|---|---|
| `name` | Must be **exactly the file name** without `.json` (lowercase letters, digits, dashes, up to 31 characters). |
| `description` | A memo for you. Ignored by the build. |
| `protected` | `true` marks an environment in service: the deploy script refuses it without `-ConfirmLab`. |
| `displayName` | Name shown in Outlook and in the admin center. No `<`, `>`, `&` or double quotes. Part of the manifest. |
| `addinId` | **GUID unique per environment and stable for its whole life**, generated once by `New-NoFridayMailEnvironment.ps1` (section 5.1.1). Never reuse it, never change it after users installed the add-in. Part of the manifest. |
| `version` | Four numbers (`1.1.0.0`), each ≤ 65535, at least `1.0.0.0`. Raise it at each manifest change. |
| `providerName`, `supportUrl` | Provider and support address (HTTPS) shown in the admin center. |
| `azure.subscriptionId` | Optional. Targets a subscription; otherwise the one of `az login`. |
| `azure.resourceGroup`, `azure.location`, `azure.staticWebAppName`, `azure.sku` | The resource group (created if missing), the region, the Static Web App (unique in Azure, 2 to 40 letters, digits, dashes) and the plan (`Free` or `Standard`). |
| `azure.appInsights` | Optional. Application Insights resource for the log of the MFA API. |
| `rules.blockedDays` | **Forbidden** days. At least one working day must remain unblocked. |
| `rules.workingDays` | **Offered** days (default Monday to Friday). |
| `rules.sendHour`, `rules.sendMinute` | Time of the two **suggestions**. |
| `rules.slotTimes` | The time chips of the pane, `"HH:mm"` with two digits, 8 at most. |
| `rules.dayCount` | Number of days in the row (1 to 10). |
| `bypass` | Optional. Exceptional send (chapter 9). Absent means off. |
| `defaultLanguage` | Fallback language, `fr` or `en`. |

The build injects the rules into the bundle with webpack `DefinePlugin` as `__NFM_RULES__`. `BLOCKED_DAYS` and `WORKING_DAYS` remain optional build-time overrides (comma-separated integers 0 to 6, strictly validated; invalid values such as a duplicate, out of range or all seven days fail the build). `BYPASS_ENABLED=true|false` is only used by the preview tool.

### 5.4 When must the manifest be published again?

| What you change | New manifest? | What happens |
|---|---|---|
| Blocked days, offered days, hours, number of days, fallback language | **No.** Redeploy the site only. | The rules are in the hosted files (`launchevent.js`, `taskpane.js`). Users get them at the next load: a few minutes, sometimes after reopening Outlook. The Description and the button tooltip of the manifest also name the blocked days (generated by `tools/manifest-lib.js` from `blockedDays` and `workingDays`, with the same day names as the interface): upload the new manifest only if you want those two texts to match; the behavior does not depend on them. |
| Display name, provider, support address, **version** | **Yes**: upload the new manifest (same add-in updated). | The admin center asks for the administrator's consent again; propagation up to 24 hours. |
| Site address (new Static Web App) | **Yes**: the manifest contains the addresses. | Same as above. |
| **`addinId`** | **Yes, and it is another add-in.** | Outlook sees a *new* add-in. The old one stays installed until removed: remove it, otherwise both fire. |

### 5.5 Classic pitfalls

- **Never reuse an `addinId`, never change it once installed.** The build refuses two environments with the same GUID. Different Ids are what allows a test and a production add-in in the same tenant (do not give both to the same users: they would see two checks); a stable Id is what makes a redeployment an update.
- **If you also use a transport rule, change the blocked day there too**, or the two layers disagree. A deployment for another day (for example `New-NoFridayMailEnvironment.ps1 -Name notuesday -DisplayName "NoTuesdayEmail" -BlockedDays 2`) gets a manifest whose Description and tooltip say Tuesday; the Exchange rule must be aligned with the same day.
- **`name` equals the file name.** Keep JSON syntax: straight quotes, commas between items, none after the last one. `npm run validate:env` says where the error is.
- **Raise `version`** at each manifest change, or the admin center may refuse the update.
- **A Saturday is not blocked.** To block the weekend too, add 6 and 0 (`[0, 5, 6]`).

<!-- icon: server -->
## 6. Build and deploy

```flow
file | Environment file | `deploy/environments*/<env>.json`
arrow | npm run build:prod | validate, inject the rules, generate the manifest
folder | `dist/<env>/` and `out/` | site, `manifest.prod.xml`, `NoFridayMail-<env>-<version>.zip`
arrow | Deploy-NoFridayMail.ps1 | SWA CLI with a token read at run time
server | Azure Static Web Apps | the site (and the API with the MFA level)
arrow | admin center | manual step
mail | Outlook | add-in available to the chosen users
```

### 6.1 Build

`npm run build:prod -- --env <name>` (or `NFM_ENV=<name>`) needs `ADDIN_BASE_URL`, the HTTPS origin of the site without path. It validates the environment strictly, injects the rules, writes `dist/<env>/` (bundles, pages, icons, `staticwebapp.config.json`, `manifest.prod.xml`) and the artifact `out/NoFridayMail-<env>-<version>.zip` (`site/`, `manifest.xml`, `DEPLOY.txt`). `npm run validate:prod -- --env <name>` validates the generated manifest. Without an environment, `npm run build` produces a development-flavoured `dist/` for tests.

### 6.2 The deploy script

`tools/Deploy-NoFridayMail.ps1 -Environment <name>` runs six stages:

| Stage | What it does |
|---|---|
| **1/6 Prerequisites** | Checklist: PowerShell, Node.js 22+, npm, Azure CLI, session, subscription, `application-insights` extension (installed by itself, without a question, when the MFA level needs it; announced only in `-WhatIf`). If `PackageIntegrity.psd1` is present (release ZIP) the package is verified before anything else. |
| **2/6 Azure infrastructure** | Creates the resource group and the Static Web App if missing (otherwise reuses them), reads the site address (`ADDIN_BASE_URL`). With the MFA level: creates `NFM_RECEIPT_KEY` only if missing and links Application Insights. |
| **3/6 Build and validation** | `npm ci`, `npm test` (skipped with an explanation when `tests/` is not shipped, or with `-SkipTests`), `npm run build:prod`, `npm run validate:prod`. |
| **4/6 API package** | MFA level only: a self-contained package `out/api-pkg/<env>`. |
| **5/6 Deployment** | `npx --yes @azure/static-web-apps-cli@<pinned> deploy ./dist/<env> --env production --swa-config-location ./dist/<env>` (plus the API flags). The line is printed (`Command: npx ...`) and contains no secret. |
| **6/6 Post-deployment checks** | HTTP 200 on `manifest.prod.xml`, `launchevent.js`, `taskpane.html`, `commands.html`; the expected `blockedDays` in the served `launchevent.js`; the add-in Id in the served manifest; with the MFA level, `POST /api/bypass` without a token must answer **401**. |

A final *Next steps* box gives the manifest path and the two ways to install (sideload, centralized).

| Parameter | Meaning |
|---|---|
| `-Environment` | The environment name (file `<name>.json` in `deploy/environments.local/` or `deploy/environments/`). `example` is a template and is refused. |
| `-SkipInfra` | Creates nothing in Azure: the Static Web App must exist (it is only read). |
| `-SkipTests` | Does not run `npm test` (not recommended in production). |
| `-ConfirmLab` | Explicit confirmation required for protected environments (`protected: true`). |
| `-WhatIf` | Simulation: nothing is created, installed, built or deployed; only reads (tool versions, `az account show`, `az group exists`, `az staticwebapp show`). |

**Secret hygiene.** The deployment token is read at run time (`az staticwebapp secrets list`), passed to the child process by environment variable (`SWA_CLI_DEPLOYMENT_TOKEN`) and **never written to disk or shown**. The SWA CLI version is pinned (never `latest`). `NFM_RECEIPT_KEY` is generated with 32 random bytes, only if missing, passed with `--output none` and never printed, logged or written; errors never repeat the arguments of the command.

**Roll back.** The site is static: go back by deploying the previous version (a previous release ZIP, or a tag of the repository) with `-SkipInfra`; republish the previous manifest if it also changed.

**Delete an environment**, in this order: remove the add-in in the admin center; `az staticwebapp delete --name <swa> --resource-group <rg> --yes`; if the group is otherwise empty `az group delete --name <rg> --yes`; delete the environment file (and the GitHub Environment).

### 6.3 The managed API (MFA level)

The `api/` folder (Node 22, Azure Functions programming model v4, Static Web Apps managed functions, Free plan) exists only for environments with `bypass.mfa.required: true`; the deployment of the API is automatic. The SWA CLI runs **no Oryx build**, so the script deploys a **self-contained package** `out/api-pkg/<env>` (the code, a generated `config.json`, `shared/` and the `node_modules` installed by `npm ci --omit=dev`), with `--api-location ./out/api-pkg/<env>` and `--swa-config-location ./dist/<env>`, so that `platform.apiRuntime: node:22` and the `/api/*` route of the generated site configuration apply. `api/` itself stays clean for git. The load of the function from the installed package is verified before deployment (`node tools/package-api.js <env> --verify`). `host.json` has no `extensionBundle`: a Node HTTP function (model v4) uses no binding extension.

<!-- icon: tag -->
## 7. Publish the manifest

Publishing is manual on purpose: it needs an administrator and a consent. The manifest is `dist/<env>/manifest.prod.xml` (also `manifest.xml` in the ZIP of `out/`).

**Centralized (production, many users).** Microsoft 365 admin center › **Settings** › **Integrated apps** › **Upload custom apps** › app type **Office Add-in** › the manifest file › assign **users or groups** (start with a pilot group) › accept the permissions (`ReadWriteItem`) › finish. Propagation: **up to 24 hours**; a user may have to reopen Outlook. An automated publication with `New-App` is not provided: Microsoft recommends *Integrated apps* for event-based add-ins, and a per-mailbox `New-App -Mailbox` did not activate the Smart Alerts in our tests.

**Update.** Open the add-in in *Integrated apps* and upload the new manifest: **same `addinId`, higher `version`**. Any manifest change needs the administrator's consent again; until then users of the organization may be blocked.

**Local (test, one person).** Outlook on the web: `https://aka.ms/olksideload` › **My add-ins** › **Custom add-ins** › **Add a custom add-in** › **Add from file**. Classic Outlook: *Get Add-ins* › **My add-ins** › **Custom add-ins** › **Add a custom add-in** › **Add from file**. Take the file on disk, or use **Save link as** on the website: **never Ctrl+S on the displayed XML**, which saves the rendered page. For a developer's `https://localhost:3000` flow: `npm run start` (loads `manifest.xml` with `office-addin-debugging`), `npm run stop`; the first launch asks to install the development certificate of `office-addin-dev-certs`.

# Part III · Use

<!-- icon: terminal -->
## 8. Everyday use

| To do | Command |
|---|---|
| Simulate | `pwsh tools/Deploy-NoFridayMail.ps1 -Environment <name> -WhatIf` |
| Deploy or update | `pwsh tools/Deploy-NoFridayMail.ps1 -Environment <name>` |
| Update a site that exists | `... -SkipInfra` |
| Validate the environment files | `npm run validate:env` |
| Build only | `$env:ADDIN_BASE_URL='https://<site>'; npm run build:prod -- --env <name>` |
| Validate the generated manifest | `npm run validate:prod -- --env <name>` |
| See the pane without Outlook | `npm run preview` |
| Read the help of the script | `Get-Help .\tools\Deploy-NoFridayMail.ps1 -Full` |

`npm run preview` builds the pane and writes `dist/preview.html` (the real pane with a fake Office object, driven by the query, for example `?theme=dark&lang=en&state=sending`), `dist/preview-gallery.html` and `previews/taskpane-preview.html` (a standalone file showing light and dark, French and English). These files are never referenced by the manifest and never produced by `build` or `build:prod`: do not deploy them. The Smart Alerts dialog is drawn by Outlook and is not customizable.

<!-- icon: key -->
## 9. Exceptional send

This chapter describes the option **Exceptional send** and, above all, what the **server** does. To turn it on step by step, see the [user guide, chapter 7](NoFridayMail-UserGuide.md#7-change-the-settings).

### 9.1 Like to a 5-year-old

On a blocked day the add-in is a **doorman**: "No, not today." The exceptional-send option says: "If it is really urgent, **write why** on a paper."

There are two levels:

1. **Level 1, the justification alone** (`bypass` without `mfa`). The doorman sticks the paper on the message. Quick, but anyone can write anything: the paper does not prove **who** wrote it.
2. **Level 2, justification + "identity card"** (`bypass.mfa.required: true`). Before sticking the paper, the doorman sends the person to the **security desk** (Microsoft Entra ID): "Show me it is really you, with your code or your phone (MFA)." If it is fine, the desk writes the request in its **book** (the API of the site) and hands back a **numbered ticket** (the *receipt*). The doorman sticks the paper **and** the ticket on the message.

In both cases the add-in **never decides** whether the person is allowed. **Exchange** (the "director") looks at the list of allowed people. Not on the list: refused anyway. And everything is **logged**: the paper, the ticket, who, when, from where.

### 9.2 Overview (level 2)

```text
 1. The user writes the justification in the pane and clicks "Verify my identity and send".
 2. The pane asks Entra ID for a token (NAA, MSAL): silent, otherwise an MFA window
    (authentication context c1: "MFA every time").
 3. The pane calls  POST /api/bypass  (same site) with the token + the justification.
        API: valid token? (signature, issuer, audience, scope, context c1)    no -> 401
             valid justification? (same rules as the pane)                    no -> 400
             key NFM_RECEIPT_KEY present?                                     no -> 500
        API: log line "NFM_BYPASS {...}" (Application Insights), then answer 200 { receipt }
 4. The pane clears the delayed delivery, sets  X-NoFriday-Bypass: v2; <justification>; r=<receipt>,
    reads it back, then sends (sendAsync) or asks to click Send.
 5. OnMessageSend (add-in): blocked day + well-formed v2 header (recent receipt)? -> the message leaves.
 6. Exchange, transport rule FRIDAY-43:
        compliant v2 header AND sender member of GRP-NoFriday-Bypass?
            yes -> X-Friday-Exempt: Bypass + incident report + severity High -> the message leaves
            no  -> the blocking rules apply: the message is refused
 7. Purview DLP: alert + incident report for every message carrying X-NoFriday-Bypass (no blocking).
```

The add-in **cannot verify the signature of the receipt** (it holds no secret). It only checks its **form** and its **date** (less than one day old). The guarantee is **server side**: the API log, the check of the receipt with `tools/verify-receipt.js`, and the correlation between "receipts seen in messages" and "receipts issued by the API".

### 9.3 The header contract

```text
X-NoFriday-Bypass: v1; <justification, percent-encoded>
X-NoFriday-Bypass: v2; <justification, percent-encoded>; r=<receipt>
```

| Element | Rule |
|---|---|
| Name | `X-NoFriday-Bypass` |
| Version | exact prefix `v1; ` or `v2; ` ("v", digit, semicolon, one space) |
| Justification | the typed text, **cleaned** (leading and trailing spaces removed, inner blanks and line breaks reduced to one space), then encoded |
| Encoding | UTF-8 percent-encoding (as `encodeURIComponent`) for non-ASCII characters, control characters, `;` and `%`. The rest of printable ASCII, spaces included, stays readable |
| Form | a single ASCII line; the encoded text contains no `;` (the `;` separates the version, then the receipt) |
| Receipt (v2) | `r=<id>.<ts>.<sig>`: `id` = 12 base64url characters, `ts` = seconds since 1970 (10 digits), `sig` = 22 base64url characters |

Examples:

```text
X-NoFriday-Bypass: v1; R%C3%A9ponse urgente client
X-NoFriday-Bypass: v2; R%C3%A9ponse urgente au client Durand; r=abcDEF123456.1793356768.QWERTYuiopASDFghjklZXC
```

Decode with `[uri]::UnescapeDataString('R%C3%A9ponse urgente client')`, or `decodeHeaderValue()` in `src/shared/bypass.js`.

**The receipt (v2).**

```text
receipt = <id>.<ts>.<sig>
sig     = first 22 characters of base64url( HMAC-SHA256( NFM_RECEIPT_KEY, "<id>.<ts>.<oid>.<sha256(justification)>" ) )
```

- `oid` = the Entra object id of the user (in the token);
- `sha256(justification)` = lowercase hexadecimal SHA-256 of the **cleaned** justification (UTF-8);
- the key `NFM_RECEIPT_KEY` never leaves the server: not in a log, not in an answer, not in the add-in.

A receipt is therefore **bound** to a person (oid) and to a precise text: it cannot be pasted on another text nor reused in someone else's name without the verification failing.

### 9.4 What the add-in checks (user side)

The same pure function, `validateJustification()` (`src/shared/bypass.js`), serves the pane (button disabled while the input is weak), the `OnMessageSend` handler (header read back) **and the API** (a generated copy in `api/shared/`). Settings in the `bypass` object of the environment:

| Setting | Default | Meaning |
|---|:---:|---|
| `enabled` | `false` | `true` = the option exists; `false` or no block = it does not. Only mandatory field. |
| `minLength` | 20 | minimum characters, after cleaning |
| `maxLength` | 200 | maximum characters |
| `minWords` | 3 | number of words with at least 3 letters (Latin letters, French accents included); `0` disables the check |
| `minDistinctChars` | 6 | different letters (case-insensitive): refuses "test test test test"; `0` disables the check |
| (fixed) | | refusal of the same character repeated more than 4 times in a row ("....." , "aaaaa") |
| `mfa` | absent | Level 2 block: `required`, `tenantId`, `clientId`, `authContext` (`c` + 1 to 99, default `c1`) |

This check stops laziness ("." , "aaaaaaaaaaaaaaaaaaaa"), not bad faith: someone who writes three hollow words will pass. The real guarantee is **server side**.

**What `OnMessageSend` does.**

1. Allowed day: nothing special, the headers are not even read.
2. Blocked day, `bypass.enabled`, Mailbox 1.8 (`item.internetHeaders`): the handler reads `X-NoFriday-Bypass`:
   - **without `mfa.required`**: a well-formed `v1; ...` or `v2; ...; r=<receipt>` with a justification that passes `validateJustification` lets the message leave;
   - **with `mfa.required`**: **only** `v2`, with a receipt of the form `^[A-Za-z0-9_-]{12}\.\d{10}\.[A-Za-z0-9_-]{22}$` dated less than one day from the clock of the machine, and a valid justification. A `v1` header is **blocked**;
   - anything else (absent, malformed, too weak, read error): normal blocking, with a mention of the option.
   - **Case-insensitive header name**: depending on the client (Outlook on the web...), `X-NoFriday-Bypass` may come back in lowercase; the pane and the handler compare names in lowercase.
   - **`sessionData` fallback channel** (Mailbox 1.11): the pane also writes the same value to `item.sessionData` (key `nfm-bypass`) **before** `sendAsync`; the handler reads the Internet header first, then, if it is absent, malformed or unreadable, `sessionData` (same acceptance rule). `sessionData` is shared between the pane and the event runtime for the same draft: it avoids `OnMessageSend` running before it sees the header just written. **The Internet header remains mandatory**: it is what the Exchange transport rule reads on the sent message; `sessionData` only helps the client-side decision. "Remove the justification" also deletes the key.
   - **Support code** added to the dialog text **only when a justification was found but refused**: `code NFM-B2` malformed or weak (including a v1 when the MFA is required); `code NFM-B3` receipt malformed or older than one day. For an **absent** value or a **refused read** (Outlook on the web returns a failure for a missing key): **no code** (first request, the message is simply blocked); the handler only writes a `console.warn` trace ("no readable justification") without any value.
3. **Meeting invitations** (`OnAppointmentSend`) never go this way: an appointment has no `internetHeaders` and the handler reads nothing.
4. `sendAsync` (Mailbox 1.15) triggers `OnMessageSend` again: the handler is stateless, it reads the header again and lets the message go.
5. If the user deletes the justification later, the header stays on the message until it is removed; the reopened pane shows "Justification saved" with "Remove the justification".

The handler **cannot** verify the signature of the receipt (no client-side secret): an invented receipt of the right form passes the add-in. This is **intended**: the add-in is a comfort safeguard, not a proof. What really protects: the Exchange rule (group), the API log and the correlation (chapter 10).

### 9.5 The API `POST /api/bypass`

**Request**: `POST /api/bypass`, header **`X-NFM-Token: Bearer <Entra v2 access token>`** (and **not** `Authorization`: the managed functions of Static Web Apps **replace** that header by their own internal token, HS256, issuer `https://<guid>.scm.azurewebsites.net`, audience `https://<guid>.azurewebsites.net/azurefunctions`. The Entra token never arrives; the API ignores `Authorization` and only logs its presence, `authorizationHeaderIgnored`), body `{ "justification": "...", "subjectHash": "..." }` (`subjectHash` optional, 128 base64/base64url characters at most, logged for correlation).

**Token checks** (`jose`, public keys `https://login.microsoftonline.com/<tenantId>/discovery/v2.0/keys`):

| Check | Expected value |
|---|---|
| signature | RS256, key of the tenant |
| `iss` | `https://login.microsoftonline.com/<tenantId>/v2.0` |
| `aud` | `<clientId>` or `api://<clientId>` |
| `tid` | `<tenantId>` |
| `scp` | contains `access_as_user` |
| `oid` | present |
| `acrs` | contains the configured authentication context (`c1`) |

**Answers**

| Status | When | Body |
|:---:|---|---|
| 200 | everything is fine | `{ "receipt": "<id>.<ts>.<sig>", "ts": 1793356768 }` |
| 400 | weak justification or invalid body | `{ "error": "invalid_justification", "code": "short|long|repeat|words|distinct|empty" }` or `{ "error": "invalid_request" }` |
| 401 | no `X-NFM-Token` (an `Authorization` alone does not count; log reason `missing_token`) | `{ "error": "missing_token" }` + `WWW-Authenticate: Bearer realm="nofridaymail"` |
| 401 | invalid or expired token | `{ "error": "invalid_token" }` + `WWW-Authenticate: Bearer error="invalid_token"` |
| 401 | valid token **without** the authentication context (MFA not played back) | `{ "error": "insufficient_claims" }` + `WWW-Authenticate: Bearer error="insufficient_claims", claims="<base64>"` |
| 405 | method other than POST | |
| 500 | configuration or `NFM_RECEIPT_KEY` missing or too short | `{ "error": "server_misconfigured" }` |

The `claims` challenge is the JSON `{"access_token":{"acrs":{"essential":true,"value":"c1"}}}` in base64: the pane plays it back **once** to get a token with the context, then calls the API again.

**Log** (one line per receipt, prefix `NFM_BYPASS `, JSON): `receiptId`, `ts`, `upn`, `oid`, `tid`, `ip`, `justification` (full text), `sha256`, `authContext`, `userAgent`, `subjectHash`, `environment`, and for freshness `uti`, `iat`, `acrs`. Refusals have the prefix `NFM_BYPASS_DENIED ` (reason, oid if known). **Never** the token nor the key.

| Name | Where | Content | Who creates it |
|---|---|---|---|
| `NFM_RECEIPT_KEY` | application setting (**secret**) | base64 of at least 32 random bytes | `tools/Deploy-NoFridayMail.ps1`, **only if missing** (value never shown); do not change it: old receipts could no longer be verified |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | application setting | Application Insights connection string | the script, if `azure.appInsights` is set |
| `api/config.json` | **generated** file (git-ignored) | `tenantId`, `clientId`, `authContext`, justification limits | `npm run build:prod` (`tools/prepare-api.js`), from the environment file |
| `api/shared/bypass.js` | **generated** file | copy of `src/shared/bypass.js` | same |

No secret in a file: the key is only an application setting. To **create the key by hand** (without the script): `az staticwebapp appsettings set --name <swa> --resource-group <rg> --setting-names "NFM_RECEIPT_KEY=<base64 of 32 bytes>" --output none` (the default output of `az` would show the value: keep `--output none`).

### 9.6 Entra ID prerequisites (an administrator does this)

One app registration **per environment**, which is both the **client** (NAA) and the **API**.

1. **App registration** (Entra ID › App registrations › New): single tenant. Note the **Application (client) ID** and the **Tenant ID** (Overview page).
2. **Authentication** › Add a platform › **Single-page application** (SPA): two redirect URIs, with the host name of the Static Web App (`<swa-host>`, for example `swa-nofridaymail-contoso.azurestaticapps.net`):
   - `brk-multihub://<swa-host>`
   - `https://<swa-host>/taskpane.html`
3. **Expose an API**: Application ID URI `api://<clientId>`; add the scope **`access_as_user`** (admins and users). The same application is client **and** API, so there is nothing to pre-authorize.
4. **Manifest** of the registration: `requestedAccessTokenVersion` (or `accessTokenAcceptedVersion`) = **2** (v2 tokens, issuer `.../v2.0`).
5. **API permissions**: grant admin consent (scope `access_as_user` of your own application).
6. **Authentication context** (Entra ID › Protection › Conditional Access › Authentication contexts › New): ID **`c1`**, name "NoFriday: exceptional send", tick "Publish to apps". Another ID (`c2`...`c99`) works: put it in `authContext`.
7. **Conditional Access policy** "MFA, sign-in frequency every time":
   - Target resources: **Authentication context** › `c1`;
   - Users: the allowed group (`GRP-NoFriday-Bypass`);
   - Grant: **Require multifactor authentication**;
   - Session: **Sign-in frequency** › **Every time**.
8. **License**: Microsoft Entra ID **P1** (Conditional Access and authentication contexts) for the people concerned.
9. **Outlook**: nested app authentication (NAA, requirement set `NestedAppAuth 1.1`) needs a recent Outlook (web, new Outlook, recent Windows). Otherwise the pane shows "Your version of Outlook does not allow the exceptional send" and no button.

These are values **you** provide; none of this is created by the project. To validate in a test environment: the playback of the MFA by the NAA window and the presence of `acrs` in the token.

**Fill in `mfa` in the environment file.**

```json
"bypass": {
  "enabled": true,
  "mfa": {
    "required": true,
    "tenantId": "<Tenant ID: Entra ID > Overview>",
    "clientId": "<Application (client) ID of the registration>",
    "authContext": "c1"
  }
}
```

| Value | Where to find it |
|---|---|
| `tenantId` | Entra ID › Overview › **Tenant ID** |
| `clientId` | the app registration › Overview › **Application (client) ID** |
| `authContext` | Conditional Access › Authentication contexts › **ID** column (`c1`...) |

While `tenantId` and `clientId` hold `00000000-0000-0000-0000-000000000000` (**placeholders**), the build and `npm run validate:env` accept them, but **`Deploy-NoFridayMail.ps1` and the GitHub workflow refuse to deploy** (message: "valeur de remplacement ... Renseignez l'ID de locataire ..."). Check with `node tools/env-config.js <name> --deploy`. With `required: true` the level-1 button disappears: the pane only offers "Verify my identity and send" and the add-in refuses messages without a ticket.

### 9.7 Server side 1: the Exchange transport rule (authorization and audit)

Role: only the members of an authorized group can send on a blocked day.

1. Create a security group, for example `GRP-NoFriday-Bypass`, and add the authorized people. **It is the same group** as the one targeted by the Conditional Access policy (step 7 above).
2. Create the rule **FRIDAY-43**, with a priority **lower in value (so higher in precedence)** than the blocking rules (FRIDAY-40, FRIDAY-41):
   - condition: the header `X-NoFriday-Bypass` matches the pattern below **and** the sender is a member of `GRP-NoFriday-Bypass`;
   - actions: add the header **`X-Friday-Exempt: Bypass`** (the exemption header already used, for example with `Meeting`), audit severity **High**, **incident report** to the compliance mailbox;
   - **the blocking rules** (FRIDAY-40, FRIDAY-41) have as exception the header `X-Friday-Exempt` containing `Bypass` (besides `Meeting`).
3. A sender who is **not** a member does not trigger FRIDAY-43: the blocking rules apply and the message is refused.

**Patterns of FRIDAY-43.** Level 2 (`mfa.required`), v2 header with receipt, **at least 20 characters** and **3 words of at least 3 letters**:

```text
^v2; (?=.{20,}).*[A-Za-z]{3,}.* .*[A-Za-z]{3,}.* .*[A-Za-z]{3,}.*; r=[A-Za-z0-9_-]{12}\.\d{10}\.[A-Za-z0-9_-]{22}$
```

Level 1 (no MFA), v1 header:

```text
^(?=v1; .{20,}$)v1; .*[A-Za-z]{3,}.* .*[A-Za-z]{3,}.* .*[A-Za-z]{3,}
```

This is a **rough mirror** of the check of the add-in: regular expressions of transport rules are limited, and the server sees the **encoded** value (`R%C3%A9ponse`: only sequences of ASCII letters count; the encoded length is greater than or equal to the decoded length). It does not check the different letters nor the repetitions, and **not the signature of the receipt**: a regular expression cannot compute an HMAC. The **user** check is the add-in's; the **authenticity** check is the API log + `tools/verify-receipt.js`. Tests (`tests/bypass.test.js`) verify that every header produced by the add-in passes these patterns.

The patterns of one condition are combined with **OR** in Exchange: to require both the form and the length, use the single patterns above (with lookahead), and check them in your tenant.

```powershell
# Example (Exchange Online PowerShell, adapt it; never put credentials or certificates in the repository)
$p = @{
    HeaderMatchesMessageHeader = 'X-NoFriday-Bypass'
    HeaderMatchesPatterns      = '^v2; (?=.{20,}).*[A-Za-z]{3,}.* .*[A-Za-z]{3,}.* .*[A-Za-z]{3,}.*; r=[A-Za-z0-9_-]{12}\.\d{10}\.[A-Za-z0-9_-]{22}$'
    FromMemberOf               = 'GRP-NoFriday-Bypass'
    SetHeaderName              = 'X-Friday-Exempt'
    SetHeaderValue             = 'Bypass'
    SetAuditSeverity           = 'High'
    GenerateIncidentReport     = 'compliance@example.com'
    IncidentReportContent      = 'Sender','Recipients','Subject','Severity','RuleDetections','AttachOriginalMail'
}
New-TransportRule -Name 'FRIDAY-43 Justified bypass (group)' -Priority 11 @p
foreach ($r in 'FRIDAY-40 REGEX Block TZ-CET', 'FRIDAY-41 ACTEXP Block TZ-CET-PROD') {
    Set-TransportRule $r -ExceptIfHeaderContainsMessageHeader 'X-Friday-Exempt' -ExceptIfHeaderContainsWords 'Meeting','Bypass'
}
```

### 9.8 Server side 2: Purview DLP (compliance trace)

Role: keep a trace of **every** occurrence of the header, allowed or not, **without blocking**. Pattern: `^v[12]; ` (v1 **and** v2).

- A DLP policy on Exchange, mode "On".
- Rule: condition **`HeaderMatchesPatterns`** on `X-NoFriday-Bypass`, actions: **alert** (severity High) and **incident report** to the compliance mailbox, **no blocking action**.

```powershell
New-DlpCompliancePolicy -Name 'NoFriday - Bypass audit' -ExchangeLocation All -Mode Enable
New-DlpComplianceRule -Name 'NoFriday - Bypass header' -Policy 'NoFriday - Bypass audit' `
    -HeaderMatchesPatterns @{ 'X-NoFriday-Bypass' = '^v[12]; ' } `
    -GenerateAlert 'compliance@example.com' -ReportSeverityLevel High `
    -GenerateIncidentReport 'compliance@example.com' -IncidentReportContent All
```

### 9.9 Known limits (read before turning it on)

1. **The header can be set by a tool other than the add-in** (an alternative mail client, a script, an API). At level 1 nothing distinguishes it from a real one. At level 2 a header **without an authentic receipt** can be detected afterwards (correlation, `verify-receipt.js`) but is **not blocked** by the server (a transport rule does not compute an HMAC): that is why **every occurrence is logged** and **the authorization rests on the Exchange group** (the identity of the authenticated sender), never on the presence of the header.
2. The quality check of the justification is an aid for the user, not a security barrier.
3. The add-in is in `SoftBlock` mode (if it does not load, the send goes, as for the Friday rule).
4. Without Mailbox 1.8 (`internetHeaders`) the section does not appear. With `mfa.required`, `NestedAppAuth 1.1` is also needed.
5. The letter check covers the Latin alphabet (French, English, accents), not Greek, Cyrillic or CJK.
6. Do not change `NFM_RECEIPT_KEY` lightly: receipts already issued could no longer be verified. A rotation is possible (a new key, the old one kept for offline verification).

<!-- icon: search -->
## 10. Finding a request

Four places, from the most precise to the widest. Table and column names may vary with your workspace: check them.

### 10.1 The API book: Application Insights (who, when, what, why)

KQL queries (Application Insights › Logs):

```kusto
// All requests (one line per issued receipt)
traces
| where message startswith "NFM_BYPASS "
| extend e = parse_json(substring(message, strlen("NFM_BYPASS ")))
| project timestamp, receiptId = tostring(e.receiptId), upn = tostring(e.upn), oid = tostring(e.oid),
          ip = tostring(e.ip), justification = tostring(e.justification), sha256 = tostring(e.sha256),
          authContext = tostring(e.authContext), subjectHash = tostring(e.subjectHash), userAgent = tostring(e.userAgent)
| order by timestamp desc
```

```kusto
// The refusals (token without MFA, weak justification, configuration)
traces
| where message startswith "NFM_BYPASS_DENIED "
| extend e = parse_json(substring(message, strlen("NFM_BYPASS_DENIED ")))
| project timestamp, reason = tostring(e.reason), detail = tostring(e.detail), code = tostring(e.code),
          upn = tostring(e.upn), oid = tostring(e.oid), ip = tostring(e.ip)
| order by timestamp desc
```

Without Application Insights (`azure.appInsights` not set), the same lines are in the log stream of the function (Azure portal › Static Web App › Functions / log stream).

### 10.2 The proof of identity: Entra sign-in logs

```kusto
// Sign-ins to the application of the environment that satisfied the authentication context c1
SigninLogs
| where AppId == "<clientId>"
| mv-expand ctx = AuthenticationContextClassReferences
| where tostring(ctx.id) == "c1"
| project TimeGenerated, UserPrincipalName, UserId, IPAddress, ConditionalAccessStatus, AuthenticationRequirement, ResultType
| order by TimeGenerated desc
```

`UserId` is the `oid` of the API log: the two must match (same person, same minute). In the portal: Entra ID › Sign-in logs › filter "Application" = the registration, detail › **Conditional Access** tab (the MFA policy applied).

**Freshness of the MFA: the 5-minute window.** *Like to a 5-year-old*: the MFA is a stamp on the hand. Entra does not ask for a new stamp if the previous one is **less than 5 minutes** old. Two exceptional sends of the same person 3 minutes apart share **the same stamp**; beyond that, a new stamp is required.

The Conditional Access policy "sign-in frequency: **every time**" does not impose one MFA per token: the Microsoft documentation states that with "every time", Entra takes a clock skew of five minutes into account ("*doesn't prompt users more often than once every five minutes*", [Configure authentication session management with Conditional Access](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-session-lifetime)). A second request within these 5 minutes therefore reuses the previous MFA ("Previously satisfied"), and the NAA window does not even need to ask for a code again.

**The guarantee, stated precisely**: each receipt is bound to an MFA satisfied by **the same person (`oid`) at most about 5 minutes before** the token was issued, not to an MFA performed for that send alone. Guaranteed: the receipt exists only if Entra issued a token carrying the authentication context `c1` (`acrs`) for that person. Not guaranteed: that the MFA is played back at each send within that window.

To know, **receipt by receipt**, whether the MFA was **freshly performed** or **reused**, the API log contains the unique token identifier (`uti`, not secret), its issue time (`iat`) and the satisfied contexts (`acrs`): `uti` is the same value as the `UniqueTokenIdentifier` column of the Entra sign-in logs and the `uti` claim of the access token.

```kusto
// For each receipt: was the MFA performed for this request, or "already satisfied"?
// Needs the export of the Entra sign-in logs to Log Analytics (Entra ID > Diagnostic settings:
// SignInLogs and NonInteractiveUserSignInLogs), in the same workspace as the API traces (or a
// cross-workspace query).
let receipts = traces
    | where message startswith "NFM_BYPASS "
    | extend e = parse_json(substring(message, strlen("NFM_BYPASS ")))
    | project receiptTime = timestamp, receiptId = tostring(e.receiptId), upn = tostring(e.upn), oid = tostring(e.oid),
              uti = tostring(e.uti), tokenIssuedAt = unixtime_seconds_todatetime(tolong(e.iat)), acrs = tostring(e.acrs);
let signIns = union isfuzzy=true SigninLogs, AADNonInteractiveUserSignInLogs
    | extend uti = tostring(UniqueTokenIdentifier)
    | project uti, SignInTime = TimeGenerated, AuthenticationRequirement, ConditionalAccessStatus,
              AuthenticationDetails, AuthenticationContextClassReferences, ResultType;
receipts
| join kind=leftouter signIns on uti
| extend mfaDetail = tostring(AuthenticationDetails)
| extend mfaFreshness = case(
    isempty(SignInTime), "no sign-in line (log not exported, or ingestion delay)",
    mfaDetail has "Previously satisfied", "MFA already satisfied (reused, 5-minute window)",
    mfaDetail has "MFA" or mfaDetail has "Mobile app" or mfaDetail has "Text message" or mfaDetail has "Phone call" or mfaDetail has "FIDO", "MFA performed for this request",
    "to examine")
| project receiptTime, receiptId, upn, uti, tokenIssuedAt, SignInTime, AuthenticationRequirement, mfaFreshness, AuthenticationDetails
| order by receiptTime desc
```

Without the export to Log Analytics: in the Entra portal (Entra ID › Sign-in logs, tabs "User sign-ins (interactive)" **and** "non-interactive"), add the filter **Unique token identifier** (the `uti` of the API log); in the **Authentication details** tab, a "Previously satisfied" line means a reused MFA, a line with a method (mobile app, SMS, FIDO...) means an MFA performed for that request.

### 10.3 The message: Exchange and DLP

```powershell
# Message trace, then detail: the FRIDAY-43 rule shows in the transport rule events
$trace = Get-MessageTraceV2 -SenderAddress alice@contoso.com -StartDate (Get-Date).AddDays(-2) -EndDate (Get-Date)
$trace | Get-MessageTraceDetailV2 | Where-Object { $_.Detail -like '*FRIDAY-43*' -or $_.Event -like '*Transport*' }

# DLP alerts and reports (one line per message carrying the header)
Search-UnifiedAuditLog -StartDate (Get-Date).AddDays(-7) -EndDate (Get-Date) -RecordType ComplianceDLPExchange -ResultSize 500 |
    Select-Object CreationDate, UserIds, Operations, AuditData
```

The incident report sent to the compliance mailbox contains the sender, the subject and the header: that is where `X-NoFriday-Bypass: v2; ...; r=<receipt>` is read.

### 10.4 The authenticity of a receipt: `tools/verify-receipt.js`

With the header found in a message and the `oid` of the sender (API log or sign-in log):

```powershell
$env:NFM_RECEIPT_KEY = '<value of the application setting of the Static Web App>'
node tools/verify-receipt.js --header "v2; R%C3%A9ponse urgente au client Durand; r=abcDEF123456.1793356768.QWERTYuiopASDFghjklZXC" --oid aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
# or, in parts:
node tools/verify-receipt.js --receipt abcDEF123456.1793356768.QWERTYuiopASDFghjklZXC --oid <oid> --justification "Réponse urgente au client Durand"
```

Answer: `VALIDE` (receipt, issue date, justification) or `INVALIDE` with the reason: malformed header, **version 1** (send without MFA step), malformed receipt, or **signature that does not match** (different oid or text, invented receipt, other key). Exit code: 0 valid, 1 invalid, 2 usage or key missing. The key is passed **by environment variable only** (`az staticwebapp appsettings list --name <swa> --resource-group <rg>` shows it: treat it as a password and paste it neither in a ticket nor in a file of the repository).

### 10.5 Correlation idea (Microsoft Sentinel)

**A receipt seen in a message without a matching `NFM_BYPASS` line in the API log is suspect**: either the receipt was invented, or the log was lost. Principle:

1. import into a table (for example `NfmBypassMailHeaders_CL`) the receipts extracted from the FRIDAY-43 / DLP incident reports (`receiptId` = the first 12 characters of the receipt, `Sender`, `Subject`, time);
2. compare with the issued receipts:

```kusto
let issued = traces
    | where message startswith "NFM_BYPASS "
    | extend e = parse_json(substring(message, strlen("NFM_BYPASS ")))
    | project receiptId = tostring(e.receiptId), issuedAt = timestamp, oid = tostring(e.oid), upn = tostring(e.upn);
NfmBypassMailHeaders_CL
| join kind=leftanti issued on receiptId
| project TimeGenerated, Sender, Subject, receiptId
```

Every returned line is an exceptional-send message **without a receipt issued by the API**: investigate (then `verify-receipt.js`). Conversely, an issued receipt never seen in a message is not abnormal (a request abandoned after the receipt). Add a scheduled analytics rule on this query.

# Part IV · Maintain

<!-- icon: layers -->
## 11. Download, packaging and integrity

### 11.1 What is distributed

A public user can download only what is needed to **deploy and use** the add-in. Three channels carry the same set of files:

```cards
download | Release ZIP | `NoFridayMail-<version>.zip` on the Releases page. Recommended. Owner-signed PowerShell files and `PackageIntegrity.psd1`.
folder | Download ZIP / `git archive` | The same files, built from the repository by `.gitattributes` `export-ignore` rules. No signature manifest.
code | Repository clone | The same files plus the tests, the CI workflows and the developer tools.
```

Shipped: `package.json` and lock file, `webpack.config.js`, `src/`, `api/`, the build tools (`tools/build*.js`, `env-config.js`, `manifest-lib.js`, `check-bundle.js`, `package-api.js`, `prepare-api.js`, `swa-config.js`, `validate-manifest.js`, `blocked-days.js`, `deploy-text.js`), `tools/verify-receipt.js` (the compliance team uses it), the deploy script, the environment generator `tools/New-NoFridayMailEnvironment.ps1` and the `tools/lib/` helpers, `tools/Test-PackageIntegrity.ps1`, `manifest.xml`, `staticwebapp.config.json`, the icons, `deploy/environment.schema.json`, `example.json` and `prod.json`, the documentation (Markdown and HTML), `README.md`, `LICENSE`, `THIRD-PARTY-NOTICES.md`, `SECURITY.md`, `CHANGELOG.md`. Kept in the repository only: `tests/` (with the fixtures), `.github/`, the preview and icon-generation tools, the documentation generator, the package builder, `AGENTS.md`, `PROVENANCE.md`. When `tests/` is absent the deploy script skips `npm test` and says so; the build and the validation still run.

### 11.2 Integrity and signature of a release

The release ZIP is built from `git archive` of the reviewed revision (so it is identical to the repository download), plus `PackageIntegrity.psd1`: the SHA-256 of every file and the expected signer. `tools/Test-PackageIntegrity.ps1 -Root <folder>` verifies it: a valid, timestamped Authenticode signature of the owner on the PowerShell files and on the manifest, then the SHA-256 of every file; missing, changed or unknown executable files fail. The deploy script runs this check first when `PackageIntegrity.psd1` is present.

```path
Verify | check | Verify a release
Verify | 1 | Extract the ZIP | in a new folder, files unblocked
Verify | 2 | Check the integrity | `.\tools\Test-PackageIntegrity.ps1 -Root .`
Verify | 3 | Check the attestation | GitHub artifact attestation of the ZIP, against the official repository
```

A checksum alone does not authenticate a file if the checksum and the file can both be replaced. A valid signature or attestation proves integrity or provenance, not the absence of vulnerabilities. The signing and timestamping of the PowerShell files and of the manifest is done by the owner with their own procedure; **CI never signs and never needs the certificate, secrets, Azure or Exchange**: it builds an unsigned verification package only. A package built that way is a test artifact and is not to be deployed.

### 11.3 Reporting

See `SECURITY.md` to report a vulnerability privately. Never publish credentials, tenant data or sensitive exploit details in a public issue.

<!-- icon: wrench -->
## 12. Development

```steps
Install | `npm ci` in the repository.
Test | `npm test` (about 300 tests, `node --test`), then Pester for the deploy script: `Invoke-Pester tests/Deploy.Tests.ps1`.
Build | `npm run build`, `npm run validate:env`, and `npm run validate` for the development manifest.
Change | A short-lived branch, a pull request to `main`, CI green, merge. Release: a new version, a `v` tag, a draft release, then the attestation.
```

### 12.1 Structure

| Path | Role |
|---|---|
| `src/shared/config.js` | Blocked days, send hour and every localized string (`languages.fr` / `languages.en`). |
| `src/shared/rules.js` | Pure date logic, no Office dependency. A unit test for every rule change. |
| `src/shared/bypass.js` | Header contract and `validateJustification`, shared by the pane, the handler and the API. |
| `src/launchevent/` | `OnMessageSend` / `OnAppointmentSend` handlers (bundle `launchevent.js`). |
| `src/taskpane/` | The "Schedule send" pane; `naa.js` is the only importer of `@azure/msal-browser` and must never reach `launchevent.js`. |
| `src/commands/commands.html` | Page of the browser runtime that loads `launchevent.js` (in `<head>`, no `defer`). |
| `api/` | Managed API of the MFA level. |
| `manifest.xml` | Development manifest (`https://localhost:3000`); the production manifest is generated by `tools/build-manifest.js`. |
| `deploy/` | Schema and shipped environments. |
| `tools/` | Build, checks, deploy script. |

### 12.2 Conventions

- The task pane button id in `manifest.xml` must equal `taskPaneCommandId` in `config.js` (`tests/handlers.test.js`).
- Smart Alerts limits apply in each language: message 500 characters, `cancelLabel` 20 characters.
- Tests never assert the values of operator-owned environment files: they use `tests/fixtures/environments` through `NFM_ENVIRONMENTS_DIR`. Only `example.json` (template) is read as-is.
- Never let `OnAppointmentSend` bypass. The receipt key is an application setting, never a file, a log line or console output.
- Hand-written Fluent 2 CSS with light and dark tokens; `npm run icons` regenerates the PNG icons from `assets/icon*.svg`.
- A public-safety test fails if a tenant id, a subscription id, a real host name or a private account name appears in a tracked file.

### 12.3 Documentation

The guides are Markdown with a small set of fenced blocks (`cards`, `steps`, `flow`, `path`); `tools/Build-Documentation.js` turns them into self-contained HTML pages (`docs/*.html`), and a test checks that the HTML is up to date. Rebuild after editing a guide: `node tools/Build-Documentation.js`.

<!-- icon: lifebuoy -->
## Annex A — Troubleshooting

| Symptom | Cause and action |
|---|---|
| `Azure session: none` | Run `az login`. |
| `Subscription ... is not accessible` | Wrong account or subscription: `az account list`, or fix `azure.subscriptionId`. |
| `The add-in Id of environment ... is a template value` | The file holds a placeholder Id. Create the environment with `New-NoFridayMailEnvironment.ps1`, or put the output of `[guid]::NewGuid()` in `addinId`. |
| `addinId ... is already used by ...` | Two environments have the same GUID: give a new one (`[guid]::NewGuid()`) to the one that was never deployed. |
| `Check failed: ... does not contain blockedDays` | The served site is not the one of this environment (wrong resource, propagation in progress): run again after a few minutes. |
| Outlook does not block | The manifest is not published (or not yet propagated, up to 24 h), or the user is not in the target; reopen Outlook. |
| `ADDIN_BASE_URL est requise` | An environment build needs the site address; the deploy script provides it. By hand: `$env:ADDIN_BASE_URL='https://...'`. |
| The pane says "Your version of Outlook does not allow the exceptional send" | `NestedAppAuth 1.1` missing: Outlook too old or an unsupported client. |
| "The validation of your identity failed" right after the window | SPA redirect URIs missing or wrong (`brk-multihub://...`), or the admin consent is missing. |
| "Your identity could not be validated (multifactor authentication required)" | No `acrs` in the token: authentication context missing, not published, or not targeted by the Conditional Access policy; the API answered 401 twice. |
| "The justification service answered with an error (500)" | `NFM_RECEIPT_KEY` missing or too short (log: `NFM_BYPASS_DENIED ... server_misconfigured`), or `api/config.json` missing from the deployment. |
| "unreachable" | The API is not deployed (the post-deployment check expects a 401 without a token), or the network. |
| 404 on `POST /api/bypass` after a deployment | The API was deployed without `node_modules` (`--api-location ./api` instead of the package `out/api-pkg/<env>`), or the site configuration of the repository root was used instead of `dist/<env>` (`--swa-config-location` missing). |
| 401 `missing_token` in the log with `authorizationHeaderIgnored: true` | The Entra token was sent in `Authorization` (overwritten by Static Web Apps) instead of `X-NFM-Token`. |
| 401 `invalid_token` in the log | Wrong `clientId` / `tenantId`, a v1 token (`requestedAccessTokenVersion` is not 2), scope missing. |
| 401 `insufficient_claims` | The token has no authentication context: the MFA was not played back. Check the context and the Conditional Access policy. |
| `Package integrity: ...` | A file of the release is missing, changed or unknown, or a signature is not valid. Download the release again; do not edit protected files. |
| Manifest rejected when adding it | The development `manifest.xml` (points to `localhost`) or a page saved with Ctrl+S. Use `dist/<env>/manifest.prod.xml`. |

<!-- icon: file -->
## Annex B — The example environment, line by line

```jsonc
{
  "name": "example",                      // = the file name, without .json
  "displayName": "NoFridayMail (Staging)", // name shown in Outlook (en-US and en-GB identical)
  "addinId": "11111111-2222-4333-8444-555555555555", // UNIQUE and STABLE GUID: placeholder here, generated once by New-NoFridayMailEnvironment.ps1
  "version": "1.0.0.0",                   // 4 numbers; raise at each manifest change
  "providerName": "My Organization",      // "Provider" shown in the admin center
  "supportUrl": "https://example.com/support-nofridaymail", // support address (HTTPS)
  "azure": {
    "subscriptionId": "00000000-0000-0000-0000-000000000000", // optional: targeted Azure subscription
    "resourceGroup": "rg-nofridaymail-staging", // resource group (created if missing)
    "location": "westeurope",             // region of the Static Web App
    "staticWebAppName": "swa-nofridaymail-staging", // name of the Static Web App (unique)
    "sku": "Free"                         // Free or Standard
  },
  "rules": {
    "blockedDays": [1, 2],                // FORBIDDEN days: here Monday and Tuesday
    "workingDays": [1, 2, 3, 4, 5],       // OFFERED days: Monday to Friday (minus blocked days)
    "sendHour": 9, "sendMinute": 30,      // time of the suggestions: 09:30
    "slotTimes": ["09:30", "11:00", "14:00", "16:30"], // time chips (8 at most)
    "dayCount": 8                         // number of days in the row (1 to 10)
  },
  "bypass": { "enabled": false },         // optional: justified exceptional send (chapter 9); "mfa": level 2
  "defaultLanguage": "fr"                 // fallback language: fr or en
}
```

The real file `deploy/environments/example.json` has **no** comments (JSON does not accept them): they are here to explain every line. Its `description` field is a memo. Note that the example blocks Monday and Tuesday, is named "(Staging)" and holds a placeholder `addinId`: it is a template, never deployed as is (use `New-NoFridayMailEnvironment.ps1`).

<!-- icon: tag -->
## Annex C — Versioning

MAJOR.MINOR.PATCH for the package (`package.json`, `CHANGELOG.md`); the manifest version has four numbers (`1.1.0.0`) and is raised at each manifest change. A release uses a new version and a `v` tag on a commit already merged into `main`; a tag is never moved, deleted or reused. `CHANGELOG.md`, `package.json` and the manifest `Version` change together. Every change is listed in `CHANGELOG.md`.
