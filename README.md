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

## How the estimate works

Route distance is the sum of the horizontal distances between consecutive points, using separate scales for the minimap's width and height.

The driving estimate starts at rest, accelerates at full throttle through the forward gears, cruises if there is enough distance, and brakes to rest at the end. It uses the variant's engine torque curve, gearing, shift time, mass, wheel or sprocket radius, and brake torque. The gearing limit and optional driver speed limit cap the modeled speed.

The model assumes flat, firm ground, 85% drivetrain efficiency, and an acceleration and braking grip limit of 0.55 g. Bends add distance. Slopes, surface changes, cornering losses, and obstacles are outside the model. Use an optional speed limit for routes where you expect lower speeds.

The average-speed estimate covers vehicles without the necessary SDK inputs, including helicopters and boats. Its starting value is based on the vehicle category and can be replaced with a measured average.
