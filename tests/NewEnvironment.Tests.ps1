#Requires -Version 7.4
# Pester tests of tools/New-NoFridayMailEnvironment.ps1 and of the add-in Id rules of tools/Deploy-NoFridayMail.ps1
# (they duplicate part of tests/new-environment.test.js on the Node side).
# Run: Invoke-Pester tests/NewEnvironment.Tests.ps1 -Output Detailed

BeforeAll {
    $script:Repo = Split-Path -Parent $PSScriptRoot
    $script:Root = Join-Path $script:Repo 'package'
    $script:New = Join-Path $script:Root 'tools/New-NoFridayMailEnvironment.ps1'
    $script:Deploy = Join-Path $script:Root 'tools/Deploy-NoFridayMail.ps1'
    $script:Fixtures = Join-Path $script:Repo 'tests/fixtures/environments'
    $script:Placeholder = '11111111-2222-4333-8444-555555555555'

    # The tests never read the operator's environment files: the known environments are the fixtures, and the files
    # are written in $TestDrive.
    $script:PreviousEnvDir = $env:NFM_ENVIRONMENTS_DIR
    $env:NFM_ENVIRONMENTS_DIR = $script:Fixtures

    # Runs a script in this process: returns its text output and its exit code (a failure prints "ERROR: ..." and exits 1).
    function script:Invoke-Script([string]$Script, [hashtable]$Parameters) {
        $text = & $Script @Parameters *>&1 | Out-String
        [pscustomobject]@{ ExitCode = $LASTEXITCODE; Text = $text }
    }
    function script:Read-Environment([string]$Folder, [string]$Name) {
        Get-Content -LiteralPath (Join-Path $Folder "$Name.json") -Raw | ConvertFrom-Json
    }
    # "az" is a global function: no real Azure command is run.
    function global:az {
        $global:LASTEXITCODE = 0
        if (($args -join ' ') -eq 'account show --output json') { return '{"name":"Test","id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","tenantId":"99999999-2222-4333-8444-555555555555"}' }
        return ''
    }
}

AfterAll {
    $env:NFM_ENVIRONMENTS_DIR = $script:PreviousEnvDir
    Remove-Item function:global:az -ErrorAction SilentlyContinue
}

