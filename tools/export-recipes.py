#!/usr/bin/env python3
"""Export recipe and item/fluid tag JSON from Minecraft JARs and datapacks."""

import argparse
from io import BytesIO
import json
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
    parser.add_argument("--fluid-units-per-millibucket", type=float, help="override the fluid amount scale (auto-detects Fabric's droplet scale)")
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
    tag_values = {"items": {}, "fluids": {}}
    for source in sources:
        pack_recipes, pack_tags, pack_mods = read_source(source)
        mods.update(pack_mods)
        recipes.update(pack_recipes)
        merge_tags(tag_values, pack_tags)

    item_tags = resolve_tags(tag_values["items"])
    fluid_tags = resolve_tags(tag_values["fluids"])
    for entry in recipes.values():
        active = recipe_conditions(entry["recipe"], mods, item_tags, fluid_tags)
        entry["active"] = active
    fluid_units_per_millibucket = args.fluid_units_per_millibucket
    if fluid_units_per_millibucket is None:
        fluid_units_per_millibucket = 81 if "fabric-api" in mods else 1

    json.dump({
        "minecraftVersion": args.minecraft_version,
        "createVersion": args.create_version,
        "fluidUnitsPerMillibucket": fluid_units_per_millibucket,
        "recipes": list(recipes.values()),
        "itemTags": item_tags,
        "fluidTags": fluid_tags,
        "modIds": sorted(mods),
    }, sys.stdout, indent=2)
    print()


def read_source(source: Path):
    recipes = {}
    tags = {"items": {}, "fluids": {}}
    mods = set()
    if source.is_dir():
        data_root = source / "data"
        if not data_root.is_dir():
            raise ValueError(f"datapack directory has no data/: {source}")
        entries = ((path.relative_to(source).as_posix(), path.read_bytes()) for path in data_root.rglob("*.json"))
        source_name = source.name
    else:
        try:
            with ZipFile(source) as archive:
                entries = list(json_entries(archive))
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
    return recipes, tags, mods


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
