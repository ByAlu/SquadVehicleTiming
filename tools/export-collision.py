"""Export sampled vehicle collision cells from Squad gameplay worlds."""

from array import array
from base64 import b64encode
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


def is_support(component, actor, cache):
    if component not in cache:
        kind = component.get_class().get_name()
        label = actor.get_actor_label() if actor else ""
        mesh = TERRAIN["SDK"]["property_value"](component, "static_mesh")
        name = f"{label} {mesh.get_name() if mesh else ''}"
        cache[component] = (kind.startswith("Landscape"), bool(SURFACE_NAMES.search(name)))
    return cache[component]


def find_support(world, x, y, cache):
    ignored = []
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


def check_cell(world, x, y, dx, dy, cache):
    support = find_support(world, x, y, cache)
    if support is None:
        return "?", -32768
    z, normal, landscape = support
    # Raise the probe enough to clear the support plane at the uphill corner.
    rise = (abs(normal.x) * dx + abs(normal.y) * dy) / (2 * max(normal.z, 0.7))
    center = unreal.Vector(x, y, z + 145 + rise)
    end = unreal.Vector(x, y, center.z - 1)
    extent = unreal.Vector(dx / 2, dy / 2, 100)
    ignored = [landscape] if landscape else []
    hit = TRACE.box_trace_single_by_profile(world, center, end, extent, unreal.Rotator(), PROFILE,
                                           False, ignored, DEBUG, False)
    return ("#" if hit is not None and hit.to_tuple()[0] else "."), round(z / 10)


def export_map(entry, spacing, collider_objects=False):
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
    if collider_objects:
        COLLIDERS["export_colliders"](world_path, entry["name"], (x_min, y_min, x_max, y_max),
                                      ROOT / "maps" / entry["name"] / "colliders.ndjson.gz")
        return
    rows = []
    heights = array("h")
    cache = {}
    for row in range(row_count):
        y = y_min + (row + 0.5) * dy
        cells = []
        for column in range(columns):
            status, height = check_cell(world, x_min + (column + 0.5) * dx, y, dx, dy, cache)
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
        export_map(by_name[name], options["spacingMeters"], options.get("colliderObjects", False))
    unreal.log("Squad collision: completed export.")


if __name__ == "__main__":
    main()
