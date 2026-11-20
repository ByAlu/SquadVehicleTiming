param(
    [string]$SdkRoot = 'C:\SqSDK\SquadEditor'
)

$ErrorActionPreference = 'Stop'
$sdk = (Resolve-Path -LiteralPath $SdkRoot).Path
$editor = Join-Path $sdk 'UnrealEngine\Engine\Binaries\Win64\UnrealEditor-Cmd.exe'
$project = Join-Path $sdk 'Squad\SquadGame.uproject'
$script = Join-Path $PSScriptRoot 'export-sdk.py'
$log = Join-Path ([IO.Path]::GetTempPath()) "SquadRouteExport-$([Guid]::NewGuid()).log"

foreach ($path in @($editor, $project, $script)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required file not found: $path"
    }
}

$arguments = @(
    $project, '-run=pythonscript', "-script=$script", '-culture=en',
    '-nullrhi', '-unattended', '-nosplash', '-NoSourceControl', "-abslog=$log"
)
& $editor @arguments | Select-String -Pattern 'Route Planner:|LogPython: Error'
$editorExit = $LASTEXITCODE

if (-not (Test-Path -LiteralPath $log -PathType Leaf) -or
    -not (Select-String -LiteralPath $log -SimpleMatch 'Route Planner: wrote ' -Quiet)) {
    throw "SDK export did not produce a catalog. See $log"
}
if ($editorExit -ne 0) {
    Write-Warning "The catalog was written. Squad Editor reported diagnostics (exit $editorExit). See $log"
}
