#Requires -Version 7.4
# Pester tests of tools/Deploy-NoFridayMail.ps1 and tools/lib/Deploy-Checks.ps1 (they duplicate part of
# tests/deploy-script.test.js on the Node side). Run: Invoke-Pester tests/Deploy.Tests.ps1 -Output Detailed

BeforeAll {
    $script:Root = Split-Path -Parent $PSScriptRoot
    $script:Script = Join-Path $script:Root 'tools/Deploy-NoFridayMail.ps1'
    $script:Lib = Join-Path $script:Root 'tools/lib/Deploy-Checks.ps1'

    # The tests never read the operator's environment files (deploy/environments.local): NFM_ENVIRONMENTS_DIR points to
    # tests/fixtures/environments (base, bypass-v1, lab-frozen, mfa-filled, mfa-placeholder). Only example (the
    # template) is read from deploy/environments: see With-RealEnvironments.
    $script:Fixtures = Join-Path $script:Root 'tests/fixtures/environments'
    $script:PreviousEnvDir = $env:NFM_ENVIRONMENTS_DIR
    $env:NFM_ENVIRONMENTS_DIR = $script:Fixtures
    function script:With-RealEnvironments([scriptblock]$Block) {
        $saved = $env:NFM_ENVIRONMENTS_DIR
        $env:NFM_ENVIRONMENTS_DIR = (Join-Path $script:Root 'deploy/environments')
        try { & $Block } finally { $env:NFM_ENVIRONMENTS_DIR = $saved }
    }

    # A fixture with Application Insights, to exercise the Azure CLI extension check (mfa-filled + azure.appInsights).
    $script:InsightsDir = Join-Path $TestDrive 'insights'
    [void][IO.Directory]::CreateDirectory($script:InsightsDir)
    $fixture = Get-Content (Join-Path $script:Fixtures 'mfa-filled.json') -Raw | ConvertFrom-Json
    $fixture.azure | Add-Member -NotePropertyName appInsights -NotePropertyValue 'appi-nfm-fixture'
    ($fixture | ConvertTo-Json -Depth 10) | Out-File (Join-Path $script:InsightsDir 'mfa-filled.json') -Encoding utf8

    # "az" is a global function: no real Azure command is run.
    $global:AzCalls = [System.Collections.Generic.List[string]]::new()
    $global:AzSettingNames = ''
    $global:AzExtensionInstalled = $true
    function global:az {
        $line = ($args | ForEach-Object { [string]$_ }) -join ' '
        $global:AzCalls.Add($line)
        $global:LASTEXITCODE = 0
        switch -Wildcard ($line) {
            'account show --output json' { return '{"name":"Test","id":"11111111-2222-4333-8444-555555555555","tenantId":"99999999-2222-4333-8444-555555555555"}' }
            'account show --subscription*' { return 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }
            'staticwebapp show*' { return 'swa-test.azurestaticapps.net' }
            'staticwebapp appsettings list*' { return $global:AzSettingNames }
            'extension show*' {
                if ($global:AzExtensionInstalled) { return '1.0.0' }
                $global:LASTEXITCODE = 1
                return $null
            }
            'monitor app-insights*' { return '' }
            default { return '' }
        }
    }

    # Runs the script in this process: returns its text output and its exit code. A failure prints "ERROR: ..." and exits 1.
    function script:Invoke-Deploy([string[]]$Arguments) {
        $global:AzCalls.Clear()
        # "-Name value" and "-Switch" pairs become a splatted hashtable (an array would bind positionally).
        $parameters = @{}
        for ($i = 0; $i -lt $Arguments.Count; $i++) {
            $name = $Arguments[$i].TrimStart('-')
            if ($i + 1 -lt $Arguments.Count -and -not $Arguments[$i + 1].StartsWith('-')) { $parameters[$name] = $Arguments[$i + 1]; $i++ }
            else { $parameters[$name] = [switch]::new($true) }
        }
        $text = & $script:Script @parameters *>&1 | Out-String
        [pscustomobject]@{ ExitCode = $LASTEXITCODE; Text = $text }
    }
}

