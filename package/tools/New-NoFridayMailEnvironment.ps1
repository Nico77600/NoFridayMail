#Requires -Version 7.4

<#
.SYNOPSIS
    NoFridayMail - creates the file of a new environment, with its own add-in Id generated once.

.DESCRIPTION
    One environment = one add-in identity. The add-in Id (the GUID in "addinId") is what Outlook uses to
    recognise the add-in:

      - STABLE: the same environment keeps the same Id for its whole life. With the same Id, a new
        deployment UPDATES the add-in your users already have. A new Id on every deployment would install a
        second add-in for every user.
      - UNIQUE: two environments never share an Id, otherwise they would replace each other in the same
        Microsoft 365 tenant.

    This script is where the Id is born. It copies the template deploy\environments\example.json, sets your
    names, generates a fresh GUID with [guid]::NewGuid(), checks that no known environment already uses it and
    validates the result with the same code as the build, in three stages shown on screen as 1/3 ... 3/3:

      1. CHECK      Node.js, the name, the target file (an existing file is refused without -Force), the
                    environments already known (their Ids and names).
      2. GENERATE   The new Id and the content of the file. Nothing is written yet.
      3. WRITE      Strict validation (schema, consistency, unique Id), then the file
                    deploy\environments.local\<Name>.json is written (never published: git ignores it).

    The Id is generated here and NEVER at deployment time: Deploy-NoFridayMail.ps1 refuses a template or
    duplicated Id and tells you to come back here. Once users installed the add-in, never change the Id.

    With -Force the file is rewritten from the template but the Id it already holds is KEPT (an environment
    never changes identity). Only -AddinId can replace it, on purpose.

    What it changes: one file in the environments folder (and the folder if it is missing). What it never
    changes: Azure, Microsoft 365, Exchange, any other file. -WhatIf writes nothing.

.PARAMETER Name
    Short environment name = file name without .json: lowercase letters, digits and hyphens (for example
    "staging" or "contoso-prod"). Must not already exist as an environment, and must not be "example".

.PARAMETER DisplayName
    Name shown in Outlook and in the admin center. Default: "NoFridayMail (<Name>)".

.PARAMETER ResourceGroup
    Azure resource group (created by the deployment if missing). Default: "rg-nofridaymail-<Name>".

.PARAMETER StaticWebAppName
    Name of the Azure Static Web Apps resource (unique in Azure). Default: "swa-nofridaymail-<Name>".

.PARAMETER Location
    Azure region of the Static Web Apps resource. Default: westeurope.

.PARAMETER SubscriptionId
    Azure subscription GUID. Optional: when omitted, the deployment uses the subscription that az uses.

.PARAMETER BlockedDays
    Days on which sending is forbidden: 0 = Sunday ... 5 = Friday ... 6 = Saturday. Default: 5 (Friday).
    Example: -BlockedDays 1,2 blocks Monday and Tuesday.

.PARAMETER Path
    Folder that receives <Name>.json. Default: deploy\environments.local\ (your own files, never
    published). The deployment looks there first.

.PARAMETER AddinId
    Rarely needed. Uses this GUID instead of generating one, for example to keep the Id of an add-in that is
    already installed. It must not be a template value nor used by another environment.

.PARAMETER Force
    Rewrites an existing <Name>.json from the template. The add-in Id of that file is kept.

.EXAMPLE
    .\tools\New-NoFridayMailEnvironment.ps1 -Name staging -WhatIf
    SIMULATE. Shows what would be created and writes nothing. Always do this first.

.EXAMPLE
    .\tools\New-NoFridayMailEnvironment.ps1 -Name staging
    Creates deploy\environments.local\staging.json: Friday blocked, westeurope, names derived from "staging",
    a new add-in Id. Then simulate and deploy it (the "Next steps" box shows the commands).

.EXAMPLE
    .\tools\New-NoFridayMailEnvironment.ps1 -Name contoso -DisplayName "NoFridayMail (Contoso)" -ResourceGroup rg-contoso-mail -StaticWebAppName swa-contoso-nofridaymail -SubscriptionId "00000000-0000-0000-0000-000000000000" -BlockedDays 1,2
    Everything set by hand: Azure names, subscription, and Monday + Tuesday blocked.

.EXAMPLE
    .\tools\New-NoFridayMailEnvironment.ps1 -Name staging -Force
    The file already exists: it is rewritten from the template and keeps its add-in Id.

