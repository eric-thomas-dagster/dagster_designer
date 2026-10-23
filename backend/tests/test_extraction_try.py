"""Try-it extraction: plumbing between the API, the project-venv runner script and the installed component.

The component here is a tiny stand-in with the real `extract_one` signature (the real one is tested in the templates repo), so
these tests cover caching, ordering, per-file failures and the missing/outdated component cases without any LLM.
"""

import sys
import textwrap
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import extraction
from app.services import extraction_try_service as svc

FAKE_COMPONENT = textwrap.dedent('''
    import json, os

    def extract_one(file_ref, *, input_type="file", output_fields, doc_label="document", model, api_key=None, api_base=None,
                    llm_max_retries=2, max_content_chars=20000, field_regions=None, warn=None):
        text = open(file_ref).read()
        if text.startswith("BOOM"):
            raise ValueError("model returned garbage")
        if warn:
            warn("heads up")
        fields = {f: text.strip() + ":" + f for f in output_fields}
        raw = json.dumps({"model": model, "key": api_key, "base": api_base, "label": doc_label, "regions": field_regions})
        return fields, raw
''')
OUTDATED_COMPONENT = "# old component without extract_one\n"


@pytest.fixture
def project(tmp_path, monkeypatch):
    svc.clear_cache()
    pdir = tmp_path / "proj"
    comp = pdir / "src" / "pkg" / "components" / "structured_document_extractor"
    comp.mkdir(parents=True)
    (comp / "component.py").write_text(FAKE_COMPONENT)
    (pdir / ".env").write_text("FROM_DOTENV=yes\nMY_KEY=dotenv-key\n")
    fake = SimpleNamespace(
        get_project=lambda pid: object() if pid == "p1" else None,
        _get_project_dir=lambda p: pdir,
        _get_project_python_path=lambda p: sys.executable,
    )
    monkeypatch.setattr(svc, "project_service", fake)
    monkeypatch.setattr(svc, "project_subprocess_env", lambda d: {"PATH": "/usr/bin:/bin", "MY_BASE": "http://localhost:11434"})
    app = FastAPI()
    app.include_router(extraction.router, prefix="/api")
    return SimpleNamespace(dir=pdir, comp=comp / "component.py", client=TestClient(app), tmp=tmp_path)


def _docs(tmp, **named):
    paths = []
    for name, text in named.items():
        p = tmp / f"{name}.txt"
        p.write_text(text)
        paths.append(str(p))
    return paths


def _body(files, **over):
    return {"files": files, "output_fields": ["total"], "document_type": "invoice", "model": "gpt-4o", "api_key_env_var": "MY_KEY", **over}


def _post(project, body):
    return project.client.post("/api/projects/p1/extraction/try", json=body)


def test_results_come_back_in_file_order_with_per_file_failures(project):
    files = _docs(project.tmp, a="alpha", b="BOOM", c="gamma")
    res = _post(project, _body(files)).json()
    assert [r["file"] for r in res["results"]] == files
    assert res["results"][0]["fields"] == {"total": "alpha:total"}
    assert res["results"][1]["ok"] is False and "garbage" in res["results"][1]["error"]
    assert res["results"][2]["ok"] is True
    assert res["calls"] == 3 and res["cached"] == 0


def test_the_runner_receives_the_key_and_base_from_the_named_env_vars_and_project_dotenv(project):
    files = _docs(project.tmp, a="x")
    body = _body(files, api_base_env_var="MY_BASE", field_regions={"total": {"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4}})
    raw = _post(project, body).json()["results"][0]["raw"]
    assert '"key": "dotenv-key"' in raw  # filled from the project's .env
    assert '"base": "http://localhost:11434"' in raw
    assert '"label": "invoice"' in raw and '"height": 0.4' in raw


def test_identical_document_and_settings_hit_the_cache_and_changed_ones_do_not(project):
    files = _docs(project.tmp, a="alpha")
    assert _post(project, _body(files)).json()["calls"] == 1
    again = _post(project, _body(files)).json()
    assert again["calls"] == 0 and again["cached"] == 1 and again["results"][0]["cached"] is True
    assert again["results"][0]["file"] == files[0]
    # a new field, a different model, a changed document or use_cache=false all re-run
    assert _post(project, _body(files, output_fields=["total", "vendor"])).json()["calls"] == 1
    assert _post(project, _body(files, model="claude-sonnet")).json()["calls"] == 1
    assert _post(project, _body(files, use_cache=False)).json()["calls"] == 1
    (project.tmp / "a.txt").write_text("changed")
    assert _post(project, _body(files)).json()["calls"] == 1


def test_failures_are_not_cached_so_a_retry_really_retries(project):
    files = _docs(project.tmp, a="BOOM")
    assert _post(project, _body(files)).json()["calls"] == 1
    assert _post(project, _body(files)).json()["calls"] == 1


def test_a_missing_or_outdated_component_is_a_clear_409(project):
    files = _docs(project.tmp, a="x")
    project.comp.write_text(OUTDATED_COMPONENT)
    res = _post(project, _body(files))
    assert res.status_code == 409 and res.json()["detail"]["code"] == "component_outdated"
    project.comp.unlink()
    res = _post(project, _body(files))
    assert res.status_code == 409 and res.json()["detail"]["code"] == "component_missing"


def test_input_validation(project):
    assert _post(project, _body([])).status_code == 400
    assert _post(project, _body(_docs(project.tmp, a="x"), output_fields=[])).status_code == 400
    many = _docs(project.tmp, **{f"d{i}": "x" for i in range(svc.MAX_FILES + 1)})
    assert _post(project, _body(many)).status_code == 400
    assert project.client.post("/api/projects/nope/extraction/try", json=_body(_docs(project.tmp, z="x"))).status_code == 404


def test_cache_is_keyed_by_hash_and_stores_no_file_path(project):
    files = _docs(project.tmp, a="x")
    _post(project, _body(files))
    assert svc._cache, "a successful result should have been cached"
    assert all(len(k) == 64 and all(c in "0123456789abcdef" for c in k) for k in svc._cache)
    assert all("file" not in value for _ts, value in svc._cache.values())
