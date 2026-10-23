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


# --- golden set + scoring through the API ---------------------------------------------------------------------------

def _digest_of(project, text):
    return svc._file_digest(_docs(project.tmp, probe=text)[0])


def _mark(project, **kw):
    body = {"asset_name": "invoices", "path": "/x/a.txt", **kw}
    return project.client.put("/api/projects/p1/extraction/golden", json=body)


def test_marked_fields_are_scored_and_summarized_on_the_next_run(project):
    files = _docs(project.tmp, a="alpha", b="beta")
    first = _post(project, _body(files, asset_name="invoices")).json()
    assert first["score"]["accuracy"] is None  # nothing marked yet
    a, b = first["results"]
    # the stand-in extractor returns "<text>:total"; mark a as right (model's own value) and b as wrong
    assert _mark(project, digest=a["digest"], field="total", value=a["fields"]["total"], extracted=a["fields"]["total"]).json()["match"] is True
    wrong = _mark(project, digest=b["digest"], field="total", value_text="999", extracted=b["fields"]["total"]).json()
    assert wrong["match"] is False and wrong["expected"] == {"total": 999} and wrong["marked_documents"] == 2
    again = _post(project, _body(files, asset_name="invoices")).json()
    assert again["cached"] == 2  # scoring needs no new model calls
    assert again["results"][0]["match"] == {"total": True} and again["results"][1]["match"] == {"total": False}
    assert again["results"][1]["expected"] == {"total": 999}
    assert (again["score"]["marked"], again["score"]["correct"], again["score"]["accuracy"]) == (2, 1, 0.5)


def test_scoring_follows_the_document_content_not_its_filename(project):
    files = _docs(project.tmp, a="alpha")
    first = _post(project, _body(files, asset_name="invoices")).json()["results"][0]
    _mark(project, digest=first["digest"], field="total", value=first["fields"]["total"])
    (project.tmp / "renamed.txt").write_text("alpha")
    moved = _post(project, _body([str(project.tmp / "renamed.txt")], asset_name="invoices")).json()
    assert moved["results"][0]["match"] == {"total": True}


def test_a_field_marked_empty_is_right_when_blank_and_a_failed_document_misses_the_rest(project):
    files = _docs(project.tmp, a="alpha", b="BOOM")
    res = _post(project, _body(files, asset_name="invoices")).json()["results"]
    _mark(project, digest=res[1]["digest"], field="total", value_text="12.5")
    again = _post(project, _body(files, asset_name="invoices")).json()
    assert again["results"][1]["ok"] is False and again["results"][1]["match"] == {"total": False}


def test_unmarking_removes_the_expectation(project):
    files = _docs(project.tmp, a="alpha")
    r = _post(project, _body(files, asset_name="invoices")).json()["results"][0]
    _mark(project, digest=r["digest"], field="total", value_text="1")
    gone = project.client.delete("/api/projects/p1/extraction/golden", params={"asset_name": "invoices", "digest": r["digest"], "field": "total"}).json()
    assert gone == {"expected": {}, "marked_documents": 0}
    assert _post(project, _body(files, asset_name="invoices")).json()["results"][0]["match"] == {}


def test_golden_get_and_unknown_project(project):
    files = _docs(project.tmp, a="alpha")
    r = _post(project, _body(files, asset_name="invoices")).json()["results"][0]
    _mark(project, digest=r["digest"], field="vendor", value_text="")  # blank = should be empty
    got = project.client.get("/api/projects/p1/extraction/golden", params={"asset_name": "invoices"}).json()
    assert got["documents"][r["digest"]]["expected"] == {"vendor": None}
    assert project.client.get("/api/projects/nope/extraction/golden", params={"asset_name": "x"}).status_code == 404


def test_no_asset_name_means_no_scoring(project):
    files = _docs(project.tmp, a="alpha")
    res = _post(project, _body(files)).json()
    assert res["score"] is None and "match" not in res["results"][0]
