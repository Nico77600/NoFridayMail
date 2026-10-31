#Requires -Version 7.4
<#
.SYNOPSIS
    NoFridayMail - builds the release package (ZIP) from a Git commit, with its PackageIntegrity.psd1 manifest.

.DESCRIPTION
    The release ZIP is the content of the package\ folder of the repository at -Ref (what GitHub's "Download ZIP"
    ships under package\), plus the repository's CHANGELOG.md and PackageIntegrity.psd1: the ZIP root is the package folder itself. Tests, CI,
    development tools and agent notes live outside package\ and are never in it. The builder works on committed bytes
    only (it refuses a dirty tracked tree unless -AllowDirty), never rewrites a file, and never signs anything.

      1. ARCHIVE   git archive of package\ at -Ref (bytes untouched) into a fresh staging folder, without the package\ prefix,
                   plus CHANGELOG.md of the repository root at -Ref (exact committed bytes; "Download ZIP" does not carry it).
      2. CHECK     no forbidden path (tests, .github, node_modules, operator environments, secrets...) and every file that
                   tools\Deploy-NoFridayMail.ps1 needs is present.
      3. MANIFEST  PackageIntegrity.psd1: SHA-256 of every archived file, the owner's public signer thumbprint, the version.
      4. VERIFY    tools\Test-PackageIntegrity.ps1 on the staging folder.
      5. ZIP       out\release\NoFridayMail-<version>[-unsigned].zip, sorted entries, commit time as file time.

    Modes (the signature step belongs to the owner's established procedure and is NOT done by this script):
      Unsigned  CI and tests. Builds the staging folder and NoFridayMail-<version>-unsigned.zip, verified with
                -AllowUnsigned (hashes only). That ZIP is not authenticated and must never be released.
      Stage     Release, first half. Requires a valid, timestamped owner signature on EVERY PowerShell file of the archive
                (the owner signs them in the repository before the release commit), writes PackageIntegrity.psd1 UNSIGNED
                into the staging folder and stops. The owner then signs that manifest, in place, last (after the final
                script signatures, because the manifest hashes the signed bytes).
      Seal      Release, second half. Checks that the staging folder is byte-identical to the archive of -Ref plus the
                owner-signed manifest, verifies everything with signatures required, and writes
                out\release\NoFridayMail-<version>.zip.

.PARAMETER Ref
    Git revision to package. Default: HEAD.

.PARAMETER RepositoryRoot
    Repository to package. Default: the repository that contains this script.

.PARAMETER Destination
    Staging folder. Must not exist (use -Force to replace a previous staging folder). Default:
    <OutputDirectory>\NoFridayMail-<version>[-unsigned] (Seal: the folder prepared by Stage must be given).

.PARAMETER OutputDirectory
    Where the ZIP is written. Default: the parent of -Destination when it is given, else <RepositoryRoot>\out\release.

.PARAMETER Mode
    Unsigned, Stage or Seal. Default: Stage (the release path).

.PARAMETER Unsigned
    Same as -Mode Unsigned.

.PARAMETER AllowDirty
    Package -Ref even if tracked files have uncommitted changes (the ZIP then differs from the working tree). Tests only.

.PARAMETER Force
    Replace an existing staging folder that holds a package built by this script.

.EXAMPLE
    .\tools\New-NoFridayMailPackage.ps1 -Unsigned
    CI/test build of HEAD: out\release\NoFridayMail-1.1.0-unsigned.zip (hashes only, not authenticated).

.EXAMPLE
    .\tools\New-NoFridayMailPackage.ps1 -Destination C:\Release\NoFridayMail-1.1.0 -Unsigned -Ref v1.1.0
    Same, for the commit tagged v1.1.0, with the staging folder where you want it.

.EXAMPLE
    .\tools\New-NoFridayMailPackage.ps1 -Mode Stage -Destination C:\Release\NoFridayMail-1.1.0
    Release, first half: refuses unsigned PowerShell files, writes the unsigned manifest, then waits for the owner.

.EXAMPLE
    .\tools\New-NoFridayMailPackage.ps1 -Mode Seal -Destination C:\Release\NoFridayMail-1.1.0
    Release, second half, after the owner signed C:\Release\NoFridayMail-1.1.0\PackageIntegrity.psd1.

.NOTES
    Author  : Nicolas Fabert
    Needs   : git on the PATH. Never contacts the network, never signs, never needs secrets, Azure or Exchange.
#>
[CmdletBinding()]
param(
    [string]$Ref = 'HEAD',
    [string]$RepositoryRoot,
    [string]$Destination,
    [string]$OutputDirectory,
    [ValidateSet('Unsigned', 'Stage', 'Seal')][string]$Mode = 'Stage',
    [switch]$Unsigned,
    [switch]$AllowDirty,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($Unsigned) { $Mode = 'Unsigned' }

# Public thumbprint of the owner's code-signing certificate.
$signer = '0F28E442889F17B5F4D251E8F96E7CC6E2C9C6D6'
$manifestName = 'PackageIntegrity.psd1'

# The package folder of the repository: the release ZIP is its content.
$packageFolder = 'package'
# Paths that must never be distributed (regular expressions on the path inside the package, forward slashes).
$forbidden = @(
    '^package/', '^tests/', '^\.github/', '^tools/preview/', '^previews/', '^dist/', '^out/', '(^|/)node_modules/', '^deploy/environments\.local/',
    '^AGENTS\.md$', '^PROVENANCE\.md$', '^SECURITY\.md$', '^\.gitattributes$', '^\.gitignore$', '^assets/.*\.svg$',
    '^tools/(New-NoFridayMailPackage\.ps1|Build-Documentation\.js|New-DocumentationImages\.js|make-icons\.js|build-preview\.js|run-tests\.js)$',
    '^tools/doc-assets/', '(^|/)\.env(\..*)?$', '\.(pfx|pem|key|p12)$', '^deploy/environments/(?!example\.json$|prod\.json$)'
)
# Everything that tools\Deploy-NoFridayMail.ps1 needs end to end (exact files), plus the documents users read.
$required = @(
    'package.json', 'package-lock.json', 'webpack.config.js', 'manifest.xml', 'staticwebapp.config.json',
    'deploy/environment.schema.json', 'deploy/environments/example.json', 'deploy/environments/prod.json',
    'api/package.json', 'api/host.json', 'src/shared/config.js', 'src/shared/rules.js',
    'tools/Deploy-NoFridayMail.ps1', 'tools/New-NoFridayMailEnvironment.ps1', 'tools/lib/Deploy-Checks.ps1', 'tools/Test-PackageIntegrity.ps1',
    'tools/build.js', 'tools/env-config.js', 'tools/build-manifest.js', 'tools/manifest-lib.js', 'tools/check-bundle.js',
    'tools/package-api.js', 'tools/prepare-api.js', 'tools/validate-manifest.js', 'tools/swa-config.js',
    'tools/blocked-days.js', 'tools/deploy-text.js', 'tools/verify-receipt.js',
    'README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'
)
# File of the repository root added to the release ZIP (outside package\, so "Download ZIP" does not carry it).
$changelogName = 'CHANGELOG.md'

function Invoke-Git {
    param([Parameter(Mandatory)][string[]]$Arguments, [switch]$AllowFailure)
    $all = @(& git -C $script:repo @Arguments 2>&1)
    $code = $LASTEXITCODE
    # Warnings (for example line-ending notices) arrive as error records: keep them out of the data.
    $output = @($all | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] })
    if ($code -ne 0 -and -not $AllowFailure) {
        throw "git $($Arguments -join ' ') failed: $(($all | Out-String).Trim())"
    }
    if ($AllowFailure) { return [pscustomobject]@{ ExitCode = $code; Output = $output } }
    return $output
}

