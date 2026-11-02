#!/usr/bin/env python3
"""Export recipe and item/fluid tag JSON from Minecraft JARs and datapacks."""

import argparse
import gzip
from io import BytesIO
import json
import re
import struct
import sys
from pathlib import Path
from zipfile import BadZipFile, ZipFile


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mods", type=Path, help="modpack mods directory")
    parser.add_argument("--jar", type=Path, action="append", default=[], help="base JAR, such as Minecraft's version JAR")
    parser.add_argument("--datapack", type=Path, action="append", default=[], help="datapack directory or ZIP; repeat for pack priority order")
    parser.add_argument("--minecraft-version", help="Minecraft version represented by the export")
    parser.add_argument("--create-version", help="Create version represented by the export")
    parser.add_argument("--item-model-ids-output", type=Path, default=Path("data/item-model-ids.json"), help="write the item-to-model index to this JSON file")
    parser.add_argument("--item-models-output", type=Path, default=Path("data/item-models.json.gz"), help="write compressed resolved 3D item models to this file")
    parser.add_argument("--fluid-units-per-millibucket", type=float, help="override the fluid amount scale (auto-detects Fabric's droplet scale)")
    parser.add_argument("--icon-dir", type=Path, default=Path("data/item-icons"), help="directory for extracted item textures")
    args = parser.parse_args()
    if not args.mods.is_dir():
        parser.error(f"not a directory: {args.mods}")
    for path in [*args.jar, *args.datapack]:
        if not path.exists():
            parser.error(f"path does not exist: {path}")

    # Base game data first, then mod data, then datapacks in increasing priority.
    sources = [*args.jar, *sorted(args.mods.glob("*.jar")), *args.datapack]
    mods = {"minecraft"}
    recipes = {}
    item_icons = {}
    item_animations = {}
    raw_models = {}
    raw_model_assets = {}
    tag_values = {"items": {}, "fluids": {}}
    args.icon_dir.mkdir(parents=True, exist_ok=True)
    for source in sources:
        pack_recipes, pack_tags, pack_mods, pack_icons, pack_animations, pack_models, pack_model_assets = read_source(source, args.icon_dir)
        mods.update(pack_mods)
        recipes.update(pack_recipes)
        merge_tags(tag_values, pack_tags)
        item_icons.update(pack_icons)
        item_animations.update(pack_animations)
        raw_models.update(pack_models)
        raw_model_assets.update(pack_model_assets)

    item_tags = resolve_tags(tag_values["items"])
    fluid_tags = resolve_tags(tag_values["fluids"])
    machine_models = resolve_models(raw_models, raw_model_assets)
    item_ids = collect_recipe_item_ids(recipes.values()) | {item for members in item_tags.values() for item in members}
    item_model_ids = {item_id: item_model_id(item_id) for item_id in item_ids if item_model_path(item_id) in raw_models}
    item_models = resolve_models(raw_models, raw_model_assets, set(item_model_ids.values()), generate_default_cube=False)
    item_model_ids = {item_id: model_id for item_id, model_id in item_model_ids.items() if model_id in item_models}
    for entry in recipes.values():
        active = recipe_conditions(entry["recipe"], mods, item_tags, fluid_tags)
        entry["active"] = active
    fluid_units_per_millibucket = args.fluid_units_per_millibucket
    if fluid_units_per_millibucket is None:
        fluid_units_per_millibucket = 81 if "fabric-api" in mods else 1

    args.item_model_ids_output.parent.mkdir(parents=True, exist_ok=True)
    args.item_model_ids_output.write_text(json.dumps(item_model_ids, separators=(",", ":")))
    args.item_models_output.parent.mkdir(parents=True, exist_ok=True)
    with args.item_models_output.open("wb") as output:
        with gzip.GzipFile(fileobj=output, mode="wb", mtime=0) as compressed:
            compressed.write(json.dumps({"itemModels": item_models}, separators=(",", ":")).encode("utf-8"))
    json.dump({
        "minecraftVersion": args.minecraft_version,
        "createVersion": args.create_version,
        "fluidUnitsPerMillibucket": fluid_units_per_millibucket,
        "itemIcons": item_icons,
        "itemAnimations": item_animations,
        "machineModels": machine_models,
        "recipes": list(recipes.values()),
        "itemTags": item_tags,
        "fluidTags": fluid_tags,
        "modIds": sorted(mods),
    }, sys.stdout, indent=2)
    print()


