"""A `dg list defs` that collides with the auto-started `dg dev` reloading the project (both
refresh the dbt component's staged .local_defs_state copy) fails for a moment and then works.
That used to surface as a false 'Project validation failed' banner. Transient collisions are
retried; real errors still fail immediately."""
import asyncio
import json
import subprocess
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.api import projects as projects_api
from app.main import app
from app.services import asset_introspection_service as ais

RACE_1 = ("Loading location x failed:\n...\nFileNotFoundError: [Errno 2] No such file or directory: "
          "PosixPath('/p/src/mod/defs/.local_defs_state/DbtProjectComponent__a__/project/target/x')")
RACE_2 = "dagster_dbt.errors.DagsterDbtProjectYmlFileNotFoundError: dbt_project.yml not found"
REAL_1 = "pydantic_core._pydantic_core.ValidationError: 1 validation error for DataFrameTransformerComponent\nfill_na_value"
REAL_2 = "FileNotFoundError: [Errno 2] No such file or directory: '/p/src/mod/defs/orders/schema.sql'"  # not the state dir
REAL_3 = "Component type 'x.Y' not found. (.local_defs_state mentioned only in passing)"


@pytest.mark.parametrize("text", [RACE_1, RACE_2])
def test_known_race_signatures_are_transient(text):
    assert ais.is_transient_state_race(text)


@pytest.mark.parametrize("text", [REAL_1, REAL_2, REAL_3, "", None])
def test_real_errors_are_never_treated_as_transient(text):
    assert not ais.is_transient_state_race(text)


# ---- the shared introspection runner -------------------------------------------------

class FakeProc:
    def __init__(self, rc, out=b"", err=b""):
        self.returncode, self._out, self._err = rc, out, err

    async def communicate(self):
        return self._out, self._err

    def kill(self): ...
    async def wait(self): ...


@pytest.fixture()
def runner(tmp_path, monkeypatch):
    """run(procs) drives the shared introspection runner with scripted fake processes (the last
    one repeats); run.calls records how many times `dg list defs` was started."""
    project_dir = tmp_path / "p"
    (project_dir / ".venv/bin").mkdir(parents=True)
    (project_dir / ".venv/bin/dg").write_text("")
    monkeypatch.setattr(ais, "TRANSIENT_RETRY_DELAYS", (0.0, 0.0, 0.0))
    project = SimpleNamespace(id="rt", dagster_package_subdir=None)

    def run(procs):
        run.calls = 0

        async def fake_exec(*a, **k):
            run.calls += 1
            return procs[min(run.calls, len(procs)) - 1]

        monkeypatch.setattr(ais.asyncio, "create_subprocess_exec", fake_exec)
        ais._assets_cache.pop("rt", None)
        try:
            return asyncio.run(ais.asset_introspection_service._run_dg_list_defs_async(project, project_dir))
        finally:
            ais._assets_cache.pop("rt", None)

    run.calls = 0
    return run


def test_transient_race_is_retried_then_succeeds(runner):
    ok = FakeProc(0, json.dumps({"assets": []}).encode())
    assert runner([FakeProc(1, b"", RACE_1.encode()), FakeProc(1, b"", RACE_2.encode()), ok]) == {"assets": []}
    assert runner.calls == 3


def test_a_real_error_is_not_retried(runner):
    with pytest.raises(RuntimeError, match="validation error"):
        runner([FakeProc(1, b"", REAL_1.encode()), FakeProc(0, b"{}")])
    assert runner.calls == 1


def test_a_persistent_race_gives_up_after_the_bounded_retries(runner):
    with pytest.raises(RuntimeError):
        runner([FakeProc(1, b"", RACE_1.encode())])
    assert runner.calls == 1 + len(ais.TRANSIENT_RETRY_DELAYS)  # initial attempt + 3 retries


# ---- POST /validate -------------------------------------------------------------------

@pytest.fixture()
def validate(tmp_path, monkeypatch):
    proj = tmp_path / "v"
    (proj / ".venv/bin").mkdir(parents=True)
    (proj / ".venv/bin/dg").write_text("")
    monkeypatch.setattr(projects_api.project_service, "get_project", lambda pid: SimpleNamespace(id=pid, is_dagster_plus=False))
    monkeypatch.setattr(projects_api.project_service, "_get_project_dir", lambda p: proj)
    monkeypatch.setattr(ais, "TRANSIENT_RETRY_DELAYS", (0.0, 0.0, 0.0))

    async def no_sleep(*_a, **_k): ...
    monkeypatch.setattr(projects_api.asyncio, "sleep", no_sleep)

    def go(results):
        calls = []

        def fake_run(cmd, **kw):
            calls.append(cmd)
            rc, out, err = results[min(len(calls), len(results)) - 1]
            return subprocess.CompletedProcess(cmd, rc, out, err)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ais._last_run_result.pop("v1", None)
        r = TestClient(app).post("/api/v1/projects/v1/validate").json()
        ais._last_run_result.pop("v1", None)
        return r, calls
    return go


def test_validate_rides_out_a_transient_race(validate):
    r, calls = validate([(1, "", RACE_1), (1, "", RACE_2), (0, "Assets │ x", "")])
    assert r["valid"] is True and len(calls) == 3


def test_validate_reports_real_errors_after_the_single_ordinary_retry(validate):
    r, calls = validate([(1, "", REAL_1)])
    assert r["valid"] is False and len(calls) == 2