AfterAll {
    $env:NFM_ENVIRONMENTS_DIR = $script:PreviousEnvDir
    Remove-Item function:global:az -ErrorAction SilentlyContinue
    Remove-Variable AzCalls, AzSettingNames, AzExtensionInstalled -Scope Global -ErrorAction SilentlyContinue
}

Describe 'Deploy-NoFridayMail.ps1' {
    It 'exposes the expected parameters' {
        $command = Get-Command $script:Script
        $command.Parameters.Keys | Should -Contain 'Environment'
        $command.Parameters.Keys | Should -Contain 'SkipInfra'
        $command.Parameters.Keys | Should -Contain 'SkipTests'
        $command.Parameters.Keys | Should -Contain 'ConfirmLab'
        $command.Parameters.Keys | Should -Contain 'WhatIf'
        $command.Parameters['Environment'].Attributes.Mandatory | Should -Contain $true
    }

    It 'has house-style help: synopsis, six stages, at least five examples' {
        $help = Get-Help $script:Script -Full
        $help.Synopsis | Should -Match '^NoFridayMail - '
        $text = $help | Out-String
        foreach ($stage in '1. CHECK', '2. INFRA', '3. BUILD', '4. API PACKAGE', '5. DEPLOY', '6. VERIFY', 'PUBLISH \(manual\)') {
            $text | Should -Match $stage
        }
        @($help.examples.example).Count | Should -BeGreaterOrEqual 5
        foreach ($name in 'Environment', 'SkipInfra', 'SkipTests', 'ConfirmLab') {
            @($help.parameters.parameter | Where-Object name -eq $name).description | Should -Not -BeNullOrEmpty
        }
    }

    It 'refuses a protected environment (lab-frozen) without -ConfirmLab, even with -WhatIf' {
        $run = Invoke-Deploy @('-Environment', 'lab-frozen', '-WhatIf')
        $run.ExitCode | Should -Be 1
        $run.Text | Should -Match 'ERROR: .*-ConfirmLab'
    }

    It 'refuses the example template' {
        With-RealEnvironments {
            $run = Invoke-Deploy @('-Environment', 'example', '-WhatIf')
            $run.ExitCode | Should -Be 1
            $run.Text | Should -Match 'is a template'
        }
    }

    It 'refuses an invalid environment name' {
        { & $script:Script -Environment 'Pas Valide' -WhatIf } | Should -Throw
    }

    It 'refuses an unknown environment and lists the ones of the folder' {
        $run = Invoke-Deploy @('-Environment', 'staging', '-WhatIf')
        $run.ExitCode | Should -Be 1
        $run.Text | Should -Match 'not found'
        $run.Text | Should -Match 'base, bypass-v1, lab-frozen, mfa-filled, mfa-placeholder'
    }

    It 'writes nothing with -WhatIf (dist/base and out/ base unchanged)' {
        $watched = {
            @(
                Get-ChildItem (Join-Path $script:Root 'dist/base') -Recurse -File -ErrorAction SilentlyContinue
                Get-ChildItem (Join-Path $script:Root 'out') -Filter 'NoFridayMail-base-*' -ErrorAction SilentlyContinue
                Get-Item (Join-Path $script:Root 'package-lock.json')
            ) | ForEach-Object { "$($_.FullName)|$($_.LastWriteTimeUtc.Ticks)|$($_.Length)" }
        }
        $before = (& $watched) -join "`n"
        $run = Invoke-Deploy @('-Environment', 'base', '-WhatIf', '-SkipInfra')
        $run.ExitCode | Should -Be 0
        ((& $watched) -join "`n") | Should -Be $before
    }

    It 'leaves no token variable in the process environment' {
        Invoke-Deploy @('-Environment', 'base', '-WhatIf', '-SkipInfra') | Out-Null
        $env:SWA_CLI_DEPLOYMENT_TOKEN | Should -BeNullOrEmpty
    }

    It 'shows the six numbered steps, the summary and the two ways to publish the manifest' {
        $run = Invoke-Deploy @('-Environment', 'base', '-WhatIf', '-SkipInfra')
        foreach ($step in '1/6', '2/6', '3/6', '4/6', '5/6', '6/6') { $run.Text | Should -Match ([regex]::Escape($step)) }
        $run.Text | Should -Match 'Simulation finished'
        $run.Text | Should -Match 'https://aka.ms/olksideload'
        $run.Text | Should -Match 'Integrated apps'
        $run.Text | Should -Match 'docs/NoFridayMail-UserGuide.md'
    }
}

