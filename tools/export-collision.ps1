param(
    [string]$SdkRoot = 'C:\SqSDK\SquadEditor',
    [Parameter(Mandatory)]
    [string[]]$Map,
    [ValidateRange(2, 16)]
    [int]$SpacingMeters = 4
)

$ErrorActionPreference = 'Stop'
$sdk = (Resolve-Path -LiteralPath $SdkRoot).Path
$editor = Join-Path $sdk 'UnrealEngine\Engine\Binaries\Win64\UnrealEditor-Cmd.exe'
$project = Join-Path $sdk 'Squad\SquadGame.uproject'
$script = Join-Path $PSScriptRoot 'export-collision.py'
$log = Join-Path ([IO.Path]::GetTempPath()) "SquadCollisionExport-$([Guid]::NewGuid()).log"
$previous = $env:SQUAD_COLLISION_OPTIONS
try {
    $env:SQUAD_COLLISION_OPTIONS = ConvertTo-Json -Compress -InputObject @{ maps = @($Map); spacingMeters = $SpacingMeters }
    & $editor $project '-run=pythonscript' "-script=$script" '-culture=en' '-stdout' '-nullrhi' '-unattended' '-nosplash' '-NoSourceControl' "-abslog=$log" |
        Select-String -Pattern 'Squad collision:|Squad terrain: loaded|LogPython: Error'
    $editorExit = $LASTEXITCODE
} finally {
    $env:SQUAD_COLLISION_OPTIONS = $previous
}

if (-not (Test-Path -LiteralPath $log -PathType Leaf) -or
    -not (Select-String -LiteralPath $log -SimpleMatch 'Squad collision: completed export.' -Quiet)) {
    throw "Collision export did not finish. See $log"
}
if ($editorExit -ne 0) {
    Write-Warning "The collision files were written. Squad Editor reported diagnostics (exit $editorExit). See $log"
}
