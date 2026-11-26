"""Export sampled vehicle collision cells from Squad gameplay worlds."""

from array import array
from base64 import b64decode, b64encode
import gzip
import json
import math
import os
from pathlib import Path
import re
import runpy
import sys
from tempfile import NamedTemporaryFile

import unreal


ROOT = Path(__file__).resolve().parents[1]
TERRAIN = runpy.run_path(str(Path(__file__).with_name("export-terrain.py")))
COLLIDERS = runpy.run_path(str(Path(__file__).with_name("export-collider-objects.py")))
PROFILE = "Vehicle"
TRACE = unreal.SystemLibrary
DEBUG = unreal.DrawDebugTrace.NONE
SURFACE_NAMES = re.compile(r"(?:^|[^a-z])(road|bridge|asphalt|street)\d*(?:[^a-z]|$)", re.I)
DEEP_WATER_CM = 150
WADING_WATER_CM = 10
# Tallil's water crossings are shallow enough for ground vehicles.
SHALLOW_WATER_MAPS = {"Tallil Outskirts"}
WATER_OUTPUT = ROOT / "water-data.js"
WATER_ASSIGNMENT = "window.squadWaterData = "
WADING_OUTPUT = ROOT / "wading-water-data.js"
WADING_ASSIGNMENT = "window.squadWadingWaterData = "


def is_support(component, actor, cache):
    if component not in cache:
        kind = component.get_class().get_name()
        label = actor.get_actor_label() if actor else ""
        mesh = TERRAIN["SDK"]["property_value"](component, "static_mesh")
        mesh_name = mesh.get_name() if mesh else ""
        # Harju's drivable track splines belong to the same actor as the landscape heightfield.
        track_spline = mesh_name == "Tracks_x3" and isinstance(component, unreal.SplineMeshComponent)
        roadway = track_spline or bool(SURFACE_NAMES.search(f"{label} {mesh_name}"))
        cache[component] = (kind.startswith("Landscape"), roadway)
    return cache[component]


def layer_zone_actors():
    actor_subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    zone_types = (unreal.SQTeamPrep, unreal.SQProtectionZone)
    return [actor for actor in actor_subsystem.get_all_level_actors() if isinstance(actor, zone_types)]


def find_support(world, x, y, cache, ignored_actors=()):
    ignored = list(ignored_actors)
    start = unreal.Vector(x, y, 250000)
    end = unreal.Vector(x, y, -250000)
    while True:
        hit = TRACE.line_trace_single_by_profile(world, start, end, PROFILE, True, ignored, DEBUG, False)
        if hit is None:
            return None
        blocking, _, _, _, _, impact, _, normal, _, actor, component, *_ = hit.to_tuple()
        if not blocking or actor is None or component is None or actor in ignored:
            return None
        landscape, roadway = is_support(component, actor, cache)
        if landscape or (roadway and normal.z >= 0.7):
            return impact.z, normal, actor if landscape else None
        ignored.append(actor)


def check_cell(world, x, y, dx, dy, cache, ignored_actors=()):
    support = find_support(world, x, y, cache, ignored_actors)
    if support is None:
        return "?", -32768
    z, normal, landscape = support
    # Raise the probe enough to clear the support plane at the uphill corner.
    rise = (abs(normal.x) * dx + abs(normal.y) * dy) / (2 * max(normal.z, 0.7))
    center = unreal.Vector(x, y, z + 145 + rise)
    end = unreal.Vector(x, y, center.z - 1)
    extent = unreal.Vector(dx / 2, dy / 2, 100)
    ignored = list(ignored_actors)
    if landscape:
        ignored.append(landscape)
    hit = TRACE.box_trace_single_by_profile(world, center, end, extent, unreal.Rotator(), PROFILE,
                                           False, ignored, DEBUG, False)
    return ("#" if hit is not None and hit.to_tuple()[0] else "."), round(z / 10)


