#Requires -Version 7.4

<#
.SYNOPSIS
    NoFridayMail - builds and deploys the Outlook add-in website on Azure Static Web Apps for one environment.

.DESCRIPTION
    Deploys the NoFridayMail website (task pane, launchevent.js, pages, manifest) for the environment you name,
    in any Azure subscription and any Microsoft 365 tenant, in a repeatable way. The script works in six stages,
    shown on screen as 1/6 ... 6/6, then tells you how to publish the manifest:

      1. CHECK         Prerequisites checklist (PowerShell 7.4, Node.js 22+, npm, Azure CLI, az login, the
                       subscription, the Azure CLI extension application-insights), then the environment
                       file (schema, consistency, unique Ids). When PackageIntegrity.psd1 is present (release
                       ZIP), the signature and the SHA256 of every file are verified first. Each missing item
                       comes with what to do.
      2. INFRA         Creates the resource group and the Static Web Apps resource if they do not exist (else
                       reuses them); the site address (defaultHostname) becomes ADDIN_BASE_URL. With the MFA
                       step (bypass.mfa.required): creates the app setting NFM_RECEIPT_KEY only when it is
                       missing and, with azure.appInsights, creates or links Application Insights.
                       Skipped by -SkipInfra (the resource must exist; it is only read).
      3. BUILD         npm ci, npm test (skipped by -SkipTests, or when tests\ is not shipped in the
                       download: build and validation still run), npm run build:prod for the environment,
                       validation of the generated manifest.
      4. API PACKAGE   MFA step only: self-contained package of the managed API in out\api-pkg\<env> (the SWA
                       CLI runs no build: node_modules are installed there with npm ci --omit=dev), and a
                       check that the function loads.
      5. DEPLOY        Uploads dist\<env> (and the API package) with the SWA CLI, version pinned. The
                       deployment token is read at run time, handed to the child process through its
                       environment and never written to disk or displayed.
      6. VERIFY        HTTP 200 on manifest.prod.xml, launchevent.js, taskpane.html and commands.html, the
                       expected blockedDays in the served launchevent.js, the add-in Id in the served
                       manifest; with the MFA step, POST /api/bypass without a token must answer 401.
      PUBLISH (manual) The manifest is published by hand: local sideload for one person (test), or the
                       Microsoft 365 admin center for everyone. A "Next steps" box at the end shows both.

    What it changes: Azure resources of the environment (resource group, Static Web Apps, app settings,
    Application Insights), the Azure CLI extension application-insights (installed silently when needed),
    node_modules\, dist\<env>\ and out\.
    What it never changes: your Microsoft 365 tenant (the manifest is published by you), Exchange, other
    Azure resources. The deployment token, NFM_RECEIPT_KEY and the Application Insights connection string are
    never written to disk, never displayed and never put on a command line shown on screen.

    -WhatIf writes nothing: no Azure creation, no installation, no build, no deployment. Only reads are done
    (tool versions, az account show, az group exists, az staticwebapp show, az extension show) and every
    action that would be taken is announced with [simulation].

    The environment is the file <name>.json looked up in deploy\environments.local\ (your own files, never
    published) and then in deploy\environments\ (prod, example). See docs\NoFridayMail-UserGuide.md.

.PARAMETER Environment
    Name of the environment = file <name>.json (lowercase letters, digits and hyphens).
      prod       deploy\environments\prod.json: edit the Azure names before the first deployment.
      <yours>    deploy\environments.local\<name>.json, created by tools\New-NoFridayMailEnvironment.ps1.
      example    A template: refused. Copy it to your own file.
    A protected environment ("protected": true in its file, or named lab) is refused without -ConfirmLab.

.PARAMETER SkipInfra
    Creates nothing in Azure: the Static Web Apps resource must already exist (it is only read).

.PARAMETER SkipTests
    Does not run npm test (not recommended for production). Tests are also skipped, with an explanation, when
    the tests\ folder is not part of what you downloaded.

.PARAMETER ConfirmLab
    Explicit confirmation required by protected environments (lab or "protected": true). Use it only on the
    owner's agreement: such an environment describes a service already in use.

.EXAMPLE
    .\tools\Deploy-NoFridayMail.ps1 -Environment prod -WhatIf
    SIMULATE. Shows the checklist and every step without creating, installing, building or deploying
    anything. Always do this first.

.EXAMPLE
    .\tools\Deploy-NoFridayMail.ps1 -Environment prod
    DEPLOY. First deployment or update of production: creates the resource group and the Static Web Apps
    resource when they are missing, tests, builds, deploys and checks the site.

.EXAMPLE
    .\tools\New-NoFridayMailEnvironment.ps1 -Name demo
    .\tools\Deploy-NoFridayMail.ps1 -Environment demo -WhatIf
    NEW ENVIRONMENT. The first command creates deploy\environments.local\demo.json (never published) with its
    own add-in Id, generated once and kept for good; edit the file if needed, then simulate and deploy. The
    deployment itself never generates an Id: a template or duplicated Id is refused.

.EXAMPLE
    .\tools\Deploy-NoFridayMail.ps1 -Environment prod -SkipInfra
    The Static Web Apps resource already exists (for example created by someone else): only read, then built
    and deployed.

.EXAMPLE
    .\tools\Deploy-NoFridayMail.ps1 -Environment prod -SkipInfra -SkipTests
    Quick redeployment after a change of rules only (blocked days, hours), without running the tests.

.EXAMPLE
    az login
    az account set --subscription "00000000-0000-0000-0000-000000000000"
    .\tools\Deploy-NoFridayMail.ps1 -Environment prod -WhatIf
    Signs in to Azure and picks the subscription before simulating (the checklist shows which subscription
    is used).

.EXAMPLE
    .\tools\Deploy-NoFridayMail.ps1 -Environment demo -ConfirmLab
    An environment marked "protected": true is refused without -ConfirmLab.

.NOTES
    Author  : Nicolas Fabert
    Version : 1.1.0
    Requires: PowerShell 7.4, Node.js 22+, Azure CLI signed in (az login) and the Contributor role on the
              subscription (not needed with -SkipInfra). Publishing the manifest needs a Microsoft 365
              administrator (Global Administrator or Exchange Administrator).
    Exit codes : 0 = success (or simulation finished), 1 = failure (the line "ERROR: ..." tells why).
    Colours and icons: plain ASCII without colours when the output is redirected or NO_COLOR is set.
    NFM_ICONS = Emoji | Symbols | Ascii forces a style; NFM_FORCE_COLOR=1 forces colours.
    Documentation : docs\NoFridayMail-UserGuide.html (step by step) and docs\NoFridayMail-Guide.html (reference).

    This Script is a Personal project.
    It's provided "AS-IS". It's not an official Microsoft product so no support can be expected from Microsoft.

    As any scripts you must read carefully the documentation and test it first in a Test environment before any run in Production.

.LINK
    docs/NoFridayMail-UserGuide.md
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidatePattern('^[a-z0-9][a-z0-9-]{0,30}$')]
    [string]$Environment,

    [switch]$SkipInfra,
    [switch]$SkipTests,
    [switch]$ConfirmLab
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Pinned SWA CLI version (never "latest": a deployment must be repeatable).
$SwaCliVersion = '2.1.0'
$root = Split-Path -Parent $PSScriptRoot
$dryRun = [bool]$WhatIfPreference
$totalSteps = 6

# Console theme and prerequisite checks (tools/lib/Deploy-Checks.ps1).
. (Join-Path $PSScriptRoot 'lib/Deploy-Checks.ps1')

$toolVersion = 'unknown'
try { $toolVersion = [string](Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).version } catch { $toolVersion = 'unknown' }
Initialize-NfmConsole -Version $toolVersion

function Write-DryWarning {
    # In a simulation a missing prerequisite is reported without stopping; in a real run it is an error.
    param([string]$Message)
    if ($dryRun) {
        Write-NfmItem Warn "[simulation] $Message"
    }
    else {
        throw $Message
    }
}

function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$File,
        [string[]]$Arguments = @()
    )
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "The command '$File $($Arguments -join ' ')' failed (code $LASTEXITCODE)."
    }
}

function Get-AzureText {
    # Read only: returns the text output, or $null when the command fails (missing resource, etc.).
    param([string[]]$Arguments)
    $text = & az @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $null
    }
    return ($text | Out-String).Trim()
}

function Invoke-NativeSecret {
    # Like Invoke-Native, for commands whose arguments hold a secret: the caller silences the output
    # (--output none) and the error message NEVER repeats the arguments.
    param(
        [Parameter(Mandatory)][string]$File,
        [Parameter(Mandatory)][string]$Description,
        [string[]]$Arguments = @()
    )
    & $File @Arguments 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "The operation '$Description' failed (code $LASTEXITCODE). The arguments are not shown because they contain a secret."
    }
}

