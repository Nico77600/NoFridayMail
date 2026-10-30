#Requires -Version 7.4
# Package builder and integrity verifier (tools\New-NoFridayMailPackage.ps1, tools\Test-PackageIntegrity.ps1).
#
# The package is built from `git archive` of a SNAPSHOT repository: the working-tree files (tracked and not ignored) are
# copied outside the real repository and committed there, so the tests do not depend on what is committed here and never
# touch the real history. CI runs everything unsigned (no secret, no signing certificate): the cases that need a real
# owner signature are tagged RealSignature and skip themselves when the files are not signed yet. The signing step
# itself belongs to the owner's procedure and cannot be exercised here: Stage and Seal are only tested for their refusals.
BeforeAll {
    $script:RepoRoot = Split-Path $PSScriptRoot -Parent
    $script:Pwsh = (Get-Process -Id $PID).Path
    $script:Sandbox = Join-Path ([IO.Path]::GetTempPath()) ('nfm-integrity-{0}' -f [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($script:Sandbox)

    function script:New-Snapshot {
        param([Parameter(Mandatory)][string]$Path)
        [void][IO.Directory]::CreateDirectory($Path)
        $files = @(& git -C $script:RepoRoot ls-files --cached --others --exclude-standard)
        foreach ($file in $files) {
            $source = Join-Path $script:RepoRoot $file
            if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
            $target = Join-Path $Path $file
            [void][IO.Directory]::CreateDirectory((Split-Path $target -Parent))
            Copy-Item -LiteralPath $source -Destination $target
        }
        & git -C $Path init -q -b main 2>&1 | Out-Null
        & git -C $Path config user.name 'Nicolas Fabert'
        & git -C $Path config user.email '195452170+Nico77600@users.noreply.github.com'
        & git -C $Path config core.autocrlf false
        & git -C $Path add -A 2>&1 | Out-Null
        & git -C $Path commit -q -m 'snapshot' 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Cannot commit the snapshot.' }
    }
    function script:Invoke-Child {
        param([Parameter(Mandatory)][string[]]$Arguments, [string]$WorkingDirectory, [hashtable]$Environment = @{})
        $saved = @{}
        foreach ($name in $Environment.Keys) { $saved[$name] = [Environment]::GetEnvironmentVariable($name); [Environment]::SetEnvironmentVariable($name, $Environment[$name]) }
        try {
            if ($WorkingDirectory) { Push-Location $WorkingDirectory }
            $output = & $script:Pwsh -NoProfile -NonInteractive @Arguments 2>&1 | ForEach-Object { "$_" }
            [pscustomobject]@{ ExitCode = $LASTEXITCODE; Text = ($output -join "`n") }
        }
        finally {
            if ($WorkingDirectory) { Pop-Location }
            foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
        }
    }
    function script:Invoke-Verifier {
        param([switch]$Strict)
        $verifier = Join-Path $script:Work 'tools\Test-PackageIntegrity.ps1'
        if ($Strict) { & $verifier -Root $script:Work } else { & $verifier -Root $script:Work -AllowUnsigned }
    }
    function script:Edit-Tamper([string]$Path) { [IO.File]::AppendAllText($Path, "`n# Evidence-only tamper") }
    function script:Get-ManifestText { [IO.File]::ReadAllText((Join-Path $script:Work 'PackageIntegrity.psd1')) }
    function script:Set-ManifestText([string]$Text) { [IO.File]::WriteAllText((Join-Path $script:Work 'PackageIntegrity.psd1'), $Text, [Text.UTF8Encoding]::new($true)) }

    # One snapshot and one unsigned build for the whole file; cases work on a throw-away copy of the staged package.
    $script:Snapshot = Join-Path $script:Sandbox 'repo'
    New-Snapshot -Path $script:Snapshot
    $script:Staged = Join-Path $script:Sandbox 'staged'
    $script:Zip = Join-Path $script:Sandbox 'NoFridayMail-unsigned.zip'
    $script:BuildOutput = Invoke-Child -Arguments @('-File', (Join-Path $script:Snapshot 'tools\New-NoFridayMailPackage.ps1'), '-Unsigned',
        '-Destination', $script:Staged, '-OutputDirectory', $script:Sandbox)
    $script:Work = Join-Path $script:Sandbox 'work'
    if ($script:BuildOutput.ExitCode -eq 0) { Copy-Item -LiteralPath $script:Staged -Destination $script:Work -Recurse }
    $script:Entries = if ($script:BuildOutput.ExitCode -eq 0) { @((Import-PowerShellDataFile (Join-Path $script:Work 'PackageIntegrity.psd1')).Files) } else { @() }
    $script:OriginalManifest = if ($script:BuildOutput.ExitCode -eq 0) { Get-ManifestText } else { '' }
}

AfterAll {
    Remove-Item -LiteralPath $script:Sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Unsigned package built from git archive' {
    It 'builds from the snapshot commit' {
        $script:BuildOutput.ExitCode | Should -Be 0 -Because $script:BuildOutput.Text
        $script:BuildOutput.Text | Should -Match 'UNSIGNED'
    }
    It 'writes the zip next to the staging folder with the version from package.json' {
        $version = (Get-Content (Join-Path $script:RepoRoot 'package.json') -Raw | ConvertFrom-Json).version
        Get-ChildItem -LiteralPath $script:Sandbox -Filter '*.zip' | ForEach-Object Name | Should -Contain "NoFridayMail-$version-unsigned.zip"
        (Import-PowerShellDataFile (Join-Path $script:Work 'PackageIntegrity.psd1')).Version | Should -Be $version
    }
    It 'contains exactly the git archive plus PackageIntegrity.psd1' {
        $archive = Join-Path $script:Sandbox 'archive.zip'
        & git -C $script:Snapshot archive --format=zip -o $archive HEAD
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archiveNames = [IO.Compression.ZipFile]::OpenRead($archive)
        try { $expected = @($archiveNames.Entries | Where-Object { $_.FullName -notmatch '/$' } | ForEach-Object FullName) } finally { $archiveNames.Dispose() }
        $releaseZip = Get-ChildItem -LiteralPath $script:Sandbox -Filter 'NoFridayMail-*-unsigned.zip' | Select-Object -First 1
        $zip = [IO.Compression.ZipFile]::OpenRead($releaseZip.FullName)
        try { $actual = @($zip.Entries | ForEach-Object FullName) } finally { $zip.Dispose() }
        @($actual | Where-Object { $_ -cne 'PackageIntegrity.psd1' } | Sort-Object) | Should -Be @($expected | Sort-Object)
        $actual | Should -Contain 'PackageIntegrity.psd1'
        @($actual | Where-Object { $_ -cmatch '^(tests|\.github)/' }).Count | Should -Be 0
    }
    It 'lists every archived file once, upper-case SHA-256, forward slashes' {
        $script:Entries.Count | Should -BeGreaterThan 30
        @($script:Entries.Path | Select-Object -Unique).Count | Should -Be $script:Entries.Count
        $script:Entries.Path | Should -Contain 'tools/Test-PackageIntegrity.ps1'
        $script:Entries.Path | Should -Not -Contain 'PackageIntegrity.psd1'
        foreach ($entry in $script:Entries) { $entry.Sha256 | Should -Match '^[0-9A-F]{64}$' }
    }
}

Describe 'Integrity verifier' {
    BeforeEach {
        # Restore the pristine package before each case (cases below mutate files in place and put them back).
        if ((Get-ManifestText) -cne $script:OriginalManifest) { Set-ManifestText $script:OriginalManifest }
    }
    It 'accepts the unsigned package only with -AllowUnsigned' {
        { Invoke-Verifier } | Should -Not -Throw
        { Invoke-Verifier -Strict } | Should -Throw -ExpectedMessage '*expected trusted, timestamped owner signature*'
    }
    It 'refuses a verifier that does not belong to the package root' {
        $outside = Join-Path $script:Sandbox 'copied-verifier.ps1'
        Copy-Item -LiteralPath (Join-Path $script:Work 'tools\Test-PackageIntegrity.ps1') -Destination $outside
        { & $outside -Root $script:Work -AllowUnsigned } | Should -Throw -ExpectedMessage '*verifier must belong to this package root*'
    }
    It 'rejects a changed file, for every inventory entry' {
        foreach ($entry in $script:Entries) {
            $path = Join-Path $script:Work $entry.Path.Replace('/', '\')
            $bytes = [IO.File]::ReadAllBytes($path)
            try {
                Edit-Tamper $path
                { Invoke-Verifier } | Should -Throw -ExpectedMessage "*SHA256 mismatch: $($entry.Path)*"
            }
            finally { [IO.File]::WriteAllBytes($path, $bytes) }
        }
        { Invoke-Verifier } | Should -Not -Throw
    }
    It 'rejects a missing file, for every inventory entry' {
        foreach ($entry in $script:Entries) {
            $path = Join-Path $script:Work $entry.Path.Replace('/', '\')
            $bytes = [IO.File]::ReadAllBytes($path)
            try {
                Remove-Item -LiteralPath $path
                { Invoke-Verifier } | Should -Throw
            }
            finally { [IO.File]::WriteAllBytes($path, $bytes) }
        }
        { Invoke-Verifier } | Should -Not -Throw
    }
    It 'rejects an absent manifest' {
        $path = Join-Path $script:Work 'PackageIntegrity.psd1'
        Rename-Item -LiteralPath $path -NewName 'PackageIntegrity.off'
        try { { Invoke-Verifier } | Should -Throw }
        finally { Rename-Item -LiteralPath (Join-Path $script:Work 'PackageIntegrity.off') -NewName 'PackageIntegrity.psd1' }
    }
    It 'rejects unknown code and data files outside the generated and operator areas' {
        foreach ($relative in 'tools\extra.ps1', 'tools\lib\extra.ps1', 'src\extra.js', 'tools\extra.js', 'api\src\extra.js', 'api\extra.json',
            'docs\extra.html', 'deploy\environments\extra.js', 'extra.ps1', 'extra.js', 'extra.cmd', 'deploy\extra.json') {
            $path = Join-Path $script:Work $relative
            [IO.File]::WriteAllText($path, 'not part of the package')
            try { { Invoke-Verifier } | Should -Throw -ExpectedMessage '*unexpected file*' -Because $relative }
            finally { Remove-Item -LiteralPath $path -Force }
        }
    }
    It 'accepts the generated and operator-owned areas' {
        $created = @()
        foreach ($relative in 'node_modules\pkg\index.js', 'api\node_modules\pkg\index.js', 'api\shared\bypass.js', 'api\config.json', 'dist\prod\launchevent.js',
            'out\NoFridayMail-prod-1.1.0.0.zip', 'previews\p.html', 'deploy\environments.local\mine.json', 'deploy\environments\mine.json', '.env', '.env.local') {
            $path = Join-Path $script:Work $relative
            [void][IO.Directory]::CreateDirectory((Split-Path $path -Parent))
            [IO.File]::WriteAllText($path, 'generated or operator-owned')
            $created += $path
        }
        try { { Invoke-Verifier } | Should -Not -Throw }
        finally {
            foreach ($path in $created) { Remove-Item -LiteralPath $path -Force }
            foreach ($folder in 'node_modules', 'api\node_modules', 'api\shared', 'dist', 'out', 'previews', 'deploy\environments.local') {
                Remove-Item -LiteralPath (Join-Path $script:Work $folder) -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
    It 'accepts a node_modules junction (the operator may link it) but rejects junctions in protected folders' {
        $outside = Join-Path $script:Sandbox 'junction-target'
        [void][IO.Directory]::CreateDirectory($outside)
        Set-Content -LiteralPath (Join-Path $outside 'x.js') 'x'
        $modules = Join-Path $script:Work 'node_modules'
        New-Item -ItemType Junction -Path $modules -Target $outside | Out-Null
        try { { Invoke-Verifier } | Should -Not -Throw }
        finally { (Get-Item -LiteralPath $modules -Force).Delete() }
        foreach ($relative in 'src', 'tools\lib', 'docs', 'api\src') {
            $link = Join-Path $script:Work $relative
            $moved = "$link.moved"
            Rename-Item -LiteralPath $link -NewName (Split-Path $moved -Leaf)
            New-Item -ItemType Junction -Path $link -Target $outside | Out-Null
            try { { Invoke-Verifier } | Should -Throw }
            finally {
                (Get-Item -LiteralPath $link -Force).Delete()
                Rename-Item -LiteralPath $moved -NewName (Split-Path $link -Leaf)
            }
        }
        { Invoke-Verifier } | Should -Not -Throw
    }
    It 'rejects a manifest that omits, duplicates, adds or retargets an entry, or changes its schema' {
        $original = Get-ManifestText
        $variants = [ordered]@{
            omitted       = [regex]::Replace($original, "(?m)^\s*@\{ Path = 'LICENSE';.*\r?\n", '')
            duplicate     = $original.Replace("@{ Path = 'LICENSE';", "@{ Path = 'SECURITY.md';")
            unlisted      = $original.Replace("Path = 'LICENSE'", "Path = 'src/extra.js'")
            traversal     = $original.Replace("Path = 'LICENSE'", "Path = '../LICENSE'")
            backslash     = $original.Replace("Path = 'LICENSE'", "Path = 'tools\LICENSE'")
            absolute      = $original.Replace("Path = 'LICENSE'", "Path = 'C:/Windows/win.ini'")
            selfreference = $original.Replace("Path = 'LICENSE'", "Path = 'PackageIntegrity.psd1'")
            wronghash     = $original.Replace("Path = 'LICENSE'; Sha256 = '", "Path = 'LICENSE'; Sha256 = 'g")
            lowercase     = [regex]::Replace($original, "(Path = 'LICENSE'; Sha256 = ')([0-9A-F]+)", { param($m) $m.Groups[1].Value + $m.Groups[2].Value.ToLowerInvariant() })
            otherSigner   = $original.Replace('0F28E442889F17B5F4D251E8F96E7CC6E2C9C6D6', '0000000000000000000000000000000000000000')
            otherAlgo     = $original.Replace("'SHA256'", "'SHA1'")
            otherSchema   = $original.Replace('SchemaVersion = 1', 'SchemaVersion = 2')
            extraKey      = $original.Replace('    Files = @(', "    Extra = 'x'`r`n    Files = @(")
            noVersion     = $original.Replace("Version = '", "Release = '")
        }
        foreach ($name in $variants.Keys) {
            $variants[$name] | Should -Not -BeExactly $original -Because $name
            Set-ManifestText $variants[$name]
            { Invoke-Verifier } | Should -Throw -Because $name
        }
        Set-ManifestText $original
        { Invoke-Verifier } | Should -Not -Throw
    }
    It 'rejects a manifest that is code rather than plain data' {
        Set-ManifestText ((Get-ManifestText) -replace "(?m)^@\{", "Write-Host injected`r`n@{")
        { Invoke-Verifier } | Should -Throw
    }
    It 'requires valid timestamped owner signatures on the PowerShell files of the repository' -Tag 'RealSignature' {
        $files = 'tools\Deploy-NoFridayMail.ps1', 'tools\New-NoFridayMailEnvironment.ps1', 'tools\lib\Deploy-Checks.ps1', 'tools\Test-PackageIntegrity.ps1'
        $states = @($files | ForEach-Object { [string](Get-AuthenticodeSignature -LiteralPath (Join-Path $script:RepoRoot $_)).Status })
        if ($states -contains 'NotSigned') { Set-ItResult -Skipped -Because 'the owner has not signed these files yet (done outside CI)'; return }
        foreach ($file in $files) {
            $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $script:RepoRoot $file)
            [string]$signature.Status | Should -Be 'Valid'
            $signature.SignerCertificate.Thumbprint | Should -BeExactly '0F28E442889F17B5F4D251E8F96E7CC6E2C9C6D6'
            $signature.TimeStamperCertificate | Should -Not -BeNullOrEmpty
        }
    }
}

Describe 'Package builder guards' {
    BeforeEach {
        $script:Case = Join-Path $script:Sandbox ('case-{0}' -f [Guid]::NewGuid().ToString('N').Substring(0, 8))
        Copy-Item -LiteralPath $script:Snapshot -Destination $script:Case -Recurse
        $script:CaseOut = Join-Path $script:Sandbox ('out-{0}' -f [Guid]::NewGuid().ToString('N').Substring(0, 8))
    }
    It 'refuses a dirty tracked tree, and builds the commit with -AllowDirty' {
        [IO.File]::AppendAllText((Join-Path $script:Case 'README.md'), "`nuncommitted change`n")
        $builder = Join-Path $script:Case 'tools\New-NoFridayMailPackage.ps1'
        $refused = Invoke-Child -Arguments @('-File', $builder, '-Unsigned', '-Destination', (Join-Path $script:CaseOut 'pkg'))
        $refused.ExitCode | Should -Not -Be 0
        $refused.Text | Should -Match 'uncommitted changes'
        Test-Path -LiteralPath (Join-Path $script:CaseOut 'pkg') | Should -BeFalse
        $allowed = Invoke-Child -Arguments @('-File', $builder, '-Unsigned', '-AllowDirty', '-Destination', (Join-Path $script:CaseOut 'pkg'))
        $allowed.ExitCode | Should -Be 0 -Because $allowed.Text
        # The package holds the committed bytes, not the dirty working tree.
        (Get-Content (Join-Path $script:CaseOut 'pkg\README.md') -Raw) | Should -Not -Match 'uncommitted change'
    }
    It 'refuses a forbidden path in the archive (export-ignore rule removed)' {
        $attributes = Join-Path $script:Case '.gitattributes'
        $text = [IO.File]::ReadAllText($attributes) -replace '(?m)^/tests export-ignore\r?\n', ''
        [IO.File]::WriteAllText($attributes, $text)
        & git -C $script:Case -c core.autocrlf=false commit -q -am 'drop export-ignore for tests' 2>&1 | Out-Null
        $run = Invoke-Child -Arguments @('-File', (Join-Path $script:Case 'tools\New-NoFridayMailPackage.ps1'), '-Unsigned', '-Destination', (Join-Path $script:CaseOut 'pkg'))
        $run.ExitCode | Should -Not -Be 0
        $run.Text | Should -Match 'Forbidden path in the package: tests/'
    }
    It 'refuses a missing required file' {
        & git -C $script:Case rm -q SECURITY.md 2>&1 | Out-Null
        & git -C $script:Case commit -q -m 'remove SECURITY.md' 2>&1 | Out-Null
        $run = Invoke-Child -Arguments @('-File', (Join-Path $script:Case 'tools\New-NoFridayMailPackage.ps1'), '-Unsigned', '-Destination', (Join-Path $script:CaseOut 'pkg'))
        $run.ExitCode | Should -Not -Be 0
        $run.Text | Should -Match 'Missing in the package: SECURITY.md'
    }
    It 'Stage refuses PowerShell files that carry no owner signature, and leaves no staging folder' {
        $destination = Join-Path $script:CaseOut 'stage'
        $files = @(& git -C $script:Case ls-files '*.ps1')
        $signed = @($files | Where-Object { $_ -in 'tools/Deploy-NoFridayMail.ps1', 'tools/New-NoFridayMailEnvironment.ps1', 'tools/lib/Deploy-Checks.ps1', 'tools/Test-PackageIntegrity.ps1' } |
                Where-Object { [string](Get-AuthenticodeSignature -LiteralPath (Join-Path $script:Case $_)).Status -ne 'NotSigned' })
        if ($signed.Count -eq 4) { Set-ItResult -Skipped -Because 'the scripts are already signed'; return }
        $run = Invoke-Child -Arguments @('-File', (Join-Path $script:Case 'tools\New-NoFridayMailPackage.ps1'), '-Mode', 'Stage', '-Destination', $destination)
        $run.ExitCode | Should -Not -Be 0
        $run.Text | Should -Match 'Stage refused'
        $run.Text | Should -Match 'tools/Deploy-NoFridayMail.ps1'
        Test-Path -LiteralPath $destination | Should -BeFalse
    }
    It 'Seal refuses without a staging folder holding the signed manifest' {
        $run = Invoke-Child -Arguments @('-File', (Join-Path $script:Case 'tools\New-NoFridayMailPackage.ps1'), '-Mode', 'Seal', '-Destination', (Join-Path $script:CaseOut 'nothing'))
        $run.ExitCode | Should -Not -Be 0
        $run.Text | Should -Match 'Seal needs the staging folder prepared by Stage'
    }
    It 'Seal refuses an unsigned manifest in a staged folder' {
        # Stage cannot succeed without signatures, so a staging folder is hand-made from the unsigned build.
        $staging = Join-Path $script:CaseOut 'staging'
        Copy-Item -LiteralPath $script:Staged -Destination $staging -Recurse
        $run = Invoke-Child -Arguments @('-File', (Join-Path $script:Case 'tools\New-NoFridayMailPackage.ps1'), '-Mode', 'Seal', '-Destination', $staging)
        $run.ExitCode | Should -Not -Be 0
        $run.Text | Should -Match 'owner signature'
        Get-ChildItem -LiteralPath $script:CaseOut -Filter '*.zip' -ErrorAction SilentlyContinue | Should -BeNullOrEmpty
    }
}

Describe 'Deploy script integration' {
    It 'refuses a package whose manifest does not authenticate (unsigned or tampered), before doing anything else' {
        # az is removed from the PATH so the run stays offline; the integrity check comes first anyway.
        $keep = ($env:PATH -split ';') | Where-Object { -not ((Test-Path (Join-Path $_ 'az.cmd')) -or (Test-Path (Join-Path $_ 'az.exe')) -or (Test-Path (Join-Path $_ 'az.ps1'))) }
        $arguments = @('-File', (Join-Path $script:Work 'tools\Deploy-NoFridayMail.ps1'), '-Environment', 'prod', '-WhatIf', '-SkipInfra')
        $unsigned = Invoke-Child -Arguments $arguments -Environment @{ PATH = ($keep -join ';') }
        $unsigned.ExitCode | Should -Not -Be 0
        $unsigned.Text | Should -Match 'Package integrity'
        $path = Join-Path $script:Work 'src\shared\config.js'
        $bytes = [IO.File]::ReadAllBytes($path)
        try {
            Edit-Tamper $path
            $tampered = Invoke-Child -Arguments $arguments -Environment @{ PATH = ($keep -join ';') }
            $tampered.ExitCode | Should -Not -Be 0
            $tampered.Text | Should -Match 'Package integrity'
        }
        finally { [IO.File]::WriteAllBytes($path, $bytes) }
    }
}

# SIG # Begin signature block
# MIImKQYJKoZIhvcNAQcCoIImGjCCJhYCAQExDzANBglghkgBZQMEAgEFADB5Bgor
# BgEEAYI3AgEEoGswaTA0BgorBgEEAYI3AgEeMCYCAwEAAAQQH8w7YFlLCE63JNLG
# KX7zUQIBAAIBAAIBAAIBAAIBADAxMA0GCWCGSAFlAwQCAQUABCCXIZxG4dz+EyGP
# KI873XXkbRk2wz1qyZQwUbefej9aC6CCDW8wggZyMIIEWqADAgECAghkM1HTxzif
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
# AQQBgjcCAQsxDjAMBgorBgEEAYI3AgEVMC8GCSqGSIb3DQEJBDEiBCCZeabANDmA
# 2pM+pSI7pNafEo749x3d/GcuI4HYeN3HGTANBgkqhkiG9w0BAQEFAASCAgBhUkwj
# yhXBgfCHYZ9Xnchm72PJTPngJcPUkKMcuua+dfr/8ppSbEexVf56v/1ga/YUON/x
# 8bCmq0ZiF+SHTCn8L3AmH6lJ1FqVv3mWK0+mHfzlv1MpKTQ7GVY/0uYNVqAvz1Iz
# 8GbdmuoxVNkpEVv3JPhNtRIRSOb4PEP4OOQssqSs99e9/+vMBk10O06lZRwhK1he
# evGKDKR9CxblgQwsBe/1/j0eaEmqAgUfNoGZlRribgEjU1YvjvO8K18DQFsX+GGw
# Lkedsoai7V2ryt+AuFVgaI/CVYw+/d3be9lTkisB9880ODKDsLrFlpWsmbIZERz5
# 1iQLHeEhLj5/qBzVIeG080ZbWq5d40AGftNBJFPVCxtaAngokrdg+DX0gNdJCO2c
# /C8mp/GudzyB35+/4DdW1fXuXXynwJb4fjgz2ozx4wvpGBj1YPE0TVEsAmjxQXrO
# 6by6LSIPbb3l7JdJ/t+8tmnt+JtuJVkwpjQcOH/yeLjw1e0E5TX0Sg5BGATmeEAi
# dyXtsTalUpVLKlYtgfD5vtj0YXf8sJkvq6JgHBWxkhCGRBJb2fyFbGYudY9eP+S9
# dIDGVFZ5TrVLyxcgy1sEVIrbtjzTyaqsQdrAalU9YTZejQrW8lW4pf08a7nNz78g
# 09XDPdBM9lvhQWAxYQ7WYqBeZAPCf0wezbIcnqGCFM0wghTJBgorBgEEAYI3AwMB
# MYIUuTCCFLUGCSqGSIb3DQEHAqCCFKYwghSiAgEDMQ0wCwYJYIZIAWUDBAIBMIGJ
# BgsqhkiG9w0BCRABBKB6BHgwdgIBAQYMKwYBBAGCqTABAwYBMDEwDQYJYIZIAWUD
# BAIBBQAEIEf9//CDSkwVYbtmz5QEZpcgE1UWoEXUedzMrb/qynMMAghgBSH4fhzJ
# EhgPMjAyNjEwMzAyMDM2MzZaMAMCAQECEDdLZQdP2zlrma6E5DjFZtKgghGnMIIE
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
# AQkQAQQwHAYJKoZIhvcNAQkFMQ8XDTI2MTAzMDIwMzYzNlowKAYJKoZIhvcNAQk0
# MRswGTALBglghkgBZQMEAgGhCgYIKoZIzj0EAwIwLwYJKoZIhvcNAQkEMSIEIOnA
# xJ2H+8EL+ys6hNAHdBOanhbXLCrFRn6GmOj/pBXpMIHIBgsqhkiG9w0BCRACLzGB
# uDCBtTCBsjCBrwQgV0/qF6r6XnxqK5sIyZixc15FCzhzykTmokygkw5j87AwgYow
# dqR0MHIxCzAJBgNVBAYTAlVTMQ4wDAYDVQQIDAVUZXhhczEQMA4GA1UEBwwHSG91
# c3RvbjERMA8GA1UECgwIU1NMIENvcnAxLjAsBgNVBAMMJVNTTC5jb20gVGltZXN0
# YW1waW5nIElzc3VpbmcgUlNBIENBIDICEFRD+De9Wu4YAYRyuFzajuMwCgYIKoZI
# zj0EAwIERjBEAiAluPYIgbCB6XViMR5jovEemnzx6GO6M0GdC58AsK9gHQIgZEps
# 3BbNjWf18jQPJ9DYjckZsrNJ8cDaUk1M49whQdY=
# SIG # End signature block
