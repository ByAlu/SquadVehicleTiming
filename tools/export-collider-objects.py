"""Write the placed collision components and available vehicle-query geometry."""

from collections import Counter
import gzip
import io
import json
from pathlib import Path
from tempfile import NamedTemporaryFile

import unreal


def xyz(vector):
    return [round(vector.x, 4), round(vector.y, 4), round(vector.z, 4)]


def transform_data(transform):
    rotation = transform.rotation
    return {"translationCm": xyz(transform.translation),
            "quaternionXyzw": [rotation.x, rotation.y, rotation.z, rotation.w],
            "scale": xyz(transform.scale3d)}


def mesh_geometry(scratch, source, world_space, complex_collision):
    scratch.reset()
    mesh, _, _ = unreal.GeometryScript_SceneUtils.copy_collision_meshes_from_object(
        source, scratch, world_space, complex_collision)
    _, indices, _ = mesh.get_all_triangle_indices(True)
    triangles = [[triangle.x, triangle.y, triangle.z] for triangle in indices.convert_triangle_list_to_array()]
    if not triangles:
        return None
    _, positions, _ = mesh.get_all_vertex_positions(False)
    return {"space": "world" if world_space else "mesh-local",
            "kind": "complex" if complex_collision else "simple",
            "verticesCm": [xyz(vertex) for vertex in positions.convert_vector_list_to_array()],
            "triangles": triangles}


def export_colliders(world_path, map_name, bounds, output):
    actor_subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    actors = sorted(actor_subsystem.get_all_level_actors(), key=lambda actor: actor.get_path_name())
    cache = {}
    counts = Counter()
    scratch = unreal.DynamicMesh()
    with NamedTemporaryFile(dir=output.parent, delete=False) as raw:
        temporary = Path(raw.name)
    try:
        with temporary.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
            with io.TextIOWrapper(compressed, encoding="utf-8", newline="\n") as stream:
                def write(record):
                    stream.write(json.dumps(record, separators=(",", ":"), allow_nan=False) + "\n")

                proj = Path(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir()))
                write({"type": "map", "schemaVersion": 1, "map": map_name, "sourceWorld": world_path,
                       "sdkVersion": (proj / "version.txt").read_text(encoding="utf-8").strip(),
                       "minimapBoundsCm": list(bounds), "axes": "Unreal XYZ, centimeters"})
                for actor in actors:
                    components = sorted(actor.get_components_by_class(unreal.PrimitiveComponent),
                                        key=lambda component: component.get_path_name())
                    for component in components:
                        if component.is_collision_enabled():
                            record = collider_record(component, actor, scratch, cache, write, counts)
                            write(record)
                            counts["components"] += 1
                write({"type": "summary", **counts})
        if not counts["components"]:
            raise RuntimeError(f"No collision-enabled components found in {world_path}.")
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    unreal.log(f"Squad collision: wrote {output} ({dict(counts)}).")


def collider_record(component, actor, scratch, cache, write, counts):
    origin, extent, _ = unreal.SystemLibrary.get_component_bounds(component)
    channel = unreal.CollisionChannel.ECC_VEHICLE
    response = component.get_collision_response_to_channel(channel)
    record = {"type": "collider", "actor": actor.get_path_name(), "label": actor.get_actor_label(),
              "component": component.get_name(), "class": component.get_class().get_name(),
              "profile": str(component.get_collision_profile_name()), "enabled": component.get_collision_enabled().name,
              "objectChannel": component.get_collision_object_type().name, "vehicleResponse": response.name,
              "boundsCenterCm": xyz(origin), "boundsHalfSizeCm": xyz(extent)}
    if response == unreal.CollisionResponseType.ECR_BLOCK:
        counts["vehicleBlockers"] += 1

    if isinstance(component, unreal.InstancedStaticMeshComponent):
        instances = [component.get_instance_transform(index, True) for index in range(component.get_instance_count())]
        record["instances"] = [transform_data(transform) if transform is not None else None for transform in instances]
        counts["instances"] += len(instances)
    else:
        record["transform"] = transform_data(component.get_world_transform())

    source = component
    world_space = True
    complex_collision = False
    allow_complex_fallback = False
    if isinstance(component, unreal.StaticMeshComponent):
        asset = component.get_editor_property("static_mesh")
        if asset is None:
            record["geometryStatus"] = "no-static-mesh"
            counts["metadataOnly"] += 1
            return record
        record["asset"] = asset.get_path_name()
        body_setup = asset.get_editor_property("body_setup")
        complexity = body_setup.get_editor_property("collision_trace_flag").name if body_setup else "CTF_USE_DEFAULT"
        record["collisionComplexity"] = complexity
        complex_collision = complexity == "CTF_USE_COMPLEX_AS_SIMPLE"
        allow_complex_fallback = not complex_collision and complexity != "CTF_USE_SIMPLE_AS_COMPLEX"
        if isinstance(component, unreal.InstancedStaticMeshComponent) or type(component) is unreal.StaticMeshComponent:
            source = asset
            world_space = False
    elif not isinstance(component, (unreal.ShapeComponent, unreal.BrushComponent)):
        record["geometryStatus"] = ("heightfield" if record["class"].startswith("LandscapeHeightfield")
                                    else "unsupported-component")
        counts["metadataOnly"] += 1
        return record

    try:
        key = (source.get_path_name(), complex_collision)
        if key not in cache:
            geometry = mesh_geometry(scratch, source, world_space, complex_collision)
            if geometry is None and allow_complex_fallback:
                geometry = mesh_geometry(scratch, source, world_space, True)
            mesh_id = key[0] if geometry else None
            if geometry:
                write({"type": "mesh", "id": mesh_id, **geometry})
                counts["meshes"] += 1
                counts["triangles"] += len(geometry["triangles"])
            cache[key] = mesh_id
        mesh_id = cache[key]
    except Exception as error:
        record["geometryStatus"] = "extraction-failed"
        record["geometryError"] = str(error)
        counts["metadataOnly"] += 1
    else:
        if mesh_id is None:
            record["geometryStatus"] = "empty-collision-mesh"
            counts["metadataOnly"] += 1
        else:
            record["mesh"] = mesh_id
            counts["meshComponents"] += 1
    return record
