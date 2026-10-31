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
        $version = (Get-Content (Join-Path $script:RepoRoot 'package\package.json') -Raw | ConvertFrom-Json).version
        Get-ChildItem -LiteralPath $script:Sandbox -Filter '*.zip' | ForEach-Object Name | Should -Contain "NoFridayMail-$version-unsigned.zip"
        (Import-PowerShellDataFile (Join-Path $script:Work 'PackageIntegrity.psd1')).Version | Should -Be $version
    }
    It 'contains exactly the package folder of the git archive plus CHANGELOG.md and PackageIntegrity.psd1' {
        $archive = Join-Path $script:Sandbox 'archive.zip'
        & git -C $script:Snapshot archive --format=zip -o $archive HEAD
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archiveNames = [IO.Compression.ZipFile]::OpenRead($archive)
        try { $all = @($archiveNames.Entries | Where-Object { $_.FullName -notmatch '/$' } | ForEach-Object FullName) } finally { $archiveNames.Dispose() }
        # "Download ZIP" itself ships nothing but package/; the release ZIP is that folder without its prefix.
        @($all | Where-Object { $_ -cnotmatch '^package/' }).Count | Should -Be 0
        $expected = @($all | ForEach-Object { $_.Substring('package/'.Length) })
        $releaseZip = Get-ChildItem -LiteralPath $script:Sandbox -Filter 'NoFridayMail-*-unsigned.zip' | Select-Object -First 1
        $zip = [IO.Compression.ZipFile]::OpenRead($releaseZip.FullName)
        try { $actual = @($zip.Entries | ForEach-Object FullName) } finally { $zip.Dispose() }
        @($actual | Where-Object { $_ -cne 'PackageIntegrity.psd1' -and $_ -cne 'CHANGELOG.md' } | Sort-Object) | Should -Be @($expected | Sort-Object)
        $actual | Should -Contain 'PackageIntegrity.psd1'
        # The root change log is not in "Download ZIP" (export-ignore) but is in the release ZIP, hashed.
        $all | Should -Not -Contain 'CHANGELOG.md'
        $actual | Should -Contain 'CHANGELOG.md'
        $script:Entries.Path | Should -Contain 'CHANGELOG.md'
        @($actual | Where-Object { $_ -cmatch '^(tests|\.github|package)/' }).Count | Should -Be 0
    }
    It 'carries the root CHANGELOG.md with its exact committed bytes' {
        $committed = Join-Path $script:Sandbox 'changelog.committed'
        & cmd /c "git -C `"$($script:Snapshot)`" cat-file blob HEAD:CHANGELOG.md > `"$committed`""
        $expected = (Get-FileHash -LiteralPath $committed -Algorithm SHA256).Hash
        (Get-FileHash -LiteralPath (Join-Path $script:Staged 'CHANGELOG.md') -Algorithm SHA256).Hash | Should -Be $expected
        ($script:Entries | Where-Object Path -ceq 'CHANGELOG.md').Sha256 | Should -Be $expected
        $zip = Get-ChildItem -LiteralPath $script:Sandbox -Filter 'NoFridayMail-*-unsigned.zip' | Select-Object -First 1
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [IO.Compression.ZipFile]::OpenRead($zip.FullName)
        try {
            $stream = $archive.GetEntry('CHANGELOG.md').Open()
            try { $sha = [Security.Cryptography.SHA256]::HashData($stream) } finally { $stream.Dispose() }
        }
        finally { $archive.Dispose() }
        [BitConverter]::ToString($sha).Replace('-', '') | Should -Be $expected
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
        $states = @($files | ForEach-Object { [string](Get-AuthenticodeSignature -LiteralPath (Join-Path $script:RepoRoot "package\$_")).Status })
        if ($states -contains 'NotSigned') { Set-ItResult -Skipped -Because 'the owner has not signed these files yet (done outside CI)'; return }
        foreach ($file in $files) {
            $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $script:RepoRoot "package\$file")
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
        [IO.File]::AppendAllText((Join-Path $script:Case 'package\README.md'), "`nuncommitted change`n")
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
    It 'refuses a forbidden path in the package (a tests folder added to package\)' {
        $leak = Join-Path $script:Case 'package\tests\leak.test.js'
        [void][IO.Directory]::CreateDirectory((Split-Path $leak -Parent))
        [IO.File]::WriteAllText($leak, 'leak')
        & git -C $script:Case add -A 2>&1 | Out-Null
        & git -C $script:Case -c core.autocrlf=false commit -q -m 'add a tests folder to the package' 2>&1 | Out-Null
        $run = Invoke-Child -Arguments @('-File', (Join-Path $script:Case 'tools\New-NoFridayMailPackage.ps1'), '-Unsigned', '-Destination', (Join-Path $script:CaseOut 'pkg'))
        $run.ExitCode | Should -Not -Be 0
        $run.Text | Should -Match 'Forbidden path in the package: tests/leak.test.js'
    }
    It 'refuses a missing required file' {
        & git -C $script:Case rm -q package/THIRD-PARTY-NOTICES.md 2>&1 | Out-Null
        & git -C $script:Case commit -q -m 'remove THIRD-PARTY-NOTICES.md' 2>&1 | Out-Null
        $run = Invoke-Child -Arguments @('-File', (Join-Path $script:Case 'tools\New-NoFridayMailPackage.ps1'), '-Unsigned', '-Destination', (Join-Path $script:CaseOut 'pkg'))
        $run.ExitCode | Should -Not -Be 0
        $run.Text | Should -Match 'Missing in the package: THIRD-PARTY-NOTICES.md'
    }
    It 'refuses a release without the root CHANGELOG.md' {
        & git -C $script:Case rm -q CHANGELOG.md 2>&1 | Out-Null
        & git -C $script:Case commit -q -m 'remove CHANGELOG.md' 2>&1 | Out-Null
        $run = Invoke-Child -Arguments @('-File', (Join-Path $script:Case 'toolsNew-NoFridayMailPackage.ps1'), '-Unsigned', '-Destination', (Join-Path $script:CaseOut 'pkg'))
        $run.ExitCode | Should -Not -Be 0
        $run.Text | Should -Match 'CHANGELOG.md'
    }
    It 'refuses a CHANGELOG.md inside package (it would hide the root one)' {
        [IO.File]::WriteAllText((Join-Path $script:Case 'packageCHANGELOG.md'), 'shadow')
        & git -C $script:Case add -A 2>&1 | Out-Null
        & git -C $script:Case -c core.autocrlf=false commit -q -m 'add CHANGELOG.md to the package folder' 2>&1 | Out-Null
        $run = Invoke-Child -Arguments @('-File', (Join-Path $script:Case 'toolsNew-NoFridayMailPackage.ps1'), '-Unsigned', '-Destination', (Join-Path $script:CaseOut 'pkg'))
        $run.ExitCode | Should -Not -Be 0
        $run.Text | Should -Match 'must not exist inside package'
    }
    It 'Stage refuses PowerShell files that carry no owner signature, and leaves no staging folder' {
        $destination = Join-Path $script:CaseOut 'stage'
        $files = @(& git -C $script:Case ls-files '*.ps1')
        $signed = @($files | Where-Object { $_ -in 'package/tools/Deploy-NoFridayMail.ps1', 'package/tools/New-NoFridayMailEnvironment.ps1', 'package/tools/lib/Deploy-Checks.ps1', 'package/tools/Test-PackageIntegrity.ps1' } |
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
