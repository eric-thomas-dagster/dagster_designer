"""Per-(project, deployment) preview subprocess supervisor.

The empty sandbox in `designer_loc_service` (ports 4100-4199) is for
"scratch authoring against Designer's community catalog." This module
is for the real thing: boot `dagster dev` on a git-cloned worktree of
the customer's own repo (from `preview_git_service`), with sandbox
env vars injected. Ports 4200-4299 keep them cleanly separate.

State is in-memory only. Reboot Designer and previews die with it;
the worktree survives on disk and the next `boot` picks up where we
left off after a fresh `uv sync`.
"""
from __future__ import annotations

import asyncio
import atexit
import os
import socket
import subprocess
import time
from pathlib import Path
from typing import Literal

import httpx
import psutil

from . import promotion_config
from . import drafts_service
from . import preview_git_service
from . import community_installer_service
from ..core.uv_binary import find_uv_binary, venv_bin_path

PORT_START = 4200
PORT_END = 4299

Status = Literal["idle", "preparing", "installing", "starting", "ready", "error"]


def _key(project_id: str, deployment_name: str) -> tuple[str, str]:
    return (project_id, deployment_name)


class PreviewState:
    """Lifecycle state for one (project, deployment) preview."""

    def __init__(self, project_id: str, deployment_name: str, location_name: str):
        self.project_id = project_id
        self.deployment_name = deployment_name
        self.location_name = location_name
        self.status: Status = "idle"
        self.error: str | None = None
        self.worktree: Path | None = None
        self.pid: int | None = None
        self.port: int | None = None
        self.proc: subprocess.Popen | None = None
        self.log: list[str] = []
        self.files_written: list[str] = []
        self.env_var_count: int = 0

    def is_proc_alive(self) -> bool:
        if not self.pid:
            return False
        try:
            proc = psutil.Process(self.pid)
            if not proc.is_running():
                return False
            cmdline = " ".join(proc.cmdline())
            return "dagster" in cmdline and "dev" in cmdline
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            return False

    def to_dict(self) -> dict:
        alive = self.is_proc_alive()
        effective_status: Status = self.status
        if self.status == "ready" and not alive:
            effective_status = "error"
        return {
            "project_id": self.project_id,
            "deployment_name": self.deployment_name,
            "location_name": self.location_name,
            "status": effective_status,
            "pid": self.pid if alive else None,
            "port": self.port if alive else None,
            "worktree_path": str(self.worktree) if self.worktree else None,
            "error": self.error,
            "graphql_url": (
                f"http://127.0.0.1:{self.port}/graphql" if alive and self.port else None
            ),
            "webserver_url": (
                f"http://127.0.0.1:{self.port}" if alive and self.port else None
            ),
            "files_written": self.files_written,
            "env_var_count": self.env_var_count,
            "log_tail": self.log[-30:],
        }


_states: dict[tuple[str, str], PreviewState] = {}
_locks: dict[tuple[str, str], asyncio.Lock] = {}


def get_state(project_id: str, deployment_name: str, location_name: str = "") -> PreviewState:
    key = _key(project_id, deployment_name)
    state = _states.get(key)
    if state is None:
        state = PreviewState(project_id, deployment_name, location_name)
        _states[key] = state
    elif location_name and not state.location_name:
        state.location_name = location_name
    return state


def _log(state: PreviewState, msg: str) -> None:
    print(f"[preview:{state.project_id[:8]}/{state.deployment_name[:12]}] {msg}")
    state.log.append(msg)
    if len(state.log) > 200:
        state.log = state.log[-200:]


def _find_available_port() -> int:
    for port in range(PORT_START, PORT_END + 1):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(("", port))
                return port
        except OSError:
            continue
    raise RuntimeError(f"No available port in {PORT_START}-{PORT_END}")


