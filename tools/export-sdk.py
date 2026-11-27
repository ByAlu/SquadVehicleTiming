"""Export the installed Squad SDK's vehicle catalog and minimap scale."""

import ast
import json
import math
from pathlib import Path
import re
import runpy
import sys
from tempfile import NamedTemporaryFile


ROOT = Path(__file__).resolve().parents[1]
VEHICLE_ROOT = ROOT / "vehicles"
VEHICLE_SETTINGS = "/Game/Settings/Vehicle"

# Each entry pairs a repository minimap with a full-size SDK gameplay layer.
MAP_LAYERS = {
    "Al Basrah": "/Al_Basrah/Maps/Gameplay_Layer_Data/AlBasrah_AAS_v1",
    "Anvil": "Anvil/Anvil_AAS_v1",
    "Belaya Pass": "Belaya_Pass/Belaya_AAS_v1",
    "Black Coast": "/BlackCoast/Maps/Gameplay_Layer_Data/BlackCoast_AAS_v1",
    "Chora": "Chora/Chora_AAS_v1",
    "Fallujah": "Fallujah_City/Fallujah_AAS_v1",
    "Fool's Road": "Fools_Road/FoolsRoad_AAS_v1",
    "Goose Bay": "Goose_Bay/GooseBay_AAS_v1",
    "Gorodok": "Gorodok/Gorodok_AAS_v1",
    "Harju": "/Harju/Maps/Gameplay_Layer_Data/Harju_AAS_v1",
    "Kamdesh Highlands": "Kamdesh_Highlands/Kamdesh_AAS_v1",
    "Kohat Toi": "Kohat/Kohat_AAS_v1",
    "Kokan": "Kokan_Valley/Kokan_AAS_v1",
    "Lashkar Valley": "Lashkar_Valley/Lashkar_AAS_v1",
    "Logar Valley": "Logar_Valley/Logar_AAS_v1",
    "Manicouagan": "Manicouagan/Manicouagan_AAS_v1",
    "Mestia": "Mestia_Green/Mestia_AAS_v1",
    "Mutaha": "Mutaha/Mutaha_AAS_v1",
    "Narva": "Narva/Narva_AAS_v1",
    "Pacific Proving Grounds": "PacificProvingGrounds/PacificProvingGrounds_AAS_v1",
    "Sanxian Islands": "/SanxianIslands/Maps/Gameplay_Layer_Data/Sanxian_RAAS_v1",
    "Skorpo": "Skorpo/Skorpo_RAAS_v1",
    "Sumari Bala": "Sumari/Sumari_AAS_v1",
    "Tallil Outskirts": "Tallil_Outskirts/Tallil_AAS_v1",
    "Tutorials": "/Game/Maps/Tutorials/Gameplay_Layer_Data/Tutorial_Infantry",
    "Yehorivka": "Yehorivka/Yehorivka_AAS_v1",
}

# Representative average speeds by vehicle class, in km/h. Users can edit them.
ICON_PRESETS = {
    "helo": ("Helicopter", 150),
    "rhib": ("Boat", 50),
    "tank": ("Tank", 40),
    "trackedifv": ("Tracked IFV", 45),
    "trackedapc": ("Tracked APC", 45),
    "trackedjeep": ("Light tracked vehicle", 45),
    "ifv": ("Wheeled IFV", 50),
    "apc": ("Wheeled APC", 50),
    "mgs": ("Mobile gun system", 50),
    "truck": ("Truck", 50),
    "jeep": ("Light wheeled vehicle", 55),
    "bike": ("Bike", 55),
}

# These table rows lack a linked physics export. Use the matching SDK chassis
# for wading estimates without replacing the selected vehicle's driving model.
CHASSIS_FALLBACKS = {
    ("BAF", "BAF_FV432_1"): ("BAF", "BAF_FV432_L11A1_RWS"),
    ("CAF", "CAF_TAPV-M2"): ("CAF", "CAF_TAPV"),
    ("GFI", "GFI_BTR-80"): ("RGF", "RGF_BTR-80"),
    ("USMC", "USMC_M1151_M2_Open"): ("USMC", "USMC_M1151_M2"),
    ("USMC", "USMC_M1151_M240_Open"): ("USMC", "USMC_M1151_M240"),
    ("USMC", "USMC_M1151_Mk19_Open"): ("USMC", "USMC_M1151_Mk19"),
}


def display_text(value):
    if not value or "(" not in value:
        return value
    # DataTable JSON serializes FText as NSLOCTEXT or LOCTEXT expressions.
    match = re.search(r'("(?:\\.|[^"\\])*")\s*\)$', value)
    return ast.literal_eval(match.group(1)) if match else value


def property_value(obj, name):
    try:
        return obj.get_editor_property(name)
    except Exception:
        return None


