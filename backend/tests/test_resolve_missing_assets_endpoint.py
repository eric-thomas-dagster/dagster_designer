import asyncio
from types import SimpleNamespace

from app.api import projects as P
from app.models.component import ComponentInstance

ERR = "dagster._core.errors.DagsterInvalidSubsetError: AssetKey(s) ['pr_review_fetch_pr_diff'] were selected, but no AssetsDefinition objects supply these keys."


def _setup(monkeypatch, tmp_path):
    defs = tmp_path / "src" / "m" / "defs"
    (defs / "sched").mkdir(parents=True)
    (defs / "sched" / "defs.yaml").write_text("type: pkg.CronScheduleComponent\nattributes:\n  asset_keys:\n    - pr_review_fetch_pr_diff\n")
    (defs / "keep").mkdir()
    (defs / "keep" / "defs.yaml").write_text("type: pkg.X\nattributes:\n  asset_name: keep\n")
    (defs / "defs.yaml").write_text("type: dagster.DefsFolderComponent\npost_processing:\n  assets:\n  - target: key:keep\n    attributes:\n      deps:\n      - pr_review_fetch_pr_diff\n")
    comp = lambda i, attrs: ComponentInstance(id=i, component_type="pkg.X", label=i, attributes=attrs)
    proj = SimpleNamespace(id="p", components=[comp("sched", {}), comp("keep", {"deps": ["pr_review_fetch_pr_diff", "other"]})],
                           custom_lineage=[], asset_field_overrides={})
    saved = {}

    def loads_ok():
        return "pr_review_fetch_pr_diff" not in "".join(p.read_text() for p in defs.rglob("defs.yaml"))

    async def validate(project, tail_lines=30):
        return (True, None) if loads_ok() else (False, ERR)

    monkeypatch.setattr(P.project_service, "get_project", lambda pid: proj)
    monkeypatch.setattr(P.project_service, "_get_project_dir", lambda p: tmp_path)
    monkeypatch.setattr(P.project_service, "update_project", lambda pid, upd: saved.update(components=upd.components) or proj)
    monkeypatch.setattr(P.asset_introspection_service, "validate_project_defs_async", validate)
    monkeypatch.setattr(P.asset_introspection_service, "clear_cache", lambda pid: None)
    return defs, proj, saved


def test_dry_run_reports_without_changing_anything(monkeypatch, tmp_path):
    defs, proj, saved = _setup(monkeypatch, tmp_path)
    out = asyncio.run(P.resolve_missing_assets("p", P.ResolveMissingAssetsRequest(dry_run=True)))
    assert out["dry_run"] and out["healed"]["pr_review_fetch_pr_diff"]["removed"] == ["sched"]
    assert (defs / "sched").exists() and not saved


def test_resolve_heals_files_revalidates_and_syncs_project_record(monkeypatch, tmp_path):
    defs, proj, saved = _setup(monkeypatch, tmp_path)
    out = asyncio.run(P.resolve_missing_assets("p", None))
    assert out["ok"] is True and out["rounds"] == 1
    assert not (defs / "sched").exists()                                            # schedule over only the missing asset goes
    assert "pr_review_fetch_pr_diff" not in (defs / "defs.yaml").read_text()        # dangling post_processing dep gone
    assert [c.id for c in saved["components"]] == ["keep"]                          # Designer's record matches the files
    assert proj.components[0].attributes["deps"] == ["other"]                       # ...including stale attributes


def test_nothing_to_do_when_project_loads(monkeypatch, tmp_path):
    defs, proj, saved = _setup(monkeypatch, tmp_path)
    for p in defs.rglob("defs.yaml"):
        p.write_text(p.read_text().replace("pr_review_fetch_pr_diff", "other"))
    out = asyncio.run(P.resolve_missing_assets("p", None))
    assert out == {"ok": True, "healed": {}, "rounds": 0, "dry_run": False}