def _uv_sync(state: PreviewState) -> None:
    """`uv sync` in the worktree. Customer repos already have a
    pyproject.toml + uv.lock (any modern Dagster project does), so this
    is fast after the first pull."""
    state.status = "installing"
    _log(state, "uv sync")
    assert state.worktree is not None
    result = subprocess.run(
        [find_uv_binary("uv"), "sync"],
        cwd=str(state.worktree),
        capture_output=True,
        text=True,
        timeout=600,
    )
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").splitlines()[-20:]
        raise RuntimeError("uv sync failed:\n" + "\n".join(tail))
    _log(state, "install complete")


def _dagster_dev_cmd(worktree: Path) -> list[str]:
    """Prefer `dg dev` if the customer's venv has it; fall back to
    `dagster dev`. Older customer repos may not include dagster-dg-cli."""
    dg = venv_bin_path(worktree / ".venv", "dg")
    if dg.exists():
        return [str(dg), "dev", "--host", "127.0.0.1"]
    dagster = venv_bin_path(worktree / ".venv", "dagster")
    if dagster.exists():
        return [str(dagster), "dev", "--host", "127.0.0.1"]
    # Last resort: `uv run dagster dev`
    return [find_uv_binary("uv"), "run", "dagster", "dev", "--host", "127.0.0.1"]


def _start_process(state: PreviewState, env_overrides: dict[str, str]) -> None:
    """Boot `dagster dev` (or `dg dev`) with sandbox env vars."""
    state.status = "starting"
    assert state.worktree is not None
    port = _find_available_port()
    cmd = _dagster_dev_cmd(state.worktree) + ["--port", str(port)]

    # Inherit Designer's env, then apply overrides. Overrides only
    # add / replace — nothing in Designer's env leaks into a lookup
    # a user's `dg.EnvVar` won't perform. The safe failure mode is
    # "missing env var → dagster loads with an unresolved reference,"
    # not "silently uses prod credentials."
    env = os.environ.copy()
    env.update(env_overrides)
    state.env_var_count = len(env_overrides)

    _log(state, f"exec: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        cwd=str(state.worktree),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=env,
    )
    state.proc = proc
    state.pid = proc.pid
    state.port = port

    stdout = proc.stdout
    assert stdout is not None
    started = time.time()
    while time.time() - started < 90:
        line = stdout.readline()
        if not line:
            if proc.poll() is not None:
                raise RuntimeError(f"preview dagster dev exited early (code {proc.returncode})")
            time.sleep(0.1)
            continue
        _log(state, line.rstrip())
        if "Serving" in line or "dagster-webserver" in line.lower():
            # The log line prints before the webserver actually accepts
            # connections — a GraphQL call fired immediately after this
            # can hit a bare ConnectError. Poll the real port instead of
            # trusting the log line alone.
            _wait_for_port(state.port, timeout=15)
            state.status = "ready"
            _drain_stdout_in_background(state)
            return
    raise RuntimeError("preview dagster dev did not report ready within 90s")


