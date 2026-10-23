"""Print what a component class itself knows about its fields, as JSON (last stdout line).

Runs in the PROJECT's Python environment, like preview_asset.py. `dg utils inspect-component --defs-yaml-json-schema` drops the
description of every field that has a default and omits class-level metadata; the Pydantic model keeps both, so this reads them
straight from the class.

  usage: python -m scripts.inspect_component <component_type>      (e.g. my_pkg.components.thing.ThingComponent)

Output: {"success": true, "fields": {<yaml key>: {"description": str|null, "extras": {...}}}, "class_extras": {...}}
"""
import importlib
import json
import sys
import warnings

warnings.filterwarnings("ignore")

# Only UI-facing hints are carried over; anything else in json_schema_extra stays where it is.
_HINT_PREFIXES = ("ui:", "x-")
_HINT_KEYS = {"enum", "examples"}


def _json_safe(value):
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return None


def _hints(extra) -> dict:
    if not isinstance(extra, dict):
        return {}
    out = {}
    for key, value in extra.items():
        if key.startswith(_HINT_PREFIXES) or key in _HINT_KEYS:
            safe = _json_safe(value)
            if safe is not None:
                out[key] = safe
    return out


def _load_class(component_type: str):
    module_path, _, class_name = component_type.rpartition(".")
    if not module_path:
        raise ValueError(f"Expected a dotted path, got {component_type!r}")
    return getattr(importlib.import_module(module_path), class_name)


def inspect_class(cls) -> dict:
    fields = {}
    for name, info in (getattr(cls, "model_fields", None) or {}).items():
        key = getattr(info, "alias", None) or name  # the YAML key is the alias when there is one
        fields[key] = {"description": info.description, "extras": _hints(info.json_schema_extra)}
    config = getattr(cls, "model_config", None) or {}
    return {"success": True, "fields": fields, "class_extras": _hints(config.get("json_schema_extra"))}


def main() -> int:
    try:
        print(json.dumps(inspect_class(_load_class(sys.argv[1]))))
    except Exception as e:  # the caller treats any failure as "nothing extra to add"
        print(json.dumps({"success": False, "error": f"{type(e).__name__}: {e}"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
