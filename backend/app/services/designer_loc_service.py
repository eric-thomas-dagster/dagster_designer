"""Designer-managed code location — a laptop-hosted Dagster subprocess.

For a Dagster+ project, Designer scaffolds a small Dagster project on the
user's laptop and boots `dg dev` on it. The subprocess exposes its own
GraphQL, which Designer proxies. The Dagster+ deployment's own code
locations are unchanged — this is a *peer* data source, not a mode.

Storage: `~/.dagster-designer/designer-locs/<project_id>/`. Scaffold
persists across Designer restarts; the subprocess itself does not — we
just re-boot fast on next request because deps are already installed.

Ports: 4100–4199, distinct from the 3000-range that `dagster dev` uses
for local Designer projects.
"""

import asyncio
import atexit
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Literal

import httpx
import psutil

from ..core.uv_binary import find_uv_binary

DESIGNER_LOCS_ROOT = Path.home() / ".dagster-designer" / "designer-locs"
DESIGNER_LOCS_ROOT.mkdir(parents=True, exist_ok=True)


def _sanitize_dir_name(project_id: str) -> str:
    """create-dagster derives a Python module name from the target
    directory's basename. It must be a valid Python identifier — start
    with a letter, no hyphens. Prefix with `ds_` and swap `-` for `_`."""
    return "ds_" + project_id.replace("-", "_")


def _cleanup_orphans() -> None:
    """Remove leftover directories in DESIGNER_LOCS_ROOT that don't
    match the current `ds_*` naming — typically broken partial scaffolds
    from earlier code paths. Runs once on module import."""
    try:
        for entry in DESIGNER_LOCS_ROOT.iterdir():
            if not entry.is_dir():
                continue
            if not entry.name.startswith("ds_"):
                print(f"[designer-loc] removing orphan dir: {entry}")
                shutil.rmtree(entry, ignore_errors=True)
    except FileNotFoundError:
        pass


_cleanup_orphans()

PORT_START = 4100
PORT_END = 4199

Status = Literal["missing", "scaffolding", "installing", "starting", "ready", "error"]


class DesignerLocState:
    """In-memory lifecycle state for one project's Designer-managed loc."""

    def __init__(self, project_id: str):
        self.project_id = project_id
        self.status: Status = "missing"
        self.error: str | None = None
        self.pid: int | None = None
        self.port: int | None = None
        self.proc: subprocess.Popen | None = None
        # Bounded ring buffer of the most recent stdout/status lines so the
        # frontend can surface progress + failure detail without ballooning.
        self.log: list[str] = []

    def dir(self) -> Path:
        return DESIGNER_LOCS_ROOT / _sanitize_dir_name(self.project_id)

    def is_scaffolded(self) -> bool:
        return (self.dir() / "pyproject.toml").exists()

    def is_installed(self) -> bool:
        return (self.dir() / ".venv" / "bin" / "dg").exists()

    def is_proc_alive(self) -> bool:
        if not self.pid:
            return False
        try:
            proc = psutil.Process(self.pid)
            if not proc.is_running():
                return False
            # Guard against PID recycling — verify cmdline still looks like dg dev.
            cmdline = " ".join(proc.cmdline())
            return "dg" in cmdline and "dev" in cmdline
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            return False

    def to_dict(self) -> dict:
        alive = self.is_proc_alive()
        effective_status: Status = self.status
        if self.status == "ready" and not alive:
            # Process died since we last saw it — surface as error.
            effective_status = "error"
        return {
            "status": effective_status,
            "pid": self.pid if alive else None,
            "port": self.port if alive else None,
            "error": self.error,
            "graphql_url": (
                f"http://127.0.0.1:{self.port}/graphql"
                if alive and self.port
                else None
            ),
            "scaffolded": self.is_scaffolded(),
            "installed": self.is_installed(),
            "log_tail": self.log[-30:],
        }


# In-memory registry (survives per Designer backend process)
_states: dict[str, DesignerLocState] = {}
_locks: dict[str, asyncio.Lock] = {}