Describe 'Deploy-NoFridayMail.ps1: MFA step (API, NFM_RECEIPT_KEY), az mocked' {
    It 'mfa-filled -WhatIf: reads the NAMES of the settings, creates nothing, shows no secret' {
        $global:AzSettingNames = ''
        $run = Invoke-Deploy @('-Environment', 'mfa-filled', '-WhatIf', '-SkipInfra')
        $global:AzCalls | Should -Contain 'staticwebapp appsettings list --name swa-nfm-fixture-mfa-filled --resource-group rg-nfm-fixtures --subscription aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --query keys(properties) --output tsv'
        ($global:AzCalls | Where-Object { $_ -like '*appsettings set*' }) | Should -BeNullOrEmpty
        ($global:AzCalls | Where-Object { $_ -like '*NFM_RECEIPT_KEY=*' }) | Should -BeNullOrEmpty
        $run.Text | Should -Match '\[simulation\] NFM_RECEIPT_KEY would be created'
        $run.Text | Should -Not -Match '[A-Za-z0-9+/]{43}='
        $run.Text | Should -Not -Match 'placeholder value'
        # SWA CLI: self-contained API package (no Oryx build) and the site configuration generated for the environment
        $run.Text | Should -BeLike '*Command: npx --yes @azure/static-web-apps-cli@2.1.0 deploy ./dist/mfa-filled --env production --swa-config-location ./dist/mfa-filled --api-location ./out/api-pkg/mfa-filled --api-language node --api-version 22*'
        (Test-Path (Join-Path $script:Root 'out/api-pkg/mfa-filled/node_modules')) | Should -BeFalse
    }

    It 'mfa-placeholder -WhatIf: warns about placeholder values without stopping the simulation' {
        $global:AzSettingNames = ''
        $run = Invoke-Deploy @('-Environment', 'mfa-placeholder', '-WhatIf', '-SkipInfra')
        $run.ExitCode | Should -Be 0
        $run.Text | Should -Match 'placeholder value'
        $run.Text | Should -Match 'NFM_RECEIPT_KEY'
    }

    It 'mfa-filled -WhatIf: keeps NFM_RECEIPT_KEY when it already exists' {
        $global:AzSettingNames = "NFM_RECEIPT_KEY`nOTHER"
        $run = Invoke-Deploy @('-Environment', 'mfa-filled', '-WhatIf', '-SkipInfra')
        $run.Text | Should -Match 'NFM_RECEIPT_KEY: already present, kept'
        ($global:AzCalls | Where-Object { $_ -like '*appsettings set*' }) | Should -BeNullOrEmpty
    }

    It 'base (no MFA): no access to the app settings, no API, no extension check' {
        $global:AzSettingNames = ''
        $run = Invoke-Deploy @('-Environment', 'base', '-WhatIf', '-SkipInfra')
        ($global:AzCalls | Where-Object { $_ -like '*appsettings*' -or $_ -like 'extension*' }) | Should -BeNullOrEmpty
        $run.Text | Should -Not -Match 'NFM_RECEIPT_KEY'
        $run.Text | Should -BeLike '*Command: npx --yes @azure/static-web-apps-cli@2.1.0 deploy ./dist/base --env production --swa-config-location ./dist/base*'
        $run.Text | Should -Not -BeLike '*--api-location*'
        $run.Text | Should -Match 'Not needed: this environment has no API'
    }

    It 'mfa-placeholder, real run: refused before any az command while mfa holds placeholder values' {
        $run = Invoke-Deploy @('-Environment', 'mfa-placeholder', '-SkipInfra', '-SkipTests')
        $run.ExitCode | Should -Be 1
        $run.Text | Should -Match '(?s)ERROR: .*placeholder value'
        ($global:AzCalls | Where-Object { $_ -like 'staticwebapp*' -or $_ -like 'group*' -or $_ -like 'monitor*' }) | Should -BeNullOrEmpty
        $run.Text | Should -Not -Match '2/6'
    }
}