def read_source(source: Path, icon_dir: Path):
    recipes = {}
    tags = {"items": {}, "fluids": {}}
    mods = set()
    icons = {}
    animations = {}
    models = {}
    model_assets = {}
    if source.is_dir():
        data_root = source / "data"
        if not data_root.is_dir():
            raise ValueError(f"datapack directory has no data/: {source}")
        entries = ((path.relative_to(source).as_posix(), path.read_bytes()) for path in data_root.rglob("*.json"))
        source_name = source.name
    else:
        try:
            with ZipFile(source) as archive:
                all_json = list(json_entries(archive))
                entries = all_json
                models = {
                    name: json.loads(contents)
                    for name, contents in all_json
                    if re.fullmatch(r"assets/[^/]+/models/[^/]+/.+\.json", name)
                }
                model_assets = dict(model_asset_entries(archive))
                icons, animations = extract_icons(image_entries(archive), icon_dir)
                if "fabric.mod.json" in archive.namelist():
                    metadata = json.loads(archive.read("fabric.mod.json"))
                    if isinstance(metadata.get("id"), str):
                        mods.add(metadata["id"])
        except BadZipFile as error:
            raise ValueError(f"not a valid JAR/ZIP: {source}") from error
        source_name = source.name

    for name, contents in entries:
        parts = Path(name).parts
        if len(parts) < 4 or parts[0] != "data":
            continue
        if parts[2] == "recipes" and name.endswith(".json"):
            recipe_path = Path(*parts[3:])
            recipe_id = f"{parts[1]}:{recipe_path.with_suffix('').as_posix()}"
            recipe = json.loads(contents)
            recipes[recipe_id] = {"id": recipe_id, "source": source_name, "recipe": recipe}
        elif parts[2] == "tags" and len(parts) >= 5 and name.endswith(".json"):
            domain = parts[3]
            domain = "items" if domain in ("item", "items") else "fluids" if domain in ("fluid", "fluids") else None
            if domain is None:
                continue
            tag_path = Path(*parts[4:]).with_suffix("").as_posix()
            tag_id = f"{parts[1]}:{tag_path}"
            tags[domain][tag_id] = json.loads(contents)
    return recipes, tags, mods, icons, animations, models, model_assets


def item_model_path(item_id):
    namespace, path = item_id.split(":", 1) if ":" in item_id else ("minecraft", item_id)
    return f"assets/{namespace}/models/item/{path}.json"


def item_model_id(item_id):
    namespace, path = item_id.split(":", 1) if ":" in item_id else ("minecraft", item_id)
    return f"{namespace}:item/{path}"


def collect_recipe_item_ids(entries):
    item_ids = set()

    def visit(value):
        if isinstance(value, dict):
            item = value.get("item")
            if isinstance(item, str) and not item.startswith("#"):
                item_ids.add(item if ":" in item else f"minecraft:{item}")
            items = value.get("items")
            if isinstance(items, list):
                item_ids.update(item if ":" in item else f"minecraft:{item}" for item in items if isinstance(item, str) and not item.startswith("#"))
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    for entry in entries:
        visit(entry.get("recipe", {}))
    return item_ids