def get_vehicles():
    registry = unreal.AssetRegistryHelpers.get_asset_registry()
    registry.scan_paths_synchronous([VEHICLE_SETTINGS], True)
    vehicles = []
    for asset in registry.get_assets_by_path(VEHICLE_SETTINGS, recursive=True):
        if not str(asset.asset_name).startswith("DT_VehicleTable_"):
            continue
        faction = str(asset.package_path).rsplit("/", 1)[-1]
        table = asset.get_asset()
        rows = json.loads(unreal.DataTableFunctionLibrary.export_data_table_to_json_string(table))
        for row in rows:
            name = display_text(row.get("DisplayName"))
            if not name or name.lower() == "none":
                continue
            icon = row.get("Icon", "").rsplit("/", 1)[-1].split(".")[0].lower()
            if any(word in icon for word in ("emplacement", "emplaced", "static", "drone", "uav")):
                continue
            hints = icon.replace("antitank", "")
            for prefix, hint in (("rhib", "rhib"), ("loach", "helo"), ("minsk", "bike"), ("quad bike", "bike")):
                if name.lower().startswith(prefix):
                    hints += f" {hint}"
                    break
            vehicle_type, speed = next((preset for word, preset in ICON_PRESETS.items() if word in hints),
                                       ("", 45))
            vehicles.append({
                "id": f"{asset.package_name}:{row['Name']}",
                "name": name,
                "faction": faction,
                "type": vehicle_type,
                "assumedSpeedKmh": speed,
            })
    distinct = {}
    row_ids = {}
    for vehicle in sorted(vehicles, key=lambda item: item["id"]):
        key = (vehicle["faction"], vehicle["name"].casefold(), vehicle["type"])
        canonical = distinct.setdefault(key, vehicle)
        row_ids[vehicle["id"]] = canonical["id"]
    return [distinct[key] for key in sorted(distinct)], row_ids


def get_map(name):
    result = {"name": name}
    layer = MAP_LAYERS.get(name)
    if not layer:
        return result
    if not layer.startswith("/"):
        folder, layer_name = layer.split("/")
        layer = f"/Game/Maps/{folder}/Gameplay_Layer_Data/{layer_name}"
    asset = unreal.load_asset(layer)
    if asset is None:
        return result
    bounds = property_value(asset, "MinimapCornersPosition")
    if bounds and bounds.is_valid:
        width = round(abs(bounds.max.x - bounds.min.x) / 100, 3)
        height = round(abs(bounds.max.y - bounds.min.y) / 100, 3)
        if width >= 1 and height >= 1:
            result.update(widthMeters=width, heightMeters=height, scaleLabel="SDK layer scale",
                          sourceLayer=layer)
    return result


def vehicle_path(vehicle):
    faction = vehicle["faction"]
    row = vehicle["id"].rsplit(":", 1)[-1]
    if any(not re.fullmatch(r"[A-Za-z0-9_ -]+", part) for part in (faction, row)):
        raise ValueError(f"Invalid faction or row name for {vehicle['id']}.")
    return VEHICLE_ROOT / faction / f"{row}.json"


