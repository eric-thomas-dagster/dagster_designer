"""GET /projects/{id}/folder: where a project lives, for "reveal in Finder" / "open in editor"."""
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import projects as projects_api


@pytest.fixture
def client(tmp_path, monkeypatch):
    app = FastAPI()
    app.include_router(projects_api.router, prefix="/api")
    folder = tmp_path / "demo"
    folder.mkdir()
    local = SimpleNamespace(id="p1", is_dagster_plus=False)
    cloud = SimpleNamespace(id="p2", is_dagster_plus=True)
    gone = SimpleNamespace(id="p3", is_dagster_plus=False)
    fake = SimpleNamespace(
        get_project=lambda pid: {"p1": local, "p2": cloud, "p3": gone}.get(pid),
        _get_project_dir=lambda p: {"p1": folder, "p2": folder, "p3": tmp_path / "missing"}[p.id],
    )
    monkeypatch.setattr(projects_api, "project_service", fake)
    return TestClient(app), folder


def test_a_local_project_reports_its_absolute_folder(client):
    c, folder = client
    body = c.get("/api/projects/p1/folder").json()
    assert body == {"path": str(folder.resolve())}


def test_a_dagster_plus_project_has_no_folder(client):
    c, _ = client
    res = c.get("/api/projects/p2/folder")
    assert res.status_code == 404 and "no folder" in res.json()["detail"]


def test_a_project_whose_folder_is_gone_or_unknown_is_a_404(client):
    c, _ = client
    assert c.get("/api/projects/p3/folder").status_code == 404
    assert c.get("/api/projects/nope/folder").status_code == 404
