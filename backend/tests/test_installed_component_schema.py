import json

from app.services.asset_introspection_service import find_installed_component_schema


def _install(project_dir, package, folder, component_type, io):
    pkg = project_dir / ".venv" / "lib" / "python3.12" / "site-packages" / package / folder
    pkg.mkdir(parents=True)
    (pkg / "schema.json").write_text(json.dumps({"component_type": component_type, "x-dagster-io": io}))
    return pkg / "schema.json"


def test_finds_a_packaged_community_schema_by_class_name(tmp_path):
    expected = _install(tmp_path, "dagster_community_components", "assets/transforms/auto_field",
                        "dagster_component_templates.AutoFieldComponent", {"inputs": {"type": "dataframe"}})
    assert find_installed_component_schema(tmp_path, "dagster_community_components.AutoFieldComponent") == expected


def test_unknown_class_or_missing_venv_returns_none(tmp_path):
    assert find_installed_component_schema(tmp_path, "dagster_community_components.AutoFieldComponent") is None
    _install(tmp_path, "dagster_community_components", "a", "x.OtherComponent", {})
    assert find_installed_component_schema(tmp_path, "dagster_community_components.AutoFieldComponent") is None
    assert find_installed_component_schema(tmp_path, "NoDots") is None
