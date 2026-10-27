from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.api import projects as projects_api
from app.main import app
from app.models.project import Project
from app.services import sample_project_service as sample


def test_unique_name_numbers_a_second_copy():
    assert sample.unique_name([]) == sample.SAMPLE_NAME
    assert sample.unique_name(["Other"]) == sample.SAMPLE_NAME
    assert sample.unique_name([sample.SAMPLE_NAME]) == f"{sample.SAMPLE_NAME} 2"
    assert sample.unique_name([sample.SAMPLE_NAME, f"{sample.SAMPLE_NAME} 2"]) == f"{sample.SAMPLE_NAME} 3"
    assert sample.unique_name([sample.SAMPLE_NAME.upper()]) == f"{sample.SAMPLE_NAME} 2"


def test_sample_files_are_valid_python_with_the_advertised_pieces(tmp_path):
    folder = sample.add_sample_files(tmp_path / "defs")
    src = (folder / "assets.py").read_text()
    compile(src, "assets.py", "exec")
    for piece in ("def raw_orders", "def cleaned_orders", "def revenue_by_product", "asset_check", "ScheduleDefinition"):
        assert piece in src
    assert (folder / "__init__.py").exists()
    sample.add_sample_files(tmp_path / "defs")  # idempotent


def test_sample_uses_only_dagster_and_the_standard_library(tmp_path):
    """It has to run with nothing installed: no pandas, no registry components."""
    import ast

    tree = ast.parse(sample.SAMPLE_ASSETS_PY)
    imported = {n.names[0].name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import)}
    imported |= {n.module.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
    assert imported <= {"random", "dagster"}


def test_endpoint_creates_a_project_and_writes_the_sample(tmp_path, monkeypatch):
    proj_dir = tmp_path / "proj"
    created = {}

    def fake_create(pc):
        created["name"] = pc.name
        return Project(id="s1", name=pc.name, description=pc.description)

    monkeypatch.setattr(projects_api.project_service, "list_projects", lambda: [SimpleNamespace(name=sample.SAMPLE_NAME)])
    monkeypatch.setattr(projects_api.project_service, "create_project", fake_create)
    monkeypatch.setattr(projects_api.project_service, "_get_project_dir", lambda p: proj_dir)
    monkeypatch.setattr(projects_api.project_service, "get_project_root_module", lambda p: "mod")

    async def noop(project):
        return None

    monkeypatch.setattr(projects_api, "_install_dependencies_and_generate_assets", noop)
    r = TestClient(app).post("/api/v1/projects/sample")
    assert created["name"] == f"{sample.SAMPLE_NAME} 2"
    assert (proj_dir / "src" / "mod" / "defs" / "coffee_shop" / "assets.py").exists()
    assert r.status_code == 201, r.text
    assert r.json()["name"] == f"{sample.SAMPLE_NAME} 2"
