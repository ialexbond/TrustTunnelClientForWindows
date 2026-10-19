[CmdletBinding()]
param(
    [string]$ArchivePath,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$inputLock = Get-Content -LiteralPath (Join-Path $repoRoot 'config/windows-core.lock.json') -Raw | ConvertFrom-Json

Push-Location $repoRoot
try {
    & node (Join-Path $PSScriptRoot 'windows-build-inputs.cjs') --sources-only
    if ($LASTEXITCODE -ne 0) { throw 'The native sources require a newly built core.' }

    $ready = $true
    foreach ($resource in $inputLock.files) {
        $target = Join-Path $repoRoot $resource.path
        if (!(Test-Path -LiteralPath $target -PathType Leaf) -or
            (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $resource.sha256) {
            $ready = $false
        }
    }
    if (!$ready) {
        if ($ValidateOnly) { throw 'Build resources are missing or differ from their verified checksums.' }
        $cache = Join-Path $repoRoot '.build-inputs'
        New-Item -ItemType Directory -Path $cache -Force | Out-Null
        if (!$ArchivePath) {
            $ArchivePath = Join-Path $cache ($inputLock.archive.sha256 + '.zip')
            $cachedArchiveValid = (Test-Path -LiteralPath $ArchivePath -PathType Leaf) -and
                (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $inputLock.archive.sha256
            if (!$cachedArchiveValid) {
                $downloadTemporary = Join-Path $cache ('download-' + [Guid]::NewGuid().ToString('N') + '.tmp')
                try {
                    Invoke-WebRequest -UseBasicParsing -Uri $inputLock.archive.url -OutFile $downloadTemporary
                    if ((Get-FileHash -LiteralPath $downloadTemporary -Algorithm SHA256).Hash.ToLowerInvariant() -cne $inputLock.archive.sha256) {
                        throw 'The downloaded build archive failed checksum verification.'
                    }
                    Copy-Item -LiteralPath $downloadTemporary -Destination $ArchivePath -Force
                } finally {
                    if (Test-Path -LiteralPath $downloadTemporary -PathType Leaf) {
                        Remove-Item -LiteralPath $downloadTemporary -Force
                    }
                }
            }
        }
        if ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $inputLock.archive.sha256) {
            throw 'The build-resource archive failed checksum verification. Nothing was copied.'
        }
        $expanded = Join-Path $cache ('verified-' + [Guid]::NewGuid().ToString('N'))
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $expanded
        foreach ($resource in $inputLock.files) {
            $inputFile = Join-Path $expanded $resource.name
            if ((Get-FileHash -LiteralPath $inputFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $resource.sha256) {
                throw ('A resource inside the archive failed verification: ' + $resource.name)
            }
        }
        foreach ($resource in $inputLock.files) {
            Copy-Item -LiteralPath (Join-Path $expanded $resource.name) -Destination (Join-Path $repoRoot $resource.path)
        }
    }
    & node (Join-Path $PSScriptRoot 'windows-build-inputs.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Build-resource verification failed.' }
    & node (Join-Path $PSScriptRoot 'core-compatibility-gate.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'The core does not support the application contract.' }
    Write-Output 'Build resources are ready. No application was installed or connected.'
} finally {
    Pop-Location
}
