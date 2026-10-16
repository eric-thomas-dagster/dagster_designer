"""A quickstart/imported project's real module (pyproject root_module) differs from
Designer's folder-name slug. Anything built from the slug points at a module that
doesn't exist: the "Open defs.yaml" link, and -- worst -- the dagster_cloud.yaml
scaffold, whose location would fail to import on Dagster+."""
import yaml
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.project import Project
from app.services.project_service import project_service

SLUG = "project_abc12345_synthetic_commerce"
REAL = "synthetic_commerce"


@pytest.fixture()
def quickstart(tmp_path, monkeypatch):
    monkeypatch.setattr(project_service, "projects_dir", tmp_path)
    project = Project(id="rm-1", name="Synthetic Commerce", directory_name=SLUG)
    project_dir = project_service._get_project_dir(project)
    project_dir.mkdir(parents=True)
    (project_dir / "pyproject.toml").write_text(f'[tool.dg.project]\nroot_module = "{REAL}"\n')
    project_service._save_project(project)
    return project, project_dir


def test_get_project_exposes_the_real_module(quickstart):
    project, _ = quickstart
    got = project_service.get_project(project.id)
    assert got.directory_name == SLUG and got.root_module == REAL


def test_get_project_falls_back_to_the_slug_without_a_pyproject(tmp_path, monkeypatch):
    monkeypatch.setattr(project_service, "projects_dir", tmp_path)
    p = Project(id="rm-2", name="X", directory_name="project_zzz_x")
    project_service._get_project_dir(p).mkdir(parents=True)
    project_service._save_project(p)
    assert project_service.get_project("rm-2").root_module == "project_zzz_x"


def test_api_returns_root_module(quickstart):
    project, _ = quickstart
    body = TestClient(app).get(f"/api/v1/projects/{project.id}").json()
    assert body["root_module"] == REAL


def test_dagster_cloud_scaffold_points_at_the_real_module(quickstart):
    project, project_dir = quickstart
    r = TestClient(app).post(f"/api/v1/projects/{project.id}/dagster-cloud/scaffold")
    assert r.status_code == 200, r.text
    loc = yaml.safe_load((project_dir / "dagster_cloud.yaml").read_text())["locations"][0]
    assert loc["location_name"] == REAL
    assert loc["code_source"]["module_name"] == f"{REAL}.definitions"
    assert SLUG not in (project_dir / "dagster_cloud.yaml").read_text()