function Get-PackageFiles {
    # Relative forward-slash paths of every file in a folder, sorted ordinally (case-sensitive, deterministic).
    param([Parameter(Mandatory)][string]$Folder)
    $base = [IO.Path]::GetFullPath($Folder).TrimEnd('\', '/')
    $list = [Collections.Generic.List[string]]::new()
    foreach ($file in Get-ChildItem -LiteralPath $base -Recurse -File -Force) {
        $list.Add([IO.Path]::GetRelativePath($base, $file.FullName).Replace('\', '/'))
    }
    $array = $list.ToArray()
    [Array]::Sort($array, [StringComparer]::Ordinal)
    return $array
}

function Test-OwnerSignature {
    param([Parameter(Mandatory)][string]$Path)
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    return ([string]$signature.Status -ceq 'Valid' -and $null -ne $signature.SignerCertificate -and
        $signature.SignerCertificate.Thumbprint -ceq $signer -and $null -ne $signature.TimeStamperCertificate)
}

function New-IntegrityManifest {
    param([Parameter(Mandatory)][string]$Folder, [Parameter(Mandatory)][string]$Version)
    $lines = [Collections.Generic.List[string]]::new()
    $lines.Add("# NoFridayMail $Version - package integrity manifest")
    $lines.Add('# SHA-256 of every file of the package except this manifest. Generated by tools\New-NoFridayMailPackage.ps1;')
    $lines.Add('# in a release it is signed (Authenticode, timestamped) by the owner, last, after the final script signatures.')
    $lines.Add('@{')
    $lines.Add('    SchemaVersion = 1')
    $lines.Add("    Algorithm = 'SHA256'")
    $lines.Add("    SignerThumbprint = '$signer'")
    $lines.Add("    Version = '$Version'")
    $lines.Add('    Files = @(')
    foreach ($relative in Get-PackageFiles $Folder) {
        if ($relative -ceq $manifestName) { continue }
        $hash = (Get-FileHash -LiteralPath (Join-Path $Folder $relative.Replace('/', [IO.Path]::DirectorySeparatorChar)) -Algorithm SHA256).Hash
        $lines.Add(("        @{{ Path = '{0}'; Sha256 = '{1}' }}" -f $relative.Replace("'", "''"), $hash))
    }
    $lines.Add('    )')
    $lines.Add('}')
    # UTF-8 with BOM and CRLF, like the other files the owner signs.
    $path = Join-Path $Folder $manifestName
    [IO.File]::WriteAllText($path, (($lines -join "`r`n") + "`r`n"), [Text.UTF8Encoding]::new($true))
}

function Assert-Layout {
    param([Parameter(Mandatory)][string]$Folder)
    $files = @(Get-PackageFiles $Folder)
    $problems = [Collections.Generic.List[string]]::new()
    foreach ($file in $files) {
        foreach ($pattern in $forbidden) {
            if ($file -cmatch $pattern) { $problems.Add("Forbidden path in the package: $file"); break }
        }
    }
    foreach ($file in $required) {
        if ($file -cnotin $files) { $problems.Add("Missing in the package: $file") }
    }
    if ($problems.Count) { throw ("Package not valid ($Folder):`n - " + ($problems -join "`n - ")) }
}

function New-PackageZip {
    param([Parameter(Mandatory)][string]$Folder, [Parameter(Mandatory)][string]$ZipPath, [Parameter(Mandatory)][datetime]$Stamp)
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($ZipPath))
    if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
    Add-Type -AssemblyName System.IO.Compression
    $stream = [IO.File]::Create($ZipPath)
    try {
        $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($relative in Get-PackageFiles $Folder) {
                $entry = $zip.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
                $entry.LastWriteTime = [DateTimeOffset]$Stamp
                $input = [IO.File]::OpenRead((Join-Path $Folder $relative.Replace('/', [IO.Path]::DirectorySeparatorChar)))
                try {
                    $output = $entry.Open()
                    try { $input.CopyTo($output) } finally { $output.Dispose() }
                }
                finally { $input.Dispose() }
            }
        }
        finally { $zip.Dispose() }
    }
    finally { $stream.Dispose() }
}

# ---- Repository, revision, version ---------------------------------------------------------------------------------
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is required and was not found on the PATH.' }
if (-not $RepositoryRoot) { $RepositoryRoot = Split-Path $PSScriptRoot -Parent }
$script:repo = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\', '/')
$top = ((& git -C $script:repo rev-parse --show-toplevel 2>&1) | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "Not a Git repository: $script:repo" }
$script:repo = [IO.Path]::GetFullPath($top)
$commit = ((Invoke-Git @('rev-parse', '--verify', "$Ref^{commit}")) | Out-String).Trim()
$head = ((Invoke-Git @('rev-parse', '--verify', 'HEAD^{commit}') -AllowFailure).Output | Out-String).Trim()
if ($commit -ceq $head -and -not $AllowDirty) {
    $dirty = @(Invoke-Git @('status', '--porcelain', '--untracked-files=no'))
    if ($dirty.Count) { throw "Tracked files have uncommitted changes; the package must equal the commit. Commit them, or use -AllowDirty for a test build.`n$($dirty -join "`n")" }
}
$version = [string]((Invoke-Git @('show', "${commit}:$packageFolder/package.json") | Out-String | ConvertFrom-Json).version)
if ($version -cnotmatch '^\d+\.\d+\.\d+$') { throw "Unexpected package.json version: $version" }
$stamp = [datetime]::Parse(((Invoke-Git @('show', '-s', '--format=%cI', $commit)) | Out-String).Trim()).ToUniversalTime()
$suffix = if ($Mode -eq 'Unsigned') { '-unsigned' } else { '' }
$baseName = "NoFridayMail-$version$suffix"

if (-not $OutputDirectory) {
    $OutputDirectory = if ($Destination) { Split-Path ([IO.Path]::GetFullPath($Destination)) -Parent } else { Join-Path $script:repo 'out\release' }
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\', '/')
if (-not $Destination) { $Destination = Join-Path $OutputDirectory $baseName }
$Destination = [IO.Path]::GetFullPath($Destination).TrimEnd('\', '/')
$zipPath = Join-Path $OutputDirectory "$baseName.zip"
$verifierName = 'tools\Test-PackageIntegrity.ps1'

# The staging folder must not be inside the content it is built from (the tracked tree), except under out\.
$repoPrefix = $script:repo + '\'
if (($Destination + '\').StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase) -and
    -not ($Destination + '\').StartsWith($repoPrefix + 'out\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "The staging folder must be outside the repository (or under out\): $Destination"
}

function Export-GitBlob {
    # Exact bytes of a committed file (git cat-file blob), written without any PowerShell text conversion.
    param([Parameter(Mandatory)][string]$Spec, [Parameter(Mandatory)][string]$Target)
    $info = [Diagnostics.ProcessStartInfo]::new('git')
    foreach ($argument in @('-C', $script:repo, 'cat-file', 'blob', $Spec)) { $info.ArgumentList.Add($argument) }
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.UseShellExecute = $false
    $process = [Diagnostics.Process]::Start($info)
    try {
        $errorText = $process.StandardError.ReadToEndAsync()
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Target))
        $output = [IO.File]::Create($Target)
        try { $process.StandardOutput.BaseStream.CopyTo($output) } finally { $output.Dispose() }
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            Remove-Item -LiteralPath $Target -Force -ErrorAction SilentlyContinue
            throw "git cat-file blob $Spec failed: $($errorText.Result.Trim())"
        }
    }
    finally { $process.Dispose() }
}

function Expand-RefArchive {
    # git archive of the package\ folder only (the root .gitattributes still applies: exact bytes of the signed files),
    # extracted without the package/ prefix: the staging folder is the package root. The root CHANGELOG.md of -Ref is
    # added next to it; it is export-ignore'd, so it is read from the commit itself, not from the archive.
    param([Parameter(Mandatory)][string]$Target)
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ("nfm-archive-{0}.zip" -f [Guid]::NewGuid().ToString('N'))
    try {
        Invoke-Git @('archive', '--format=zip', '-o', $temporary, $commit, '--', $packageFolder) | Out-Null
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $targetRoot = [IO.Path]::GetFullPath($Target).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
        $zip = [IO.Compression.ZipFile]::OpenRead($temporary)
        try {
            $count = 0
            foreach ($entry in $zip.Entries) {
                if ($entry.FullName.EndsWith('/')) { continue }
                if (-not $entry.FullName.StartsWith("$packageFolder/", [StringComparison]::Ordinal)) { throw "Unexpected path in the archive of ${packageFolder}: $($entry.FullName)" }
                $relative = $entry.FullName.Substring($packageFolder.Length + 1)
                $path = [IO.Path]::GetFullPath((Join-Path $targetRoot $relative.Replace('/', [IO.Path]::DirectorySeparatorChar)))
                if (-not $path.StartsWith($targetRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe path in the archive: $($entry.FullName)" }
                [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $path, $false)
                $count++
            }
            if ($count -eq 0) { throw "No $packageFolder/ folder in ${Ref}." }
            $changelogTarget = Join-Path $targetRoot $changelogName
            if (Test-Path -LiteralPath $changelogTarget) { throw "$changelogName must not exist inside $packageFolder/: the root file is the one added to the release ZIP." }
            Export-GitBlob -Spec "${commit}:$changelogName" -Target $changelogTarget
        }
        finally { $zip.Dispose() }
    }
    finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

# ---- Seal: staging folder prepared by Stage and signed by the owner ----------------------------------------------------
if ($Mode -eq 'Seal') {
    if (-not (Test-Path -LiteralPath (Join-Path $Destination $manifestName))) { throw "Seal needs the staging folder prepared by Stage, with the owner-signed $manifestName : $Destination" }
    $fresh = Join-Path ([IO.Path]::GetTempPath()) ("nfm-seal-{0}" -f [Guid]::NewGuid().ToString('N'))
    try {
        [void][IO.Directory]::CreateDirectory($fresh)
        Expand-RefArchive $fresh
        $expected = @(Get-PackageFiles $fresh)
        $actual = @(Get-PackageFiles $Destination | Where-Object { $_ -cne $manifestName })
        if (($expected -join "`n") -cne ($actual -join "`n")) { throw 'The staging folder does not hold exactly the files of the archive (plus the manifest).' }
        foreach ($relative in $expected) {
            $suffixPath = $relative.Replace('/', [IO.Path]::DirectorySeparatorChar)
            if ((Get-FileHash -LiteralPath (Join-Path $fresh $suffixPath)).Hash -cne (Get-FileHash -LiteralPath (Join-Path $Destination $suffixPath)).Hash) {
                throw "Staged file differs from the archive of ${Ref}: $relative"
            }
        }
    }
    finally { Remove-Item -LiteralPath $fresh -Recurse -Force -ErrorAction SilentlyContinue }
    Assert-Layout $Destination
    & (Join-Path $Destination $verifierName) -Root $Destination
    New-PackageZip -Folder $Destination -ZipPath $zipPath -Stamp $stamp
    Write-Host "Release package sealed: $zipPath"
    return
}

# ---- Unsigned / Stage: archive, check, manifest -------------------------------------------------------------------
if (Test-Path -LiteralPath $Destination) {
    if (-not $Force) { throw "The staging folder already exists: $Destination. Use -Force to replace it." }
    if (-not (Test-Path -LiteralPath (Join-Path $Destination $manifestName)) -and @(Get-ChildItem -LiteralPath $Destination -Force).Count) {
        throw "The destination is not a package built by this script, it is not replaced: $Destination"
    }
    Remove-Item -LiteralPath $Destination -Recurse -Force
}
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Destination))
[void][IO.Directory]::CreateDirectory($Destination)
Expand-RefArchive $Destination
Assert-Layout $Destination

if ($Mode -eq 'Stage') {
    $unsignedFiles = @(Get-PackageFiles $Destination | Where-Object { $_ -cmatch '(?i)\.ps(m1|d1|1)$' } |
        Where-Object { -not (Test-OwnerSignature (Join-Path $Destination $_.Replace('/', [IO.Path]::DirectorySeparatorChar))) })
    if ($unsignedFiles.Count) {
        Remove-Item -LiteralPath $Destination -Recurse -Force
        throw ("Stage refused: these PowerShell files have no valid, timestamped owner signature in ${Ref}. " +
            "Sign them with the owner's established procedure, commit, then run Stage again (use -Unsigned for a CI/test build):`n - " +
            ($unsignedFiles -join "`n - "))
    }
}

