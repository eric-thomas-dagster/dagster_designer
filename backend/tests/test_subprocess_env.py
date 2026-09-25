"""Regression tests for project_subprocess_env.

This is the shared helper that replaced ~7 duplicated (and, in two cases,
subtly broken) copies of "build an env dict for running a project's own
dg/dbt tooling" scattered across projects.py, pipelines.py, components.py
and asset_introspection_service.py. The bug it fixes bit this app three
separate times in one session: a subprocess that inherits the BACKEND's
own VIRTUAL_ENV (or has it merely popped, leaving nothing) lets a
dbt-backed component's nested `dbt parse`/`dbt build` subprocess resolve
its adapter plugin off the wrong (or no) venv, failing with "Could not
find adapter type duckdb!" even though the project's own venv has it
installed.
"""

import sys

import pytest

from app.core.uv_binary import project_subprocess_env


def test_points_virtual_env_at_the_project_venv(tmp_path):
    env = project_subprocess_env(tmp_path)
    assert env["VIRTUAL_ENV"] == str((tmp_path / ".venv").resolve())


def test_prepends_the_project_venv_bin_dir_to_path(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    env = project_subprocess_env(tmp_path)
    bin_name = "Scripts" if sys.platform == "win32" else "bin"
    expected_bin = str(tmp_path / ".venv" / bin_name)
    parts = env["PATH"].split(";" if sys.platform == "win32" else ":")
    assert parts[0] == expected_bin
    # The rest of the original PATH must still be there -- this is meant
    # to take priority over the ambient PATH, not replace it (a project's
    # dbt/dg still needs to find system tools like git).
    assert "/usr/bin" in parts
    assert "/bin" in parts


def test_removes_pythonhome(tmp_path, monkeypatch):
    monkeypatch.setenv("PYTHONHOME", "/some/other/interpreter")
    env = project_subprocess_env(tmp_path)
    assert "PYTHONHOME" not in env


def test_overrides_an_already_set_virtual_env_rather_than_leaking_it(tmp_path, monkeypatch):
    # This is the actual bug: this backend process runs from its OWN venv
    # (backend/.venv), which sets VIRTUAL_ENV in os.environ. A subprocess
    # spawned for a DIFFERENT project must not inherit that value.
    monkeypatch.setenv("VIRTUAL_ENV", "/Applications/Dagster Designer.app/Contents/Resources/backend/.venv")
    env = project_subprocess_env(tmp_path)
    assert env["VIRTUAL_ENV"] == str((tmp_path / ".venv").resolve())
    assert "Dagster Designer.app" not in env["VIRTUAL_ENV"]


def test_preserves_other_environment_variables(tmp_path, monkeypatch):
    monkeypatch.setenv("SOME_APP_SPECIFIC_VAR", "keep-me")
    env = project_subprocess_env(tmp_path)
    assert env["SOME_APP_SPECIFIC_VAR"] == "keep-me"


def test_does_not_require_the_venv_to_actually_exist(tmp_path):
    # The caller is responsible for checking dg_path.exists() before
    # spawning anything -- this just builds the env dict, so it should
    # never raise even for a project whose .venv hasn't been created yet.
    missing = tmp_path / "does-not-exist"
    env = project_subprocess_env(missing)
    assert env["VIRTUAL_ENV"] == str((missing / ".venv").resolve())
