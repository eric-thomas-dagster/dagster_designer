"""Resolves the `uv` / `uvx` executables.

Not just `shutil.which` because GUI-launched processes (double-clicking the
app, or Dagster Designer's own Tauri shell) don't always inherit the same
PATH a login shell does, so we also check uv's own well-known per-user
install location before giving up.
"""

import shutil
from pathlib import Path


def find_uv_binary(name: str = "uv") -> str:
    found = shutil.which(name)
    if found:
        return found
    fallback = Path.home() / ".local" / "bin" / name
    if fallback.exists():
        return str(fallback)
    return name  # last resort -- let the OS raise if it's truly not on PATH