Describe 'New-NoFridayMailEnvironment.ps1' {
    BeforeEach {
        $script:Out = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
    }

    It 'exposes the expected parameters and house-style help' {
        $command = Get-Command $script:New
        foreach ($name in 'Name', 'DisplayName', 'ResourceGroup', 'StaticWebAppName', 'Location', 'SubscriptionId', 'BlockedDays', 'Path', 'AddinId', 'Force', 'WhatIf') {
            $command.Parameters.Keys | Should -Contain $name
        }
        $command.Parameters['Name'].Attributes.Mandatory | Should -Contain $true
        $help = Get-Help $script:New -Full
        $help.Synopsis | Should -Match '^NoFridayMail - '
        @($help.examples.example).Count | Should -BeGreaterOrEqual 4
        foreach ($name in 'Name', 'DisplayName', 'BlockedDays', 'Path', 'Force') {
            @($help.parameters.parameter | Where-Object name -eq $name).description | Should -Not -BeNullOrEmpty
        }
    }

    It 'generates a valid add-in Id that is not a template value and not used by a known environment' {
        $run = Invoke-Script $script:New @{ Name = 'gen'; Path = $script:Out }
        $run.ExitCode | Should -Be 0
        $config = Read-Environment $script:Out 'gen'
        $config.addinId | Should -Match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        [guid]::Empty.ToString() | Should -Not -Be $config.addinId
        $config.addinId | Should -Not -Be $script:Placeholder
        $used = Get-ChildItem $script:Fixtures -Filter *.json | ForEach-Object { (Get-Content $_.FullName -Raw | ConvertFrom-Json).addinId }
        $used | Should -Not -Contain $config.addinId
        $config.name | Should -Be 'gen'
        $config.version | Should -Be '1.0.0.0'
        $config.azure.resourceGroup | Should -Be 'rg-nofridaymail-gen'
        $config.azure.staticWebAppName | Should -Be 'swa-nofridaymail-gen'
        $config.azure.location | Should -Be 'westeurope'
        $config.azure.PSObject.Properties.Name | Should -Not -Contain 'subscriptionId'
        @($config.rules.blockedDays) | Should -Be @(5)
        $run.Text | Should -Match 'Next steps'
        $run.Text | Should -Match 'Deploy-NoFridayMail\.ps1 -Environment gen -WhatIf'
    }

    It 'generates a different Id for each environment' {
        $a = Join-Path $script:Out 'a'
        $b = Join-Path $script:Out 'b'
        (Invoke-Script $script:New @{ Name = 'one'; Path = $a }).ExitCode | Should -Be 0
        (Invoke-Script $script:New @{ Name = 'two'; Path = $b }).ExitCode | Should -Be 0
        (Read-Environment $a 'one').addinId | Should -Not -Be (Read-Environment $b 'two').addinId
    }

    It 'applies the parameters (display name, Azure names, subscription, blocked days)' {
        $subscription = [guid]::NewGuid().ToString()
        $run = Invoke-Script $script:New @{
            Name = 'full'; Path = $script:Out; DisplayName = 'NoFridayMail (Full)'; ResourceGroup = 'rg-full'; StaticWebAppName = 'swa-full-app'
            Location = 'northeurope'; SubscriptionId = $subscription; BlockedDays = @(2, 1)
        }
        $run.ExitCode | Should -Be 0
        $config = Read-Environment $script:Out 'full'
        $config.displayName | Should -Be 'NoFridayMail (Full)'
        $config.azure.resourceGroup | Should -Be 'rg-full'
        $config.azure.staticWebAppName | Should -Be 'swa-full-app'
        $config.azure.location | Should -Be 'northeurope'
        $config.azure.subscriptionId | Should -Be $subscription
        @($config.rules.blockedDays) | Should -Be @(1, 2)
    }

    It 'is stable: running again without -Force refuses and leaves the file, and its Id, unchanged' {
        (Invoke-Script $script:New @{ Name = 'stable'; Path = $script:Out }).ExitCode | Should -Be 0
        $file = Join-Path $script:Out 'stable.json'
        $before = Get-Content $file -Raw
        $run = Invoke-Script $script:New @{ Name = 'stable'; Path = $script:Out }
        $run.ExitCode | Should -Be 1
        $run.Text | Should -Match 'ERROR: .*already exists'
        Get-Content $file -Raw | Should -Be $before
    }

    It 'keeps the add-in Id of an existing file when -Force rewrites it' {
        (Invoke-Script $script:New @{ Name = 'forced'; Path = $script:Out }).ExitCode | Should -Be 0
        $id = (Read-Environment $script:Out 'forced').addinId
        $run = Invoke-Script $script:New @{ Name = 'forced'; Path = $script:Out; Force = $true; DisplayName = 'NoFridayMail (Renamed)' }
        $run.ExitCode | Should -Be 0
        $run.Text | Should -Match 'KEPT'
        $config = Read-Environment $script:Out 'forced'
        $config.addinId | Should -Be $id
        $config.displayName | Should -Be 'NoFridayMail (Renamed)'
    }

    It 'writes nothing with -WhatIf (no file, no folder) and does not show an Id' {
        $run = Invoke-Script $script:New @{ Name = 'dry'; Path = $script:Out; WhatIf = $true }
        $run.ExitCode | Should -Be 0
        Test-Path $script:Out | Should -BeFalse
        $run.Text | Should -Match 'simulation'
        $run.Text | Should -Match 'nothing was written'
    }

    It 'refuses a name already used by a known environment, in any folder' {
        $run = Invoke-Script $script:New @{ Name = 'base'; Path = $script:Out }
        $run.ExitCode | Should -Be 1
        $run.Text | Should -Match "ERROR: An environment named 'base' already exists"
        Test-Path $script:Out | Should -BeFalse
    }

    It 'refuses the name example' {
        $run = Invoke-Script $script:New @{ Name = 'example'; Path = $script:Out }
        $run.ExitCode | Should -Be 1
        $run.Text | Should -Match 'ERROR: .*template'
    }

    It 'refuses an invalid name' {
        { & $script:New -Name 'Not Valid' -Path $script:Out } | Should -Throw
        { & $script:New -Name 'ok' -Path $script:Out -BlockedDays 9 } | Should -Throw
    }

    It 'refuses an -AddinId used by a known environment or equal to a template value' {
        $used = (Read-Environment $script:Fixtures 'base').addinId
        $run = Invoke-Script $script:New @{ Name = 'dup'; Path = $script:Out; AddinId = $used }
        $run.ExitCode | Should -Be 1
        $run.Text | Should -Match "ERROR: .*already used by the environment 'base'"
        $run = Invoke-Script $script:New @{ Name = 'dup'; Path = $script:Out; AddinId = $script:Placeholder }
        $run.ExitCode | Should -Be 1
        $run.Text | Should -Match 'ERROR: .*template value'
        Test-Path $script:Out | Should -BeFalse
    }

    It 'uses -AddinId when it is free' {
        $wanted = [guid]::NewGuid().ToString()
        (Invoke-Script $script:New @{ Name = 'adopt'; Path = $script:Out; AddinId = $wanted }).ExitCode | Should -Be 0
        (Read-Environment $script:Out 'adopt').addinId | Should -Be $wanted
    }

    It 'refuses content that would not validate and writes nothing' {
        $run = Invoke-Script $script:New @{ Name = 'bad'; Path = $script:Out; BlockedDays = @(1, 2, 3, 4, 5) }
        $run.ExitCode | Should -Be 1
        $run.Text | Should -Match 'ERROR: .*nothing was written'
        $run.Text | Should -Match 'working day'
        Test-Path (Join-Path $script:Out 'bad.json') | Should -BeFalse
    }
}

