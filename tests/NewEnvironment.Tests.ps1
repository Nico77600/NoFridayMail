#Requires -Version 7.4
# Pester tests of tools/New-NoFridayMailEnvironment.ps1 and of the add-in Id rules of tools/Deploy-NoFridayMail.ps1
# (they duplicate part of tests/new-environment.test.js on the Node side).
# Run: Invoke-Pester tests/NewEnvironment.Tests.ps1 -Output Detailed

BeforeAll {
    $script:Root = Split-Path -Parent $PSScriptRoot
    $script:New = Join-Path $script:Root 'tools/New-NoFridayMailEnvironment.ps1'
    $script:Deploy = Join-Path $script:Root 'tools/Deploy-NoFridayMail.ps1'
    $script:Fixtures = Join-Path $script:Root 'tests/fixtures/environments'
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

# SIG # Begin signature block
# MIImKgYJKoZIhvcNAQcCoIImGzCCJhcCAQExDzANBglghkgBZQMEAgEFADB5Bgor
# BgEEAYI3AgEEoGswaTA0BgorBgEEAYI3AgEeMCYCAwEAAAQQH8w7YFlLCE63JNLG
# KX7zUQIBAAIBAAIBAAIBAAIBADAxMA0GCWCGSAFlAwQCAQUABCB5kjXfMJVV1cSm
# +xwwuFFI1GG4yaKQFnqRGDrF00nPaKCCDW8wggZyMIIEWqADAgECAghkM1HTxzif
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
# AQQBgjcCAQsxDjAMBgorBgEEAYI3AgEVMC8GCSqGSIb3DQEJBDEiBCBQNfnIPQGy
# ThVdUAKLXDBmHtMQo3JduVC5IpyxoP64rzANBgkqhkiG9w0BAQEFAASCAgAOMxlw
# tZqjSDiy1IrZ6JUE2h6BNFkNKZJ7RaoCbyXqiwgRERz7MjZ8TTRitZFIldKa0sba
# Jt/gBIoprboddXcA6LoC9thn+I0DxmmEEF845enWerqQRAF43TrGuNfvbtLkcLr4
# YYboPESsgW6LdJZhwTe2ls5BdEwYBKFvuTYoO9e7xwZyNlUFANd1dpZX24DJH14P
# I8H0hVDtLxoZX1VsihhkCHDdUOuk0ohFmh5ATwTUcFUS9t9/xIZLzp2P4aziBMZJ
# sp9HhvwfZT4w6YPVUyBlCpJfWFWJDorBGptGaD3QRuF6BOEYuhPJtvZatHN/xD8H
# 2LDe4DG3tMG8jdHaz6U/dSU+4rgIaRk8RKZq5Gvu7X8RE5jcx9pwQ4KCra6sld0f
# JPP9pmMjpUg8ChkXwYAm3bjbanqXLKhAQ3b2ucDWk9rLAnhp3nEzff2bYzdtlu/H
# 64pwE+Et68PzBuIL+VWMicE2ytRIJ2+Ni8lwXLoD+1y3ihDEpbsJIuKaZEoO3CyM
# KEReBK9KuE9IOif2/9ANUcrskELkK6RqB6ZRc7SPSRCM+83VUfdjQbWlCZlkE1MS
# ga7b27wXx4n+fq0s1oesIYRezChGsFTjZ/7CSY8/TaziZ5vVchlLkTes5v/D6q53
# lPABFGeqQTXeK+4Fjb/w7ZJTdRuNY4BjZdP07qGCFM4wghTKBgorBgEEAYI3AwMB
# MYIUujCCFLYGCSqGSIb3DQEHAqCCFKcwghSjAgEDMQ0wCwYJYIZIAWUDBAIBMIGJ
# BgsqhkiG9w0BCRABBKB6BHgwdgIBAQYMKwYBBAGCqTABAwYBMDEwDQYJYIZIAWUD
# BAIBBQAEIIqsRdsadGX+3/UXqSQPMgIWw8j5NX8cIJcDWW+1VBV9AghRtDw8znAq
# +BgPMjAyNjEwMzAyMDM2MzBaMAMCAQECEF1RT9+E12P25mrcGCj4IO2gghGnMIIE
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
# AQkQAQQwHAYJKoZIhvcNAQkFMQ8XDTI2MTAzMDIwMzYzMFowKAYJKoZIhvcNAQk0
# MRswGTALBglghkgBZQMEAgGhCgYIKoZIzj0EAwIwLwYJKoZIhvcNAQkEMSIEIHxP
# vtdx7sKYInxubRJBpo62iqE043k7gtTF1x/RHiEbMIHIBgsqhkiG9w0BCRACLzGB
# uDCBtTCBsjCBrwQgV0/qF6r6XnxqK5sIyZixc15FCzhzykTmokygkw5j87AwgYow
# dqR0MHIxCzAJBgNVBAYTAlVTMQ4wDAYDVQQIDAVUZXhhczEQMA4GA1UEBwwHSG91
# c3RvbjERMA8GA1UECgwIU1NMIENvcnAxLjAsBgNVBAMMJVNTTC5jb20gVGltZXN0
# YW1waW5nIElzc3VpbmcgUlNBIENBIDICEFRD+De9Wu4YAYRyuFzajuMwCgYIKoZI
# zj0EAwIERzBFAiAXx/uHWVAWdjUyLXZKDmIgjYFrGSuSMdne0hMmk77JWwIhAPQX
# dZjV6B4EQXw9ipu3oK698hqutfMIBZM9YD2GJGwD
# SIG # End signature block