def scan_water(collision, columns, rows, bounds, minimum_depth_cm, include_unsupported, *, record_depth=False):
    heights = array("h")
    heights.frombytes(b64decode(collision["elevationDmInt16Le"]))
    if sys.byteorder != "little":
        heights.byteswap()
    x_min, x_max = sorted((bounds.min.x, bounds.max.x))
    y_min, y_max = sorted((bounds.min.y, bounds.max.y))
    dx = (x_max - x_min) / columns
    dy = (y_max - y_min) / rows
    xs = [x_min + (column + 0.5) * dx for column in range(columns)]
    ys = [y_min + (row + 0.5) * dy for row in range(rows)]
    water = bytearray(columns * rows)
    # Vehicle traces can pass through overlap-only water, so trace the water components directly.
    water_components = []
    for actor in unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors():
        for component in actor.get_components_by_class(unreal.PrimitiveComponent):
            if (component.get_collision_object_type() == unreal.CollisionChannel.ECC_WATER
                    and component.get_collision_enabled() != unreal.CollisionEnabled.NO_COLLISION):
                water_components.append(component)
    unreal.log(f"Squad collision: {collision['map']} has {len(water_components)} water components.")
    for component in water_components:
        center, extent, _ = TRACE.get_component_bounds(component)
        top = center.z + extent.z + 10
        bottom = center.z - extent.z - 10
        first_column = max(0, math.ceil((center.x - extent.x - x_min) / dx - 0.5))
        last_column = min(columns, math.floor((center.x + extent.x - x_min) / dx - 0.5) + 1)
        first_row = max(0, math.ceil((center.y - extent.y - y_min) / dy - 0.5))
        last_row = min(rows, math.floor((center.y + extent.y - y_min) / dy - 0.5) + 1)
        trace = component.line_trace_component
        for row in range(first_row, last_row):
            y = ys[row]
            for column in range(first_column, last_column):
                index = row * columns + column
                height = heights[index]
                if (water[index] and not record_depth) or (height == -32768 and not include_unsupported):
                    continue
                cutoff = bottom if height == -32768 else max(bottom, height * 10 + minimum_depth_cm)
                if cutoff >= top:
                    continue
                start, end = unreal.Vector(xs[column], y, top), unreal.Vector(xs[column], y, cutoff)
                hit = trace(start, end, False, False, False) or trace(start, end, True, False, False)
                if hit is not None:
                    if record_depth:
                        depth_cm = round(hit[0].z - height * 10)
                        water[index] = max(water[index], min(255, max(minimum_depth_cm, depth_cm)))
                    else:
                        water[index] = 1
    return water


def water_spans(water):
    spans = []
    for index, (cell, previous) in enumerate(zip(water + b"\0", b"\0" + water)):
        if cell != previous:
            spans.append(index)
    return spans


def write_water_grid(output, assignment, name, grid, format_comment):
    data = {}
    if output.exists():
        source = output.read_text(encoding="utf-8")
        data = json.loads(source.split(assignment, 1)[1].strip().removesuffix(";"))
    data[name] = grid
    lines = [f"  {json.dumps(name)}: {json.dumps(value, separators=(',', ':'))}" for name, value in sorted(data.items())]
    bundle = (
        "// Generated by tools/export-collision.ps1 -Water.\n"
        f"// {format_comment}\n"
        + assignment + "{\n" + ",\n".join(lines) + "\n};\n"
    )
    with NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=ROOT, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(bundle)
    try:
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)


def export_water(entry, bounds):
    name = entry["name"]
    source = (ROOT / "maps" / name / "collision.js").read_text(encoding="utf-8")
    collision = json.loads(source.split("document.currentScript.collisionData = ", 1)[1].strip().removesuffix(";"))
    columns, rows = (collision["grid"][key] for key in ("columns", "rows"))
    deep = b"" if name in SHALLOW_WATER_MAPS else scan_water(collision, columns, rows, bounds, DEEP_WATER_CM, True)
    wading = scan_water(collision, columns, rows, bounds, WADING_WATER_CM, False, record_depth=True)
    write_water_grid(WATER_OUTPUT, WATER_ASSIGNMENT, name, [columns, rows, *water_spans(deep)],
                     "Each map stores columns, rows, and pairs of flattened cell offsets [start, end).")
    payload = b64encode(gzip.compress(wading, mtime=0)).decode("ascii") if any(wading) else ""
    write_water_grid(WADING_OUTPUT, WADING_ASSIGNMENT, name, [columns, rows, payload],
                     "Each map stores columns, rows, and gzip-compressed centimeter depths (0 = no depth sample, 255 = 255 cm or more).")
    count = len(wading) - wading.count(0)
    unreal.log(f"Squad collision: {name} has {sum(deep)} deep water cells and {count} sampled water depths.")