.NOTES
    Author  : Nicolas Fabert
    Version : 1.1.0
    Requires: PowerShell 7.4 and Node.js 22+ (used to validate the file with the same code as the build).
    Exit codes : 0 = success (or simulation finished), 1 = failure (the line "ERROR: ..." tells why).
    Colours and icons: plain ASCII without colours when the output is redirected or NO_COLOR is set.
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
    [string]$Name,

    [ValidatePattern('^[^<>&"]+$')]
    [ValidateLength(1, 125)]
    [string]$DisplayName,

    [string]$ResourceGroup,
    [string]$StaticWebAppName,

    [ValidatePattern('^[a-z0-9]{3,30}$')]
    [string]$Location = 'westeurope',

    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    [string]$SubscriptionId,

    [ValidateRange(0, 6)]
    [int[]]$BlockedDays = @(5),

    [string]$Path,

    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    [string]$AddinId,

    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dryRun = [bool]$WhatIfPreference
$totalSteps = 3
# Template values that are never a real add-in Id (same list as PLACEHOLDER_ADDIN_IDS in tools/env-config.js).
$placeholderIds = @('11111111-2222-4333-8444-555555555555', '00000000-0000-0000-0000-000000000000')

# Console theme and prerequisite checks (tools/lib/Deploy-Checks.ps1).
. (Join-Path $PSScriptRoot 'lib/Deploy-Checks.ps1')

$toolVersion = 'unknown'
try { $toolVersion = [string](Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).version } catch { $toolVersion = 'unknown' }
Initialize-NfmConsole -Version $toolVersion

function Get-KnownEnvironment {
    # Every environment file of the folders that count: name, path and add-in Id (null when unreadable).
    param([string[]]$Folders)
    foreach ($folder in ($Folders | Where-Object { $_ } | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $folder -PathType Container)) { continue }
        foreach ($file in Get-ChildItem -LiteralPath $folder -Filter '*.json' -File) {
            $id = $null
            try {
                $content = Get-Content -LiteralPath $file.FullName -Raw -Encoding utf8 | ConvertFrom-Json
                if ($content.PSObject.Properties['addinId']) { $id = ([string]$content.addinId).ToLowerInvariant() }
            }
            catch { $id = $null }
            [pscustomobject]@{ Name = $file.BaseName; Path = $file.FullName; AddinId = $id }
        }
    }
}

