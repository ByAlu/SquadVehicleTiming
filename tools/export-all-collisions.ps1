param(
    [string]$SdkRoot = 'C:\SqSDK\SquadEditor',
    [ValidateRange(2, 16)]
    [int]$SpacingMeters = 4
)

$ErrorActionPreference = 'Stop'
$catalogPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'sdk-data.js'
$catalog = (Get-Content -LiteralPath $catalogPath -Raw) -split 'window\.squadSdkData = ', 2
if ($catalog.Count -ne 2) {
    throw "SDK map catalog could not be read from $catalogPath."
}

$maps = @(($catalog[1].Trim().TrimEnd(';') | ConvertFrom-Json).maps |
    Where-Object { $_.sourceLayer })
if (!$maps.Count) {
    throw "No calibrated maps were found in $catalogPath."
}

$exporter = Join-Path $PSScriptRoot 'export-collision.ps1'
foreach ($map in $maps) {
    Write-Host "Exporting collision grid and water data for $($map.name)"
    & $exporter -SdkRoot $SdkRoot -Map $map.name -SpacingMeters $SpacingMeters
    & $exporter -SdkRoot $SdkRoot -Map $map.name -Water
}