def _wait_for_port(port: int, timeout: float = 15) -> None:
    """Block (caller must be off the event loop) until something is
    actually accepting TCP connections on `port`, or the timeout elapses.
    Best-effort — a timeout here isn't fatal, the caller proceeds anyway
    and a real failure just surfaces on the next request."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.2)


def _drain_stdout_in_background(state: PreviewState) -> None:
    import threading

    def _pump():
        if not state.proc or not state.proc.stdout:
            return
        for line in state.proc.stdout:
            _log(state, line.rstrip())

    t = threading.Thread(target=_pump, daemon=True)
    t.start()


async def boot_preview(
    project_id: str,
    deployment_name: str,
    location_name: str,
) -> PreviewState:
    """One-shot: prepare worktree + apply drafts + uv sync + boot dagster dev.

    Idempotent — if the preview is already `ready` with a live subprocess,
    returns immediately after re-applying drafts (in case they changed)."""
    from .project_service import project_service

    project = project_service.get_project(project_id)
    if project is None:
        raise RuntimeError("Project not found")
    if not project.is_dagster_plus:
        raise RuntimeError("Preview is only meaningful for Dagster+ projects.")

    mapping = promotion_config.find_mapping(project.dagster_plus_org or "", location_name)
    if mapping is None:
        raise RuntimeError(
            f"No repo mapping for ({project.dagster_plus_org}, {location_name}). "
            "Configure it in the Drafts drawer settings."
        )

    key = _key(project_id, deployment_name)
    lock = _locks.setdefault(key, asyncio.Lock())
    state = get_state(project_id, deployment_name, location_name)

    async with lock:
        state.error = None
        loop = asyncio.get_event_loop()

        # 1. Ensure the git worktree exists + drafts applied.
        state.status = "preparing"
        try:
            scoped_drafts = [
                d for d in drafts_service.list_drafts(project_id)
                if d.location_name == location_name and d.deployment_name == deployment_name
            ]
            # Resolved here (async, before the executor handoff below) so
            # a draft referencing a brand-new community component — never
            # before registered in this location's code — gets its type
            # rewritten to the catalog's canonical form and the installer
            # bootstrapped into the worktree, instead of writing an
            # unresolvable type and failing to load.
            catalog_rewrites = await community_installer_service.resolve_catalog_rewrites(
                [d.component_type for d in scoped_drafts]
            )

            def _prepare():
                return preview_git_service.prepare_preview(
                    project_id=project_id,
                    owner_repo=mapping.owner_repo,
                    base_branch=mapping.default_branch,
                    deployment_name=deployment_name,
                    defs_subdir=mapping.defs_subdir,
                    drafts=scoped_drafts,
                    catalog_rewrites=catalog_rewrites,
                )
            prep = await loop.run_in_executor(None, _prepare)
            state.worktree = Path(prep["worktree_path"])
            state.files_written = prep["files_written"]
            _log(state, f"worktree ready with {len(scoped_drafts)} draft(s) applied")
        except Exception as e:
            state.status = "error"
            state.error = f"git prepare failed: {e}"
            return state

        # 2. If already running for this key, just reapply drafts + return.
        if state.is_proc_alive():
            state.status = "ready"
            return state

        # 3. uv sync + start dagster dev with env overrides.
        try:
            await loop.run_in_executor(None, _uv_sync, state)
            await loop.run_in_executor(None, _start_process, state, dict(mapping.preview_env))
        except Exception as e:
            state.status = "error"
            state.error = str(e)
            _log(state, f"ERROR: {e}")

    return state


def stop_preview(project_id: str, deployment_name: str) -> None:
    key = _key(project_id, deployment_name)
    state = _states.get(key)
    if not state or not state.proc:
        return
    try:
        state.proc.terminate()
        state.proc.wait(timeout=5)
    except Exception:
        try:
            state.proc.kill()
        except Exception:
            pass
    state.status = "idle"
    state.pid = None
    state.port = None
    state.proc = None


async def proxy_graphql(project_id: str, deployment_name: str, query: str, variables: dict | None) -> dict:
    key = _key(project_id, deployment_name)
    state = _states.get(key)
    if not state or not (state.port and state.is_proc_alive()):
        raise RuntimeError("Preview is not running")
    url = f"http://127.0.0.1:{state.port}/graphql"
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(url, json={"query": query, "variables": variables or {}})
        r.raise_for_status()
        return r.json()


def list_previews(project_id: str | None = None) -> list[dict]:
    """Everything we're tracking. Frontend can use this to show a
    "these previews are running" surface across the whole app."""
    return [
        s.to_dict()
        for (pid, _), s in _states.items()
        if project_id is None or pid == project_id
    ]


@atexit.register
def _shutdown_all() -> None:
    for state in list(_states.values()):
        if state.proc:
            try:
                state.proc.terminate()
            except Exception:
                pass
