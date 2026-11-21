# Squad Vehicle Timing

Open `index.html` in a browser. The planner runs locally using the bundled SDK catalog and the repository's minimaps.

1. In the right sidebar, choose a map and a faction, select a vehicle, and click **Add vehicle**. Repeat across factions to compare vehicles on the same route. Each selected vehicle has a color shared by its name and node times.
2. Click the minimap in Draw mode to add a numbered node. Select an existing node and click an empty spot to start a new branch from it. Right-click a node to remove it and reconnect its children to its parent. If you remove node 1, its first child becomes the new start. Undo reverses the last addition or removal.
3. The ETA and average speed update as you draw or change vehicles. For ground vehicles, the estimate uses the map's terrain where available. Choose a vehicle configuration if prompted. Ground vehicles without a usable driving profile use your average speed on firm, flat ground as the starting point.
4. Scroll over the map to zoom in or out around your pointer. Use Pan to move the map and the percentage button to fit the whole map again.
5. To auto-route a link, select its destination node, choose a ground vehicle under **Auto-route vehicle**, and click **Auto-route link**. The link starts at the node's parent. The planner draws the resulting path and recomputes ETAs for all selected vehicles. **Remove auto-route** restores the straight link. Undo reverses either change.

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

The exporter also builds each map's compressed browser bundle. After editing the JSON grids, run `python tools/build-terrain.py` to rebuild the bundles. The planner loads one map at a time, including when opened directly from disk in a current browser.

## Vehicle collision data

Logar Valley includes a collision grid. Export a grid for another calibrated map from the repository in PowerShell by passing its name to `-Map`.

```powershell
.\tools\export-collision.ps1 -Map 'Logar Valley' -SpacingMeters 4
```

The exporter loads gameplay geometry and traces the SDK's `Vehicle` collision profile. A downward trace finds landscape or a road or bridge surface. A box probe above that surface records blockers inside each grid cell, including small walls that a terrain sample can miss. Rows in `maps/<map>/collision.js` use `#` for a blocker, `.` for no hit, and `?` when no support surface could be identified.

The planner highlights blocked ground links and withholds ground-vehicle ETAs for paths through them. Auto-routing avoids detected blockers. Missing collision data and unsampled cells are reported separately. This is a single-height, static collision grid with one probe size. Clearance can differ for individual vehicles, underpasses, and objects that appear during a match.

## How the estimate works

The displayed distance is horizontal map distance. The displayed average speed divides that distance by the estimated time.

Each node shows the elapsed travel time for every selected vehicle along its own path from node 1, which starts at 0 seconds. The sidebar compares the estimates for the highlighted path to the selected node. Speed carries through intermediate nodes, and terrain beyond a node is outside that node's estimate. Each time is rounded for display.

The driving estimate starts at rest, accelerates at full throttle through the forward gears, and cruises if there is enough distance. The vehicle passes every node at the fastest speed the model allows, including the destination. The estimate uses the variant's engine torque curve, gearing, shift time, mass, wheel or sprocket radius, and brake torque. The gearing limit caps the modeled speed.

The terrain model samples short segments along the route. It projects the SDK slope onto the direction of travel and uses nearby elevation samples when the slope is unavailable. Uphill grades reduce acceleration and speed. Downhill grades reduce braking and the target speed, with more acceleration available. Surface type and SDK material friction adjust speed and grip. Wheeled vehicles receive larger pace reductions on soft ground than tracked vehicles. The model carries speed between segments and allows braking distance before a lower speed limit.

Auto-routing searches the terrain grid by estimated cruising time, using surface pace and elevation changes for the chosen vehicle. It excludes mapped water, missing terrain, steps steeper than a 45% grade, and known collision cells. If a direct link is passable, the planner compares it with the grid route using the vehicle timing model. The search still uses the coarser terrain grid for its waypoints, so it can miss narrow passages even where collision data is available.

Surface and grade adjustments are estimates. The base model uses 85% drivetrain efficiency and a grip limit of 0.55 g on firm ground. Unknown material uses firm-ground grip, and gaps in terrain coverage use level ground. The app reports sampled and classified portions of the route. Obstacle clearance, water crossings, and turning speed require separate checks.

Ground vehicles without a physics profile use their editable average speed with surface and grade adjustments. Helicopters and boats use their editable average route speed.