def export_map(entry, spacing, collider_objects=False, water=False):
    layer_path = entry.get("sourceLayer")
    if not layer_path:
        raise ValueError(f"{entry['name']} has no calibrated SDK layer.")
    layer = unreal.load_asset(layer_path)
    bounds = TERRAIN["SDK"]["property_value"](layer, "MinimapCornersPosition")
    if not bounds or not bounds.is_valid:
        raise ValueError(f"{layer_path} has no valid minimap bounds.")
    x_min, x_max = sorted((bounds.min.x, bounds.max.x))
    y_min, y_max = sorted((bounds.min.y, bounds.max.y))
    columns = math.ceil((x_max - x_min) / (spacing * 100))
    row_count = math.ceil((y_max - y_min) / (spacing * 100))
    if min(columns, row_count) < 1:
        raise ValueError(f"{layer_path} has empty minimap bounds.")
    dx, dy = (x_max - x_min) / columns, (y_max - y_min) / row_count
    area = unreal.Box(unreal.Vector(x_min, y_min, -250000), unreal.Vector(x_max, y_max, 250000))
    world_path = layer_path.replace("/Gameplay_Layer_Data/", "/Gameplay_Layers/")
    world = TERRAIN["load_map"](world_path, area)
    if water:
        export_water(entry, bounds)
        return
    if collider_objects:
        COLLIDERS["export_colliders"](world_path, entry["name"], (x_min, y_min, x_max, y_max),
                                      ROOT / "maps" / entry["name"] / "colliders.ndjson.gz")
        return
    rows = []
    heights = array("h")
    cache = {}
    ignored_actors = layer_zone_actors()
    unreal.log(f"Squad collision: {entry['name']} ignores {len(ignored_actors)} layer-specific staging and protection actors.")
    for row in range(row_count):
        y = y_min + (row + 0.5) * dy
        cells = []
        for column in range(columns):
            status, height = check_cell(world, x_min + (column + 0.5) * dx, y, dx, dy, cache, ignored_actors)
            cells.append(status)
            heights.append(height)
        rows.append("".join(cells))
    blocked = sum(row.count("#") for row in rows)
    unknown = sum(row.count("?") for row in rows)
    if unknown == columns * row_count:
        raise RuntimeError(f"No support surfaces were found in {world_path}.")
    if sys.byteorder != "little":
        heights.byteswap()
    metadata = {"schemaVersion": 1, "map": entry["name"], "sourceWorld": world_path, "profile": PROFILE,
                "grid": {"columns": columns, "rows": row_count, "columnSpacingMeters": dx / 100,
                         "rowSpacingMeters": dy / 100}, "rows": rows,
                "elevationDmInt16Le": b64encode(heights.tobytes()).decode("ascii")}
    output = ROOT / "maps" / entry["name"] / "collision.js"
    with NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=output.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write("// Generated by tools/export-collision.py.\n")
        stream.write(f"document.currentScript.collisionData = {json.dumps(metadata, indent=2, allow_nan=False)};\n")
    try:
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    unreal.log(f"Squad collision: wrote {output} ({blocked} blocked, {unknown} unknown of {columns * row_count}).")


def main():
    options = json.loads(os.environ["SQUAD_COLLISION_OPTIONS"])
    source = (ROOT / "sdk-data.js").read_text(encoding="utf-8")
    entries = json.loads(source.split("window.squadSdkData = ", 1)[1].strip().removesuffix(";"))["maps"]
    by_name = {entry["name"]: entry for entry in entries}
    for name in dict.fromkeys(options["maps"]):
        if name not in by_name:
            raise ValueError(f"Unknown map: {name}.")
        export_map(by_name[name], options["spacingMeters"], options.get("colliderObjects", False),
                   options.get("water", False))
        if options.get("water"):
            unreal.SystemLibrary.collect_garbage()
    unreal.log("Squad collision: completed export.")


if __name__ == "__main__":
    main()