Describe 'Azure CLI extension application-insights (az mocked)' {
    BeforeAll {
        $script:SavedDir = $env:NFM_ENVIRONMENTS_DIR
        $env:NFM_ENVIRONMENTS_DIR = $script:InsightsDir
    }
    AfterAll { $env:NFM_ENVIRONMENTS_DIR = $script:SavedDir }

    It 'missing extension, -WhatIf: announced in plain words, never installed' {
        $global:AzExtensionInstalled = $false
        $global:AzSettingNames = ''
        $run = Invoke-Deploy @('-Environment', 'mfa-filled', '-WhatIf', '-SkipInfra')
        $run.ExitCode | Should -Be 0
        $global:AzCalls | Should -Contain 'extension show --name application-insights --query version --output tsv'
        ($global:AzCalls | Where-Object { $_ -like 'extension add*' }) | Should -BeNullOrEmpty
        $run.Text | Should -Match 'application-insights'
        $run.Text | Should -Match 'would be installed automatically'
    }

    It 'installed extension: confirmed, nothing to install' {
        $global:AzExtensionInstalled = $true
        $run = Invoke-Deploy @('-Environment', 'mfa-filled', '-WhatIf', '-SkipInfra')
        $run.Text | Should -Match 'extension "application-insights" installed'
        ($global:AzCalls | Where-Object { $_ -like 'extension add*' }) | Should -BeNullOrEmpty
    }
}

Describe 'Deploy-Checks.ps1 helpers' {
    BeforeAll { . $script:Lib }

    It 'Get-NodeMajor reads the major version' {
        Get-NodeMajor 'v22.11.0' | Should -Be 22
        Get-NodeMajor '20.1.0' | Should -Be 20
        Get-NodeMajor 'v26.13.0' | Should -Be 26
        Get-NodeMajor 'garbage' | Should -Be 0
        Get-NodeMajor '' | Should -Be 0
    }

    It 'Install-AzExtension runs the silent command and fails with a clear message' {
        $global:AzCalls.Clear()
        Install-AzExtension
        $global:AzCalls | Should -Contain 'extension add --name application-insights --only-show-errors'
    }

    It 'New-NfmCheck / Write-NfmCheck print the status and "What to do"' {
        $env:NO_COLOR = '1'
        try {
            Initialize-NfmConsole -Version '9.9.9'
            $out = (New-NfmCheck FAIL 'Thing: missing' 'install the thing') | Write-NfmCheck 6>&1 | Out-String
        }
        finally { Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue }
        $out | Should -Match 'Thing: missing'
        $out | Should -Match 'What to do: install the thing'
    }
}