def resolve_models(raw_models, model_assets, model_ids=None, generate_default_cube=True):
    """Flatten selected Minecraft item models into face geometry and resolved texture IDs."""
    model_map = json.loads((Path(__file__).parents[1] / "data/machine-model-ids.json").read_text())
    layout = json.loads((Path(__file__).parents[1] / "data/machine-layout-rules.json").read_text())
    model_ids = model_ids if model_ids is not None else set(model_map.values()) | {layout["basinModel"], *layout["heaterModels"].values()}
    cache = {}

    def model_path(model_id):
        namespace, path = model_id.split(":", 1) if ":" in model_id else ("minecraft", model_id)
        if "/" not in path:
            path = f"item/{path}"
        return f"assets/{namespace}/models/{path}.json"

    def resolve_texture(texture, textures, namespace):
        seen = set()
        while isinstance(texture, str) and texture.startswith("#") and texture[1:] not in seen:
            seen.add(texture[1:])
            texture = textures.get(texture[1:], "")
        if isinstance(texture, str) and texture and ":" not in texture:
            texture = f"minecraft:{texture}"
        return texture if isinstance(texture, str) else ""

    def resolve(model_id, active):
        if model_id in cache:
            return cache[model_id]
        if model_id in active:
            return {"textures": {}, "elements": []}
        data = raw_models.get(model_path(model_id))
        if data is None:
            return {"textures": {}, "elements": []}
        parent_id = data.get("parent")
        parent = resolve(parent_id, active | {model_id}) if isinstance(parent_id, str) and not parent_id.startswith("builtin/") else {"textures": {}, "elements": [], "triangles": []}
        textures = {**parent["textures"], **data.get("textures", {})}
        elements = data.get("elements", parent["elements"])
        resolved_elements = []
        for element in elements:
            faces = {}
            for direction, face in element.get("faces", {}).items():
                texture = face.get("texture", "")
                if not isinstance(texture, str) or not texture:
                    continue
                uvs = face.get("uv") or default_face_uv(direction, element["from"], element["to"])
                faces[direction] = {"texture": texture, "uv": uvs, "rotation": face.get("rotation", 0)}
            resolved_elements.append({
                "from": element["from"],
                "to": element["to"],
                "rotation": element.get("rotation"),
                "faces": faces,
            })
        triangles = list(parent.get("triangles", []))
        obj_reference = data.get("model")
        if isinstance(obj_reference, str):
            triangles.extend(parse_obj_model(obj_reference, model_assets, textures, data.get("flip_v", False), model_id.split(":", 1)[0]))
        result = {"textures": textures, "elements": resolved_elements, "triangles": triangles}
        cache[model_id] = result
        return result

    result = {}
    for model_id in sorted(model_ids):
        model = resolve(model_id, set())
        namespace = model_id.split(":", 1)[0]
        elements = []
        for element in model["elements"]:
            faces = {}
            for direction, face in element["faces"].items():
                texture = resolve_texture(face["texture"], model["textures"], namespace)
                if texture:
                    faces[direction] = {**face, "texture": texture}
            elements.append({**element, "faces": faces})
        if generate_default_cube and not any(element["faces"] for element in elements) and not model["triangles"]:
            elements = default_cube_elements(model["textures"], namespace)
        if not any(element["faces"] for element in elements) and not model["triangles"]:
            continue
        fallback_texture = resolve_texture(model["textures"].get("layer0", ""), model["textures"], namespace)
        result[model_id] = {
            "elements": elements,
            "triangles": model["triangles"],
            **({"fallbackTexture": fallback_texture} if fallback_texture else {}),
        }
    return result


def parse_obj_model(reference, model_assets, textures, flip_v, namespace):
    obj_path = model_asset_path(reference)
    obj = model_assets.get(obj_path)
    if obj is None:
        return []
    materials = {}
    for line in obj.decode("utf-8").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == "mtllib":
            mtl_path = str(Path(obj_path).parent / parts[1])
            mtl = model_assets.get(mtl_path, b"").decode("utf-8")
            current = None
            for mtl_line in mtl.splitlines():
                values = mtl_line.split()
                if len(values) >= 2 and values[0] == "newmtl":
                    current = values[1]
                elif len(values) >= 2 and values[0] == "map_Kd" and current:
                    materials[current] = resolve_obj_texture(values[-1], textures, namespace)

    positions = []
    uvs = []
    triangles = []
    current_texture = ""
    for line in obj.decode("utf-8").splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "v" and len(parts) >= 4:
            positions.append(tuple(float(value) * 16 for value in parts[1:4]))
        elif parts[0] == "vt" and len(parts) >= 3:
            u, v = float(parts[1]), float(parts[2])
            uvs.append((u * 16, (1 - v if flip_v else v) * 16))
        elif parts[0] == "usemtl" and len(parts) >= 2:
            current_texture = materials.get(parts[1], "")
        elif parts[0] == "f" and len(parts) >= 4 and current_texture:
            vertices = []
            for token in parts[1:]:
                fields = token.split("/")
                vertex_index = int(fields[0])
                uv_index = int(fields[1]) if len(fields) > 1 and fields[1] else 0
                vertex_index = vertex_index - 1 if vertex_index > 0 else len(positions) + vertex_index
                uv_index = uv_index - 1 if uv_index > 0 else len(uvs) + uv_index
                if vertex_index < 0 or vertex_index >= len(positions) or uv_index < 0 or uv_index >= len(uvs):
                    vertices = []
                    break
                vertices.append({"position": positions[vertex_index], "uv": uvs[uv_index]})
            for index in range(1, len(vertices) - 1):
                triangles.append({"texture": current_texture, "vertices": [vertices[0], vertices[index], vertices[index + 1]]})
    return triangles


def model_asset_path(reference):
    namespace, path = reference.split(":", 1) if ":" in reference else ("minecraft", reference)
    if not path.startswith("models/"):
        path = f"models/{path}"
    return f"assets/{namespace}/{path}"


