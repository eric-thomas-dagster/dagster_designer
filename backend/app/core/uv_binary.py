"""Resolves the `uv` / `uvx` executables.

Not just `shutil.which` because GUI-launched processes (double-clicking the
app, or Dagster Designer's own Tauri shell) don't always inherit the same
PATH a login shell does, so we also check uv's own well-known per-user
install location before giving up.
"""

import os
import shutil
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