Describe 'Deploy-NoFridayMail.ps1: add-in Id rules' {
    BeforeAll {
        # A folder of environments built from the "base" fixture with a template Id and two environments that share an Id.
        $script:Bad = Join-Path $TestDrive 'bad-ids'
        [void][IO.Directory]::CreateDirectory($script:Bad)
        $base = Get-Content (Join-Path $script:Fixtures 'base.json') -Raw
        foreach ($case in @(
                @{ Name = 'tpl'; Id = $script:Placeholder }
                @{ Name = 'zero'; Id = '00000000-0000-0000-0000-000000000000' }
                @{ Name = 'twin-a'; Id = 'c0a1f001-0000-4000-8000-000000000003' }
                @{ Name = 'twin-b'; Id = 'c0a1f001-0000-4000-8000-000000000003' }
                @{ Name = 'solo'; Id = 'c0a1f001-0000-4000-8000-000000000004' })) {
            $json = $base -replace '"name": "base"', ('"name": "' + $case.Name + '"') -replace '"addinId": "[^"]+"', ('"addinId": "' + $case.Id + '"')
            $json | Set-Content -LiteralPath (Join-Path $script:Bad "$($case.Name).json") -Encoding utf8
        }
        $script:SavedDir = $env:NFM_ENVIRONMENTS_DIR
        $env:NFM_ENVIRONMENTS_DIR = $script:Bad
    }
    AfterAll { $env:NFM_ENVIRONMENTS_DIR = $script:SavedDir }

    It 'stops on the template add-in Id, even with -WhatIf, and explains the fix' {
        $run = Invoke-Script $script:Deploy @{ Environment = 'tpl'; WhatIf = $true }
        $run.ExitCode | Should -Be 1
        $text = $run.Text -replace '\s+', ' '
        $text | Should -Match 'ERROR: The add-in Id of environment ''tpl'' is a template value'
        $text | Should -Match 'New-NoFridayMailEnvironment\.ps1 -Name <name>'
        $text | Should -Match '\[guid\]::NewGuid\(\)'
        $text | Should -Match 'never generates the Id at deployment time'
        $text | Should -Not -Match '2/6'
    }

    It 'stops on the all-zero add-in Id' {
        $run = Invoke-Script $script:Deploy @{ Environment = 'zero'; WhatIf = $true }
        $run.ExitCode | Should -Be 1
        $run.Text | Should -Match 'template value'
    }

    It 'stops on an add-in Id shared with another environment and names both' {
        $run = Invoke-Script $script:Deploy @{ Environment = 'twin-a'; WhatIf = $true; SkipInfra = $true }
        $run.ExitCode | Should -Be 1
        $text = $run.Text -replace '[\s|]+', ' '
        $text | Should -Match 'already used by "twin-b"'
        $text | Should -Match 'Two environments must never share an add-in Id'
        $text | Should -Not -Match '2/6'
    }

    It 'does not generate or change an add-in Id: the environment file stays byte for byte the same' {
        $file = Join-Path $script:Bad 'tpl.json'
        $before = (Get-FileHash $file).Hash
        Invoke-Script $script:Deploy @{ Environment = 'tpl'; WhatIf = $true } | Out-Null
        (Get-FileHash $file).Hash | Should -Be $before
    }
}