def write_text(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file() and path.read_text(encoding="utf-8") == content:
        return
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as output:
        temporary = Path(output.name)
        output.write(content)
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def write_vehicle_files(vehicles):
    records = {}
    for vehicle in vehicles:
        path = vehicle_path(vehicle)
        key = path.as_posix().casefold()
        if key in records:
            raise ValueError(f"Vehicle rows share the same JSON file at {path}.")
        records[key] = (path, vehicle)

    for path, vehicle in records.values():
        write_text(path, json.dumps(vehicle, indent=2, ensure_ascii=False) + "\n")

    for path in VEHICLE_ROOT.glob("*/*.json"):
        if path.as_posix().casefold() in records:
            continue
        vehicle = json.loads(path.read_text(encoding="utf-8"))
        if vehicle["id"].startswith(VEHICLE_SETTINGS + "/") and path == vehicle_path(vehicle):
            path.unlink()


def water_model(variant):
    water = variant.get("waterMotion")
    if not water:
        return None
    body = variant.get("body", {})
    area = water.get("surfaceAreaCm2")
    if area == 0:
        width, height = body.get("width"), body.get("height")
        if not all(type(value) in (int, float) and math.isfinite(value) and value > 0 for value in (width, height)):
            return None
        area = width * height
    result = {**water, "surfaceAreaCm2": area, "massKg": body.get("mass")}
    if all(type(value) in (int, float) and math.isfinite(value) and value > 0 for value in result.values()):
        return result
    return None


def vehicle_width(variant):
    width = variant.get("body", {}).get("width")
    if type(width) in (int, float) and math.isfinite(width) and width > 0:
        return width / 100
    return None


def driving_profile(variant):
    speed_limit = variant.get("noSlipRpmLimitKmh", {}).get("forward")
    body = variant.get("body", {})
    engine = variant.get("engine", {})
    transmission = variant.get("transmission", {})
    mass = body.get("mass")
    final_drive = transmission.get("final_drive_ratio")
    max_rpm = engine.get("max_rpm")
    torque_scale = engine.get("max_torque")
    if not all(value and math.isfinite(value) and value > 0
               for value in (speed_limit, mass, final_drive, max_rpm, torque_scale)):
        return None

    curve = engine.get("torque_curve", {}).get("unrealText", "")
    keys = re.search(r"\bKeys=\((\([^()]*\)(?:,\([^()]*\))*)\)", curve)
    if not keys or "TangentWeightMode=RCTWM_Weighted" in curve:
        return None
    for field in ("PreInfinityExtrap", "PostInfinityExtrap"):
        mode = re.search(rf"\b{field}=(\w+)", curve)
        if mode and mode.group(1) != "RCCE_Constant":
            return None
    torque = []
    for entry in re.findall(r"\(([^()]*)\)", keys.group(1)):
        key = dict(field.split("=", 1) for field in entry.split(",") if field)
        torque.append({
            "rpm": float(key.get("Time", 0)),
            "nm": float(key.get("Value", 0)) * torque_scale,
            "mode": key.get("InterpMode", "RCIM_Linear").removeprefix("RCIM_").lower(),
            "arrive": float(key.get("ArriveTangent", 0)) * torque_scale,
            "leave": float(key.get("LeaveTangent", 0)) * torque_scale,
        })
    if not any(key["nm"] > 0 for key in torque):
        return None

    tracks = variant.get("tracks")
    if tracks:
        radius = tracks.get("sprocket_radius", 0) / 100
        brake_torque = 2 * tracks.get("brake_torque", 0)
        friction_values = [tracks.get("friction_multiplier")]
    else:
        wheels = variant.get("wheels", [])
        radii = {wheel.get("wheel_radius", 0) / 100 for wheel in wheels}
        if len(radii) != 1:
            return None
        radius = next(iter(radii))
        brake_torque = sum(wheel.get("max_brake_torque", 0) for wheel in wheels)
        friction_values = [wheel.get("friction_multiplier") for wheel in wheels]
    if not (radius > 0 and brake_torque > 0):
        return None

    gears = []
    for gear in transmission.get("forward_gear_ratios", []):
        ratio = gear.get("ratio", 0)
        if ratio <= 0:
            continue
        governor = gear.get("rpm_governor", 0)
        limit_rpm = min(max_rpm, governor) if tracks and governor > 0 else max_rpm
        shift_ratio = gear.get("change_up_ratio", 0) if transmission.get("automatic_transmission") else 1
        gears.append({
            "ratio": ratio * final_drive,
            "limitRpm": limit_rpm,
            "shiftRpm": min(limit_rpm, max_rpm * shift_ratio) if shift_ratio > 0 else limit_rpm,
        })
    if not gears:
        return None
    blueprint = variant["blueprints"][0].rsplit(".", 1)[-1]
    profile = {
        "name": blueprint.removeprefix("BP_").removesuffix("_C").replace("_", " "),
        "massKg": mass,
        "tracked": bool(tracks),
        "radiusMeters": radius,
        "idleRpm": engine.get("idle_rpm", 0),
        "speedLimitKmh": speed_limit,
        "brakeTorqueNm": brake_torque,
        "shiftSeconds": max(0, transmission.get("gear_switch_time", 0)),
        "gears": gears,
        "torque": torque,
    }
    if width := vehicle_width(variant):
        profile["widthMeters"] = width
    if all(type(value) in (int, float) and math.isfinite(value) and value > 0 for value in friction_values):
        profile["frictionMultiplier"] = round(sum(friction_values) / len(friction_values), 6)
    slope = {
        "brakingFactor": body.get("slope_braking_factor"),
        "boostFactor": body.get("slope_boost_factor"),
        "minSpeedKmh": body.get("slope_boost_min_speed"),
        "maxSpeedKmh": body.get("slope_boost_max_speed"),
        "minAngleDegrees": body.get("slope_boost_min_angle"),
        "maxAngleDegrees": body.get("slope_boost_max_angle"),
    }
    if all(type(value) in (int, float) and math.isfinite(value) and value >= 0 for value in slope.values()):
        profile["slope"] = {key: round(value, 6) for key, value in slope.items()}
    if variant.get("amphibious"):
        profile["amphibious"] = True
        if water := water_model(variant):
            profile["waterMotion"] = water
    return profile


def wading_profile(variant):
    wheels = variant.get("wheels", [])
    if not wheels or variant.get("tracks"):
        return None
    radii = [wheel.get("wheel_radius", 0) for wheel in wheels]
    transmission = variant.get("transmission", {})
    final_drive = transmission.get("final_drive_ratio", 0)
    max_rpm = variant.get("engine", {}).get("max_rpm", 0)
    if not all(type(value) in (int, float) and math.isfinite(value) and value > 0
               for value in (*radii, final_drive, max_rpm)):
        return None

    # Water reaches the smallest wheel first on configurations with mixed radii.
    radius = min(radii) / 100
    gears = [{"ratio": gear["ratio"] * final_drive, "limitRpm": max_rpm}
             for gear in transmission.get("forward_gear_ratios", [])
             if gear.get("ratio", 0) > 0]
    if not gears:
        return None
    speed_limit = 2 * math.pi * radius * max_rpm * 0.06 / min(gear["ratio"] for gear in gears)
    return {"radiusMeters": radius, "speedLimitKmh": speed_limit, "gears": gears[:2]}


def build_vehicle_catalog():
    vehicles = []
    variants_by_row = {}
    for path in VEHICLE_ROOT.glob("*/*.json"):
        vehicle = json.loads(path.read_text(encoding="utf-8"))
        if path != vehicle_path(vehicle):
            raise ValueError(f"{path} must match the faction and row name in the vehicle record.")
        variants_by_row[vehicle["faction"], path.stem] = vehicle.pop("sdkPhysics", {}).get("variants", [])
        vehicles.append(vehicle)
    if not vehicles:
        raise RuntimeError("No vehicle JSON files were found.")
    vehicles.sort(key=lambda vehicle: (vehicle["faction"], vehicle["name"].casefold(), vehicle["type"]))
    for vehicle in vehicles:
        row = (vehicle["faction"], vehicle_path(vehicle).stem)
        variants = variants_by_row[row]
        chassis_variants = variants or variants_by_row.get(CHASSIS_FALLBACKS.get(row), [])
        if vehicle["type"] not in ("Boat", "Helicopter"):
            width = max((value for variant in chassis_variants if (value := vehicle_width(variant))), default=0)
            if width:
                vehicle["widthMeters"] = width
        profiles = [profile for variant in variants if (profile := driving_profile(variant))]
        if profiles:
            vehicle["drivingProfiles"] = profiles
        elif variants and all(variant.get("amphibious") for variant in variants):
            vehicle["amphibious"] = True
            water = water_model(variants[0])
            if water and all(water_model(variant) == water for variant in variants):
                vehicle["waterMotion"] = water
        if not profiles and vehicle["type"] not in ("Boat", "Helicopter") and chassis_variants:
            wading = wading_profile(chassis_variants[0])
            if wading and all(wading_profile(variant) == wading for variant in chassis_variants[1:]):
                vehicle["wadingProfile"] = wading
    rows = ",\n".join(f"  {json.dumps(vehicle, ensure_ascii=False)}" for vehicle in vehicles)
    output = VEHICLE_ROOT / "catalog.js"
    write_text(output, f"// Generated from the faction JSON files by tools/export-sdk.py.\n"
                       f"window.squadVehicles = [\n{rows}\n];\n")
    return output


def write_map_data(version, maps):
    rows = ",\n".join(f"    {json.dumps(item, ensure_ascii=False)}" for item in maps)
    output = ROOT / "sdk-data.js"
    write_text(output, f"// Generated by tools/export-sdk.ps1 from the installed Squad SDK.\n"
                       f"window.squadSdkData = {{\n"
                       f'  "version": {json.dumps(version)},\n'
                       f'  "maps": [\n{rows}\n  ]\n'
                       f"}};\n")
    return output


def main():
    vehicles, row_ids = get_vehicles()
    if not vehicles:
        raise RuntimeError("No vehicle settings were found in the Squad SDK.")
    unreal.log(f"Route Planner: exported {len(vehicles)} vehicle entries.")
    map_names = sorted((path.parent.name for path in (ROOT / "maps").glob("*/minimap.webp")), key=str.casefold)
    if not map_names:
        raise RuntimeError("No minimap images were found in the repository.")
    maps = []
    for name in map_names:
        result = get_map(name)
        maps.append(result)
        unreal.log(f"Route Planner: {result}")
    project = Path(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir()))
    version = (project / "version.txt").read_text(encoding="utf-8").strip()
    physics = runpy.run_path(str(Path(__file__).with_name("vehicle_physics.py")))
    physics["enrich"](vehicles, row_ids, VEHICLE_SETTINGS, version)
    write_vehicle_files(vehicles)
    catalog = build_vehicle_catalog()
    maps_file = write_map_data(version, maps)
    unreal.log(f"Route Planner: wrote {catalog} and {maps_file}.")


if __name__ == "__main__":
    if sys.argv[1:] == ["--build-vehicles"]:
        print(f"Wrote {build_vehicle_catalog()}")
    else:
        import unreal

        main()
