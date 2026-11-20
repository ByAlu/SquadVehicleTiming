# Squad Route Planner

Open `index.html` in a browser. The planner runs locally using the bundled SDK catalog and the repository's minimaps.

1. Choose a map and a vehicle. The vehicle list is grouped by faction.
2. Click the minimap to add waypoints or drag to trace a route. Undo removes the last click or drag. Pan and the zoom controls help with detailed routes.
3. Adjust **Average route speed** for the way you expect to drive or fly. The distance and estimated time update as you edit the route or change vehicles.

## Refresh the SDK data

Run this from the repository in PowerShell. Use `-SdkRoot` if Squad Editor is installed elsewhere.

```powershell
.\tools\export-sdk.ps1 -SdkRoot 'C:\SqSDK\SquadEditor'
```

The exporter runs the installed Unreal Editor Python commandlet and regenerates `sdk-data.js`. It reads the faction vehicle tables for display names and map icons. It reads minimap world dimensions from the gameplay layers' `MinimapCornersPosition` property for the bundled map images. A map without a readable scale asks for its full image width and height in meters. You can also override a supplied scale under **Map scale**.

## How the estimate works

Route distance is the sum of the horizontal distances between consecutive points, using separate scales for the minimap's width and height. Travel time is that distance divided by the average route speed. The starting speed is a heuristic based on the SDK vehicle icon category. It can be replaced with a speed measured in-game. The route calculation uses the drawn line and does not simulate acceleration, terrain, or obstacles.
