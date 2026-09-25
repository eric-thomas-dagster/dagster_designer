"""Resolves the `uv` / `uvx` executables.

Not just `shutil.which` because GUI-launched processes (double-clicking the
app, or Dagster Designer's own Tauri shell) don't always inherit the same
PATH a login shell does, so we also check uv's own well-known per-user
install location before giving up.
"""

import os
import shutil
import sys
from pathlib import Path


def _bundled_uv_dir() -> Path | None:
    """The bin/ dir tauri.conf.json's bundle.resources copies vendor/uv/uv
    into (see src-tauri/scripts/fetch-uv.sh), if this is a packaged app.
    This is the one source we can be certain actually exists in a real
    install -- the whole reason it's bundled is that plain `uv`/`uvx` on
    PATH is not guaranteed at all, so callers that skip this and shell out
    to bare "uv" (relying on PATH alone) will break on any machine that
    doesn't happen to have uv installed system-wide.
    <this file>.parents: [0]=core, [1]=app, [2]=backend, [3]=Resources
    """
    resources_dir = Path(__file__).resolve().parents[3]
    bin_dir = resources_dir / "bin"
    return bin_dir if bin_dir.is_dir() else None


def find_uv_binary(name: str = "uv") -> str:
    bundled_dir = _bundled_uv_dir()
    if bundled_dir:
        bundled = bundled_dir / name
        if bundled.exists():
            return str(bundled)
    found = shutil.which(name)
    if found:
        return found
    fallback = Path.home() / ".local" / "bin" / name
    if fallback.exists():
        return str(fallback)
    return name  # last resort -- let the OS raise if it's truly not on PATH


def venv_bin_path(venv_dir: Path, name: str) -> Path:
    """Path to an executable inside a project's own .venv, cross-platform.

    A venv puts its binaries in bin/ with no extension on macOS/Linux, but
    in Scripts/ with a .exe extension on Windows -- and that .exe applies
    to console-script entry points too (dg.exe, dagster.exe), not just
    python.exe itself. Every hardcoded `venv_dir / "bin" / name` in this
    codebase (there were ~25 of them, scattered across a dozen files) only
    ever worked on macOS/Linux; confirmed live on a real Windows box that
    they fail with a literal "not found at .../.venv/bin/dg" error, since
    that path never exists there at all.
    """
    if sys.platform == "win32":
        return venv_dir / "Scripts" / f"{name}.exe"
    return venv_dir / "bin" / name


def project_subprocess_env(project_dir: Path) -> dict[str, str]:
    """A subprocess env for running a PROJECT's own dg/uv/dbt tooling.

    Points VIRTUAL_ENV/PATH at the PROJECT's own .venv -- not just drops
    them -- and clears PYTHONHOME. This backend process runs from its own
    venv (backend/.venv), which sets VIRTUAL_ENV in ITS environment;
    naively inheriting that (or popping it without replacing it) breaks
    any dbt-backed component's nested `dbt parse`/`dbt build` subprocess,
    which resolves its adapter plugin (dbt-duckdb, dbt-snowflake, ...) off
    PATH/VIRTUAL_ENV, not off dg's own resolved binary path -- surfacing
    as "Could not find adapter type duckdb!" even though the project's own
    venv has the adapter installed. Also silences a spurious "the active
    virtual environment does not match the project virtual environment"
    warning `dg` prints on every invocation otherwise, which was noise
    except when it buried a real error underneath it.

    Confirmed live as the root cause of independent incidents in three
    different call sites this session (validate_project, asset
    introspection's dg list defs, a component-schema inspect-component
    call), each of which had partially or fully skipped this -- one
    tested helper instead of re-deriving it per call site.
    """
    venv_dir = project_dir / ".venv"
    bin_dir = venv_bin_path(venv_dir, "dg").parent
    env = os.environ.copy()
    env["VIRTUAL_ENV"] = str(venv_dir.resolve())
    env["PATH"] = f"{bin_dir}{os.pathsep}{env.get('PATH', '')}"
    env.pop("PYTHONHOME", None)
    return env


def env_with_bundled_uv_on_path() -> dict[str, str]:
    """A copy of the current environment with the bundled uv/uvx's own
    directory prepended to PATH.

    Needed when shelling out to a THIRD-PARTY tool (e.g. the
    dagster-community-components-cli, launched via our resolved uvx) that
    itself internally invokes bare "uv" -- we can't fix that tool's own
    source, but since we control the environment it runs in, putting our
    bundled uv on PATH lets its own subprocess calls find it exactly the
    way find_uv_binary() lets our own calls find it.
    """
    env = os.environ.copy()
    bundled_dir = _bundled_uv_dir()
    if bundled_dir:
        env["PATH"] = f"{bundled_dir}{os.pathsep}{env.get('PATH', '')}"
    return env
