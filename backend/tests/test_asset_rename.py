from app.services.asset_rename import restore, rewrite_references


def _write(p, text):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    return p


def test_rewrites_upstream_deps_and_post_processing_targets_but_nothing_else(tmp_path):
    defs = tmp_path / "defs"
    down = _write(defs / "down" / "defs.yaml", "type: x.Y\nattributes:\n  asset_name: down  # keep this comment\n  upstream_asset_key: old_name\n  description: old_name is mentioned here\n")
    multi = _write(defs / "multi" / "defs.yaml", "type: x.Y\nattributes:\n  asset_name: multi\n  upstream_asset_keys:\n    - old_name\n    - other\n")
    root = _write(defs / "defs.yaml", "type: dagster.DefsFolderComponent\npost_processing:\n  assets:\n  - target: key:old_name\n    attributes:\n      deps:\n      - old_name\n      - keep\n")
    unrelated = _write(defs / "u" / "defs.yaml", "type: x.Y\nattributes:\n  asset_name: unrelated\n  table: old_name\n")
    src = _write(defs / "old_name" / "defs.yaml", "type: x.Y\nattributes:\n  asset_name: old_name\n")

    touched = rewrite_references(defs, "old_name", "new_name", skip_dir=defs / "old_name")

    assert sorted(p.parent.name for p in touched) == ["defs", "down", "multi"]
    assert "upstream_asset_key: new_name" in down.read_text() and "# keep this comment" in down.read_text()
    assert "old_name is mentioned here" in down.read_text()            # free text untouched
    assert "- new_name" in multi.read_text() and "- other" in multi.read_text()
    r = root.read_text()
    assert "key:new_name" in r and "- new_name" in r and "- keep" in r and "old_name" not in r
    assert "table: old_name" in unrelated.read_text()                   # not a reference field
    assert "asset_name: old_name" in src.read_text()                    # the renamed one is left to the caller

    restore(touched)
    assert "upstream_asset_key: old_name" in down.read_text() and "key:old_name" in root.read_text()


def test_no_references_touches_nothing(tmp_path):
    defs = tmp_path / "defs"
    _write(defs / "a" / "defs.yaml", "type: x.Y\nattributes:\n  asset_name: a\n")
    assert rewrite_references(defs, "ghost", "x") == {}


def test_configure_rename_moves_the_instance_and_updates_downstream(monkeypatch, tmp_path):
    import asyncio
    from types import SimpleNamespace

    from app.api import templates_registry as T
    from app.models.graph import PipelineGraph
    from app.services.asset_introspection_service import AssetIntrospectionService

    defs = tmp_path / "defs"
    comps = tmp_path / "components"
    (comps / "widget").mkdir(parents=True)
    (comps / "widget" / "manifest.yaml").write_text("component_type: pkg.Widget\n")
    old = _write(defs / "old_name" / "defs.yaml", "type: pkg.Widget\nattributes:\n  asset_name: old_name\n")
    down = _write(defs / "down" / "defs.yaml", "type: pkg.Widget\nattributes:\n  asset_name: down\n  upstream_asset_key: old_name\n")
    edge = SimpleNamespace(source="old_name", target="down")
    proj = SimpleNamespace(id="p", name="p", graph=PipelineGraph(), components=[SimpleNamespace(id="old_name"), SimpleNamespace(id="down")],
                           custom_lineage=[edge], asset_field_overrides={"old_name": {"group_name": "g"}})
    monkeypatch.setattr(T.project_service, "get_project", lambda pid: proj)
    monkeypatch.setattr(T.project_service, "_get_project_dir", lambda p: tmp_path)
    monkeypatch.setattr(T.project_service, "_save_project", lambda p: None)
    monkeypatch.setattr(T, "detect_project_structure", lambda *a, **k: (tmp_path, "m", True, defs, comps))
    fail = {"on": False}

    async def fake_introspect(self, project, *a, **k):
        if fail["on"]:
            raise RuntimeError("project does not load")
        return [], []
    monkeypatch.setattr(AssetIntrospectionService, "get_assets_for_project_async", fake_introspect)
    monkeypatch.setattr(AssetIntrospectionService, "clear_cache", lambda self, pid: None)

    def configure(**cfg):
        req = SimpleNamespace(project_id="p", config=cfg)
        return asyncio.run(T.configure_component("widget", req))

    # a failing rename is undone completely
    fail["on"] = True
    r = configure(name="new_name", asset_name="new_name", _renamed_from="old_name")
    assert r["success"] is False
    assert old.exists() and not (defs / "new_name").exists()
    assert "upstream_asset_key: old_name" in down.read_text()
    assert proj.custom_lineage[0].source == "old_name" and "old_name" in proj.asset_field_overrides

    # a successful rename moves the folder and rewrites everything that pointed at it
    fail["on"] = False
    r = configure(name="new_name", asset_name="new_name", _renamed_from="old_name")
    assert r["success"] is not False
    assert not (defs / "old_name").exists() and (defs / "new_name" / "defs.yaml").exists()
    assert "upstream_asset_key: new_name" in down.read_text()
    assert proj.custom_lineage[0].source == "new_name" and "new_name" in proj.asset_field_overrides and "old_name" not in proj.asset_field_overrides
    assert [c.id for c in proj.components if c.id in ("old_name", "new_name")] == ["new_name"]