def resolve_obj_texture(reference, textures, namespace):
    seen = set()
    while reference.startswith("#") and reference[1:] not in seen:
        seen.add(reference[1:])
        reference = textures.get(reference[1:], "")
    if reference and ":" not in reference:
        reference = f"minecraft:{reference}"
    return reference


def default_face_uv(direction, start, end):
    x0, y0, z0 = start
    x1, y1, z1 = end
    return {
        "north": [16 - x1, 16 - y1, 16 - x0, 16 - y0],
        "south": [x0, 16 - y1, x1, 16 - y0],
        "west": [z0, 16 - y1, z1, 16 - y0],
        "east": [16 - z1, 16 - y1, 16 - z0, 16 - y0],
        "up": [x0, z0, x1, z1],
        "down": [x0, 16 - z1, x1, 16 - z0],
    }.get(direction, [0, 0, 16, 16])


def default_cube_elements(textures, namespace):
    def texture(*keys):
        for key in keys:
            if key in textures:
                value = textures[key]
                seen = set()
                while isinstance(value, str) and value.startswith("#") and value[1:] not in seen:
                    seen.add(value[1:])
                    value = textures.get(value[1:], "")
                if isinstance(value, str) and value:
                    return value if ":" in value else f"minecraft:{value}"
        return ""

    side = texture("side", "all", "0", "particle")
    top = texture("top", "up", "all", "0", "particle") or side
    bottom = texture("bottom", "down", "top", "all", "0", "particle") or side
    face_textures = {
        "north": texture("front", "north", "side", "all", "0", "particle") or side,
        "south": texture("south", "side", "all", "0", "particle") or side,
        "east": texture("east", "side", "all", "0", "particle") or side,
        "west": texture("west", "side", "all", "0", "particle") or side,
        "up": top,
        "down": bottom,
    }
    faces = {
        direction: {"texture": value, "uv": default_face_uv(direction, [0, 0, 0], [16, 16, 16]), "rotation": 0}
        for direction, value in face_textures.items() if value
    }
    return [{"from": [0, 0, 0], "to": [16, 16, 16], "faces": faces}] if faces else []


def extract_icons(entries, icon_dir: Path):
    icons = {}
    item_icons = set()
    images = {}
    metadata = {}
    for name, contents in entries:
        is_metadata = name.endswith(".png.mcmeta")
        image_name = name[:-7] if is_metadata else name
        match = re.fullmatch(r"assets/([^/]+)/textures/(items?|blocks?)/([A-Za-z0-9_./-]+)\.png", image_name)
        if not match:
            continue
        namespace, layer, texture = match.groups()
        if ".." in texture.split("/"):
            continue
        item_id = f"{namespace}:{texture}"
        relative_path = Path(namespace, "blocks", f"{texture}.png") if layer.startswith("block") else Path(namespace, f"{texture}.png")
        icon_path = icon_dir / relative_path
        texture_kind = "block" if layer.startswith("block") else "item"
        if is_metadata:
            metadata[item_id] = json.loads(contents)
            continue
        icon_path.parent.mkdir(parents=True, exist_ok=True)
        icon_path.write_bytes(contents)
        images[item_id] = contents
        icons[f"{namespace}:{texture_kind}/{texture}"] = icon_path.as_posix()
        if layer.startswith("item"):
            icons[item_id] = (icon_dir / relative_path).as_posix()
            item_icons.add(item_id)
        elif item_id not in item_icons:
            icons.setdefault(item_id, (icon_dir / relative_path).as_posix())

    animations = {}
    for item_id, data in metadata.items():
        image = images.get(item_id)
        animation = data.get("animation")
        if image is None or not isinstance(animation, dict):
            continue
        texture_width, texture_height = struct.unpack(">II", image[16:24])
        frame_width = int(animation.get("width", texture_width))
        frame_height = int(animation.get("height", frame_width))
        if frame_width <= 0 or frame_height <= 0 or texture_width % frame_width or texture_height % frame_height:
            continue
        columns, rows = texture_width // frame_width, texture_height // frame_height
        default_time = max(1, int(animation.get("frametime", 1)))
        declared_frames = animation.get("frames")
        frame_entries = declared_frames if isinstance(declared_frames, list) else range(columns * rows)
        frames = []
        for entry in frame_entries:
            index, duration = (entry.get("index"), entry.get("time", default_time)) if isinstance(entry, dict) else (entry, default_time)
            if isinstance(index, int) and 0 <= index < columns * rows and isinstance(duration, int) and duration > 0:
                frames.append({"index": index, "time": duration})
        if frames:
            animations[item_id] = {
                "textureWidth": texture_width,
                "textureHeight": texture_height,
                "frameWidth": frame_width,
                "frameHeight": frame_height,
                "frames": frames,
            }
    return icons, animations