$callerDir = (Get-Location).Path
$exitCode = 0
$target = ''
$newId = ''
Push-Location $root
try {
    Write-NfmBanner -Title 'NoFridayMail - new environment' -Subtitle 'One environment = one add-in identity, generated once and kept' -Details ([ordered]@{
            Target = @('Folder', $Name)
            Mode   = @($(if ($dryRun) { 'Skip' } else { 'Tool' }), $(if ($dryRun) { 'simulation (-WhatIf): nothing is written' } else { 'real run' }))
        })

    # ===== 1/3 Check ===================================================================================
    Write-NfmStep 1 $totalSteps 'Checks' -Icon Check

    $toolChecks = @(Test-NodeTool)
    $toolChecks | Write-NfmCheck
    if (@($toolChecks | Where-Object Status -eq 'FAIL').Count -gt 0) {
        throw 'Missing prerequisites: Node.js 22 or newer and npm. Fix the [!] lines above (line "What to do"), open a new terminal, then run again.'
    }

    if ($Name -eq 'example') {
        throw "'example' is the template and cannot be an environment name. Choose another name (for example 'staging')."
    }

    # Same folders as the deployment: your own folder first, then the published one. NFM_ENVIRONMENTS_DIR replaces both (tests).
    $defaultDir = if ($env:NFM_ENVIRONMENTS_DIR) { $env:NFM_ENVIRONMENTS_DIR } else { Join-Path $root 'deploy/environments.local' }
    $targetDir = if ($Path) { $Path } else { $defaultDir }
    $targetDir = [System.IO.Path]::GetFullPath($targetDir, $callerDir)
    $target = Join-Path $targetDir "$Name.json"
    $searched = @(if ($env:NFM_ENVIRONMENTS_DIR) { $env:NFM_ENVIRONMENTS_DIR } else { (Join-Path $root 'deploy/environments.local'); (Join-Path $root 'deploy/environments') })
    $known = @(Get-KnownEnvironment -Folders ($searched + @($targetDir)))
    New-NfmCheck OK "Environments already known: $(if ($known.Count) { ($known.Name | Sort-Object -Unique) -join ', ' } else { 'none' })" | Write-NfmCheck

    $template = Join-Path $root 'deploy/environments/example.json'
    if (-not (Test-Path -LiteralPath $template)) {
        throw "The template deploy/environments/example.json is missing. Restore it (git checkout deploy/environments/example.json or download the package again)."
    }
    New-NfmCheck OK 'Template found: deploy/environments/example.json' | Write-NfmCheck

    # A name already used elsewhere is refused (the local folder wins over the published one: a silent shadow is a trap).
    $sameName = @($known | Where-Object { $_.Name -eq $Name -and [System.IO.Path]::GetFullPath($_.Path) -ne [System.IO.Path]::GetFullPath($target) })
    if ($sameName.Count -gt 0) {
        throw "An environment named '$Name' already exists: $($sameName[0].Path). Choose another name."
    }
    $existing = $known | Where-Object { [System.IO.Path]::GetFullPath($_.Path) -eq [System.IO.Path]::GetFullPath($target) } | Select-Object -First 1
    if ($existing -and -not $Force) {
        throw "The file $target already exists. Its add-in Id is kept for good, so the file is never silently replaced. Edit it by hand, or add -Force to rewrite it from the template (the Id it holds is kept)."
    }
    if ($existing) {
        New-NfmCheck WARN "The file already exists and will be rewritten (-Force): $target" 'its add-in Id is kept; check the other values afterwards.' | Write-NfmCheck
    }
    else {
        New-NfmCheck OK "Target file free: $target" | Write-NfmCheck
    }

    # ===== 2/3 Generate ================================================================================
    Write-NfmStep 2 $totalSteps 'Add-in Id and file content' -Icon Key

    # Ids used by the OTHER environments (the file being rewritten does not count against itself).
    $selfPath = if ($existing) { $existing.Path } else { '' }
    $usedIds = @($known | Where-Object { $_.AddinId -and $_.Path -ne $selfPath } | ForEach-Object { $_.AddinId })
    if ($AddinId) {
        $newId = $AddinId.ToLowerInvariant()
        if ($placeholderIds -contains $newId) {
            throw "-AddinId $AddinId is a template value, not a real Id. Omit -AddinId to get a fresh one."
        }
        $owner = $known | Where-Object { $_.AddinId -eq $newId -and $_.Path -ne $selfPath } | Select-Object -First 1
        if ($owner) {
            throw "-AddinId $AddinId is already used by the environment '$($owner.Name)' ($($owner.Path)). Two environments must never share an Id."
        }
        Write-NfmItem Ok "Add-in Id given with -AddinId: $newId" -Icon Key
    }
    elseif ($existing -and $existing.AddinId -and ($placeholderIds -notcontains $existing.AddinId)) {
        $newId = $existing.AddinId
        Write-NfmItem Ok "Add-in Id KEPT from the existing file (an environment never changes identity): $newId" -Icon Key
    }
    else {
        $attempt = 0
        do {
            $attempt++
            $newId = [guid]::NewGuid().ToString()
        } while ((($usedIds -contains $newId) -or ($placeholderIds -contains $newId)) -and $attempt -lt 5)
        if (($usedIds -contains $newId) -or ($placeholderIds -contains $newId)) {
            throw "Could not generate an add-in Id that no known environment uses (GUID $newId already taken). Run the script again."
        }
        if ($dryRun) {
            Write-NfmItem Skip '[simulation] a fresh GUID would be generated with [guid]::NewGuid() (the real run shows the Id)' -Icon Key
        }
        else {
            Write-NfmItem Ok "New add-in Id generated with [guid]::NewGuid(): $newId (unique among $($known.Count) known environment file(s))" -Icon Key
        }
    }

    $config = Get-Content -LiteralPath $template -Raw -Encoding utf8 | ConvertFrom-Json
    $config.description = "Environment '$Name' created with tools/New-NoFridayMailEnvironment.ps1. Its addinId was generated once and identifies this add-in for good: never change it after users installed the add-in, never reuse it in another environment."
    $config.name = $Name
    $config.displayName = if ($DisplayName) { $DisplayName } else { "NoFridayMail ($Name)" }
    $config.addinId = $newId
    $config.version = '1.0.0.0'
    $config.azure.resourceGroup = if ($ResourceGroup) { $ResourceGroup } else { "rg-nofridaymail-$Name" }
    $config.azure.staticWebAppName = if ($StaticWebAppName) { $StaticWebAppName } else { "swa-nofridaymail-$Name" }
    $config.azure.location = $Location
    if ($SubscriptionId) {
        $config.azure.subscriptionId = $SubscriptionId.ToLowerInvariant()
    }
    else {
        $config.azure.PSObject.Properties.Remove('subscriptionId')
    }
    $config.rules.blockedDays = [int[]]@($BlockedDays | Sort-Object -Unique)
    $json = (($config | ConvertTo-Json -Depth 10) -replace "`r`n", "`n") + "`n"
    Write-NfmItem Ok "Content prepared from the template: display name '$($config.displayName)', blocked days $($config.rules.blockedDays -join ','), $($config.azure.resourceGroup) / $($config.azure.staticWebAppName) ($Location)"

    # ===== 3/3 Validate and write ======================================================================
    Write-NfmStep 3 $totalSteps 'Validation and file' -Icon Build

    # Strict validation of the content BEFORE anything is written (schema, consistency, unique Id), same code as the build.
    $validation = $json | & node tools/env-config.js $Name --stdin 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "The environment would not be valid, nothing was written:`n$(($validation | Out-String).Trim())"
    }
    New-NfmCheck OK 'Content valid (schema, consistency, unique add-in Id)' | Write-NfmCheck

    if ($PSCmdlet.ShouldProcess($target, 'Write the environment file')) {
        New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
        [System.IO.File]::WriteAllText($target, $json, [System.Text.UTF8Encoding]::new($false))
        Write-NfmItem Ok "File written: $target"
    }
    elseif ($dryRun) {
        Write-NfmItem Skip "[simulation] would write $target"
    }

    $values = [ordered]@{
        File     = @('Folder', $target)
        'Add-in Id' = @('Key', $(if ($dryRun) { '(generated by the real run)' } else { $newId }))
        Name     = @('Info', $config.displayName)
    }
    if ($dryRun) {
        $values['Result'] = @('Skip', 'simulation finished: nothing was written')
        Write-NfmSummary -Title 'Simulation finished' -Values $values -Status $(if ($script:NfmWarnings -gt 0) { 'Warn' } else { 'Ok' })
    }
    else {
        $values['Result'] = @('Ok', 'environment created')
        Write-NfmSummary -Title 'Environment created' -Values $values -Status $(if ($script:NfmWarnings -gt 0) { 'Warn' } else { 'Ok' })
    }

    $standardDir = [System.IO.Path]::GetFullPath((Join-Path $root 'deploy/environments.local'))
    $nextLines = @(
        "1. Open $target and check providerName, supportUrl and the rules.",
        "   Keep addinId as it is: it identifies this add-in for good (never change it",
        "   after users installed it, never copy it into another environment).",
        '2. Simulate the deployment (writes nothing):',
        "   .\tools\Deploy-NoFridayMail.ps1 -Environment $Name -WhatIf",
        '3. Deploy:',
        "   .\tools\Deploy-NoFridayMail.ps1 -Environment $Name",
        '4. Redeploy with the same command for every update: the same Id means Outlook',
        '   updates the add-in your users already have.'
    )
    if ([System.IO.Path]::GetFullPath($targetDir).TrimEnd('\', '/') -ne $standardDir.TrimEnd('\', '/')) {
        $nextLines += @('', "Note: the deployment looks in deploy\environments.local\ first; copy the file there to use it.")
    }
    Write-NfmBox -Title 'Next steps' -Status Info -Lines $nextLines
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
# MIImKwYJKoZIhvcNAQcCoIImHDCCJhgCAQExDzANBglghkgBZQMEAgEFADB5Bgor
# BgEEAYI3AgEEoGswaTA0BgorBgEEAYI3AgEeMCYCAwEAAAQQH8w7YFlLCE63JNLG
# KX7zUQIBAAIBAAIBAAIBAAIBADAxMA0GCWCGSAFlAwQCAQUABCCWGy2o+jabYoD8
# wpQuN7rU9wSxlGrdaYm0sAZgHflKs6CCDW8wggZyMIIEWqADAgECAghkM1HTxzif
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
# wZislcdCZuS6MYIYEjCCGA4CAQEwgYwweDELMAkGA1UEBhMCVVMxDjAMBgNVBAgM
# BVRleGFzMRAwDgYDVQQHDAdIb3VzdG9uMREwDwYDVQQKDAhTU0wgQ29ycDE0MDIG
# A1UEAwwrU1NMLmNvbSBDb2RlIFNpZ25pbmcgSW50ZXJtZWRpYXRlIENBIFJTQSBS
# MQIQBof4ljXihJpmCqqt2mhAWzANBglghkgBZQMEAgEFAKCBhDAYBgorBgEEAYI3
# AgEMMQowCKACgAChAoAAMBkGCSqGSIb3DQEJAzEMBgorBgEEAYI3AgEEMBwGCisG
# AQQBgjcCAQsxDjAMBgorBgEEAYI3AgEVMC8GCSqGSIb3DQEJBDEiBCAE3Tgr+rfc
# vtl5s1VlkYKDnDDFIxMzWzb4bNs6M4FhrDANBgkqhkiG9w0BAQEFAASCAgAdVkXp
# IZrTaRaeM7akMpFtXPGreMjxjCmovIeb2l7lx2vpAucIB7meSKLHsWjp137LXV3X
# dqi8ovRQ1ToOnSRe1jb8DdLou0E0ZoIkrmboJSjsO9xP1iNLggUzwaCfzVpZRcP+
# K3raCnSN4VFcLGcEgcazR0InoN+2rPAtvU4XTo/4KZTTiU3jVnYpA94hz+bAJ/Wr
# 2LihONLI8ANAfNRbw5At/qauV0zAWoOffoe2VZOXrdIShf93DFnW+yyTlDwTW37e
# L+dm9Makjp2EWRuxa6jwsmK/k1PhewfZJcExLHYSXvYdRT9mvevFsZ9hkBwdopJ9
# 2W3QzcHb6go3Kj/AR/Nm3ask7Db92b8Qbyl/prTvHBzwkAvl9K1bjqvyylk99WXQ
# xRbbnrhpgeL2+bcgDHQV4o2yEgch6tzpJ0//vOKhnxJpatK+wK+kAVMb5zTNOQv9
# Otw00PJlyVNedrbQZ0putOOlaky2FG2XsUMHxu2yvO8k9xrQc0i+VJzq94TSIUkh
# S4rBk34CMGK8Kf4VM7K0Zc+OhRxaYtOqIaBilm1IWjSwBX+o/d4rW26I1TRNOiBp
# rn20kYX1SAO+mYte822flupD6XxDi1wqw/P8gk82aILuhXJ7hE3BTG5m4TmDhTmz
# rRHhazQX9QzO6aSR7AzteJOE495Ucwm4h+84eqGCFM8wghTLBgorBgEEAYI3AwMB
# MYIUuzCCFLcGCSqGSIb3DQEHAqCCFKgwghSkAgEDMQ0wCwYJYIZIAWUDBAIBMIGJ
# BgsqhkiG9w0BCRABBKB6BHgwdgIBAQYMKwYBBAGCqTABAwYBMDEwDQYJYIZIAWUD
# BAIBBQAEIE8ETFxV0V4xrHiQjjpMHOcMDGPY6JfaQhoCh2V2c1gDAgghI8snCkC4
# rxgPMjAyNjEwMzAxOTQ3MzRaMAMCAQECEFOS3r7OGEKzhwpwpNYYkXCgghGnMIIE
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
# wzSPOzGCAlcwggJTAgEBMIGGMHIxCzAJBgNVBAYTAlVTMQ4wDAYDVQQIDAVUZXhh
# czEQMA4GA1UEBwwHSG91c3RvbjERMA8GA1UECgwIU1NMIENvcnAxLjAsBgNVBAMM
# JVNTTC5jb20gVGltZXN0YW1waW5nIElzc3VpbmcgUlNBIENBIDICEFRD+De9Wu4Y
# AYRyuFzajuMwCwYJYIZIAWUDBAIBoIIBYDAaBgkqhkiG9w0BCQMxDQYLKoZIhvcN
# AQkQAQQwHAYJKoZIhvcNAQkFMQ8XDTI2MTAzMDE5NDczNFowKAYJKoZIhvcNAQk0
# MRswGTALBglghkgBZQMEAgGhCgYIKoZIzj0EAwIwLwYJKoZIhvcNAQkEMSIEIBM9
# gzI3YeJ4rgrHhBsJiR0Y5wTBYPBeMQ0e8PayFGWcMIHIBgsqhkiG9w0BCRACLzGB
# uDCBtTCBsjCBrwQgV0/qF6r6XnxqK5sIyZixc15FCzhzykTmokygkw5j87AwgYow
# dqR0MHIxCzAJBgNVBAYTAlVTMQ4wDAYDVQQIDAVUZXhhczEQMA4GA1UEBwwHSG91
# c3RvbjERMA8GA1UECgwIU1NMIENvcnAxLjAsBgNVBAMMJVNTTC5jb20gVGltZXN0
# YW1waW5nIElzc3VpbmcgUlNBIENBIDICEFRD+De9Wu4YAYRyuFzajuMwCgYIKoZI
# zj0EAwIESDBGAiEAv6H+5ZOnSbkmAP0nk7C6E+XUJ56mqyZhGtkkeaR0C7MCIQCR
# 268PS680Dd8MyRBI3ZISbKAW3oRgt2L9YXExgkDkJw==
# SIG # End signature block
