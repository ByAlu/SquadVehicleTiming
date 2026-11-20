param(
    [string]$SdkRoot = 'C:\SqSDK\SquadEditor',
    [string[]]$Map = @(),
    [ValidateRange(4, 128)]
    [int]$SpacingMeters = 16
)

$ErrorActionPreference = 'Stop'
$sdk = (Resolve-Path -LiteralPath $SdkRoot).Path
$editor = Join-Path $sdk 'UnrealEngine\Engine\Binaries\Win64\UnrealEditor-Cmd.exe'
$project = Join-Path $sdk 'Squad\SquadGame.uproject'
$script = Join-Path $PSScriptRoot 'export-terrain.py'
$log = Join-Path ([IO.Path]::GetTempPath()) "SquadTerrainExport-$([Guid]::NewGuid()).log"

foreach ($path in @($editor, $project, $script)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required file not found: $path"
    }
}

$arguments = @(
    $project, '-run=pythonscript', "-script=$script", '-culture=en', '-stdout',
    '-nullrhi', '-unattended', '-nosplash', '-NoSourceControl', "-abslog=$log"
)
$previous = $env:SQUAD_ROUTE_TERRAIN_OPTIONS
try {
    $env:SQUAD_ROUTE_TERRAIN_OPTIONS = ConvertTo-Json -Compress -InputObject @{
        maps = @($Map)
        spacingMeters = $SpacingMeters
    }
    & $editor @arguments | Select-String -Pattern 'Squad terrain:|LogPython: Error'
    $editorExit = $LASTEXITCODE
}
finally {
    $env:SQUAD_ROUTE_TERRAIN_OPTIONS = $previous
}

if (-not (Test-Path -LiteralPath $log -PathType Leaf) -or
    -not (Select-String -LiteralPath $log -SimpleMatch 'Squad terrain: completed ' -Quiet)) {
    throw "Terrain export did not finish for all selected maps. See $log"
}
if ($editorExit -ne 0) {
    Write-Warning "The terrain files were written. Squad Editor reported diagnostics (exit $editorExit). See $log"
}