def get_state(project_id: str) -> DesignerLocState:
    state = _states.get(project_id)
    if state is None:
        state = DesignerLocState(project_id)
        _states[project_id] = state
    return state


def _log(state: DesignerLocState, msg: str) -> None:
    print(f"[designer-loc:{state.project_id}] {msg}")
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


def _scaffold(state: DesignerLocState) -> None:
    """Run create-dagster to scaffold a new empty Dagster project."""
    state.status = "scaffolding"
    if state.is_scaffolded():
        _log(state, "already scaffolded, skipping create-dagster")
        return

    # If the directory exists but scaffold is incomplete (partial write
    # from a prior failed run), nuke it — create-dagster refuses to
    # write into a non-empty target.
    if state.dir().exists():
        _log(state, f"cleaning partial scaffold at {state.dir()}")
        shutil.rmtree(state.dir(), ignore_errors=True)

    state.dir().parent.mkdir(parents=True, exist_ok=True)
    _log(state, f"create-dagster -> {state.dir()}")
    # create-dagster is interactive; feed default "y" answers.
    result = subprocess.run(
        [find_uv_binary("uvx"), "create-dagster", "project", str(state.dir()), "--no-uv-sync"],
        input="y\ny\ny\ny\n",
        capture_output=True,
        text=True,
        timeout=180,
    )
    if result.returncode != 0:
        # Clean up any partial write so retry starts fresh.
        if state.dir().exists():
            shutil.rmtree(state.dir(), ignore_errors=True)
        tail = (result.stderr or result.stdout or "").splitlines()[-20:]
        raise RuntimeError("create-dagster failed:\n" + "\n".join(tail))
    _log(state, "scaffold complete")


