"""Saving a source file must drop cached validation/definitions, or 'Retry
validation' right after an edit reports the OLD result (caches live 8-60s)."""
import time

import pytest

from app.services import asset_introspection_service as ais


@pytest.mark.parametrize("path", [
    "src/mod/defs/a/defs.yaml", "src/mod/definitions.py", "pyproject.toml",
    "dbt/proj/models/x.sql", "./src/mod/defs/b.yaml", "dagster_cloud.yaml",
])
def test_definition_files_invalidate(path):
    assert ais.is_definition_affecting_path(path)


@pytest.mark.parametrize("path", [
    "data/synthetic.duckdb", ".venv/lib/x.py", ".designer_dagster_home/history/runs.db",
    "src/mod/__pycache__/x.cpython-312.pyc", "logs/run.log", "src/mod/x.pyc",
])
def test_data_venv_and_cache_files_do_not(path):
    assert not ais.is_definition_affecting_path(path)


def test_invalidate_clears_every_cached_view():
    from app.api.primitives import _definitions_cache
    pid = "inv-test"
    ais._assets_cache[pid] = (time.time(), {"x": 1})
    ais.record_last_run_result(pid, True, None)
    _definitions_cache[pid] = (time.time(), {"y": 2})
    assert ais.get_recent_run_result(pid) == (True, None)
    ais.invalidate_project_caches(pid)
    assert pid not in ais._assets_cache and pid not in _definitions_cache
    assert ais.get_recent_run_result(pid) is None
    ais.invalidate_project_caches(pid)  # idempotent / safe when nothing cached


def test_write_endpoint_invalidates_only_for_definition_files(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.api import files as files_api

    monkeypatch.setattr(files_api.file_service, "write_file", lambda pid, p, c: {"ok": True})
    pid = "w1"
    c = TestClient(app)

    ais.record_last_run_result(pid, False, "stale")
    assert c.post(f"/api/v1/files/write/{pid}/src/mod/defs/a/defs.yaml", json={"content": "x"}).status_code == 200
    assert ais.get_recent_run_result(pid) is None  # dropped

    ais.record_last_run_result(pid, False, "keep me")
    assert c.post(f"/api/v1/files/write/{pid}/data/notes.csv", json={"content": "x"}).status_code == 200
    assert ais.get_recent_run_result(pid) == (False, "keep me")  # untouched