def json_entries(archive: ZipFile):
    for name in archive.namelist():
        if name.endswith(".json"):
            yield name, archive.read(name)
        elif name.endswith(".jar"):
            try:
                with ZipFile(BytesIO(archive.read(name))) as nested:
                    yield from json_entries(nested)
            except BadZipFile:
                continue


def image_entries(archive: ZipFile):
    for name in archive.namelist():
        if re.fullmatch(r"assets/([^/]+)/textures/(items?|blocks?)/([A-Za-z0-9_./-]+)\.png(?:\.mcmeta)?", name):
            yield name, archive.read(name)
        elif name.endswith(".jar"):
            try:
                with ZipFile(BytesIO(archive.read(name))) as nested:
                    yield from image_entries(nested)
            except BadZipFile:
                continue


def model_asset_entries(archive: ZipFile):
    for name in archive.namelist():
        if name.endswith((".obj", ".mtl")):
            yield name, archive.read(name)
        elif name.endswith(".jar"):
            try:
                with ZipFile(BytesIO(archive.read(name))) as nested:
                    yield from model_asset_entries(nested)
            except BadZipFile:
                continue


def merge_tags(merged, additions) -> None:
    for domain, tags in additions.items():
        for tag_id, definition in tags.items():
            if definition.get("replace", False) or tag_id not in merged[domain]:
                merged[domain][tag_id] = []
            merged[domain][tag_id].extend(definition.get("values", []))


def resolve_tags(tags):
    resolved = {}

    def expand(tag_id, seen):
        if tag_id in seen:
            return set()
        seen = seen | {tag_id}
        values = set()
        for entry in tags.get(tag_id, []):
            value = entry.get("id") if isinstance(entry, dict) else entry
            if not isinstance(value, str):
                continue
            if value.startswith("#"):
                values.update(expand(value[1:], seen))
            else:
                values.add(value)
        return values

    for tag_id in tags:
        resolved[tag_id] = sorted(expand(tag_id, set()))
    return resolved


def recipe_conditions(recipe, mods, item_tags, fluid_tags):
    conditions = []
    for key in ("fabric:load_conditions", "conditions"):
        value = recipe.get(key, [])
        if isinstance(value, list):
            conditions.extend(value)
        elif isinstance(value, dict):
            conditions.append(value)
    results = [evaluate_condition(condition, mods, item_tags, fluid_tags) for condition in conditions]
    if False in results:
        return False
    if None in results:
        return None
    return True


def evaluate_condition(condition, mods, item_tags, fluid_tags):
    if not isinstance(condition, dict):
        return None
    kind = condition.get("condition") or condition.get("type")
    if kind in ("fabric:all_mods_loaded", "forge:mod_loaded"):
        names = condition.get("values")
        if names is None:
            name = condition.get("modid")
            names = [name] if isinstance(name, str) else []
        names = [name for name in names if isinstance(name, str)]
        return bool(names) and all(name in mods for name in names)
    if kind == "fabric:any_mods_loaded":
        names = [name for name in condition.get("values", []) if isinstance(name, str)]
        return bool(names) and any(name in mods for name in names)
    if kind == "fabric:not" or kind == "forge:not":
        nested = condition.get("value")
        result = evaluate_condition(nested, mods, item_tags, fluid_tags)
        return None if result is None else not result
    if kind in ("fabric:tags_populated", "fabric:tag_populated"):
        return all(item_tags.get(tag, fluid_tags.get(tag, [])) for tag in condition.get("values", []) if isinstance(tag, str))
    if kind in ("fabric:and", "forge:and"):
        nested = condition.get("values", condition.get("conditions", []))
        return combine(evaluate_condition(value, mods, item_tags, fluid_tags) for value in nested)
    if kind in ("fabric:or", "forge:or"):
        nested = condition.get("values", condition.get("conditions", []))
        values = [evaluate_condition(value, mods, item_tags, fluid_tags) for value in nested]
        if True in values:
            return True
        return None if None in values else False
    return None


def combine(results):
    values = list(results)
    if False in values:
        return False
    return None if None in values else True


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(1)
