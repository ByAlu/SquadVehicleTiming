"""Read motion configuration through Unreal's Squad SDK Python API."""

import math
import re

import unreal


def read_property(obj, name):
    try:
        return obj.get_editor_property(name)
    except Exception:
        return None


def fields(obj, names):
    result = {}
    for name in names.split():
        value = read_property(obj, name)
        if type(value) in (int, float, bool) and math.isfinite(value):
            result[name] = value
    return result


def curve_data(curve):
    if curve is None:
        return None
    external = read_property(curve, "external_curve")
    if external:
        return {"asset": external.get_path_name()}
    text = curve.export_text()
    keys = re.search(r"\bKeys=\((\([^()]*\)(?:,\([^()]*\))*)\)", text)
    if not keys:
        return None
    # RuntimeFloatCurve keeps its inline keys protected. Unreal's struct export
    # preserves their values, interpolation, tangents, and extrapolation modes.
    return {"unrealText": text}


def config_data(asset):
    result = {"configAsset": asset.get_path_name(), "configClass": asset.get_class().get_name()}
    body = read_property(asset, "vehicle_config")
    result["body"] = fields(body, "mass width height drag_coefficient downforce_coefficient "
                                  "slope_braking_factor slope_boost_factor slope_boost_min_speed "
                                  "slope_boost_max_speed slope_boost_min_angle slope_boost_max_angle")
    engine = read_property(asset, "engine_config")
    result["engine"] = fields(engine, "idle_rpm max_rpm max_torque engine_braking_effect "
                                      "rev_up_rate_locked rev_up_rate_unlocked rev_down_rate_unlocked")
    torque_curve = curve_data(read_property(engine, "torque_curve"))
    if torque_curve:
        result["engine"]["torque_curve"] = torque_curve

    transmission = read_property(asset, "transmission_config")
    gears = fields(transmission, "final_drive_ratio automatic_transmission clutch_strength "
                                 "use_speed_for_shifting gear_switch_time gear_auto_box_latency")
    for name in ("forward_gear_ratios", "reverse_gear_ratios"):
        values = read_property(transmission, name)
        if values:
            gears[name] = [fields(gear, "ratio change_up_ratio change_down_ratio rpm_governor") for gear in values]
    result["transmission"] = gears

    tracks = read_property(asset, "track_config")
    radius_cm = None
    if tracks is not None:
        result["tracks"] = fields(tracks, "sprocket_radius sprocket_mass track_mass rolling_resistance "
                                         "brake_torque handbrake_torque friction_multiplier")
        radius_cm = result["tracks"].get("sprocket_radius")
    else:
        wheels = read_property(asset, "wheel_config")
        wheel_setups = read_property(wheels, "wheel_setup") or []
        wheel_data = []
        for setup in wheel_setups:
            wheel = read_property(setup, "wheel_data")
            settings = fields(wheel, "wheel_radius wheel_mass friction_multiplier max_brake_torque "
                                     "max_handbrake_torque torque_ratio max_steering_angle")
            bone = read_property(setup, "bone_name")
            if bone is not None:
                settings["bone_name"] = str(bone)
            if settings:
                wheel_data.append(settings)
        if wheel_data:
            result["wheels"] = wheel_data
            radii = {wheel.get("wheel_radius") for wheel in wheel_data}
            if len(radii) == 1:
                radius_cm = next(iter(radii))

    rpm = result["engine"].get("max_rpm")
    final_drive = gears.get("final_drive_ratio")
    if rpm and rpm > 0 and final_drive and final_drive > 0 and radius_cm and radius_cm > 0:
        limits = {}
        for direction in ("forward", "reverse"):
            speeds = []
            for gear in gears.get(f"{direction}_gear_ratios", []):
                ratio = abs(gear.get("ratio", 0))
                if ratio == 0:
                    continue
                governor = gear.get("rpm_governor", 0)
                gear_rpm = min(rpm, governor) if tracks is not None and governor > 0 else rpm
                speed = gear_rpm / (final_drive * ratio) * (2 * math.pi * radius_cm / 100) * 0.06
                speeds.append(round(speed, 2))
            if speeds:
                limits[direction] = max(speeds)
        if limits:
            result["noSlipRpmLimitKmh"] = limits
    return result


def enrich(vehicles, row_ids, vehicle_settings, sdk_version):
    registry = unreal.AssetRegistryHelpers.get_asset_registry()
    variants = {}
    settings = sorted(registry.get_assets_by_path(vehicle_settings, recursive=True),
                      key=lambda asset: str(asset.package_name))
    for asset in settings:
        if str(asset.asset_class_path.asset_name) != "BP_SQVehicleSettings_C":
            continue
        setting = asset.get_asset()
        row = read_property(setting, "data")
        if row is None or row.data_table is None:
            continue
        table_path = row.data_table.get_path_name().split(".", 1)[0]
        vehicle_id = row_ids.get(f"{table_path}:{row.row_name}")
        if vehicle_id is None:
            continue
        for version in read_property(setting, "VehicleVersions") or []:
            # Blueprint-defined struct members retain their generated suffix.
            blueprint = read_property(version, "Vehicle_6_F3193FEA4E8C11847F01B7B328A45158")
            if blueprint:
                variants.setdefault(vehicle_id, {})[blueprint.get_path_name()] = blueprint

    profiles = {}
    matched = 0
    configured = 0
    for vehicle in vehicles:
        blueprints = variants.get(vehicle["id"])
        if not blueprints:
            continue
        matched += 1
        groups = {}
        for path, blueprint in sorted(blueprints.items()):
            default = unreal.get_default_object(blueprint)
            movement = read_property(default, "vehicle_movement")
            movement_class = movement.get_class().get_name() if movement else None
            config = read_property(movement, "VehicleConfigAsset")
            config_path = config.get_path_name() if config else None
            key = (movement_class, config_path)
            if key not in groups:
                profile = {"blueprints": []}
                if movement_class:
                    profile["movementClass"] = movement_class
                if config_path:
                    if config_path not in profiles:
                        profiles[config_path] = config_data(config)
                    profile.update(profiles[config_path])
                    if vehicle["type"] in ("Boat", "Helicopter"):
                        profile.pop("noSlipRpmLimitKmh", None)
                groups[key] = profile
            groups[key]["blueprints"].append(path)
        if any("configAsset" in group for group in groups.values()):
            configured += 1
        vehicle["sdkPhysics"] = {"sdkVersion": sdk_version, "variants": list(groups.values())}
    unreal.log(f"Route Planner: linked {matched} vehicle records and extracted {len(profiles)} "
               f"physics assets for {configured} of them.")
    if not profiles:
        raise RuntimeError("No vehicle physics assets were found.")
