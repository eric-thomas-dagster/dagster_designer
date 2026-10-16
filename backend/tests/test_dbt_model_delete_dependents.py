import pytest
from fastapi import HTTPException

from app.api import projects as P

MANIFEST = {
    "nodes": {
        "model.p.stg": {"name": "stg", "resource_type": "model", "original_file_path": "models/stg.sql"},
        "model.p.mart": {"name": "mart", "resource_type": "model"},
        "test.p.nn": {"name": "nn", "resource_type": "test"},
    },
    "exposures": {"exposure.p.dash": {"name": "dash", "resource_type": "exposure"}},
    "child_map": {"model.p.stg": ["model.p.mart", "test.p.nn", "exposure.p.dash"], "model.p.mart": []},
}


def test_dependents_lists_models_and_exposures_not_tests():
    d = P.dbt_model_dependents(MANIFEST, "model.p.stg")
    assert sorted(x["name"] for x in d) == ["dash", "mart"]
    assert P.dbt_model_dependents(MANIFEST, "model.p.mart") == []
    assert P.dbt_model_dependents({}, "x") == []


def test_delete_refuses_without_force_and_leaves_files(monkeypatch, tmp_path):
    import asyncio
    (tmp_path / "models").mkdir()
    sql = tmp_path / "models" / "stg.sql"; sql.write_text("select 1")
    monkeypatch.setattr(P.project_service, "get_project", lambda pid: object())
    monkeypatch.setattr(P, "_resolve_dbt_root_for_write", lambda proj, rel: tmp_path)
    monkeypatch.setattr(P, "_load_dbt_artifact", lambda path: MANIFEST)
    req = P.DeleteDbtModelRequest(dbt_relative_path="x", model_unique_id="model.p.stg")
    with pytest.raises(HTTPException) as e:
        asyncio.run(P.delete_dbt_model("p", req))
    assert e.value.status_code == 409 and sql.exists()
    req.force = True
    asyncio.run(P.delete_dbt_model("p", req))
    assert not sql.exists()
