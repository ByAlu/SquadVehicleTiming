"""Sample physical surfaces from Squad gameplay maps in Unreal Editor."""

import json
import math
import os
from pathlib import Path
import re
import runpy
from tempfile import NamedTemporaryFile

import unreal


ROOT = Path(__file__).resolve().parents[1]
SDK = runpy.run_path(str(Path(__file__).with_name("export-sdk.py")))
BUILD_GRID = runpy.run_path(str(Path(__file__).with_name("build-terrain.py")))["build_grid"]


def surface_names(project):
    config = (project / "Config/DefaultEngine.ini").read_text(encoding="utf-8-sig", errors="replace")
    names = re.findall(r'\+PhysicalSurfaces=\(Type=SurfaceType(\d+),Name="([^"]+)"\)', config)
    return {0: "Default", **{int(index): name for index, name in names}}


def load_map(path):
    world = unreal.EditorLoadingAndSavingUtils.load_map(path)
    if world is None:
        raise RuntimeError(f"Could not load {path}.")

    partition = unreal.WorldPartitionBlueprintLibrary
    descriptors = partition.get_actor_descs() or []
    # Older gameplay maps have conventional streaming levels and no descriptors.
    # Load terrain and splines explicitly in partitioned maps to make them traceable.
    terrain = []
    for actor in descriptors:
        kind = actor.native_class.get_name() if actor.native_class else ""
        label = str(actor.label).lower()
        if kind.startswith("Landscape") or any(word in label for word in ("road", "bridge", "water", "river")):
            if not actor.actor_is_editor_only:
                terrain.append(actor.guid)
    if terrain:
        partition.load_actors(terrain)
    unreal.GameplayStatics.flush_level_streaming(world)
    unreal.SystemLibrary.execute_console_command(world, "StaticMesh.FinishCompilation")
    unreal.log(f"Squad terrain: loaded {path} with {len(terrain)} partition terrain actors.")
    return world


def surface_id(component, material, face_index, names, surfaces, indices, material_cache):
    kind = component.get_class().get_name() if component else "Unknown"
    source = "landscape" if kind.startswith("Landscape") else "geometry"
    material_source = "trace"
    if material is None and component is not None:
        body = SDK["property_value"](component, "body_instance")
        material = SDK["property_value"](body, "phys_material_override")
        material_source = "collision-override"
        if material is None and source == "geometry":
            render_material = None
            if face_index >= 0:
                render_material, _ = component.get_material_from_collision_face_index(face_index)
            if render_material is None and component.get_num_materials() == 1:
                render_material = component.get_material(0)
            if render_material is not None:
                material = render_material.get_physical_material()
                material_source = "mesh-material"
        elif material is None and source == "landscape":
            material = SDK["property_value"](component.get_owner(), "default_phys_material")
            material_source = "landscape-default"
    if material is None:
        material_source = "unknown"
    cache_key = material
    if cache_key not in material_cache:
        if material is None:
            properties = {"type": "Unknown"}
        else:
            surface = material.get_editor_property("surface_type")
            properties = {
                "type": names.get(surface.value, surface.name),
                "physicalMaterial": material.get_path_name(),
                "friction": material.get_editor_property("friction"),
                "staticFriction": material.get_editor_property("static_friction"),
            }
        material_cache[cache_key] = properties
    key = (source, material_source, cache_key)
    if key not in indices:
        indices[key] = len(surfaces)
        surfaces.append({"source": source, "materialSource": material_source, **material_cache[cache_key]})
    return indices[key]


def trace_surface(world, x, y):
    trace = unreal.SystemLibrary.line_trace_single_by_profile
    start = unreal.Vector(x, y, 250000)
    end = unreal.Vector(x, y, -250000)
    ignored = []
    while True:
        hit = trace(world, start, end, "Vehicle", True, ignored, unreal.DrawDebugTrace.NONE, False)
        if hit is None:
            return None
        # The installed SDK wraps FHitResult's fields as a tuple.
        blocking, _, _, _, _, impact, _, normal, material, actor, component, _, _, _, _, face_index, *_ = hit.to_tuple()
        if not blocking:
            return None
        volume = isinstance(actor, unreal.Volume) or isinstance(component, unreal.ShapeComponent)
        foliage = actor is not None and actor.get_class().get_name() == "InstancedFoliageActor"
        if actor is None or not (volume or foliage):
            return impact, normal, material, component, face_index
        if material is not None and material.get_editor_property("surface_type").value == 4:
            return impact, normal, material, component, face_index
        if actor in ignored:
            return None
        ignored.append(actor)