def _install(state: DesignerLocState) -> None:
    """Sync deps in the scaffolded project so `dg dev` can boot."""
    state.status = "installing"
    _log(state, "uv sync")
    result = subprocess.run(
        [find_uv_binary("uv"), "sync"],
        cwd=str(state.dir()),
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").splitlines()[-20:]
        raise RuntimeError("uv sync failed:\n" + "\n".join(tail))
    _log(state, "install complete")


def _start_process(state: DesignerLocState) -> None:
    """Boot `dg dev` and wait for it to report ready."""
    state.status = "starting"
    port = _find_available_port()
    dg = state.dir() / ".venv" / "bin" / "dg"
    if not dg.exists():
        raise RuntimeError(f"dg not found at {dg}")

    _log(state, f"dg dev --port {port}")
    proc = subprocess.Popen(
        [str(dg), "dev", "--port", str(port), "--host", "127.0.0.1"],
        cwd=str(state.dir()),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    state.proc = proc
    state.pid = proc.pid
    state.port = port

    stdout = proc.stdout
    assert stdout is not None
    # Look for the "Serving" line — dg dev prints it once ready.
    started = time.time()
    while time.time() - started < 60:
        line = stdout.readline()
        if not line:
            if proc.poll() is not None:
                raise RuntimeError(f"dg dev exited early (code {proc.returncode})")
            time.sleep(0.1)
            continue
        _log(state, line.rstrip())
        if "Serving" in line or "dagster-webserver" in line.lower():
            state.status = "ready"
            _drain_stdout_in_background(state)
            return
    raise RuntimeError("dg dev did not report ready within 60s")


def _drain_stdout_in_background(state: DesignerLocState) -> None:
    """Keep reading dg dev's stdout so its pipe doesn't fill and block."""
    import threading

    def _pump():
        if not state.proc or not state.proc.stdout:
            return
        for line in state.proc.stdout:
            _log(state, line.rstrip())

    t = threading.Thread(target=_pump, daemon=True)
    t.start()


async def ensure_running(project_id: str) -> DesignerLocState:
    """Idempotent: scaffold + install + start if needed."""
    state = get_state(project_id)
    if state.status == "ready" and state.is_proc_alive():
        return state

    lock = _locks.setdefault(project_id, asyncio.Lock())
    async with lock:
        # Re-check under lock
        if state.status == "ready" and state.is_proc_alive():
            return state

        state.error = None
        loop = asyncio.get_event_loop()
        try:
            if not state.is_scaffolded():
                await loop.run_in_executor(None, _scaffold, state)
            if not state.is_installed():
                await loop.run_in_executor(None, _install, state)
            await loop.run_in_executor(None, _start_process, state)
        except Exception as e:
            state.status = "error"
            state.error = str(e)
            _log(state, f"ERROR: {e}")

    return state


def stop(project_id: str) -> None:
    """Terminate the subprocess for this project, if running."""
    state = _states.get(project_id)
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
    state.status = "missing"
    state.pid = None
    state.port = None
    state.proc = None


def _package_for(component_type: str) -> str | None:
    """Derive the PyPI package name from a component type.

    `dagster_slack.SlackNotifier` -> `dagster-slack`. Returns None when
    no install is needed — either because the type lives in Dagster
    core or because it was already installed via the community-templates
    CLI (which drops files into `src/<sandbox_module>/components/<id>/`,
    meaning the type's module IS the sandbox's own module, not a PyPI
    package).
    """
    module = component_type.split(".", 1)[0]
    if module == "dagster":
        return None
    # Sandbox-hosted community components — type's root module IS the
    # sandbox project (e.g. `ds_15d41a02_...`), files already on disk,
    # no PyPI install applicable.
    if module.startswith("ds_"):
        return None
    return module.replace("_", "-")


def _package_installed(state: DesignerLocState, package_name: str) -> bool:
    """Fast presence check via pyproject.toml text scan."""
    pyproject = state.dir() / "pyproject.toml"
    if not pyproject.exists():
        return False
    return package_name in pyproject.read_text()


def _sanitize_folder(component_id: str) -> str:
    """`ScheduledJobComponent[2]` -> `scheduledjobcomponent_2`."""
    out = []
    for ch in component_id.lower():
        if ch.isalnum():
            out.append(ch)
        elif ch in ("_", "-"):
            out.append(ch)
        elif ch in ("[", "]", " "):
            out.append("_")
    return "".join(out).strip("_")


async def install_community_component(project_id: str, component_id: str) -> dict:
    """Install a community component template into the sandbox.

    Shells out to `dagster-community-components-cli` (via `uvx`) with
    the sandbox as the working directory. The CLI knows how to fetch
    the template from GitHub, drop files into the right subdirectory,
    and add any pinned deps. We then bounce `dg dev` so the newly
    registered component type shows up in `componentTypesForLocationOrError`.

    Returns the invoked command's stdout tail + a rough parse of the
    written `defs.yaml` (so the caller learns the canonical `type:` string).
    """
    state = get_state(project_id)
    if not state.is_scaffolded():
        raise RuntimeError("Sandbox is not scaffolded yet")

    cmd = [
        "uvx",
        "--from", "dagster-community-components-cli",
        "dagster-component",
        "add", component_id,
        "--auto-install",
        "--manager", "uv",
        "--force",
    ]
    _log(state, f"dagster-component add {component_id}")
    result = subprocess.run(
        cmd,
        cwd=str(state.dir()),
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").splitlines()[-20:]
        raise RuntimeError("dagster-component add failed:\n" + "\n".join(tail))

    # Discover the canonical component type by reading the freshly-written
    # defs.yaml. The CLI drops it under src/<module>/components/<id>/.
    module_name = state.dir().name
    comp_root_candidates = [
        state.dir() / "src" / module_name / "components" / component_id,
        state.dir() / module_name / "components" / component_id,
    ]
    canonical_type: str | None = None
    req_path: Path | None = None
    for cd in comp_root_candidates:
        defs = cd / "defs.yaml"
        if defs.exists():
            for line in defs.read_text().splitlines():
                line = line.strip()
                if line.startswith("type:"):
                    canonical_type = line.split(":", 1)[1].strip().strip('"').strip("'")
                    break
        req = cd / "requirements.txt"
        if req.exists():
            req_path = req

    # Safety-net dep install: `dagster-component add --auto-install` is
    # known to skip templates' `requirements.txt` sometimes (hit this on
    # airtable_ingestion, synthetic_data_generator, and others). If the
    # template ships one, `uv add` its contents explicitly so the sandbox
    # can actually load the component on restart.
    if req_path is not None:
        reqs: list[str] = []
        for line in req_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            reqs.append(line)
        if reqs:
            _log(state, f"uv add (from requirements.txt): {' '.join(reqs)}")
            add_result = subprocess.run(
                [find_uv_binary("uv"), "add", *reqs],
                cwd=str(state.dir()),
                capture_output=True,
                text=True,
                timeout=300,
            )
            if add_result.returncode != 0:
                tail = (add_result.stderr or add_result.stdout or "").splitlines()[-10:]
                _log(state, "WARNING: template requirements install failed:\n" + "\n".join(tail))
                # Don't hard-fail — the user might still be able to remove the
                # broken component. But warn loudly.
            else:
                _log(state, "template requirements installed")

    # New Python deps => restart to pick up the venv changes.
    _log(state, "restarting sandbox to load newly-installed component")
    stop(project_id)
    await ensure_running(project_id)

    return {
        "component_id": component_id,
        "component_type": canonical_type,
        "install_stdout_tail": (result.stdout or "").splitlines()[-15:],
    }


async def scaffold_component(
    project_id: str,
    component_type: str,
    attributes_yaml: str,
    component_id: str | None,
) -> dict:
    """Author a new component instance directly into the sandbox.

    Writes `src/<module>/defs/<slug>/defs.yaml` and installs the
    component's package if not already present. Since Dagster picks up
    package changes on process restart, we bounce the subprocess when
    an install happened; YAML-only changes are hot-reloaded by dg dev.
    """
    import uuid as _uuid

    state = get_state(project_id)
    if not state.is_scaffolded():
        raise RuntimeError("Sandbox is not scaffolded yet")

    module_name = state.dir().name  # matches `ds_<sanitized_project_id>`
    src_module_dir = state.dir() / "src" / module_name
    defs_dir = src_module_dir / "defs"
    defs_dir.mkdir(parents=True, exist_ok=True)

    short = component_type.rsplit(".", 1)[-1]
    if not component_id:
        component_id = f"{short}[{_uuid.uuid4().hex[:6]}]"

    comp_dir = defs_dir / _sanitize_folder(component_id)
    comp_dir.mkdir(exist_ok=True)

    # Install package on-demand for community components.
    package_name = _package_for(component_type)
    needs_restart = False
    if package_name and not _package_installed(state, package_name):
        _log(state, f"uv add {package_name}")
        result = subprocess.run(
            [find_uv_binary("uv"), "add", package_name],
            cwd=str(state.dir()),
            capture_output=True,
            text=True,
            timeout=300,
        )
        if result.returncode != 0:
            tail = (result.stderr or result.stdout or "").splitlines()[-20:]
            raise RuntimeError(f"uv add {package_name} failed:\n" + "\n".join(tail))
        needs_restart = True

    # Write the defs.yaml verbatim — user-supplied YAML already contains
    # `type: <FQN>` + `attributes:` (seeded from the type's `example`).
    (comp_dir / "defs.yaml").write_text(attributes_yaml)
    _log(state, f"wrote {comp_dir / 'defs.yaml'}")

    if needs_restart:
        _log(state, "package changed; restarting subprocess")
        stop(project_id)
        await ensure_running(project_id)

    return {
        "component_id": component_id,
        "path": str(comp_dir / "defs.yaml"),
        "restarted": needs_restart,
        "package": package_name,
    }


async def proxy_graphql(project_id: str, query: str, variables: dict | None) -> dict:
    """Forward a GraphQL request to this project's Designer-managed loc."""
    state = get_state(project_id)
    if not (state.port and state.is_proc_alive()):
        raise RuntimeError("Designer-managed location is not running")
    url = f"http://127.0.0.1:{state.port}/graphql"
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(url, json={"query": query, "variables": variables or {}})
        r.raise_for_status()
        return r.json()


@atexit.register
def _shutdown_all() -> None:
    """Kill all Designer-managed subprocesses when the backend exits."""
    for state in list(_states.values()):
        if state.proc:
            try:
                state.proc.terminate()
            except Exception:
                pass
