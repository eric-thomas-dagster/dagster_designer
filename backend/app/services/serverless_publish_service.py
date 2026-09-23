"""Shared logic for "publish directly to a Dagster+ Serverless deployment,
skip git entirely" -- the explicitly-discouraged fast path for a demo
you're going to throw away. Two callers share this:

  - designer_loc_service.publish_serverless: publishes the Designer
    sandbox's code. Already Dagster+-connected (org/token/deployment
    come from the project record).
  - project_service-level local-project publish: publishes a plain
    local project's own code. NOT Dagster+-connected by default, so
    org/token/deployment are collected from the caller instead of
    assumed to already exist on the project.

Path-based rather than coupled to either caller's own state object, so
both can reuse it without a service importing the other.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Callable


def detect_python_version(project_dir: Path) -> str:
    """Read a venv's actual Python version (`major.minor`) from
    pyvenv.cfg rather than hardcoding one — avoids deploying against a
    version that doesn't match what the project's deps were installed
    for. Falls back to 3.12 (create-dagster's current default) if the
    file's missing or unparseable."""
    cfg = project_dir / ".venv" / "pyvenv.cfg"
    try:
        for line in cfg.read_text().splitlines():
            if line.strip().startswith("version"):
                # "version = 3.12.14" or "version_info = 3.12.14.final.0"
                raw = line.split("=", 1)[1].strip()
                parts = raw.split(".")
                if len(parts) >= 2:
                    return f"{parts[0]}.{parts[1]}"
    except Exception:
        pass
    return "3.12"


def run_serverless_deploy(
    project_dir: Path,
    module_name: str,
    org: str,
    token: str,
    deployment: str,
    location_name: str,
    log: Callable[[str], None] = print,
) -> list[str]:
    """Blocking — shells out to the (deprecated-but-functional)
    dagster-cloud CLI via uvx, so nothing needs to be pre-installed.
    `--build-method local` skips Docker entirely, which is the whole
    point of this path. Caller must run this off the event loop —
    packaging + upload can take tens of seconds."""
    python_version = detect_python_version(project_dir)
    cmd = [
        "uvx", "--from", "dagster-cloud-cli", "dagster-cloud",
        "serverless", "deploy-python-executable",
        str(project_dir),
        "--organization", org,
        "--api-token", token,
        "--deployment", deployment,
        "--location-name", location_name,
        "--module-name", module_name,
        "--build-method", "local",
        "--python-version", python_version,
    ]
    log(f"dagster-cloud serverless deploy-python-executable --location-name {location_name}")
    result = subprocess.run(
        cmd,
        cwd=str(project_dir),
        capture_output=True,
        text=True,
        timeout=900,
    )
    tail = (result.stdout or "").splitlines()[-30:] + (result.stderr or "").splitlines()[-10:]
    for line in tail:
        log(line)
    if result.returncode != 0:
        raise RuntimeError("serverless deploy failed:\n" + "\n".join(tail[-20:]))
    return tail