New-IntegrityManifest -Folder $Destination -Version $version
if ($Mode -eq 'Unsigned') {
    & (Join-Path $Destination $verifierName) -Root $Destination -AllowUnsigned
    New-PackageZip -Folder $Destination -ZipPath $zipPath -Stamp $stamp
}

$all = @(Get-PackageFiles $Destination)
$bytes = ($all | ForEach-Object { (Get-Item -LiteralPath (Join-Path $Destination $_.Replace('/', [IO.Path]::DirectorySeparatorChar))).Length } | Measure-Object -Sum).Sum
Write-Host ''
Write-Host "  NoFridayMail $version - package $(if ($Mode -eq 'Unsigned') { 'ready (UNSIGNED: CI/test only, never release it)' } else { 'staged' })" -ForegroundColor Green
Write-Host "  Commit   : $commit"
Write-Host "  Folder   : $Destination"
Write-Host ("  Content  : {0} files, {1:N1} MB" -f $all.Count, ($bytes / 1MB))
if ($Mode -eq 'Unsigned') {
    Write-Host "  ZIP      : $zipPath"
}
else {
    Write-Host "  Next     : the owner signs $manifestName in the staging folder (established procedure, last), then:"
    Write-Host "             .\tools\New-NoFridayMailPackage.ps1 -Mode Seal -Destination '$Destination' -Ref $Ref"
}
Write-Host ''
$all | ForEach-Object { '    {0}' -f $_ }
