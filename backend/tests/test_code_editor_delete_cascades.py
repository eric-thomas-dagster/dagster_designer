import asyncio

from app.api import files as F
from types import SimpleNamespace

from app.services import project_service as PS
from app.services.file_service import FileService


def test_deleting_a_component_folder_in_the_code_editor_cleans_what_pointed_at_it(monkeypatch, tmp_path):
    proj = tmp_path / "p1"
    defs = proj / "src" / "m" / "defs"
    (defs / "raw").mkdir(parents=True)
    (defs / "raw" / "defs.yaml").write_text("type: pkg.Gen\nattributes:\n  asset_name: raw_things\n")
    (defs / "sched").mkdir()
    (defs / "sched" / "defs.yaml").write_text("type: pkg.CronScheduleComponent\nattributes:\n  asset_keys:\n  - raw_things\n")
    (defs / "other").mkdir()
    (defs / "other" / "defs.yaml").write_text("type: pkg.X\nattributes:\n  asset_name: other\n")
    monkeypatch.setattr(PS.project_service, "get_project", lambda pid: SimpleNamespace(directory_name="p1"))
    monkeypatch.setattr(F, "file_service", FileService(str(tmp_path)))
    monkeypatch.setattr(F, "_invalidate_if_definition_file", lambda *a: None)

    out = asyncio.run(F.delete_directory("p1", "src/m/defs/raw"))
    assert not (defs / "raw").exists() and not (defs / "sched").exists() and (defs / "other").exists()
    assert out["cascade"]["removed"] == ["sched"]


def test_deleting_an_ordinary_file_does_not_touch_anything_else(monkeypatch, tmp_path):
    proj = tmp_path / "p1"
    (proj / "src" / "m" / "defs" / "raw").mkdir(parents=True)
    (proj / "src" / "m" / "defs" / "raw" / "defs.yaml").write_text("type: pkg.Gen\nattributes:\n  asset_name: raw\n")
    (proj / "notes.txt").write_text("hi")
    monkeypatch.setattr(PS.project_service, "get_project", lambda pid: SimpleNamespace(directory_name="p1"))
    monkeypatch.setattr(F, "file_service", FileService(str(tmp_path)))
    monkeypatch.setattr(F, "_invalidate_if_definition_file", lambda *a: None)
    out = asyncio.run(F.delete_file("p1", "notes.txt"))
    assert "cascade" not in out and (proj / "src" / "m" / "defs" / "raw" / "defs.yaml").exists()
