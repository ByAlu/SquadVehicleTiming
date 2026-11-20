"""Export the installed Squad SDK's vehicle catalog and minimap scale."""

import ast
import json
from pathlib import Path
import re

import unreal


ROOT = Path(__file__).resolve().parents[1]
PROJECT = Path(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir()))
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
    for vehicle in sorted(vehicles, key=lambda item: item["id"]):
        key = (vehicle["faction"], vehicle["name"].casefold(), vehicle["type"])
        distinct.setdefault(key, vehicle)
    return [distinct[key] for key in sorted(distinct)]


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
        height = round(abs(bounds.max.x - bounds.min.x) / 100, 3)
        width = round(abs(bounds.max.y - bounds.min.y) / 100, 3)
        if width >= 1 and height >= 1:
            result.update(widthMeters=width, heightMeters=height, scaleLabel="SDK layer scale",
                          sourceLayer=layer)
    return result


def main():
    vehicles = get_vehicles()
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
    version = (PROJECT / "version.txt").read_text(encoding="utf-8").strip()
    lines = [
        "// Generated by tools/export-sdk.ps1 from the installed Squad SDK.",
        "window.squadSdkData = {",
        f"  \"version\": {json.dumps(version)},",
    ]
    for index, (key, items) in enumerate((("maps", maps), ("vehicles", vehicles))):
        lines.append(f'  "{key}": [')
        lines.append(",\n".join(f"    {json.dumps(item, ensure_ascii=False)}" for item in items))
        lines.append("  ]," if index == 0 else "  ]")
    lines.extend(["};", ""])
    output = ROOT / "sdk-data.js"
    temporary = output.with_suffix(".tmp")
    temporary.write_text("\n".join(lines), encoding="utf-8")
    temporary.replace(output)
    unreal.log(f"Route Planner: wrote {output}.")


if __name__ == "__main__":
    main()