def write_grid(path, metadata, rows):
    header = json.dumps(metadata, indent=2, ensure_ascii=False, allow_nan=False)
    stream = NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=path.parent, delete=False)
    temporary = Path(stream.name)
    try:
        with stream:
            stream.write(header.removesuffix("\n}") + ',\n  "rows": [\n')
            for index, row in enumerate(rows):
                if index:
                    stream.write(",\n")
                stream.write("    " + json.dumps(row, separators=(",", ":"), allow_nan=False))
            stream.write("\n  ]\n}\n")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def export_map(entry, spacing_m, names, version):
    name = entry["name"]
    layer_path = entry.get("sourceLayer")
    if not layer_path:
        raise ValueError("the minimap has no calibrated SDK gameplay layer.")

    layer = unreal.load_asset(layer_path)
    bounds = SDK["property_value"](layer, "MinimapCornersPosition")
    if not bounds or not bounds.is_valid:
        raise ValueError(f"{layer_path} has no valid minimap bounds.")

    x_min, x_max = sorted((bounds.min.x, bounds.max.x))
    y_min, y_max = sorted((bounds.min.y, bounds.max.y))
    width_m = (x_max - x_min) / 100
    height_m = (y_max - y_min) / 100
    if min(height_m, width_m) < 1:
        raise ValueError(f"{layer_path} has empty minimap bounds.")
    rows_count = math.ceil(height_m / spacing_m)
    cols_count = math.ceil(width_m / spacing_m)
    dx = width_m / cols_count
    dy = height_m / rows_count

    world_path = layer_path.replace("/Gameplay_Layer_Data/", "/Gameplay_Layers/")
    world = load_map(world_path)
    indices = {}
    material_cache = {}
    surfaces = []
    rows = []
    sampled = 0
    for row in range(rows_count):
        cells = []
        y = y_min + (row + 0.5) * dy * 100
        for col in range(cols_count):
            x = x_min + (col + 0.5) * dx * 100
            hit = trace_surface(world, x, y)
            if hit is None:
                cells.append(None)
                continue
            impact, normal, material, component, face_index = hit
            elevation_dm = round(impact.z / 10)
            grade_right = round(-1000 * normal.x / normal.z) if normal.z > 0.01 else None
            grade_down = round(-1000 * normal.y / normal.z) if normal.z > 0.01 else None
            cells.append([elevation_dm, grade_right, grade_down,
                          surface_id(component, material, face_index, names, surfaces, indices, material_cache)])
            sampled += 1
        rows.append(cells)

    if sampled == 0:
        raise RuntimeError(f"{world_path} returned no blocking terrain samples.")

    metadata = {
        "schemaVersion": 1,
        "sdkVersion": version,
        "map": name,
        "sourceLayer": layer_path,
        "sourceWorld": world_path,
        "grid": {
            "columns": cols_count,
            "rows": rows_count,
            "columnSpacingMeters": dx,
            "rowSpacingMeters": dy,
            "topLeftWorldCm": [x_min, y_min],
            "rightWorldDirection": [1, 0],
            "downWorldDirection": [0, 1],
            "cellFields": ["elevationDecimeters", "gradeRightPerThousand", "gradeDownPerThousand", "surfaceIndex"],
        },
        "sampleCount": sampled,
        "surfaces": surfaces,
    }
    output = ROOT / "maps" / name / "terrain.json"
    write_grid(output, metadata, rows)
    BUILD_GRID(output)
    unreal.log(f"Squad terrain: wrote {output}: {sampled}/{rows_count * cols_count} samples, {len(surfaces)} surfaces.")


def main():
    options = json.loads(os.environ.get("SQUAD_ROUTE_TERRAIN_OPTIONS", "{}"))
    spacing_m = options.get("spacingMeters", 16)
    requested = options.get("maps", [])
    catalog = (ROOT / "sdk-data.js").read_text(encoding="utf-8")
    entries = json.loads(catalog.split("window.squadSdkData = ", 1)[1].strip().removesuffix(";"))["maps"]
    by_name = {entry["name"]: entry for entry in entries}
    missing_names = set(requested) - by_name.keys()
    if missing_names:
        raise ValueError(f"Unknown map(s): {', '.join(sorted(missing_names))}.")

    version_path = Path(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir()))
    names = surface_names(version_path)
    version = (version_path / "version.txt").read_text(encoding="utf-8").strip()
    failures = []
    exported = 0
    for entry in ([by_name[name] for name in dict.fromkeys(requested)] if requested else entries):
        if not entry.get("sourceLayer") and not requested:
            unreal.log_warning(f"Squad terrain: skipped {entry['name']} because its minimap has no SDK bounds.")
            continue
        try:
            unreal.log(f"Squad terrain: sampling {entry['name']}.")
            export_map(entry, spacing_m, names, version)
            exported += 1
        except Exception as error:
            failures.append(entry["name"])
            unreal.log_warning(f"Squad terrain: {entry['name']}: {error}")
    if failures or not exported:
        raise RuntimeError(f"Exported {exported} map(s). Failed maps: {', '.join(failures)}.")
    unreal.log(f"Squad terrain: completed {exported} map(s).")


if __name__ == "__main__":
    main()
