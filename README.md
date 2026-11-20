# Squad Route Planner

Open `index.html` in a browser. The planner runs locally using the bundled SDK catalog and the repository's minimaps.

1. Choose a map and a vehicle. The vehicle list is grouped by faction.
2. Click the minimap to add waypoints or drag to trace a route. Undo removes the last click or drag. Pan and the zoom controls help with detailed routes.
3. The estimate updates as you draw or change vehicles. Where SDK driving data is available, choose a vehicle configuration if prompted and optionally set a **Speed limit**. Vehicles without a usable driving profile use the editable **Average route speed**.

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

## Terrain data

Export the terrain grid for one or more maps from the repository in PowerShell. Use `-SpacingMeters` to trade file size and export time for finer samples.

```powershell
.\tools\export-terrain.ps1 -Map 'Yehorivka','Logar Valley' -SpacingMeters 16
```

Omit `-Map` to export the maps with calibrated SDK bounds in `sdk-data.js`. The editor loads the gameplay worlds locally and writes `maps/<map>/terrain.json`. Loading a map for the first time may take several minutes while Unreal builds cached assets.

The rows follow the minimap from top to bottom and the cells from left to right. Each cell samples the center of its grid square. Use `floor(u × columns)` and `floor(v × rows)` for normalized minimap coordinates, clamping the right and bottom edges to the last column and row. The grid metadata gives the world origin, directions, and actual sample spacing.

Each hit stores **world Z in decimeters**, **grade to the right**, **grade downward**, and a **surface index**. The elevation datum is the Unreal map's Z origin. A grade of 100 represents a 10% climb. For a route heading given as a unit vector in map meters, multiply each grade by its matching heading component and add them to get the directional grade. Surface entries preserve the SDK physical surface name, collision source, material asset, and friction values where available.

A `null` cell means the vehicle collision trace found no blocking surface. The scan skips invisible collision volumes and instanced foliage. It can still hit roads, bridges, roofs, and other solid geometry. Water that only overlaps vehicles may appear as the riverbed below. Narrow features can fall between samples.

`materialSource` records how the physical material was resolved. A trace result or a collision override identifies the material directly. A mesh material or landscape default is a fallback. An unknown surface still carries elevation and grade when its collision was sampled.

## How the estimate works

Route distance is the sum of the horizontal distances between consecutive points, using separate scales for the minimap's width and height.

The driving estimate starts at rest, accelerates at full throttle through the forward gears, cruises if there is enough distance, and brakes to rest at the end. It uses the variant's engine torque curve, gearing, shift time, mass, wheel or sprocket radius, and brake torque. The gearing limit and optional driver speed limit cap the modeled speed.

The model assumes flat, firm ground, 85% drivetrain efficiency, and an acceleration and braking grip limit of 0.55 g. Bends add distance. Slopes, surface changes, cornering losses, and obstacles are outside the model. Use an optional speed limit for routes where you expect lower speeds.

The average-speed estimate covers vehicles without the necessary SDK inputs, including helicopters and boats. Its starting value is based on the vehicle category and can be replaced with a measured average.
