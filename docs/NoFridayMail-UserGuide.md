---
title: NoFridayMail
subtitle: User guide
version: 1.1.0
author: Nicolas Fabert
updated: 2026-10-30
---

# NoFridayMail — User guide

> Follow the path, one step after the other. Each step says **what to do**, gives the command to copy, says **what you should see**, and **what to do if not**. How the add-in works, every setting and the internals are in the [technical guide](NoFridayMail-Guide.md).

> [!IMPORTANT]
> Files downloaded from the Internet may be blocked by Windows and fail to run. Before using this project, unblock every file in the downloaded folder:
>
> ```powershell
> Get-ChildItem "C:\Chemin\Du\Dossier" -Recurse -File -Force | Unblock-File
> ```
>
> Replace the example path with the folder where you downloaded or extracted this project.

> [!WARNING]
> NoFridayMail is a safeguard against accidental sends, not a security control. It uses the Smart Alerts `SoftBlock` mode: if Outlook cannot load the add-in, the message is sent. Outlook on Android and iOS is not covered. For a hard guarantee that no mail leaves on a blocked day, add an Exchange Online transport rule (chapter 1).

> [!NOTE]
> The exceptional send (a justification, with an identity check if you turn on the MFA level) is **off** in the delivered configuration. Turn it on only after the server side is in place: [technical guide, chapter 9](NoFridayMail-Guide.md#9-exceptional-send).

<!-- icon: flow -->
## 1. Start here

```path
Set up once | settings | Set up once: then the website is online
Set up once | 1 | Get the tools | PowerShell 7, Node.js, Azure CLI, then `az login`
Set up once | 2 | Prepare your environment | one command creates your file, with its own identity
Set up once | 3 | Simulate | `-WhatIf`: nothing is created, you only read
Set up once | 4 | Deploy | the website goes online and the script checks it
A | user | Install for one person (local)
A | 5 | Open Outlook on the web | `https://aka.ms/olksideload`
A | 6 | Add the manifest from a file | My add-ins › Custom add-ins
A | 7 | Test | send a mail on a blocked day
B | people | Deploy for everyone (centralized)
B | 5 | Upload the manifest | Microsoft 365 admin center › Integrated apps
B | 6 | Choose who gets it | a pilot group first
B | 7 | Wait and test | up to 24 hours
```

1. Do steps **1 to 4** once. They put the small website of the add-in online, in your own Azure subscription.
2. Then choose:
   - **A · Install for one person (local)** — to try the add-in on your own mailbox, with no administrator. Perfect for a test.
   - **B · Deploy for everyone (centralized)** — a Microsoft 365 administrator publishes the add-in to a group or to the whole company. This is the production way.
   - Or both: A first, then B.

**What the add-in does.** On a blocked day (Friday by default), when someone clicks **Send**:

```cards
mail | The message is blocked | A dialog explains why and offers **Schedule send**. Nothing leaves.
calendar | The schedule pane opens | The person picks another allowed day and time (Monday 08:00 for example) and the message leaves then.
people | Meetings are blocked too | An invitation cannot be delayed: it is blocked with an explanation and can be sent the next allowed day.
key | Exceptional send (option) | With a written justification, and an identity check (MFA) if you turn on that level. Exchange decides who is allowed.
```

**What it does not do.**

- Outlook on **Android and iOS** does not run Smart Alerts: the add-in does not cover mobile.
- If Outlook cannot load the add-in, the message is sent (`SoftBlock`). For a **hard guarantee**, add an Exchange Online **transport rule** that rejects mail on the blocked day. The add-in is the friendly layer, the rule is the strict one.
- Public holidays are not handled: only the day of the week counts.

**Which download to use.**

| Download | Where | What it is |
|---|---|---|
| **Release ZIP** `NoFridayMail-1.1.0.zip` (**recommended**) | the *Releases* page of the repository | The files to deploy and use, with the owner-signed PowerShell files and the integrity manifest `PackageIntegrity.psd1`. The deploy script verifies them before it runs anything. |
| *Download ZIP* of the repository, or `git archive` | the green **Code** button | **Exactly the same files**, without the signatures and the manifest. |
| `git clone` of the repository | GitHub | Everything above, plus what only contributors need: the tests (`tests/`), the CI workflows (`.github/`), the preview and icon tools. |

Inside the ZIP: the deploy script and its tools (`tools\`), the add-in sources (`src\`), the small API of the MFA level (`api\`), the environment schema with an example and a production template (`deploy\`), the manifest and site files, these guides (Markdown and HTML), `README.md`, `LICENSE`, `THIRD-PARTY-NOTICES.md`, `SECURITY.md` and `CHANGELOG.md`. The tests and the CI live **only in the repository**: when `tests\` is absent, the deploy script says so and skips `npm test`; the build and the validation still run.

**The commands use one example.** Copy them as they are, and only change the names in this table to yours:

| What | In the example | Change to |
|---|---|---|
| The folder of the add-in | `C:\Tools\NoFridayMail` | where you extracted the ZIP |
| The environment name | `contoso` | a short name of yours (lowercase letters, digits, dashes) |
| The Azure resource group | `rg-nofridaymail-contoso` | a name of your choice |
| The Azure website name | `swa-nofridaymail-contoso` | a name that nobody else uses in Azure |
| The blocked day | `[5]` (Friday) | your day: [chapter 7](#7-change-the-settings) |

<!-- icon: checklist -->
## 2. Before you start

```steps
Install the tools | PowerShell 7.4 or later, Node.js LTS (22 or later) and the Azure CLI. Three installs, a few minutes.
Get the add-in | Download the release ZIP, unblock the files (box above) and extract it to `C:\Tools\NoFridayMail`.
Check your Azure access | You can sign in to Azure with an account that may create resources (role *Contributor*) in a subscription.
```

### The details

| Item | Requirement |
|---|---|
| PowerShell | **7.4 or later** (`pwsh`). Windows PowerShell 5.1 is not enough. |
| Node.js | **22 or later** (LTS), with `npm`. |
| Azure CLI | `az`, signed in with `az login`. |
| Azure | A subscription where you can create a resource group and a *Static Web App* (role **Contributor**). The `Microsoft.Web` provider must be registered (`az provider register --namespace Microsoft.Web`). The Free plan is enough. |
| Microsoft 365 | To publish for everyone (path B): the **Global Administrator** or **Exchange Administrator** role, in the Microsoft 365 admin center. For path A, nothing. |
| Outlook | Outlook on the web, new Outlook for Windows, classic Outlook for Windows 2206 or later, Outlook for Mac (new interface). Mailbox in Exchange Online. |

If a tool is missing, the deploy script tells you in plain words and says what to do (the checklist of step 3). You can also install them now:

```powershell
winget install Microsoft.PowerShell
winget install OpenJS.NodeJS.LTS
winget install Microsoft.AzureCLI
```

**You should see:** each command ends with *Successfully installed*. Close the terminal and open a new one, so that the new tools are found.

**If not:** `winget` is not available on old Windows: use the installers of [PowerShell](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows), [Node.js](https://nodejs.org) and [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli).

### Open a terminal in the folder

In File Explorer, open the folder `C:\Tools\NoFridayMail`, click the address bar, type `pwsh` and press Enter. A PowerShell 7 window opens **already in the right folder**. Check:

```powershell
$PSVersionTable.PSVersion
Get-Location
```

**You should see:** a version that starts with 7 (7.4 or more) and the path `C:\Tools\NoFridayMail`.

**If not:** if `pwsh` is not recognized, PowerShell 7 is not installed or the terminal was opened before the installation: close it and open a new one.

> [!NOTE]
> Keep this window open for all the steps. Every command below is run from the folder of the add-in.

<!-- icon: settings -->
## 3. Set up once

### 1 · Get the tools ready

**Do:** sign in to Azure, then choose the subscription where the website will live:

```powershell
az login
az account list --output table
az account set --subscription "<name or id of your subscription>"
```

**You should see:** a browser window to sign in, then a table of your subscriptions with one marked `True` in the *IsDefault* column.

**If not:** *az is not recognized*: open a new terminal after installing the Azure CLI. *No subscription found*: your account has no Azure subscription; ask your Azure administrator.

Then install the add-in's own tools once (this downloads its libraries, about one minute):

```powershell
npm ci
```

**You should see:** a line like `added 300 packages` and no red `npm error`.

### 2 · Prepare your environment

An *environment* is one small text file that says everything about one installation: its name, its Azure names, the blocked days. Your files go in `deploy\environments.local\`, a folder that is yours and never published.

> [!IMPORTANT]
> **One environment = one add-in identity.** The file holds an `addinId`, a long number that Outlook uses to recognise your add-in. It is generated **once**, by the command below, and kept **for good**. With the same number, every new deployment *updates* the add-in your users already have. With a new number, they would get a *second* add-in. So: never change it after users installed the add-in, and never copy it into another environment.

**Do:** create the file. First read what the command would do, then run it:

```powershell
pwsh .\tools\New-NoFridayMailEnvironment.ps1 -Name contoso -WhatIf
pwsh .\tools\New-NoFridayMailEnvironment.ps1 -Name contoso
notepad deploy\environments.local\contoso.json
```

`-Name` is the short name of the environment (lowercase letters, digits, dashes). The command copies the template, generates a fresh `addinId`, checks that no other environment uses it, validates the file and writes `deploy\environments.local\contoso.json`. Defaults: Friday blocked, region `westeurope`, display name `NoFridayMail (contoso)`, Azure names `rg-nofridaymail-contoso` and `swa-nofridaymail-contoso`. Change any of them with `-DisplayName`, `-ResourceGroup`, `-StaticWebAppName`, `-Location`, `-SubscriptionId` and `-BlockedDays` (for example `-BlockedDays 1,2` blocks Monday and Tuesday; 5 is Friday, the table is in [chapter 7](#7-change-the-settings)).

**You should see:** the three steps **1/3 Checks**, **2/3 Add-in Id and file content**, **3/3 Validation and file**, then a green *Environment created* card with the path of the file and the new Id, and a *Next steps* card. With `-WhatIf` the card says *Simulation finished* and nothing is written.

In Notepad, check `providerName` and `supportUrl` (shown in the admin center) and leave `addinId` as it is. Running the command again for the same name stops with *already exists*: the file, and its Id, are never replaced by accident. `-Force` rewrites the other values from the template and **keeps the Id**.

Check the file:

```powershell
npm run validate:env
```

**You should see:** `Valid environments: contoso, example, prod`.

**If not:** the message lists the exact line that is wrong (a missing comma, a name different from the file name, a number that is not a valid identity). Fix it and run the command again.

### 3 · Simulate

**Do:** run the script in simulation mode. It **creates nothing, installs nothing, deploys nothing**: it reads and tells.

```powershell
pwsh .\tools\Deploy-NoFridayMail.ps1 -Environment contoso -WhatIf
```

**You should see:** a framed header (*NoFridayMail - build and deploy*, the target environment, and the mode *simulation (-WhatIf): nothing is written*), then the six steps — **1/6 Prerequisites**, **2/6 Azure infrastructure**, **3/6 Build and validation**, **4/6 API package** (only with the MFA level), **5/6 Deployment**, **6/6 Post-deployment checks** — and a final box *Next steps*. Step 1 is a **checklist**:

```text
   1/6  ?  Prerequisites
      +  PowerShell 7.6.9 (7.4 or newer required)
      +  Node.js v22.11.0 (22 or newer required)
      +  npm 10.9.0
      +  Environment file valid (schema, consistency, unique Ids)
      +  Azure CLI (az) found
      +  Azure session: <your subscription>
```

A `+` line is ready. A line marked `!` or `x` is a problem, and the line under it, *What to do*, says how to fix it (install Node.js, run `az login`, and so on). In simulation, a problem is shown as a warning and the rest is only described, so you can read everything first.

**If not:** the command ends with `Environment ... not found`: the file is not in `deploy\environments.local\`, or its name is different. The message lists the environments it can see.

### 4 · Deploy

**Do:** when the simulation reads well, run the real thing:

```powershell
pwsh .\tools\Deploy-NoFridayMail.ps1 -Environment contoso
```

The script, in order: checks the prerequisites (and installs the Azure CLI `application-insights` extension by itself if the MFA level needs it); creates the resource group and the Static Web App if they do not exist (otherwise reuses them); installs the libraries, runs the tests when they are present, builds the site and checks the manifest; uploads the site; then **asks the website itself whether it is alive**. The deployment token is read at the last moment and is never written to a file nor shown.

**You should see:** at the end, under **6/6 Post-deployment checks**, one green line per check, then a summary box and the *Next steps* box with the path of the manifest. The checks are these:

```text
   6/6  ?  Post-deployment checks
      +  HTTP 200  /manifest.prod.xml
      +  HTTP 200  /launchevent.js
      +  HTTP 200  /taskpane.html
      +  HTTP 200  /commands.html
      +  launchevent.js: blockedDays:[5] present
```

and the address of your website, `https://<name>.azurestaticapps.net`. Write it down: it is the address of your add-in.

**If not:** read the red `ERROR:` line. *Prerequisites missing*: follow the *What to do* line. *Subscription not accessible*: wrong account, `az account set` again. *Check failed ... after several tries*: Azure can take a few minutes to publish: run the same command again.

### The post-deployment checks, by hand

The script already checked these. If you want to see them yourself, open the address in a browser:

| Address | You should see |
|---|---|
| `https://<name>.azurestaticapps.net/` | a small page with a link to the manifest |
| `https://<name>.azurestaticapps.net/manifest.prod.xml` | XML text starting with `<OfficeApp` (do not save it from here: see step 5) |
| `https://<name>.azurestaticapps.net/taskpane.html` | the schedule pane, without Outlook |

The manifest you will install is also on your disk: `dist\contoso\manifest.prod.xml`.

**Done.** The website is online. Go to **A** (chapter 4), **B** (chapter 5), or both.

<!-- icon: user -->
## 4. A · Install for one person (local)

The *local* mode installs the add-in **on your mailbox only**, from the manifest file. No administrator is needed, and nobody else is affected. It is the way to **test**. (The website is the one you deployed; "local" is about who gets the add-in.)

> [!WARNING]
> Install for one person through **Add from file** (sideloading) or through the centralized deployment of chapter 5. In our tests, a server-side installation for one mailbox with `New-App -Mailbox` did **not** activate the Smart Alerts in Outlook on the web. Do not use it.

### 5 · Open the add-in store of Outlook on the web

**Do:** open Outlook on the web, then this address:

```text
https://aka.ms/olksideload
```

**You should see:** the *Add-Ins for Outlook* window.

**If not:** a blank window or a sign-in loop: sign in to Outlook on the web first (`https://outlook.office.com`), then open the address again.

### 6 · Add the manifest from a file

**Do:** in the window, choose **My add-ins**, scroll to **Custom add-ins**, click **+ Add a custom add-in** › **Add from file**, then choose the manifest of your environment:

```text
C:\Tools\NoFridayMail\dist\contoso\manifest.prod.xml
```

Accept the warning ("Custom add-ins ... you are responsible for it") and confirm.

**You should see:** *NoFridayMail* in the list of **Custom add-ins**.

> [!NOTE]
> The easy way is the file on your disk (above). If you prefer to download the manifest from the website, use **right-click › Save link as** on its link. Do **not** open `manifest.prod.xml` in the browser and press **Ctrl+S**: the browser then saves the *displayed* page, not the original file, and Outlook rejects it. This is a real pitfall.

**If not:** *The manifest is not valid*: you picked the development manifest `manifest.xml` of the folder (it points to `localhost`) or a page saved with Ctrl+S. Use `dist\<environment>\manifest.prod.xml`.

**Classic Outlook for Windows:** *Get Add-ins* (Home ribbon) › **My add-ins** › **Custom add-ins** › **Add a custom add-in** › **Add from file**, then the same file. Close and reopen Outlook.

### 7 · Test that it works

**Do:** you do not have to wait for Friday. In a test environment, block **today**. Find today's number:

```powershell
[int](Get-Date).DayOfWeek
```

(`0` Sunday, `1` Monday ... `6` Saturday.) Put that number in `blockedDays` of a *test* environment file (for example `[3]` on a Wednesday), redeploy it ([chapter 6](#6-keep-it-running)) and install its manifest. Then, in Outlook on the web: **New mail**, write to yourself, click **Send**.

**You should see:** a dialog that says the send is not allowed today, with the buttons **Don't send** and **Schedule send**. **Schedule send** opens the pane with suggestions (the next allowed days), a row of days and time chips. Choosing one and clicking **Schedule and send** sets the delivery time and sends. On an allowed day the mail simply leaves.

**If not:** nothing appears at all. In this order: (1) reload the Outlook page (Ctrl+F5); (2) open **Manage add-ins** and check that *NoFridayMail* is there and **On**; (3) open `https://<name>.azurestaticapps.net/launchevent.js` in a browser: it must show code; (4) check that today's number really is in `blockedDays` of the deployed environment. More in [chapter 8](#8-troubleshooting).

Remove the test when you are done: **Manage add-ins** › *NoFridayMail* › **Remove**.

<!-- icon: people -->
## 5. B · Deploy for everyone (centralized)

The *centralized* mode is for production: a Microsoft 365 administrator publishes the add-in once, and Outlook gives it to the chosen people by itself. Smart Alerts only work for add-ins deployed this way (or sideloaded for a test).

### 5 · Upload the manifest

**Do:** as a Microsoft 365 administrator, open the admin center `https://admin.microsoft.com`, then **Settings** › **Integrated apps** › **Upload custom apps**. Choose the app type **Office Add-in**, **Upload manifest file (.xml) from device**, and select:

```text
C:\Tools\NoFridayMail\dist\contoso\manifest.prod.xml
```

**You should see:** the name *NoFridayMail*, its version and the permissions it asks for (**ReadWriteItem**: it needs to set the delivery time).

**If not:** *The manifest is invalid*: the file was changed or saved from the browser; take the one in `dist\<environment>\`. *Not allowed*: your role is not Global Administrator or Exchange Administrator.

### 6 · Choose who gets it

**Do:** on the next page, choose **Specific users/groups** and pick a **pilot group** of a few people. Keep **Just me** for a very first trial, and **Everyone** for later. Accept the permissions and finish.

**You should see:** *Deployment completed*, then the add-in in the **Integrated apps** list.

> [!NOTE]
> Always start with a pilot group. Widen the audience once the pilot has worked for a few days: open the add-in in **Integrated apps** and edit the users.

### 7 · Wait and test

**Do:** wait. The deployment can take **up to 24 hours** to reach every mailbox; often it is much faster. Ask a pilot person to close and reopen Outlook, then to repeat the test of step 7 above.

**You should see:** the same dialog as in step 7.

**If not:** wait the full 24 hours before worrying. Then follow [chapter 8](#8-troubleshooting).

### Update, remove

- **Update the manifest** (new name, version, address or provider): raise `version` in the environment file (`1.1.0.0` becomes `1.1.1.0`), redeploy, then in **Integrated apps** open the add-in and upload the **new manifest** — the same `addinId`, a **higher** `version`. The administrator must accept the new consent. Settings only (blocked days, hours) need **no** new manifest: see chapter 6.
- **Remove**: **Integrated apps** › the add-in › **Remove**. Do this **before** deleting the website; otherwise users briefly see "add-in unavailable" (the send still goes, `SoftBlock`).

<!-- icon: refresh -->
## 6. Keep it running

### Change a setting and redeploy

**Do:** edit your environment file, then run the same command as before:

```powershell
pwsh .\tools\Deploy-NoFridayMail.ps1 -Environment contoso -WhatIf
pwsh .\tools\Deploy-NoFridayMail.ps1 -Environment contoso -SkipInfra
```

`-SkipInfra` means "the website already exists, only update it" (faster).

**You should see:** the same steps and checks as the first time.

Users get new **rules** (days, hours) at the next loading of the add-in: a few minutes, sometimes after reopening Outlook. **No new manifest** is needed. A change of **name, version, provider or address** needs a new manifest: chapter 5, *Update*.

### Go back to the previous version

**Do:** extract the ZIP of the previous release in another folder, copy your environment file into its `deploy\environments.local\`, and deploy from there with `-SkipInfra`. If the manifest also changed, upload the previous manifest again (chapter 5).

### Delete an environment

In this order: (1) remove the add-in in **Integrated apps** (or **Manage add-ins** for a sideload); (2) delete the website: `az staticwebapp delete --name <swa> --resource-group <rg> --yes`; (3) if the resource group holds nothing else: `az group delete --name <rg> --yes`; (4) delete your environment file.

### Verify a release you downloaded

The release ZIP carries the owner's signature on its PowerShell files and a manifest of file hashes. The deploy script checks it by itself. To check by hand, from the extracted folder:

```powershell
.\tools\Test-PackageIntegrity.ps1 -Root .
```

**You should see:** no output and no error. A red `Package integrity: ...` line names the file that is missing, changed or unknown: download the release again from the official repository.

<!-- icon: calendar -->
## 7. Change the settings

Everything is in your environment file, `deploy\environments.local\<name>.json`. You change a line, then redeploy (chapter 6). The complete list of settings is in the [technical guide, chapter 5](NoFridayMail-Guide.md#5-environments-and-settings).

**Days are numbers.**

| Number | Day |
|:---:|---|
| **0** | Sunday |
| **1** | Monday |
| **2** | Tuesday |
| **3** | Wednesday |
| **4** | Thursday |
| **5** | Friday |
| **6** | Saturday |

| To change | Write | Example |
|---|---|---|
| The blocked day | `"blockedDays": [1]` | block Monday instead of Friday |
| Two blocked days | `"blockedDays": [1, 5]` | Monday and Friday |
| The days offered in the pane | `"workingDays": [1, 2, 3, 4, 5]` | a day is offered only if it is working **and** not blocked. Weekends are never blocked, only never offered. |
| The suggested time | `"sendHour": 8, "sendMinute": 0` | 08:00 |
| The time chips | `"slotTimes": ["09:30", "14:00", "16:30"]` | `HH:mm`, two digits, 8 at most |
| The number of days in the row | `"dayCount": 10` | from 1 to 10 |
| The displayed name | `"displayName": "NoFridayMail"` | no `<`, `>`, `&` or double quotes. **Needs a new manifest and a higher `version`.** |

> [!NOTE]
> **When must the manifest be uploaded again?** Only when the **name, provider, support address, `version`, website address or `addinId`** change. Changing `addinId` creates a *different* add-in: remove the old one. Days, hours and language need only a redeploy of the site (the Description and tooltip texts of the manifest also name the blocked days: upload the new manifest if you want them to match). Never give two environments the same `addinId`, and never change the `addinId` of an environment whose add-in is installed.

### A new environment

Run `pwsh .\tools\New-NoFridayMailEnvironment.ps1 -Name <new name>` (step 2 of chapter 3): it creates `deploy\environments.local\<new name>.json` with its own `addinId`. Edit `displayName`, the `azure` names and the `rules` if needed. Then `npm run validate:env`, the simulation, the deployment, and the manifest of `dist\<new name>\`. Two environments can live in the same Microsoft 365 tenant if their `addinId` differ — but do not give both to the same people, or the user sees two checks.

### Use another day (for example NoTuesdayEmail)

The add-in is not tied to Friday. Everything the user reads (dialog, task pane, suggestions) follows `blockedDays`, and so do the Description and the button tooltip of the manifest. To block Tuesday under the name *NoTuesdayEmail*:

```powershell
pwsh .\tools\New-NoFridayMailEnvironment.ps1 -Name notuesday -DisplayName "NoTuesdayEmail" -BlockedDays 2 -WhatIf
pwsh .\tools\New-NoFridayMailEnvironment.ps1 -Name notuesday -DisplayName "NoTuesdayEmail" -BlockedDays 2
pwsh .\tools\Deploy-NoFridayMail.ps1 -Environment notuesday -WhatIf
```

`-BlockedDays 2` is Tuesday (0 = Sunday ... 5 = Friday ... 6 = Saturday); `-BlockedDays 1,5` blocks Monday and Friday. Then deploy and publish the manifest as usual: it says *"Blocks sending emails and meeting invitations on Tuesdays..."* (and the French equivalent). The environment has its own `addinId`, so it can live next to the Friday one in the same tenant (do not give both to the same people).

> [!IMPORTANT]
> If you also use an **Exchange transport rule** (the strict layer), set it to the **same day**. The add-in follows the environment file; the rule does not: align them, or the two layers disagree.

### The exceptional send (option)

**Like to a 5-year-old.** On a blocked day the add-in is a doorman: "No, not today". With the option, the doorman adds: "If it is really urgent, write **why** on a small paper, and I note it in my book." But the doorman is not the boss: **Exchange** looks at the list of allowed people. Not on the list, refused anyway. And everything is **logged**.

Two levels:

```cards
key | Level 1: the justification | A written reason of at least 20 characters and 3 words. Quick, but it does not prove who wrote it.
shield | Level 2: justification and identity (MFA) | Before sending, the person proves who they are with Microsoft Entra ID, and the add-in gets a numbered ticket (the receipt). Recommended.
```

To turn it on, add a `bypass` block next to `rules` in the environment file (`"bypass": { "enabled": true }` for level 1, with an `mfa` block for level 2), validate, redeploy. **Prepare the server side first** (the allowed group, the Exchange transport rule, the Purview trace, and for level 2 the Entra registration): everything is in the [technical guide, chapter 9](NoFridayMail-Guide.md#9-exceptional-send). With level 2 the script refuses to deploy while `tenantId` and `clientId` are the placeholder `00000000-0000-0000-0000-000000000000`.

<!-- icon: lifebuoy -->
## 8. Troubleshooting

| Symptom | What to do |
|---|---|
| **Nothing appears** when I click Send on a blocked day | In this order: reload Outlook on the web (Ctrl+F5); open **Manage add-ins** and check that *NoFridayMail* is installed and **On**; open `https://<name>.azurestaticapps.net/launchevent.js` — it must show code; check that today's number is in `blockedDays`; for a centralized deployment, remember the delay (up to 24 h); classic Outlook: close and reopen it. |
| The add-in is installed but only works some days | That is normal: it only acts on the blocked days of your environment file. |
| *The manifest is not valid* when adding it | You used `manifest.xml` (development, points to `localhost`) or a page saved with Ctrl+S. Use `dist\<environment>\manifest.prod.xml`, or **Save link as**. |
| Add-in unavailable, or an error at send | The website does not answer: open `https://<name>.azurestaticapps.net/manifest.prod.xml`. If it fails, run the deploy script again. The send still goes (`SoftBlock`). |
| The script says `x  Node.js ...` or `!  ...` or `Azure session: none` | Follow the *What to do* line: install Node.js 22 or later, or run `az login`. |
| `Subscription ... is not accessible` | Wrong account or subscription: `az account list --output table`, `az account set`, or fix `azure.subscriptionId` in the environment file. |
| *Check failed ... does not answer HTTP 200* | Azure is still publishing: wait a few minutes and run the script again. |
| *The add-in Id of environment ... is a template value* | The file still holds the placeholder identity of the template. Create the environment with `New-NoFridayMailEnvironment.ps1` (or paste the output of `[guid]::NewGuid()` into `addinId`), then deploy. The deploy script never generates the Id itself, so that it stays the same at every deployment. |
| *invalid: addinId ... is already used by ...* | Two environment files have the same identity number. Give a new `[guid]::NewGuid()` to the one that was never deployed; never change the Id of an add-in users already installed. |
| The **MFA window does not open** (exceptional send) | Your browser blocked the pop-up. Allow pop-ups for `https://<name>.azurestaticapps.net` and for `login.microsoftonline.com`, then try again. |
| Dialog text ends with **code NFM-B2** | A justification was found but refused: malformed or too weak (too short, fewer than 3 words, too few different letters), or a level-1 header while the MFA is required. Write a clearer justification. |
| Dialog text ends with **code NFM-B3** | The receipt is malformed or older than one day. Click **Send with justification** again to get a new one. |
| *Your version of Outlook does not allow the exceptional send* | The MFA level needs Nested App Authentication (NestedAppAuth 1.1): use Outlook on the web, new Outlook or a recent Outlook for Windows. |
| API **401** `missing_token`, `invalid_token`, `insufficient_claims` | Token problems of the MFA level: see [technical guide, Annex A](NoFridayMail-Guide.md#annex-a--troubleshooting). `insufficient_claims` means the identity check (MFA) was not played back: check the authentication context and the Conditional Access policy. |
| API **404** on `/api/bypass`, or **500** | The API was not deployed as a self-contained package, or the receipt key is missing: run the deploy script again (it creates the key only if missing). |

**Where are the requests logged?** Every exceptional send is written at four places (the API log in Application Insights, the Entra sign-in logs, the Exchange message trace and incident report, the Purview DLP alerts). How to find a request, step by step, with the queries: [technical guide, chapter 10](NoFridayMail-Guide.md#10-finding-a-request).

Anything else: [technical guide, Annex A — Troubleshooting](NoFridayMail-Guide.md#annex-a--troubleshooting).