function ConvertTo-FlatText {
    # Same normalisation as tools/check-bundle.js: no whitespace, double quotes.
    param([string]$Text)
    return (($Text -replace '\s', '') -replace "'", '"')
}

$exitCode = 0
$baseUrl = ''
$manifestPath = ''
$deployed = $false
Push-Location $root
try {
    Write-NfmBanner -Title 'NoFridayMail - build and deploy' -Subtitle 'Outlook add-in website on Azure Static Web Apps' -Details ([ordered]@{
            Target = @('Folder', $Environment)
            Mode   = @($(if ($dryRun) { 'Skip' } else { 'Rocket' }), $(if ($dryRun) { 'simulation (-WhatIf): nothing is written' } else { 'real run' }))
        })

    # ===== 1/6 Prerequisites ===========================================================================
    Write-NfmStep 1 $totalSteps 'Prerequisites' -Icon Check

    # Environment file: your own folder first, then the published one. NFM_ENVIRONMENTS_DIR replaces both (tests).
    $envDirs = if ($env:NFM_ENVIRONMENTS_DIR) { @($env:NFM_ENVIRONMENTS_DIR) } else { @((Join-Path $root 'deploy/environments.local'), (Join-Path $root 'deploy/environments')) }
    $envFile = $envDirs | ForEach-Object { Join-Path $_ "$Environment.json" } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $envFile) {
        $available = @($envDirs | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.json' | Select-Object -ExpandProperty BaseName } | Sort-Object -Unique) -join ', '
        throw "Environment '$Environment' not found (searched in: $($envDirs -join ' ; ')). Available: $available."
    }
    $cfg = Get-Content -LiteralPath $envFile -Raw -Encoding utf8 | ConvertFrom-Json

    # Protection: a protected environment is never redeployed without an explicit confirmation (before any other action).
    $isProtected = ($Environment -eq 'lab') -or ($cfg.PSObject.Properties['protected'] -and $cfg.protected -eq $true)
    if ($isProtected -and -not $ConfirmLab) {
        throw "Environment '$Environment' is protected (an existing service). Do not redeploy it without the owner's agreement, then add -ConfirmLab to confirm explicitly."
    }
    if ($Environment -eq 'example') {
        throw "'example' is a template: copy deploy/environments/example.json to your own file (deploy/environments.local/<name>.json, see docs/NoFridayMail-Guide.md)."
    }
    # The add-in Id identifies the add-in for good (same Id = Outlook updates it, new Id = a second add-in for every
    # user). It is generated once by New-NoFridayMailEnvironment.ps1, never here: a template Id stops the run.
    $placeholderIds = @('11111111-2222-4333-8444-555555555555', '00000000-0000-0000-0000-000000000000')
    if ($placeholderIds -contains ([string]$cfg.addinId).ToLowerInvariant()) {
        throw ("The add-in Id of environment '$Environment' is a template value ($($cfg.addinId)), not a real Id. " +
            "Each environment needs its own add-in Id, generated ONCE and then kept for good: the same Id lets Outlook update the add-in your users already have, a new Id on every deployment would install a second add-in for every user. " +
            "This script never generates the Id at deployment time, to keep it stable. " +
            "Fix: create the environment with  .\tools\New-NoFridayMailEnvironment.ps1 -Name <name>  (it generates a unique Id), " +
            "or put the output of  [guid]::NewGuid()  (New-Guid) in ""addinId"" of $envFile, then run again.")
    }
    Write-NfmItem Info "Environment file: $envFile" -Icon Folder
    Write-NfmItem Info "Add-in: $($cfg.displayName) | Id $($cfg.addinId) | version $($cfg.version)"
    Write-NfmItem Info "Blocked days: $($cfg.rules.blockedDays -join ',') | working days: $($cfg.rules.workingDays -join ',')"

    Write-NfmLegend
    New-NfmCheck OK "PowerShell $($PSVersionTable.PSVersion) (7.4 or newer required)" | Write-NfmCheck
    $toolChecks = @(Test-NodeTool)
    $toolChecks | Write-NfmCheck
    if (@($toolChecks | Where-Object Status -eq 'FAIL').Count -gt 0) {
        # Without Node.js and npm nothing can be validated or built: stop, even in a simulation.
        throw 'Missing prerequisites: Node.js 22 or newer and npm. Fix the [!] lines above (line "What to do"), open a new terminal, then run again.'
    }

    # The tests are not shipped in the release ZIP nor in "Download ZIP" (tests/ stays in the repository).
    $testsPresent = [bool](Get-ChildItem -LiteralPath (Join-Path $root 'tests') -Filter '*.test.js' -File -ErrorAction SilentlyContinue | Select-Object -First 1)
    # Release package: when PackageIntegrity.psd1 is present, the content is verified (owner signature + SHA256 of every
    # file) BEFORE anything else runs. A cloned repository or a "Download ZIP" has none.
    $integrityManifest = Join-Path $root 'PackageIntegrity.psd1'
    if (Test-Path -LiteralPath $integrityManifest) {
        & (Join-Path $PSScriptRoot 'Test-PackageIntegrity.ps1') -Root $root
        New-NfmCheck OK 'Package integrity: signature and SHA256 of every file verified' | Write-NfmCheck
    }
    else {
        New-NfmCheck SKIP 'Package integrity: no PackageIntegrity.psd1 (normal for a clone or "Download ZIP"; the release ZIP has one)' | Write-NfmCheck
    }

    # Strict validation of the environment (schema + consistency + unique Ids), same code as the build.
    $envCheck = & node tools/env-config.js $Environment 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "The environment file is not valid (a duplicated add-in Id is reported here too):`n$(($envCheck | Out-String).Trim())"
    }
    New-NfmCheck OK 'Environment file valid (schema, consistency, unique Ids)' | Write-NfmCheck
    # Checks of a real deployment only: placeholder Entra identifiers (bypass.mfa) are refused.
    $deployCheck = & node tools/env-config.js $Environment --deploy 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-DryWarning (($deployCheck | Out-String).Trim())
    }

    # MFA step: the site embeds the API (api/ folder) and a receipt secret is needed on the Static Web App.
    $apiEnabled = $false
    $bypassProp = $cfg.PSObject.Properties['bypass']
    if ($bypassProp -and $bypassProp.Value.PSObject.Properties['enabled'] -and $bypassProp.Value.enabled -eq $true) {
        $mfaProp = $bypassProp.Value.PSObject.Properties['mfa']
        if ($mfaProp -and $mfaProp.Value.PSObject.Properties['required'] -and $mfaProp.Value.required -eq $true) {
            $apiEnabled = $true
        }
    }
    $appInsightsName = ''
    if ($cfg.azure.PSObject.Properties['appInsights']) {
        $appInsightsName = [string]$cfg.azure.appInsights
    }
    if ($apiEnabled) {
        Write-NfmItem Info 'MFA step: the API (api/) will be deployed; receipt key: app setting NFM_RECEIPT_KEY.' -Icon Key
    }

    $azAvailable = [bool](Get-Command az -ErrorAction SilentlyContinue)
    $subscriptionArgs = @()
    $azReady = $false
    $azProblems = @()
    if (-not $azAvailable) {
        New-NfmCheck FAIL 'Azure CLI (az): not found' 'install it (https://learn.microsoft.com/cli/azure/install-azure-cli or "winget install Microsoft.AzureCLI"), then open a NEW terminal.' | Write-NfmCheck
        New-NfmCheck SKIP 'Azure session and subscription: checked once Azure CLI is available' | Write-NfmCheck
        $azProblems += 'Azure CLI (az)'
    }
    else {
        New-NfmCheck OK 'Azure CLI (az) found' | Write-NfmCheck
        $account = Get-AzureText -Arguments @('account', 'show', '--output', 'json')
        if (-not $account) {
            New-NfmCheck FAIL 'Azure session: none (you are not signed in)' 'run "az login" (a browser window opens), then, with several subscriptions, "az account set --subscription <id>".' | Write-NfmCheck
            $azProblems += 'Azure session (az login)'
        }
        else {
            $azReady = $true
            $accountInfo = $account | ConvertFrom-Json
            New-NfmCheck OK "Azure session: $($accountInfo.name) (subscription $($accountInfo.id), tenant $($accountInfo.tenantId))" | Write-NfmCheck
            if ($cfg.azure.PSObject.Properties['subscriptionId']) {
                $wanted = [string]$cfg.azure.subscriptionId
                $check = Get-AzureText -Arguments @('account', 'show', '--subscription', $wanted, '--query', 'id', '--output', 'tsv')
                if (-not $check) {
                    $azReady = $false
                    New-NfmCheck FAIL "Subscription ${wanted}: not accessible with this session" 'check the account ("az account list --output table"), sign in again ("az login") or fix azure.subscriptionId in the environment file.' | Write-NfmCheck
                    $azProblems += "subscription $wanted"
                }
                else {
                    $subscriptionArgs = @('--subscription', $wanted)
                    New-NfmCheck OK "Subscription targeted by the environment: $wanted" | Write-NfmCheck
                }
            }
            else {
                New-NfmCheck OK "Subscription: the one az uses ($($accountInfo.id)) - no subscriptionId in the environment file" | Write-NfmCheck
            }
        }
    }

    # Azure CLI extension "application-insights": needed only for "az monitor app-insights" (MFA step with
    # azure.appInsights). Without it az would stop and ask a question, so it is installed beforehand, silently.
    if ($apiEnabled -and $appInsightsName) {
        if (-not $azReady) {
            New-NfmCheck SKIP 'Azure CLI extension "application-insights": checked once Azure CLI is ready' | Write-NfmCheck
        }
        elseif (Test-AzExtension) {
            New-NfmCheck OK 'Azure CLI extension "application-insights" installed' | Write-NfmCheck
        }
        else {
            Write-NfmItem Warn 'The Azure CLI extension "application-insights" is not installed. It is a small add-on of az, needed to create the API log book (Application Insights). It is installed automatically.'
            if ($PSCmdlet.ShouldProcess('Azure CLI extension application-insights', 'Install (az extension add --name application-insights --only-show-errors)')) {
                Install-AzExtension
                if (Test-AzExtension) {
                    New-NfmCheck OK 'Azure CLI extension "application-insights" installed just now' | Write-NfmCheck
                }
                else {
                    New-NfmCheck FAIL 'Azure CLI extension "application-insights": still missing after the installation' 'try it by hand: az extension add --name application-insights' | Write-NfmCheck
                    $azProblems += 'extension application-insights'
                }
            }
            elseif ($dryRun) {
                New-NfmCheck SKIP '[simulation] extension "application-insights" would be installed automatically (nothing is installed in a simulation)' | Write-NfmCheck
            }
            else {
                New-NfmCheck FAIL 'Azure CLI extension "application-insights": installation declined' 'install it: az extension add --name application-insights' | Write-NfmCheck
                $azProblems += 'extension application-insights'
            }
        }
    }
    else {
        New-NfmCheck SKIP 'Azure CLI extension "application-insights": not needed for this environment' | Write-NfmCheck
    }

    if ($azProblems.Count -gt 0) {
        Write-DryWarning ("Missing prerequisites: $($azProblems -join ', '). Fix the [!] lines above (line `"What to do`"), then run again.")
    }

    $rg = [string]$cfg.azure.resourceGroup
    $swa = [string]$cfg.azure.staticWebAppName
    $location = [string]$cfg.azure.location
    $sku = [string]$cfg.azure.sku

    # ===== 2/6 Azure infrastructure ====================================================================
    Write-NfmStep 2 $totalSteps "Azure infrastructure ($rg / $swa)" -Icon Cloud
    $hostname = $null
    if ($azReady) {
        $swaShow = @('staticwebapp', 'show', '--name', $swa, '--resource-group', $rg) + $subscriptionArgs + @('--query', 'defaultHostname', '--output', 'tsv')
        if ($SkipInfra) {
            $hostname = Get-AzureText -Arguments $swaShow
            if (-not $hostname) {
                Write-DryWarning "-SkipInfra: the Static Web Apps resource '$swa' (resource group '$rg') was not found."
            }
            else {
                Write-NfmItem Ok "Existing resource reused (-SkipInfra): $hostname"
            }
        }
        else {
            $groupExists = Get-AzureText -Arguments (@('group', 'exists', '--name', $rg) + $subscriptionArgs)
            if ($groupExists -ne 'true') {
                if ($PSCmdlet.ShouldProcess("resource group $rg ($location)", 'Create')) {
                    Invoke-Native -File 'az' -Arguments (@('group', 'create', '--name', $rg, '--location', $location, '--output', 'none') + $subscriptionArgs)
                    Write-NfmItem Ok "Resource group created: $rg"
                }
                elseif ($dryRun) {
                    Write-NfmItem Skip "[simulation] resource group '$rg' would be created in $location"
                }
            }
            else {
                Write-NfmItem Ok "Existing resource group: $rg"
            }
            $hostname = Get-AzureText -Arguments $swaShow
            if (-not $hostname) {
                if ($PSCmdlet.ShouldProcess("Static Web App $swa (SKU $sku, $location)", 'Create')) {
                    Invoke-Native -File 'az' -Arguments (@('staticwebapp', 'create', '--name', $swa, '--resource-group', $rg, '--location', $location, '--sku', $sku, '--output', 'none') + $subscriptionArgs)
                    $hostname = Get-AzureText -Arguments $swaShow
                    Write-NfmItem Ok "Static Web App created: $hostname"
                }
                elseif ($dryRun) {
                    Write-NfmItem Skip "[simulation] Static Web App '$swa' (SKU $sku) would be created"
                }
            }
            else {
                Write-NfmItem Ok "Existing Static Web App reused: $hostname"
            }
        }
    }
    else {
        Write-NfmItem Skip '[simulation] Azure unavailable: infrastructure not checked.'
    }

    if (-not $hostname) {
        if (-not $dryRun) {
            throw "Cannot get the address (defaultHostname) of the Static Web Apps resource '$swa'."
        }
        $hostname = "$swa.azurestaticapps.net"
        Write-NfmItem Skip "[simulation] Assumed address for the next steps: $hostname"
    }
    $baseUrl = "https://$hostname"
    Write-NfmItem Info "ADDIN_BASE_URL = $baseUrl" -Icon Cloud

    # Receipt secret and Application Insights (MFA step).
    if ($apiEnabled -and $azReady) {
        $settingsBase = @('--name', $swa, '--resource-group', $rg) + $subscriptionArgs
        # Names of the existing settings (never their values).
        $existingNames = Get-AzureText -Arguments (@('staticwebapp', 'appsettings', 'list') + $settingsBase + @('--query', 'keys(properties)', '--output', 'tsv'))
        $existing = @()
        if ($existingNames) { $existing = @($existingNames -split '\s+' | Where-Object { $_ }) }
        if ($existing -contains 'NFM_RECEIPT_KEY') {
            Write-NfmItem Ok 'NFM_RECEIPT_KEY: already present, kept (receipts already issued stay verifiable).' -Icon Key
        }
        elseif ($PSCmdlet.ShouldProcess("${swa}: app setting NFM_RECEIPT_KEY", 'Create (32 random bytes, value never displayed)')) {
            $receiptKey = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
            try {
                Invoke-NativeSecret -File 'az' -Description 'creation of NFM_RECEIPT_KEY' -Arguments (@('staticwebapp', 'appsettings', 'set') + $settingsBase + @('--setting-names', "NFM_RECEIPT_KEY=$receiptKey", '--output', 'none'))
            }
            finally {
                $receiptKey = $null
            }
            Write-NfmItem Ok 'NFM_RECEIPT_KEY: created (value not displayed). To verify receipts: see docs/NoFridayMail-Guide.md.' -Icon Key
        }
        else {
            Write-NfmItem Skip '[simulation] NFM_RECEIPT_KEY would be created if it was missing (value never displayed).' -Icon Key
        }

        if ($appInsightsName) {
            $aiBase = @('--app', $appInsightsName, '--resource-group', $rg) + $subscriptionArgs
            $aiExists = Get-AzureText -Arguments (@('monitor', 'app-insights', 'component', 'show') + $aiBase + @('--query', 'name', '--output', 'tsv'))
            if (-not $aiExists) {
                if ($PSCmdlet.ShouldProcess("Application Insights $appInsightsName", 'Create')) {
                    Invoke-Native -File 'az' -Arguments (@('monitor', 'app-insights', 'component', 'create') + $aiBase + @('--location', $location, '--kind', 'web', '--application-type', 'web', '--output', 'none'))
                    Write-NfmItem Ok "Application Insights created: $appInsightsName"
                }
                elseif ($dryRun) {
                    Write-NfmItem Skip "[simulation] Application Insights '$appInsightsName' would be created"
                }
            }
            else {
                Write-NfmItem Ok "Existing Application Insights reused: $appInsightsName"
            }
            if ($existing -contains 'APPLICATIONINSIGHTS_CONNECTION_STRING') {
                Write-NfmItem Ok 'APPLICATIONINSIGHTS_CONNECTION_STRING: already present, kept.'
            }
            elseif ($PSCmdlet.ShouldProcess("${swa}: app setting APPLICATIONINSIGHTS_CONNECTION_STRING", 'Link to Application Insights (value never displayed)')) {
                $connection = Get-AzureText -Arguments (@('monitor', 'app-insights', 'component', 'show') + $aiBase + @('--query', 'connectionString', '--output', 'tsv'))
                if (-not $connection) {
                    throw "Cannot read the connection string of Application Insights '$appInsightsName'."
                }
                try {
                    Invoke-NativeSecret -File 'az' -Description 'linking Application Insights' -Arguments (@('staticwebapp', 'appsettings', 'set') + $settingsBase + @('--setting-names', "APPLICATIONINSIGHTS_CONNECTION_STRING=$connection", '--output', 'none'))
                }
                finally {
                    $connection = $null
                }
                Write-NfmItem Ok 'APPLICATIONINSIGHTS_CONNECTION_STRING: set (value not displayed).'
            }
            elseif ($dryRun) {
                Write-NfmItem Skip '[simulation] APPLICATIONINSIGHTS_CONNECTION_STRING would be linked (value never displayed).'
            }
        }
        else {
            Write-NfmItem Info 'azure.appInsights not set: the API logs stay in the function stream (no Application Insights traces).'
        }
    }
    elseif ($apiEnabled) {
        Write-NfmItem Skip '[simulation] Azure unavailable: app settings (NFM_RECEIPT_KEY) not checked.'
    }

    # ===== 3/6 Build and validation ====================================================================
    Write-NfmStep 3 $totalSteps 'Build and validation' -Icon Build
    $previousEnv = @{
        NFM_ENV        = $env:NFM_ENV
        ADDIN_BASE_URL = $env:ADDIN_BASE_URL
    }
    $manifestPath = Join-Path $root "dist/$Environment/manifest.prod.xml"
    $siteDir = Join-Path $root "dist/$Environment"
    try {
        $env:NFM_ENV = $Environment
        $env:ADDIN_BASE_URL = $baseUrl

        if ($PSCmdlet.ShouldProcess('node_modules', 'npm ci (install the dependencies)')) {
            Write-NfmItem Info 'npm ci (installing the dependencies)' -Icon Tool
            Invoke-Native -File 'npm' -Arguments @('ci')
        }
        elseif ($dryRun) {
            Write-NfmItem Skip '[simulation] npm ci would install the dependencies'
        }
        if ($SkipTests) {
            Write-NfmItem Warn 'Tests skipped (-SkipTests).'
        }
        elseif (-not $testsPresent) {
            Write-NfmItem Info 'Tests not run: the tests/ folder is not part of the downloaded package (it stays in the GitHub repository). The build and the manifest validation still run.'
        }
        elseif ($PSCmdlet.ShouldProcess('unit tests', 'npm test')) {
            Write-NfmItem Info 'npm test' -Icon Tool
            Invoke-Native -File 'npm' -Arguments @('test')
        }
        elseif ($dryRun) {
            Write-NfmItem Skip '[simulation] npm test would run the unit tests'
        }
        if ($PSCmdlet.ShouldProcess("dist/$Environment and out/", "npm run build:prod for '$Environment'")) {
            Write-NfmItem Info "npm run build:prod ($Environment)" -Icon Tool
            Invoke-Native -File 'npm' -Arguments @('run', 'build:prod')
        }
        elseif ($dryRun) {
            Write-NfmItem Skip "[simulation] npm run build:prod would build dist/$Environment and out/"
        }
        if ($PSCmdlet.ShouldProcess($manifestPath, 'npm run validate:prod (manifest validation)')) {
            Write-NfmItem Info 'npm run validate:prod (manifest validation)' -Icon Tool
            Invoke-Native -File 'npm' -Arguments @('run', 'validate:prod')
        }
        elseif ($dryRun) {
            Write-NfmItem Skip '[simulation] npm run validate:prod would validate the generated manifest'
        }

        # ===== 4/6 API package ============================================================================
        # The SWA CLI uploads the API folder as is, WITHOUT an Oryx build: the dependencies (@azure/functions, jose) must
        # already be in it. The package is built in out/api-pkg/<env> (never in api/, which stays clean for git).
        $apiPackageDir = Join-Path $root "out/api-pkg/$Environment"
        $apiLocation = "./out/api-pkg/$Environment"
        if ($apiEnabled) {
            Write-NfmStep 4 $totalSteps "API package ($apiLocation)" -Icon Package
            if ($PSCmdlet.ShouldProcess($apiLocation, 'Prepare the API package: copy of api/, config.json, npm ci --omit=dev, load check')) {
                Invoke-Native -File 'node' -Arguments @('tools/package-api.js', $Environment)
                Push-Location $apiPackageDir
                try {
                    Invoke-Native -File 'npm' -Arguments @('ci', '--omit=dev')
                }
                finally {
                    Pop-Location
                }
                # The function must load and register from the installed package (otherwise: 404 online).
                Invoke-Native -File 'node' -Arguments @('tools/package-api.js', $Environment, '--verify')
                Write-NfmItem Ok 'API package ready; the function loads from the installed package.'
            }
            elseif ($dryRun) {
                Write-NfmItem Skip "[simulation] the API package would be prepared in $apiLocation (api/ copy, npm ci --omit=dev, load check)"
            }
        }
        else {
            Write-NfmStep 4 $totalSteps 'API package' -Icon Package
            Write-NfmItem Skip 'Not needed: this environment has no API.'
        }

        # ===== 5/6 Deployment =============================================================================
        Write-NfmStep 5 $totalSteps "Deployment of dist/$Environment to $baseUrl" -Icon Rocket
        # SWA CLI command line (no secret: the token goes through SWA_CLI_DEPLOYMENT_TOKEN). The site configuration is the
        # one GENERATED for the environment (--swa-config-location): otherwise the CLI takes the repository root
        # staticwebapp.config.json (no platform.apiRuntime, no /api/* route).
        $deployArguments = @('--yes', "@azure/static-web-apps-cli@$SwaCliVersion", 'deploy', "./dist/$Environment", '--env', 'production', '--swa-config-location', "./dist/$Environment")
        if ($apiEnabled) {
            $deployArguments += @('--api-location', $apiLocation, '--api-language', 'node', '--api-version', '22')
        }
        Write-NfmItem Info "Command: npx $($deployArguments -join ' ')"
        if ($PSCmdlet.ShouldProcess("$swa ($baseUrl)", "Deploy dist/$Environment (SWA CLI $SwaCliVersion)")) {
            if (-not (Test-Path -LiteralPath $siteDir)) {
                throw "Folder to deploy not found: $siteDir."
            }
            if ($apiEnabled -and -not (Test-Path -LiteralPath (Join-Path $apiPackageDir 'node_modules'))) {
                throw "API package incomplete: $apiPackageDir\node_modules is missing (npm ci --omit=dev did not run)."
            }
            $token = $null
            try {
                # Token read at run time, handed over only through the child process environment.
                $token = Get-AzureText -Arguments (@('staticwebapp', 'secrets', 'list', '--name', $swa, '--resource-group', $rg) + $subscriptionArgs + @('--query', 'properties.apiKey', '--output', 'tsv'))
                if (-not $token) {
                    throw "Cannot read the deployment token of '$swa' (insufficient rights?)."
                }
                $env:SWA_CLI_DEPLOYMENT_TOKEN = $token
                Invoke-Native -File 'npx' -Arguments $deployArguments
            }
            finally {
                [Environment]::SetEnvironmentVariable('SWA_CLI_DEPLOYMENT_TOKEN', $null, 'Process')
                $token = $null
            }
            $deployed = $true
            Write-NfmItem Ok "Site uploaded to $baseUrl (SWA CLI $SwaCliVersion)"
        }
        elseif ($dryRun) {
            Write-NfmItem Skip "[simulation] dist/$Environment would be uploaded with the SWA CLI $SwaCliVersion (the token is read at run time, never displayed)"
        }

        # ===== 6/6 Post-deployment checks =================================================================
        Write-NfmStep 6 $totalSteps 'Post-deployment checks' -Icon Verify
        if ($deployed) {
            $expectedDays = "blockedDays:[$($cfg.rules.blockedDays -join ',')]"
            $paths = '/manifest.prod.xml', '/launchevent.js', '/taskpane.html', '/commands.html'
            foreach ($path in $paths) {
                $ok = $false
                $content = ''
                for ($attempt = 1; $attempt -le 12 -and -not $ok; $attempt++) {
                    try {
                        $response = Invoke-WebRequest -Uri "$baseUrl$path" -UseBasicParsing -TimeoutSec 30
                        if ($response.StatusCode -eq 200) {
                            $ok = $true
                            $content = [string]$response.Content
                        }
                    }
                    catch {
                        # Static Web Apps propagation: retry a few times before failing.
                    }
                    if (-not $ok) {
                        Start-Sleep -Seconds 10
                    }
                }
                if (-not $ok) {
                    throw "Check failed: $baseUrl$path does not answer HTTP 200 after several tries."
                }
                Write-NfmItem Ok "HTTP 200  $path"
                if ($path -eq '/launchevent.js') {
                    if (-not (ConvertTo-FlatText $content).Contains($expectedDays)) {
                        throw "Check failed: the served launchevent.js does not contain $expectedDays (stale deployment or wrong environment)."
                    }
                    Write-NfmItem Ok "launchevent.js: $expectedDays present"
                }
                if ($path -eq '/manifest.prod.xml' -and -not $content.Contains($cfg.addinId)) {
                    throw "Check failed: the served manifest does not contain the Id $($cfg.addinId)."
                }
            }
            if ($apiEnabled) {
                # Without a token the API must refuse (401): it is deployed, reachable and protected.
                $apiStatus = $null
                for ($attempt = 1; $attempt -le 12 -and $apiStatus -ne 401; $attempt++) {
                    try {
                        $apiResponse = Invoke-WebRequest -Uri "$baseUrl/api/bypass" -Method Post -ContentType 'application/json' -Body '{}' -UseBasicParsing -TimeoutSec 30 -SkipHttpErrorCheck
                        $apiStatus = [int]$apiResponse.StatusCode
                    }
                    catch {
                        $apiStatus = $null
                    }
                    if ($apiStatus -ne 401) {
                        Start-Sleep -Seconds 10
                    }
                }
                if ($apiStatus -ne 401) {
                    throw "Check failed: POST $baseUrl/api/bypass without a token should answer 401 (answer: $apiStatus). The API is not deployed or misconfigured (see docs/NoFridayMail-Guide.md)."
                }
                Write-NfmItem Ok 'HTTP 401  POST /api/bypass without a token (expected: the API refuses without an identity)'
            }
        }
        else {
            $apiNote = if ($apiEnabled) { ', then HTTP 401 on POST /api/bypass without a token' } else { '' }
            Write-NfmItem Skip "[simulation] HTTP 200 would be checked on manifest.prod.xml, launchevent.js, taskpane.html and commands.html, then blockedDays:[$($cfg.rules.blockedDays -join ',')] and the add-in Id in the served files$apiNote"
        }
    }
    finally {
        # Restores the process environment (SetEnvironmentVariable does not depend on -WhatIf).
        foreach ($name in $previousEnv.Keys) {
            [Environment]::SetEnvironmentVariable($name, $previousEnv[$name], 'Process')
        }
    }

    # ===== Summary and next steps ======================================================================
    $artifact = Join-Path $root "out/NoFridayMail-$Environment-$($cfg.version).zip"
    $values = [ordered]@{
        Site     = @('Cloud', $baseUrl)
        Manifest = @('Folder', $manifestPath)
        Package  = @('Package', $artifact)
    }
    $summaryStatus = if ($script:NfmWarnings -gt 0) { 'Warn' } else { 'Ok' }
    if ($dryRun) {
        $values['Result'] = @('Skip', 'simulation finished: nothing was created, installed, built or deployed')
        Write-NfmSummary -Title 'Simulation finished' -Values $values -Status $summaryStatus
    }
    else {
        $values['Result'] = @('Ok', 'site deployed and checked')
        Write-NfmSummary -Title 'Deployment complete' -Values $values -Status $summaryStatus
    }

    $manifestShown = if ($dryRun) { "dist/$Environment/manifest.prod.xml (created by the real run)" } else { $manifestPath }
    Write-NfmBox -Title 'Next steps: publish the manifest' -Status Info -Lines @(
        "Manifest to publish: $manifestShown",
        '',
        'A. TEST FOR ONE PERSON (local sideload, recommended first)',
        '   1. Open Outlook on the web, then go to https://aka.ms/olksideload',
        '   2. My add-ins > Custom add-ins > Add a custom add-in > Add from file...',
        '   3. Choose the manifest file. Classic Outlook: Get Add-ins > My add-ins >',
        '      Add a custom add-in > From file.',
        '',
        'B. DEPLOY FOR EVERYONE (centralized deployment)',
        '   1. Microsoft 365 admin center > Settings > Integrated apps',
        '   2. Upload custom apps > App type: Office Add-in > upload the manifest file',
        '   3. Choose the users or groups (start with a pilot group), accept the',
        '      permissions (ReadWriteItem) and finish. Propagation: up to 24 hours.',
        '   Update: upload the new manifest with the same Id and a higher version.',
        '',
        'Step by step, with what you should see: docs/NoFridayMail-UserGuide.md'
    )
}
catch {
    Write-NfmError $_.Exception.Message
    $exitCode = 1
}
finally {
    Pop-Location
    Restore-NfmConsole
}
exit $exitCode

# SIG # Begin signature block
# MIImKgYJKoZIhvcNAQcCoIImGzCCJhcCAQExDzANBglghkgBZQMEAgEFADB5Bgor
# BgEEAYI3AgEEoGswaTA0BgorBgEEAYI3AgEeMCYCAwEAAAQQH8w7YFlLCE63JNLG
# KX7zUQIBAAIBAAIBAAIBAAIBADAxMA0GCWCGSAFlAwQCAQUABCBV8jnaKU2mky9E
# m0fAnWe6vW8UI6CaMrhwRALyoRyQlaCCDW8wggZyMIIEWqADAgECAghkM1HTxzif
# CDANBgkqhkiG9w0BAQsFADB8MQswCQYDVQQGEwJVUzEOMAwGA1UECAwFVGV4YXMx
# EDAOBgNVBAcMB0hvdXN0b24xGDAWBgNVBAoMD1NTTCBDb3Jwb3JhdGlvbjExMC8G
# A1UEAwwoU1NMLmNvbSBSb290IENlcnRpZmljYXRpb24gQXV0aG9yaXR5IFJTQTAe
# Fw0xNjA2MjQyMDQ0MzBaFw0zMTA2MjQyMDQ0MzBaMHgxCzAJBgNVBAYTAlVTMQ4w
# DAYDVQQIDAVUZXhhczEQMA4GA1UEBwwHSG91c3RvbjERMA8GA1UECgwIU1NMIENv
# cnAxNDAyBgNVBAMMK1NTTC5jb20gQ29kZSBTaWduaW5nIEludGVybWVkaWF0ZSBD
# QSBSU0EgUjEwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQCfgxNzqrDG
# bSHL24t6h3TQcdyOl3Ka5LuINLTdgAPGL0WkdJq/Hg9Q6p5tePOf+lEmqT2d0bKU
# Vz77OYkbkStW72fL5gvjDjmMxjX0jD3dJekBrBdCfVgWQNz51ShEHZVkMGE6ZPKX
# 13NMfXsjAm3zdetVPW+qLcSvvnSsXf5qtvzqXHnpD0OctVIFD+8+sbGP0EmtpuNC
# GVQ/8y8Ooct8/hP5IznaJRy4PgBKOm8yMDdkHseudQfYVdIYyQ6KvKNc8HwKp4WB
# wg6vj5lc02AlvINaaRwlE81y9eucgJvcLGfE3ckJmNVz68Qho+Uyjj4vUpjGYDdk
# jLJvSlRyGMwnh/rNdaJjIUy1PWT9K6abVa8mTGC0uVz+q0O9rdATZlAfC9KJpv/X
# gAbxwxECMzNhF/dWH44vO2jnFfF3VkopngPawismYTJboFblSSmNNqf1x1KiVgMg
# Lzh4gL32Bq5BNMuURb2bx4kYHwu6/6muakCZE93vUN8BuvIE1tAx3zQ4XldbyDge
# VtSsSKbt//m4wTvtwiS+RGCnd83VPZhZtEPqqmB9zcLlL/Hr9dQg1Zc0bl0EawUR
# 0tOSjAknRO1PNTFGfnQZBWLsiePqI3CY5NEv1IoTGEaTZeVYc9NMPSd6Ij/D+KNV
# t/nmh4LsRR7Fbjp8sU65q2j3m2PVkUG8qQIDAQABo4H7MIH4MA8GA1UdEwEB/wQF
# MAMBAf8wHwYDVR0jBBgwFoAU3QQJB6L1en1SUxKSle44gCUNplkwMAYIKwYBBQUH
# AQEEJDAiMCAGCCsGAQUFBzABhhRodHRwOi8vb2NzcHMuc3NsLmNvbTARBgNVHSAE
# CjAIMAYGBFUdIAAwEwYDVR0lBAwwCgYIKwYBBQUHAwMwOwYDVR0fBDQwMjAwoC6g
# LIYqaHR0cDovL2NybHMuc3NsLmNvbS9zc2wuY29tLXJzYS1Sb290Q0EuY3JsMB0G
# A1UdDgQWBBRUwv4QlQCTzWr158DX2bJLuI8M4zAOBgNVHQ8BAf8EBAMCAYYwDQYJ
# KoZIhvcNAQELBQADggIBAPUPJodwr5miyvXWyfCNZj05gtOII9iCv49UhCe204MH
# 154niU2EjlTRIO5gQ9tXQjzHsJX2vszqoz2OTwbGK1mGf+tzG8rlQCbgPW/M9r1x
# xs19DiBAOdYF0q+UCL9/wlG3K7V7gyHwY9rlnOFpLnUdTsthHvWlM98CnRXZ7WmT
# V7pGRS6AvGW+5xI+3kf/kJwQrfZWsqTU+tb8LryXIbN2g9KR+gZQ0bGAKID+260P
# Z+34fdzZcFt6umi1s0pmF4/n8OdX3Wn+vF7h1YyfE7uVmhX7eSuF1W0+Z0duGwdc
# +1RFDxYRLhHDsLy1bhwzV5Qe/kI0Ro4xUE7bM1eV+jjk5hLbq1guRbfZIsr0WkdJ
# LCjoT4xCPGRo6eZDrBmRqccTgl/8cQo3t51Qezxd96JSgjXktefTCm9r/o35pNfV
# HUvnfWII+NnXrJlJ27WEQRQu9i5gl1NLmv7xiHp0up516eDap8nMLDt7TAp4z5T3
# NmC2gzyKVMtODWgqlBF1JhTqIDfM63kXdlV4cW3iSTgzN9vkbFnHI2LmvM4uVEv9
# XgMqyN0eS3FE0HU+MWJliymm7STheh2ENH+kF3y0rH0/NVjLw78a3Z9UVm1F5VPz
# iIorMaPKPlDRADTsJwjDZ8Zc6Gi/zy4WZbg8Zv87spWrmo2dzJTw7XhQf+xkR6Od
# MIIG9TCCBN2gAwIBAgIQBof4ljXihJpmCqqt2mhAWzANBgkqhkiG9w0BAQsFADB4
# MQswCQYDVQQGEwJVUzEOMAwGA1UECAwFVGV4YXMxEDAOBgNVBAcMB0hvdXN0b24x
# ETAPBgNVBAoMCFNTTCBDb3JwMTQwMgYDVQQDDCtTU0wuY29tIENvZGUgU2lnbmlu
# ZyBJbnRlcm1lZGlhdGUgQ0EgUlNBIFIxMB4XDTI2MTAxMzAyNDgwMloXDTI3MTAx
# MzAyNDgwMlowXDELMAkGA1UEBhMCRlIxGzAZBgNVBAcMEkNoYW50ZWxvdXAtRW4t
# QnJpZTEXMBUGA1UECgwOTmljb2xhcyBGYWJlcnQxFzAVBgNVBAMMDk5pY29sYXMg
# RmFiZXJ0MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAsg6CT0mFQ4jB
# V2plIS4uWFSoVqRHd82Y7XYZ4CUTe/7nPBRUlXXdKTZMMHzGgiG8dEXNE8K1Xe90
# Dgl/FnorzAFlrNWSwf6t27UAUw9xkqtRDVVpVgpixpWkAwjcQeLG+YMqBkGbFi35
# TGvS23lPFWvLp4DxARrv15MtZ/NjNTCAAGUlMP2hFVBknEmrnYjEGyeJ93sl20RS
# WXQQLNqlenBdkGCrQW4XjHtRjJAEqAC68hN6nWevopSQ8CLUV7A1RFfHFarDrzrL
# zr0/NjIdSyIfM9hShln31NDrktB6Ups2XIyrtPDNB7fjkW4jpLlOqQGfYKsU9ErE
# 4SnFsh0yOOjitegyh1RvZ9wH++3DF4CmJfTli5l/gEIm8xCCryxI+K5EogW3wu1y
# u8NT2hcvHjdh7OpRyPyFAuLZ8MfX7kPAJpnuCeOuktzY/20eVD8bDglj+4zgqzsn
# cR/t6T/7w1/HxpRyrVoKvEyRx+mphYh5jMdEa0BjxOL0vAJpdGZSfXGmPm/yPqRn
# 5STTkMtzkVQXPbcvgKM0luzFcQKPHk3qdHLEXa8gf93ktYDbLE5Wd2UHrXz3SZxN
# URHPdIXCr1qgrqQve7041kMpzrkDI5DnG2lvRG4108gp02bHG0muKyZlDdCOra7h
# Zonu2nO79sFallruzzNi0o994PoWksUCAwEAAaOCAZUwggGRMAwGA1UdEwEB/wQC
# MAAwHwYDVR0jBBgwFoAUVML+EJUAk81q9efA19myS7iPDOMwegYIKwYBBQUHAQEE
# bjBsMEgGCCsGAQUFBzAChjxodHRwOi8vY2VydC5zc2wuY29tL1NTTGNvbS1TdWJD
# QS1Db2RlU2lnbmluZy1SU0EtNDA5Ni1SMS5jZXIwIAYIKwYBBQUHMAGGFGh0dHA6
# Ly9vY3Nwcy5zc2wuY29tMFEGA1UdIARKMEgwCAYGZ4EMAQQBMDwGDCsGAQQBgqkw
# AQMDATAsMCoGCCsGAQUFBwIBFh5odHRwczovL3d3dy5zc2wuY29tL3JlcG9zaXRv
# cnkwEwYDVR0lBAwwCgYIKwYBBQUHAwMwTQYDVR0fBEYwRDBCoECgPoY8aHR0cDov
# L2NybHMuc3NsLmNvbS9TU0xjb20tU3ViQ0EtQ29kZVNpZ25pbmctUlNBLTQwOTYt
# UjEuY3JsMB0GA1UdDgQWBBRoUx3630l9wA1fUpkKkw2GUIxl/jAOBgNVHQ8BAf8E
# BAMCB4AwDQYJKoZIhvcNAQELBQADggIBAE3oj6cNuwlDToi1BwjgsA5djfRN4DIi
# BYDFZIRYaIRe/rEdnItz3aqQQdFuwXnJA/MQEmi2WAGek8GeZF+R41s8FbcDxBUE
# BoSt98TuBE+0xgxQWDiPhhXaX1Aw9V0GF4ZnlfCSw1eu2KiASaKn7Bo0PLbEAXff
# vftRXof/kyqtw8iID6I4Rhrf5DI3WVZQodakUUmWnbnziWvEZOWbNOfzwP+7BwEt
# 7jQANfbmEfb4p75rfy5dQVwniTDSvdo6xkrbe1Cr93GS7cJta18IG5CoIVUmdK+s
# W38B1sLuy8Mi0MstMXV3004yaRuzLdNaAM0f9WAFerxemiQC0kdmA44/lWV3lVkM
# WJSwkHBkkSg8Eh0hxcGzTH2xmtDhLJHNNLRwkI9u2Ur+HbLCt50oBgSV8BcCs/1i
# qi884iC/yuX+HIv9YgTUNZ8c4lLaq4VuliJpXLu2buHIsTkO0v0+5oCM91zjTVZm
# ULeH38N0Vr83psiJVuBSxQyt5nRVrpYz7FACq5gtXELkyViq/rGOlJKaRrgQ6WWq
# eoIXqKhVFAdP/jAEm2M8ezoVYsUgPyKY2OcuecV9coulAcxUIUydx6qYiOfsGj5u
# Dy7l4aYjvB771wkUMzUQwxzcDYXJtMMTaWRe6n9EemR67jc73u5CJyFg3PfA5WR1
# wZislcdCZuS6MYIYETCCGA0CAQEwgYwweDELMAkGA1UEBhMCVVMxDjAMBgNVBAgM
# BVRleGFzMRAwDgYDVQQHDAdIb3VzdG9uMREwDwYDVQQKDAhTU0wgQ29ycDE0MDIG
# A1UEAwwrU1NMLmNvbSBDb2RlIFNpZ25pbmcgSW50ZXJtZWRpYXRlIENBIFJTQSBS
# MQIQBof4ljXihJpmCqqt2mhAWzANBglghkgBZQMEAgEFAKCBhDAYBgorBgEEAYI3
# AgEMMQowCKACgAChAoAAMBkGCSqGSIb3DQEJAzEMBgorBgEEAYI3AgEEMBwGCisG
# AQQBgjcCAQsxDjAMBgorBgEEAYI3AgEVMC8GCSqGSIb3DQEJBDEiBCAL3iISWVIs
# r+QijJ/RQ6oqgKEp6rm36BKBZ9vWFWFgTzANBgkqhkiG9w0BAQEFAASCAgCfEmEB
# WNbfBu1dnRNWlmtinrXVc44r6Rh/xkxdBA0dykATxt7JXQaR2Y3R4NzbruwGa8Ag
# Q5c3T/zw6kc+I6b9xPXsl4yaT84JYctoB+zwtFmB3PHp8M3qv7Yu4ITLWhWHe0TX
# xuyqV77W2T1nqovELuBuE1z2QjOL5n0y4s6s6Hvt7HKKOh0nBazKik/KaPeLt4Bb
# eEkUBSprCcNlTRCIclzX/MN8ybkEx47MM0qIWjLryuNu344jS3NiLrAykG/tBgDI
# lAYIIHvzwfPcnVdYF+JgDv6g1hX0M7o4VUrNTI+ab5qDYTBEHjJmgz52EXYypJ9I
# L1DqPJqeZdFWyKPceLIr1hECPvVtUAsdEh/zwrRmVXS0EHrTuj0ZkuHuw1MNFznm
# l0FB2jGgIOKe2H7BWyTjVLOdkRCDMGWMYQ97eG9fJRNbrX6xZ2xCgCOn+pMkYpZy
# BfUZNSh6qTQ0Xgy7chjujemO/UNmzN8HcHQfuJqBANhop+HsRs/KZcw49ydrDGqa
# CMLXqhMhBEr7qnunCuUmpUGkjTwNvPY/MgL9kRuqS9NcBvfsTA3K8RB2xBUBHIGW
# mDDZJpNhmxBxou2YELVoTQWrC7bcyjisdcUr79ErPXLW13T4Qa2c8lZ1h33xg09/
# fPW0/EmM3CsCT9ba6/AMmAlTPBbPaWmvtrKTvKGCFM4wghTKBgorBgEEAYI3AwMB
# MYIUujCCFLYGCSqGSIb3DQEHAqCCFKcwghSjAgEDMQ0wCwYJYIZIAWUDBAIBMIGJ
# BgsqhkiG9w0BCRABBKB6BHgwdgIBAQYMKwYBBAGCqTABAwYBMDEwDQYJYIZIAWUD
# BAIBBQAEIKz75x7M7+JDnGaIhao3OnSD/wCF3kI7XWLjCzRkfloPAghBusYLOiUr
# KhgPMjAyNjEwMzAxOTQ3MjRaMAMCAQECEAtteq2K0UHRxc+1Im6voTigghGnMIIE
# 8zCCAtugAwIBAgIQVEP4N71a7hgBhHK4XNqO4zANBgkqhkiG9w0BAQsFADByMQsw
# CQYDVQQGEwJVUzEOMAwGA1UECAwFVGV4YXMxEDAOBgNVBAcMB0hvdXN0b24xETAP
# BgNVBAoMCFNTTCBDb3JwMS4wLAYDVQQDDCVTU0wuY29tIFRpbWVzdGFtcGluZyBJ
# c3N1aW5nIFJTQSBDQSAyMB4XDTI2MDYxMjE3MjI0NloXDTM2MDYwOTE3MjI0NVow
# bjELMAkGA1UEBhMCVVMxDjAMBgNVBAgMBVRleGFzMRAwDgYDVQQHDAdIb3VzdG9u
# MREwDwYDVQQKDAhTU0wgQ29ycDEqMCgGA1UEAwwhU1NMLmNvbSBUaW1lc3RhbXBp
# bmcgVW5pdCAyMDI2IEUxMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE6CWLuGYT
# LkiSOPMLNskOBthXsIhRSA46feOQwvSLcDaNh6vxUzBKEx1KdFBRFs7OHrnH/K0V
# A6MbDQIFpUg0PaOCAVIwggFOMB8GA1UdIwQYMBaAFHCaZcFDgKP86bFkiW7xMJwJ
# Icl8ME0GCCsGAQUFBwEBBEEwPzA9BggrBgEFBQcwAoYxaHR0cDovL2NlcnQuc3Ns
# LmNvbS9TU0wuY29tLXRpbWVTdGFtcGluZy1JLVIyLmNlcjBRBgNVHSAESjBIMDwG
# DCsGAQQBgqkwAQMGATAsMCoGCCsGAQUFBwIBFh5odHRwczovL3d3dy5zc2wuY29t
# L3JlcG9zaXRvcnkwCAYGZ4EMAQQCMBYGA1UdJQEB/wQMMAoGCCsGAQUFBwMIMEIG
# A1UdHwQ7MDkwN6A1oDOGMWh0dHA6Ly9jcmxzLnNzbC5jb20vU1NMLmNvbS10aW1l
# U3RhbXBpbmctSS1SMi5jcmwwHQYDVR0OBBYEFCesA1a6KGq6FzuDPUB/eagk7MM8
# MA4GA1UdDwEB/wQEAwIHgDANBgkqhkiG9w0BAQsFAAOCAgEAT3ZuzvwDnsIZTXBn
# +hjmuBXgzB12fbYxT9uYe6ZvhvpbZWKcyDQgacETkPw8k6yeqnYCYyFZ063lMPEq
# AhAD2nMG614Zh7PtHW9DWqfsgivxbPYBeN+t7UxgkYT3expbWMdPEqBtWVyHOvLc
# KvMxgJWfJjANwVkwVDfky/j7cf28+iimN8PKc7S/u8/LenRRnV2W2YfncRnkz9Cf
# s5nRDzaZguiHrrp2GxwgnNQSH4GBjHOl3PzLsnVbGoZKi4ZEjgXups4mGGOK7+GB
# 2HAlQn+OS944cHqlkH0gElt2WezoCNRpELph9qaxuBnjSEqXWWfgE6yGBwO0uxKN
# qpWVTHmAwr6SvBPofxubXIuEn9ivR4CLOuAxUSrJ41ZBg/qqG0oJjF6GkRKbxq7c
# yWSkEZYJhmKCg2Hg5fXHagOxiwbmn5JPZ1vhWCrbk3v/dTx2gvTK5+erC5H9/rTc
# ljUI776yd2rfhjfkpvyAsbtXs4D7nrnw8i9wor5+fdtRSJBVxqzLmykFftoL0Up2
# Q++tyKCUdribdcnrB4HKS3s+t3AjdcbA06DCL8GifQi9fL0yRBRNlA4o6BP+Sr75
# 5MaCNjURYZDvDyxJHBBT7cqjZIwsiR8s+6860noFbBBtdge2Iw7CPC/1Q31I27hV
# olS7B0yao3v8X2MtWy3msZlXTcEwggXdMIIDxaADAgECAgh7LJvTFoAymTANBgkq
# hkiG9w0BAQsFADB8MQswCQYDVQQGEwJVUzEOMAwGA1UECAwFVGV4YXMxEDAOBgNV
# BAcMB0hvdXN0b24xGDAWBgNVBAoMD1NTTCBDb3Jwb3JhdGlvbjExMC8GA1UEAwwo
# U1NMLmNvbSBSb290IENlcnRpZmljYXRpb24gQXV0aG9yaXR5IFJTQTAeFw0xNjAy
# MTIxNzM5MzlaFw00MTAyMTIxNzM5MzlaMHwxCzAJBgNVBAYTAlVTMQ4wDAYDVQQI
# DAVUZXhhczEQMA4GA1UEBwwHSG91c3RvbjEYMBYGA1UECgwPU1NMIENvcnBvcmF0
# aW9uMTEwLwYDVQQDDChTU0wuY29tIFJvb3QgQ2VydGlmaWNhdGlvbiBBdXRob3Jp
# dHkgUlNBMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA+Q/doyt9y9Aq
# /uxnhabnLhu6d+Hj9a+k7PpKXZHEV0drGHdrdvL9k+Q9D8IWngtmw1aUnheDhc5W
# 7/IW/QBi9SIJVOhlF05BueBPRpeqG8i4bmJeabFf2yoCfvxsyvNB2O3Q6Pw/YUjt
# sAMUHRAOSxngu07shmX/NvNeZwILnYZVYf16OO3+4hkAt2+hUGJ1dDyg+sglkrRu
# eiLH+B6h47LdkTGrKx0E/6VKBDfphaQzK/3i1lU0fBmkSmjHsqjTt8qhk4jrwZe8
# jPkd2SKEJHTHBD1qqSmTzOu4W+H+XyWqNFjIwSNUnRuYEcM4nH49hmylD0CGfAL0
# XAJPKMuucZ8POsgz/hElNer8usVgPdl8GNWyqdN1eANyIso6wx/vLOUuqfqeLLZR
# Rv2vA9bqYGjqhRY2a4XpHsCz3cQk3IAqgUFtlD7I4MmBQQCeXr9/xQiYohgsQkCz
# +W84J0tOgPQ9gUfgiHzqHM61dVxRLhwrfxpyKOcAtdF0xtfkn60Hk7ZTNTX8N+TD
# 9l0WviFz3pIK+KBjaryWkmo++LxlVZve9Q2JJgT8JRqmJWnLwm3KfOJZX5es6+8u
# yLzXG1k8K8zyGciTaydjGc/86Sb4ynGbf5P+NGeETpnr/LN4CTNwumamdu0bc+sa
# pQ3EIhMglFYKTixsTrH9z5wJuqIz7YcCAwEAAaNjMGEwHQYDVR0OBBYEFN0ECQei
# 9Xp9UlMSkpXuOIAlDaZZMA8GA1UdEwEB/wQFMAMBAf8wHwYDVR0jBBgwFoAU3QQJ
# B6L1en1SUxKSle44gCUNplkwDgYDVR0PAQH/BAQDAgGGMA0GCSqGSIb3DQEBCwUA
# A4ICAQAgGBGUKfsmnRweHnBh8ZVyk3EkrWiTWI4yrxuzcAP8JSt0hZA9eGr0uYul
# lzu1GJG7Hqf5QFuR+VWZrx4R0Fwdp2bjsZQHDDI5puobsHnYHZxwROOK3cT5lR+K
# OEM/AYWlR6c9RrK85SJo93uc2Cw+CiHILTOsv8WBmTF0wXVxxb6x8CNF9J1r/Blj
# naO8BMYYCyW7U4kPs4BQ3kXuRH+rlHhkmNP2KN2H2HBldPsOuRPrpw9hqTKWzN67
# 7WNMGLupQPegVG4giHF1GOp6tDRy4CMnd1y2kOqGJUCr7zMPy5+CvqIg+/a1LRrm
# woWxdA/7yGUCpFIBR91JIsG/2OtrrH7e7GMzFbcjCI/GD41BWt2OxbmP5UU/eNu6
# 0htAsf5xTT/ggaK6XrTsFeCT3QgffuFVmQsh3pOeCvvmo0m9NjD+53eyoHWXtS2B
# iBdlIPfakACfyVLMMso1fPU9D9gr1/UmbMkGNJYW6nBZGjJ5eQu2iH8PUkg9v2zY
# okQu0U63cljTiROV/kSr+NeLG26cvCygW9VqAK9fN+HV+hALmJyG5yaPzvDsbopX
# C4DjTrLAoGNhkLpVaDd0araS25+hhiK2ZScO7LafQmDkZ8K12kELxNOLYRu8+h+R
# K9dEB166KazZxenvU0ha64DxKFghzbAGVfsnP1OQcKkEHlcnuTCCBsswggSzoAMC
# AQICEFKdu8K4iYf1g4DgsOuiBjYwDQYJKoZIhvcNAQELBQAwfDELMAkGA1UEBhMC
# VVMxDjAMBgNVBAgMBVRleGFzMRAwDgYDVQQHDAdIb3VzdG9uMRgwFgYDVQQKDA9T
# U0wgQ29ycG9yYXRpb24xMTAvBgNVBAMMKFNTTC5jb20gUm9vdCBDZXJ0aWZpY2F0
# aW9uIEF1dGhvcml0eSBSU0EwHhcNMjYwNjEyMTY0MjE1WhcNNDEwMjEyMTczOTM5
# WjByMQswCQYDVQQGEwJVUzEOMAwGA1UECAwFVGV4YXMxEDAOBgNVBAcMB0hvdXN0
# b24xETAPBgNVBAoMCFNTTCBDb3JwMS4wLAYDVQQDDCVTU0wuY29tIFRpbWVzdGFt
# cGluZyBJc3N1aW5nIFJTQSBDQSAyMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIIC
# CgKCAgEAny+r5nNNkLwxRps2B3laUGNU9y7vWiJ5013yf0iXz65bQdwa9bjj8l/S
# keXqHGqfSh2Foae+80E8mDEf93oIwjsy2CX2cXmKxqtF8HJGYB4f6yRhKED50wkb
# OysL02IXf+/EZna44jffhhVz4OU/k52xQ/PnIg/uFhc2Wk+Sc/CHqAr+lYVkPz7L
# y5RqB9f1RKGr9JC37W1LgVdHC50dNIdsa3QXPhltYZubR3npE4Bbfi0joUW5n5O0
# ayweN45R/YVLxA0YGlp1OHVfVnsqXq8bhnw1Lc4kjJ6XOgXlOlw/a8ze57TvbduZ
# l3ehewTmvO0Aky/nqOWDS9IPPxdxdG6vprBbSuHlxNANBAbHTiFgkfZmf0dZYlT/
# AnZIoFxAq0HILPolf4OgWgET76SiWSlm2XYRIXwVjpeqG0plvXwRIQBzSiEJj7Qe
# QFnCvHx4gQMINvN3+yG/1rxhEbajGve0tTP3lX4PPOHVAE0QJp4ZzPI1YYJkhVRr
# iVVxVRU4Fsg4BPwP6I+YLmHb1tZ4RLwOFNLh/gJYDgPlChCoxOogFxXgwPZZrDyE
# RYB0aeOexW0OKacN4RRu9cqF2KKu/Ab5AL7eYDLVGUPrEEyYbIMApVKqpebc0/jD
# QniC+3rkauRAjgVc8m1ip/CQgG1Dw4Z9ulVRAY9VR6Za26LsTbUCAwEAAaOCAVEw
# ggFNMBIGA1UdEwEB/wQIMAYBAf8CAQAwHwYDVR0jBBgwFoAU3QQJB6L1en1SUxKS
# le44gCUNplkwTQYIKwYBBQUHAQEEQTA/MD0GCCsGAQUFBzAChjFodHRwOi8vY2Vy
# dC5zc2wuY29tL1NTTGNvbS1Sb290Q0EtUlNBLTQwOTYtUjEuY2VyMD8GA1UdIAQ4
# MDYwNAYEVR0gADAsMCoGCCsGAQUFBwIBFh5odHRwczovL3d3dy5zc2wuY29tL3Jl
# cG9zaXRvcnkwEwYDVR0lBAwwCgYIKwYBBQUHAwgwQgYDVR0fBDswOTA3oDWgM4Yx
# aHR0cDovL2NybHMuc3NsLmNvbS9TU0xjb20tUm9vdENBLVJTQS00MDk2LVIxLmNy
# bDAdBgNVHQ4EFgQUcJplwUOAo/zpsWSJbvEwnAkhyXwwDgYDVR0PAQH/BAQDAgGG
# MA0GCSqGSIb3DQEBCwUAA4ICAQBlFFvNMemA6iBiBYo56IKQjWhWuQaYKuo4qpf0
# KJNERAt1gz+HsA2SL3xA/V+EA8SRPNP9SvX0is+5mDsppYvpKyYGqYP36YFW0mbF
# 1F0ZtXxumCUUO/ZV5mBNKDf5Q4PY7Qb0eWAepUc0rNJr/Mvn5ZiXfJPxDb2xmcg8
# aRD652/nr+Ork2UBP0E43iJdI4LF7Vs29R3SGRLYZOxM15DI4QebsKRl0KDlf4Om
# YGCKc7umTxibkZtN1C1KWgnf9jadU/JwnySaYEBgx6/v+FVC6SGONziY7TcvI9MV
# +qYxHUPlOm6AaQP2dS4bjWXnm86ldCbUkxtOACumSfT97077JNiVa7PZ1IBkd/2P
# E1AC8gs7U+/Yk1BN9XRPIi15k/uA1xF9oeee5KGjyiGKkqIT7W8QkgUT5zeCinFK
# kcKafZMcROSVYpXtmtQqGGR2g4uPYqJ0K1hms6gJXrHt/34p8M9PrV8oNWe0Zl1E
# rDMtXndUg3qhJL4pA3ZUlo7w5lM5ml+A7ijr/3Gk2v4QRoDeE2ShmTXdHgtqo8L/
# fT119mYcETycE2NYGRXsBl3N0rzDsHRr8P3TrprqhRrX04iS0P7eQ+lDxgS3yhGn
# 3OzWGhDt9Gf2x1qe0/qdhFAVOkXxzMZz4Uat6xsAfzX0+/m8GEKW5Ojw/HY+kLvV
# wzSPOzGCAlYwggJSAgEBMIGGMHIxCzAJBgNVBAYTAlVTMQ4wDAYDVQQIDAVUZXhh
# czEQMA4GA1UEBwwHSG91c3RvbjERMA8GA1UECgwIU1NMIENvcnAxLjAsBgNVBAMM
# JVNTTC5jb20gVGltZXN0YW1waW5nIElzc3VpbmcgUlNBIENBIDICEFRD+De9Wu4Y
# AYRyuFzajuMwCwYJYIZIAWUDBAIBoIIBYDAaBgkqhkiG9w0BCQMxDQYLKoZIhvcN
# AQkQAQQwHAYJKoZIhvcNAQkFMQ8XDTI2MTAzMDE5NDcyNFowKAYJKoZIhvcNAQk0
# MRswGTALBglghkgBZQMEAgGhCgYIKoZIzj0EAwIwLwYJKoZIhvcNAQkEMSIEIIlz
# YZW4y0ujOLrgvbOYf9nMBK/k2r1dqcXJpvW06mRvMIHIBgsqhkiG9w0BCRACLzGB
# uDCBtTCBsjCBrwQgV0/qF6r6XnxqK5sIyZixc15FCzhzykTmokygkw5j87AwgYow
# dqR0MHIxCzAJBgNVBAYTAlVTMQ4wDAYDVQQIDAVUZXhhczEQMA4GA1UEBwwHSG91
# c3RvbjERMA8GA1UECgwIU1NMIENvcnAxLjAsBgNVBAMMJVNTTC5jb20gVGltZXN0
# YW1waW5nIElzc3VpbmcgUlNBIENBIDICEFRD+De9Wu4YAYRyuFzajuMwCgYIKoZI
# zj0EAwIERzBFAiEAwc6Sz9ikA744H2vv49LvcYH9WKNJLoDap6wL8LlJZIwCIFU4
# 83q9mF7GSmCaIUa3IJd1iN5p/f00DJBEYZL7W+4B
# SIG # End signature block