Describe 'Console theme: ASCII fallback, NO_COLOR, forced style' {
    BeforeAll {
        . $script:Lib
        function script:Get-ThemeOutput([hashtable]$Environment) {
            $saved = @{}
            foreach ($key in 'NO_COLOR', 'NFM_FORCE_COLOR', 'NFM_ICONS', 'TERM') { $saved[$key] = [Environment]::GetEnvironmentVariable($key) }
            try {
                foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $null) }
                foreach ($key in $Environment.Keys) { [Environment]::SetEnvironmentVariable($key, $Environment[$key]) }
                Initialize-NfmConsole -Version '9.9.9'
                $PSStyle.OutputRendering = 'Ansi'
                $text = & {
                    Write-NfmBanner -Title 'Title' -Subtitle 'Sub' -Details ([ordered]@{ Key = @('Folder', 'value') })
                    Write-NfmStep 1 6 'Prerequisites' -Icon Check
                    Write-NfmItem Ok 'fine'
                    Write-NfmItem Warn 'careful'
                    Write-NfmSummary -Title 'Done' -Values ([ordered]@{ Result = @('Ok', 'all good') })
                } 6>&1 | Out-String
                [pscustomobject]@{ Text = $text; Style = $script:NfmIconStyle }
            }
            finally { foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key]) } }
        }
    }

    It 'redirected output (these tests) gives plain ASCII, no colour, and a + - | frame' {
        $r = Get-ThemeOutput @{}
        $r.Style | Should -Be 'Ascii'
        $r.Text | Should -Not -Match '[^\x00-\x7F]'
        $r.Text | Should -Not -Match '\x1b\['
        $r.Text | Should -Match '\+-{20,}\+'
        $r.Text | Should -Match '1/6'
    }

    It 'NO_COLOR removes the colours; NFM_FORCE_COLOR=1 brings them back' {
        (Get-ThemeOutput @{ NO_COLOR = '1' }).Text | Should -Not -Match '\x1b\['
        (Get-ThemeOutput @{ NFM_FORCE_COLOR = '1' }).Text | Should -Match '\x1b\['
        (Get-ThemeOutput @{ NFM_FORCE_COLOR = '1'; NO_COLOR = '1' }).Text | Should -Match '\x1b\['
        # an ASCII frame stays plain ASCII even with colours forced
        ((Get-ThemeOutput @{ NFM_FORCE_COLOR = '1'; NFM_ICONS = 'Ascii' }).Text -replace '\x1b\[[0-9;]*m', '') | Should -Not -Match '[^\x00-\x7F]'
    }

    It 'NFM_ICONS selects the style; TERM=dumb falls back to ASCII' {
        (Get-ThemeOutput @{ NFM_ICONS = 'Symbols' }).Style | Should -Be 'Symbols'
        (Get-ThemeOutput @{ NFM_ICONS = 'Emoji' }).Style | Should -Be 'Emoji'
        (Get-ThemeOutput @{ TERM = 'dumb' }).Style | Should -Be 'Ascii'
        (Get-ThemeOutput @{ NFM_ICONS = 'Symbols' }).Text | Should -Match ([char]0x256D)
    }

    It 'counts warnings for the summary status' {
        Initialize-NfmConsole -Version '1'
        Write-NfmItem Warn 'one' 6>&1 | Out-Null
        $script:NfmWarnings | Should -Be 1
    }
}

