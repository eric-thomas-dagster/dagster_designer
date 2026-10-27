import os
import time

from app.services import definitions_disk_cache as dc


def _project(tmp_path):
    p = tmp_path / "proj"
    (p / "src" / "defs").mkdir(parents=True)
    (p / "src" / "defs" / "a.yaml").write_text("type: x\n")
    (p / "pyproject.toml").write_text("[project]\n")
    return p


def test_round_trip_and_miss_when_nothing_stored(tmp_path):
    p, cd = _project(tmp_path), tmp_path / "cache"
    assert dc.load("p1", p, cd) is None
    dc.store("p1", p, {"assets": [1]}, 3.2, cd)
    assert dc.load("p1", p, cd) == {"assets": [1]}


def test_editing_a_definition_file_invalidates(tmp_path):
    p, cd = _project(tmp_path), tmp_path / "cache"
    dc.store("p1", p, {"v": 1}, cache_dir=cd)
    f = p / "src" / "defs" / "a.yaml"
    f.write_text("type: y, longer\n")
    assert dc.load("p1", p, cd) is None


def test_same_size_edit_is_caught_by_mtime(tmp_path):
    p, cd = _project(tmp_path), tmp_path / "cache"
    f = p / "src" / "defs" / "a.yaml"
    dc.store("p1", p, {"v": 1}, cache_dir=cd)
    f.write_text("type: z\n")  # same length as "type: x\n"
    os.utime(f, ns=(time.time_ns() + 5_000_000_000,) * 2)
    assert dc.load("p1", p, cd) is None


def test_new_and_deleted_files_invalidate(tmp_path):
    p, cd = _project(tmp_path), tmp_path / "cache"
    dc.store("p1", p, {"v": 1}, cache_dir=cd)
    (p / "src" / "defs" / "b.yaml").write_text("x")
    assert dc.load("p1", p, cd) is None
    dc.store("p1", p, {"v": 2}, cache_dir=cd)
    (p / "src" / "defs" / "b.yaml").unlink()
    assert dc.load("p1", p, cd) is None


def test_files_that_cannot_affect_definitions_are_ignored(tmp_path):
    p, cd = _project(tmp_path), tmp_path / "cache"
    for d in ("data", ".venv", "logs", "node_modules", ".git"):
        (p / d).mkdir()
    dc.store("p1", p, {"v": 1}, cache_dir=cd)
    (p / "data" / "out.csv").write_text("rows")
    (p / ".venv" / "x").write_text("pkg")
    (p / "logs" / "run.log").write_text("hi")
    (p / "src" / "defs" / "mod.cpython-312.pyc").write_bytes(b"\0")
    assert dc.load("p1", p, cd) == {"v": 1}


def test_expires_and_ignores_other_versions(tmp_path, monkeypatch):
    p, cd = _project(tmp_path), tmp_path / "cache"
    dc.store("p1", p, {"v": 1}, cache_dir=cd)
    monkeypatch.setattr(dc, "MAX_AGE_SECONDS", -1)
    assert dc.load("p1", p, cd) is None
    monkeypatch.setattr(dc, "MAX_AGE_SECONDS", 3600)
    assert dc.load("p1", p, cd) == {"v": 1}
    monkeypatch.setattr(dc, "SCHEMA_VERSION", 99)
    assert dc.load("p1", p, cd) is None


def test_clear_and_corrupt_file_are_harmless(tmp_path):
    p, cd = _project(tmp_path), tmp_path / "cache"
    dc.store("p1", p, {"v": 1}, cache_dir=cd)
    dc.clear("p1", cd)
    assert dc.load("p1", p, cd) is None
    dc.clear("never-stored", cd)
    (cd / "p2.json").write_text("{not json")
    assert dc.load("p2", p, cd) is None


def test_projects_do_not_share_entries_and_ids_are_sanitised(tmp_path):
    p, cd = _project(tmp_path), tmp_path / "cache"
    dc.store("a", p, {"v": "a"}, cache_dir=cd)
    assert dc.load("b", p, cd) is None
    dc.store("../../evil", p, {"v": 1}, cache_dir=cd)
    assert not any(x for x in tmp_path.rglob("evil*") if cd not in x.parents)
