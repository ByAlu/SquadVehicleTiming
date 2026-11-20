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

The exporter runs the installed Unreal Editor Python commandlet. It writes one JSON file per vehicle to `vehicles/<faction>/<SDK row>.json` and rebuilds `vehicles/catalog.js` for direct browser launch. It reads the faction vehicle tables for display names and map icons. Running the SDK export again refreshes those JSON files from the SDK.

After editing vehicle JSON files, rebuild the browser catalog with `python tools/export-sdk.py --build-vehicles`. This command runs without the Squad SDK.

The exporter writes minimap world dimensions to `sdk-data.js` using the gameplay layers' `MinimapCornersPosition` property. A map without a readable scale asks for its full image width and height in meters. You can also override a supplied scale under **Map scale**.

## Vehicle physics data

Look for `sdkPhysics` in the individual vehicle JSON files. The exporter follows the SDK's vehicle settings to each Blueprint variant and reads its assigned movement configuration. Variants that share the same configuration are grouped. Each profile names its source Blueprint and, where available, its configuration asset.

- `body` includes configured mass in kg, aerodynamic coefficients, and slope-assist settings.
- `engine` includes RPM limits, the torque setting, engine rev rates, braking effect, and the torque curve. Inline curves use Unreal's struct text format, which retains the curve keys and interpolation settings. External curves name the SDK asset.
- `transmission`, `wheels`, and `tracks` record gearing, shift settings, radii in centimeters, and available braking and friction settings.
- `noSlipRpmLimitKmh` is a calculated forward or reverse speed at the engine's RPM limit, using the gearing and wheel or sprocket radius. It assumes no slip and enough power to reach the RPM limit. It is provided for ground movement where those inputs are available.

The SDK vehicle stats table has no rows in v10.6.1. Measured acceleration from rest, achievable top speed, and braking distance require a running vehicle under specified surface, slope, and driving conditions. A profile with only a Blueprint or movement class indicates that the extractor could link the variant but could not read a compatible motion configuration.

## How the estimate works

Route distance is the sum of the horizontal distances between consecutive points, using separate scales for the minimap's width and height. Travel time is that distance divided by the average route speed. The starting speed is a heuristic based on the SDK vehicle icon category. It can be replaced with a speed measured in-game. The route calculation uses the drawn line and does not simulate acceleration, terrain, or obstacles.