# SIG # Begin signature block
# MIImKQYJKoZIhvcNAQcCoIImGjCCJhYCAQExDzANBglghkgBZQMEAgEFADB5Bgor
# BgEEAYI3AgEEoGswaTA0BgorBgEEAYI3AgEeMCYCAwEAAAQQH8w7YFlLCE63JNLG
# KX7zUQIBAAIBAAIBAAIBAAIBADAxMA0GCWCGSAFlAwQCAQUABCAp/e88XGqCY+fb
# DmKrgYnN7YW7XJ1gmXhBom0Mq2ZQY6CCDW8wggZyMIIEWqADAgECAghkM1HTxzif
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
# wZislcdCZuS6MYIYEDCCGAwCAQEwgYwweDELMAkGA1UEBhMCVVMxDjAMBgNVBAgM
# BVRleGFzMRAwDgYDVQQHDAdIb3VzdG9uMREwDwYDVQQKDAhTU0wgQ29ycDE0MDIG
# A1UEAwwrU1NMLmNvbSBDb2RlIFNpZ25pbmcgSW50ZXJtZWRpYXRlIENBIFJTQSBS
# MQIQBof4ljXihJpmCqqt2mhAWzANBglghkgBZQMEAgEFAKCBhDAYBgorBgEEAYI3
# AgEMMQowCKACgAChAoAAMBkGCSqGSIb3DQEJAzEMBgorBgEEAYI3AgEEMBwGCisG
# AQQBgjcCAQsxDjAMBgorBgEEAYI3AgEVMC8GCSqGSIb3DQEJBDEiBCAeVTiaFQF1
# QjsXmG/rPfSXVP8RKh1d0weKfWOUn5Ac9DANBgkqhkiG9w0BAQEFAASCAgBwAqC7
# j7Een7SBuAdgyWdQLlUjFOeqBe/HHiYb1Q87e59cqP1FVZ1Ko6XmzLOxT48c5pf/
# ff9iCDz/Do8IgRL6MSuYvMgQ5T0VIFcWn9+uA0XB0V/u+9UHon1UsY4cxQ1DggP1
# Skj9mf+UXcgIf8e/L+xzietOM1lEfpYHOj8T0cEbheXXuI0L+0XTy5IRxmM57HTI
# 9DLpFTLOEC3ckBwnGjy3stUssOh9+IEgGw6CE83LBfU7gXm6E3TYXxwJPULj18pW
# uVlHwwI/t9iv4gCR8u+tWSalmGx/nSF2exqB1a5TG1My7HfOxaqdOsj2Dm0rxmQv
# ya4HXnAT0nWymED+VT0elZHqlJcxFJrusM2h2sbe3vJGvOgfmtmlGvGZNMhpDVIL
# VHCSYx1zcsWzKAo4BmlrcneQaQdqmAFFP7i/KVF/MQJW34Irv/v/e+CQOLIAm2BP
# xIQHogXove1U1Ec2C5VvGGKn6GxyMKmUf7AZIOUjOGOi9EGsek33ZsK04oAUi5OR
# J8Vm8yvMlsam5G8W4i7ZdzpI4Mx3vSSnmkfqdOwukFUCGc0ngcFZMXYn5d3ExBkk
# ORT3wsgCsg4t8BRCKC27rJ1my8FfcNkmkAdpC9FH/+MdiODzju1gfPpGGTSQpEvO
# LAzlBWthl/KRUC3RmXwsTpAmA4Jn4uSYN8wwIqGCFM0wghTJBgorBgEEAYI3AwMB
# MYIUuTCCFLUGCSqGSIb3DQEHAqCCFKYwghSiAgEDMQ0wCwYJYIZIAWUDBAIBMIGJ
# BgsqhkiG9w0BCRABBKB6BHgwdgIBAQYMKwYBBAGCqTABAwYBMDEwDQYJYIZIAWUD
# BAIBBQAEIOa7D0qFLKVk6vKILsGEUombKxbLsxQu6Ruc8od0ORu/Agh33vf8UWeT
# /BgPMjAyNjEwMzAyMDM2MjRaMAMCAQECEDOGwvskcO1zI2ndGxNu0I2gghGnMIIE
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
# wzSPOzGCAlUwggJRAgEBMIGGMHIxCzAJBgNVBAYTAlVTMQ4wDAYDVQQIDAVUZXhh
# czEQMA4GA1UEBwwHSG91c3RvbjERMA8GA1UECgwIU1NMIENvcnAxLjAsBgNVBAMM
# JVNTTC5jb20gVGltZXN0YW1waW5nIElzc3VpbmcgUlNBIENBIDICEFRD+De9Wu4Y
# AYRyuFzajuMwCwYJYIZIAWUDBAIBoIIBYDAaBgkqhkiG9w0BCQMxDQYLKoZIhvcN
# AQkQAQQwHAYJKoZIhvcNAQkFMQ8XDTI2MTAzMDIwMzYyNFowKAYJKoZIhvcNAQk0
# MRswGTALBglghkgBZQMEAgGhCgYIKoZIzj0EAwIwLwYJKoZIhvcNAQkEMSIEIAhv
# KOKvT9x3XQA+klO/0dmbp53z5DIo6eXg1YiUNC56MIHIBgsqhkiG9w0BCRACLzGB
# uDCBtTCBsjCBrwQgV0/qF6r6XnxqK5sIyZixc15FCzhzykTmokygkw5j87AwgYow
# dqR0MHIxCzAJBgNVBAYTAlVTMQ4wDAYDVQQIDAVUZXhhczEQMA4GA1UEBwwHSG91
# c3RvbjERMA8GA1UECgwIU1NMIENvcnAxLjAsBgNVBAMMJVNTTC5jb20gVGltZXN0
# YW1waW5nIElzc3VpbmcgUlNBIENBIDICEFRD+De9Wu4YAYRyuFzajuMwCgYIKoZI
# zj0EAwIERjBEAiAqKiX1+NX4vu+2rQdiW4slX66U/Bin5uZcG7VocFsXdAIgdLkM
# CcLL2CemHBMHOXTeOlUog+INGy/9/JT2RO5wK90=
# SIG # End signature block
