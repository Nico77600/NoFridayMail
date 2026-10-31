#Requires -Version 7.4
# Pester tests of tools/Deploy-NoFridayMail.ps1 and tools/lib/Deploy-Checks.ps1 (they duplicate part of
# tests/deploy-script.test.js on the Node side). Run: Invoke-Pester tests/Deploy.Tests.ps1 -Output Detailed

BeforeAll {
    $script:Repo = Split-Path -Parent $PSScriptRoot
    $script:Root = Join-Path $script:Repo 'package'
    $script:Script = Join-Path $script:Root 'tools/Deploy-NoFridayMail.ps1'
    $script:Lib = Join-Path $script:Root 'tools/lib/Deploy-Checks.ps1'

    # The tests never read the operator's environment files (deploy/environments.local): NFM_ENVIRONMENTS_DIR points to
    # tests/fixtures/environments (base, bypass-v1, lab-frozen, mfa-filled, mfa-placeholder). Only example (the
    # template) is read from deploy/environments: see With-RealEnvironments.
    $script:Fixtures = Join-Path $script:Repo 'tests/fixtures/environments'
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
