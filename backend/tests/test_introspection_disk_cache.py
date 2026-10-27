"""Reopening a project (a fresh process, or after the 60s memory cache expires) must not re-run `dg list defs` while the project's
files are unchanged -- and must run it for real after any edit, or when validation asks for the truth."""
import asyncio
import json
from types import SimpleNamespace

import pytest

from app.services import asset_introspection_service as ais


class FakeProc:
    returncode = 0

    def __init__(self, payload):
        self._out = json.dumps(payload).encode()

    async def communicate(self):
        return self._out, b""

    def kill(self): ...
    async def wait(self): ...


@pytest.fixture()
def env(tmp_path, monkeypatch):
    project_dir = tmp_path / "p"
    (project_dir / ".venv/bin").mkdir(parents=True)
    (project_dir / ".venv/bin/dg").write_text("")
    (project_dir / "src").mkdir()
    (project_dir / "src" / "defs.yaml").write_text("type: a\n")
    project = SimpleNamespace(id="dc", dagster_package_subdir=None)
    state = SimpleNamespace(calls=0, project_dir=project_dir)

    async def fake_exec(*a, **k):
        state.calls += 1
        return FakeProc({"assets": [state.calls]})

    monkeypatch.setattr(ais.asyncio, "create_subprocess_exec", fake_exec)
    ais._assets_cache.pop("dc", None)

    def load():
        return asyncio.run(ais.asset_introspection_service._run_dg_list_defs_async(project, project_dir))

    state.load = load
    yield state
    ais._assets_cache.pop("dc", None)


def test_second_open_with_unchanged_files_skips_dg(env):
    assert env.load() == {"assets": [1]}
    ais._assets_cache.pop("dc", None)  # what a restart or the 60s expiry does
    assert env.load() == {"assets": [1]}
    assert env.calls == 1


def test_editing_a_file_reruns_dg(env):
    env.load()
    ais._assets_cache.pop("dc", None)
    (env.project_dir / "src" / "defs.yaml").write_text("type: b, now longer\n")
    assert env.load() == {"assets": [2]}
    assert env.calls == 2


def test_invalidating_the_project_reruns_dg(env):
    env.load()
    ais.invalidate_project_caches("dc")
    assert env.load() == {"assets": [2]}


def test_validation_always_runs_the_real_thing(env, monkeypatch):
    env.load()
    project = SimpleNamespace(id="dc", dagster_package_subdir=None)
    svc = ais.asset_introspection_service
    monkeypatch.setattr(svc, "_get_project_dir", lambda p: env.project_dir)
    ok, err = asyncio.run(svc.validate_project_defs_async(project))
    assert (ok, err) == (True, None)
    assert env.calls == 2
