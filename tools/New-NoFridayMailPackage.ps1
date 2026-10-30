#Requires -Version 7.4
<#
.SYNOPSIS
    NoFridayMail - builds the release package (ZIP) from a Git commit, with its PackageIntegrity.psd1 manifest.

.DESCRIPTION
    The release ZIP is derived from `git archive <Ref>`, the same rule set as GitHub's "Download ZIP": what the
    .gitattributes `export-ignore` lines leave out (tests, CI, development tools, agent notes) is not in the package,
    and nothing else is added except PackageIntegrity.psd1. The builder works on committed bytes only (it refuses a dirty
    tracked tree unless -AllowDirty), never rewrites a file, and never signs anything.

      1. ARCHIVE   git archive of -Ref into a fresh staging folder (bytes untouched).
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

# Paths that must never be distributed (regular expressions on the archive path, forward slashes).
$forbidden = @(
    '^tests/', '^\.github/', '^tools/preview/', '^previews/', '^dist/', '^out/', '(^|/)node_modules/', '^deploy/environments\.local/',
    '^AGENTS\.md$', '^PROVENANCE\.md$', '^\.gitattributes$', '^\.gitignore$', '^assets/.*\.svg$',
    '^tools/(New-NoFridayMailPackage\.ps1|Build-Documentation\.js|make-icons\.js|build-preview\.js)$',
    '(^|/)\.env(\..*)?$', '\.(pfx|pem|key|p12)$', '^deploy/environments/(?!example\.json$|prod\.json$)'
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
    'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'SECURITY.md', 'CHANGELOG.md'
)

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
$version = [string]((Invoke-Git @('show', "${commit}:package.json") | Out-String | ConvertFrom-Json).version)
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

function Expand-RefArchive {
    param([Parameter(Mandatory)][string]$Target)
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ("nfm-archive-{0}.zip" -f [Guid]::NewGuid().ToString('N'))
    try {
        Invoke-Git @('archive', '--format=zip', '-o', $temporary, $commit) | Out-Null
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($temporary, $Target)
    }
    finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

# ---- Seal: staging folder prepared by Stage and signed by the owner ----------------------------------------------------
if ($Mode -eq 'Seal') {
    if (-not (Test-Path -LiteralPath (Join-Path $Destination $manifestName))) { throw "Seal needs the staging folder prepared by Stage, with the owner-signed $manifestName : $Destination" }
    $fresh = Join-Path ([IO.Path]::GetTempPath()) ("nfm-seal-{0}" -f [Guid]::NewGuid().ToString('N'))
    try {
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

# SIG # Begin signature block
# MIImKgYJKoZIhvcNAQcCoIImGzCCJhcCAQExDzANBglghkgBZQMEAgEFADB5Bgor
# BgEEAYI3AgEEoGswaTA0BgorBgEEAYI3AgEeMCYCAwEAAAQQH8w7YFlLCE63JNLG
# KX7zUQIBAAIBAAIBAAIBAAIBADAxMA0GCWCGSAFlAwQCAQUABCCGdMKv0cA9c83I
# OMxxWsrPhm6eVlmJdqY8ySv1oHHruaCCDW8wggZyMIIEWqADAgECAghkM1HTxzif
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
# AQQBgjcCAQsxDjAMBgorBgEEAYI3AgEVMC8GCSqGSIb3DQEJBDEiBCCSpG6uLEK4
# R4C3acPECJNyANHWEtTCR1IRregvgeZEtjANBgkqhkiG9w0BAQEFAASCAgAVqbSD
# O35bH7mqySVCQZshNFLB1pl9cEsiMZFcBa8aPeWmODVOkU0w8489jjwD9YSpI7wf
# zkGV0kRl5TGf5JOQEh8rAu+o3nufcFOI8JPqJ963Btox7u7zynzctNgQIGSmziKN
# ZPHu77uD6h0jG7R+4lwjypTmZuhspx9qsKw2T/LIy6NjHmpLJnSP9iZ73kx37xff
# ibc/mDgOkGS0U9gzO6NSaphFEG1Z6CO74OZn943YK4wMpYpGZGGArKmgIYGmnYSX
# 9atyOsbVLahVlwxJknfyUTy9bmTZa9XRffdq2zSD8FNZ67JBGCTMyY15BzPZJLL4
# F0KFAlA8CEwiR/V/NhtZUoSfy2xIJqQ2Vk3rQtemt+WykSMmd3AiSDjCAdNgpXPd
# SsIWIhgOB/KCgN/44V82ZtuQri4WeeAWkN3uMxJFG0LPnzINLFEjR7NdNrm0sb+Z
# ajzWSP4CPRy6JgrIvLJAeVF33dX4loQgNjlcjas/J8lzsLCbhiflPletgyyrF+Hi
# +9/rNqRzSiCvCG/WQjRX4n2gHSjp3nu324NrymnR7ezeDs29NhQhC4YE33C14IQ4
# qFPszClfpUjiBFwmOqxc28zqAegsBtf6SvDTbVXVTgkmW4EaERUvcFnygQ9qjX9k
# BUYFUNzUUHWEOc1Pzez6V5u+iddfmEwzXJnuTaGCFM4wghTKBgorBgEEAYI3AwMB
# MYIUujCCFLYGCSqGSIb3DQEHAqCCFKcwghSjAgEDMQ0wCwYJYIZIAWUDBAIBMIGJ
# BgsqhkiG9w0BCRABBKB6BHgwdgIBAQYMKwYBBAGCqTABAwYBMDEwDQYJYIZIAWUD
# BAIBBQAEIGSeHkUcSuOPqJ14WAjsjthxIws3KEbj22Mgq/rgW+otAgg2e26H3r8e
# axgPMjAyNjEwMzAyMDM2NDJaMAMCAQECEBdstqWnULzzjlPT4vXVnaugghGnMIIE
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
# AQkQAQQwHAYJKoZIhvcNAQkFMQ8XDTI2MTAzMDIwMzY0MlowKAYJKoZIhvcNAQk0
# MRswGTALBglghkgBZQMEAgGhCgYIKoZIzj0EAwIwLwYJKoZIhvcNAQkEMSIEIOtI
# GFipRa1oft8zFEg/MgqpaCKvUloKjOvDGMEe2gGBMIHIBgsqhkiG9w0BCRACLzGB
# uDCBtTCBsjCBrwQgV0/qF6r6XnxqK5sIyZixc15FCzhzykTmokygkw5j87AwgYow
# dqR0MHIxCzAJBgNVBAYTAlVTMQ4wDAYDVQQIDAVUZXhhczEQMA4GA1UEBwwHSG91
# c3RvbjERMA8GA1UECgwIU1NMIENvcnAxLjAsBgNVBAMMJVNTTC5jb20gVGltZXN0
# YW1waW5nIElzc3VpbmcgUlNBIENBIDICEFRD+De9Wu4YAYRyuFzajuMwCgYIKoZI
# zj0EAwIERzBFAiBwCFpfWTwSfZERGpEPcCQ8WDldak5dPcm9h6OWVbRgpgIhAOX5
# 3TCGWJLKb2YqVH/fM7ZOQ9TwVfmTXHCNy30sOZxa
# SIG # End signature block
