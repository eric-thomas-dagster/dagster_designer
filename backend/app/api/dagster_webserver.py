"""API endpoints for Dagster webserver management."""

import asyncio
import subprocess
import psutil
import socket
import re
import time
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core.config import settings
from ..core.uv_binary import find_uv_binary, venv_bin_path

router = APIRouter(prefix="/dagster-ui", tags=["dagster-ui"])

# In-memory cache of project_id -> (port, pid) for the session
_project_ports: dict[str, tuple[int, int]] = {}

# Track projects currently being started to prevent duplicate starts
_starting_projects: set[str] = set()


class DagsterUIStatus(BaseModel):
    """Status of the Dagster UI webserver."""
    running: bool
    url: str
    port: int
    pid: int | None = None


def find_available_port(start_port: int = 3000, max_attempts: int = 10) -> int:
    """Find an available port starting from start_port.

    Args:
        start_port: Port to start searching from
        max_attempts: Maximum number of ports to try

    Returns:
        Available port number

    Raises:
        RuntimeError: If no available port found
    """
    for port in range(start_port, start_port + max_attempts):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(('', port))
                return port
        except OSError:
            continue
    raise RuntimeError(f"No available port found in range {start_port}-{start_port + max_attempts}")


def check_dagster_webserver(port: int | None = None, project_path: Path | None = None) -> tuple[bool, int | None, int | None]:
    """Check if Dagster webserver is running.

    Args:
        port: Specific port to check, or None to check all dagster processes
        project_path: Specific project path to check, or None to match any dagster process

    Returns:
        Tuple of (is_running, pid, port_found)
    """
    # Check every listening process -- NOT restricted to a specific port
    # range. This used to only look at 3000-3009 ("common Dagster ports"),
    # but that's an arbitrary band layered on top of a scan that already
    # discriminates on the real signal (cmdline containing 'dagster'/'dg
    # dev', optionally the cwd matching project_path). A dev server that
    # landed outside that band -- e.g. because 3000-3009 were all occupied
    # by orphans from earlier sessions -- would be invisible to this check,
    # defeating the dedup it exists to provide and letting a duplicate get
    # spawned right on top of it.
    for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
        try:
            # Check all network connections for this process
            for conn in proc.net_connections():
                if conn.status == 'LISTEN':
                    found_port = conn.laddr.port
                    if port is None or port == found_port:
                        # Verify it's a Dagster-related process by checking parent or self
                        cmdline = proc.info.get('cmdline')
                        if cmdline:
                            cmdline_str = ' '.join(cmdline)
                            # Check if this or parent is a dagster process
                            if any(pattern in cmdline_str for pattern in ['dagster', 'dg dev']):
                                # If project_path is specified, verify it matches
                                if project_path:
                                    try:
                                        proc_cwd = proc.cwd()
                                        if str(project_path) not in proc_cwd:
                                            continue
                                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                                        continue
                                return True, proc.info['pid'], found_port
                        # Also check parent process
                        try:
                            parent = psutil.Process(proc.ppid())
                            parent_cmdline = ' '.join(parent.cmdline())
                            if any(pattern in parent_cmdline for pattern in ['dg dev', 'dagster-webserver', 'dagster dev']):
                                # If project_path is specified, verify it matches
                                if project_path:
                                    try:
                                        parent_cwd = parent.cwd()
                                        if str(project_path) not in parent_cwd:
                                            continue
                                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                                        continue
                                return True, parent.pid, found_port
                        except (psutil.NoSuchProcess, psutil.AccessDenied):
                            pass
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            pass
    return False, None, None


def find_all_designer_dev_servers() -> list[tuple[int, int, str]]:
    """Find every `dg dev`/`dagster dev` process tree running under any
    project inside settings.projects_dir -- i.e. every dev server THIS
    Designer install could have spawned, regardless of which app session
    spawned it or which port it landed on.

    This is the cleanup counterpart to check_dagster_webserver (which only
    answers "is there one for THIS project"): `/start/{project_id}` spawns
    these with start_new_session=True so they survive the backend process
    dying, and nothing was killing them on app quit -- they just pile up
    release over release, one new orphan each time the app was relaunched
    and "Start Dev Server" clicked again (confirmed via a real `ps aux`
    snapshot showing dozens of jaffle_shop/cars `dg dev` processes spanning
    many days). Scoped to projects_dir specifically so this never touches a
    `dg dev` the user happens to be running by hand elsewhere.

    Only matches a ROOT process whose cmdline contains the literal 'dg dev'
    or 'dagster dev' (a real, persistent dev server), then walks ITS
    descendant tree (daemon, grpc code-server, webserver -- all genuine
    children of that one dev server) to find the rest. This is deliberately
    narrower than pattern-matching every process's cmdline independently:
    a one-shot `dg list defs`/`dg check`/`dg launch` ALSO spawns its own
    transient grpc/code-server children to load user code, and those
    children's cmdlines contain 'dagster' too -- matching them directly
    (an earlier version of this function did) killed an in-flight `dg list
    defs` mid-validation, surfacing as a spurious "Project validation
    failed" with no real error. Requiring descent from an actual 'dg
    dev'/'dagster dev' root avoids that entirely, since a one-shot
    command's root process never matches that literal string.

    Returns a list of (pid, port, project_cwd) tuples.
    """
    projects_root = str(settings.projects_dir.resolve())
    roots: list[psutil.Process] = []
    for proc in psutil.process_iter(['pid', 'cmdline']):
        try:
            cmdline = proc.info.get('cmdline') or []
            cmdline_str = ' '.join(cmdline)
            if not any(pattern in cmdline_str for pattern in ['dg dev', 'dagster dev']):
                continue
            if not proc.cwd().startswith(projects_root):
                continue
            roots.append(proc)
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue

    found: list[tuple[int, int, str]] = []
    seen_pids: set[int] = set()
    for root in roots:
        try:
            root_cwd = root.cwd()
            family = [root] + root.children(recursive=True)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        for proc in family:
            try:
                pid = proc.pid
                if pid in seen_pids or not proc.is_running():
                    continue
                seen_pids.add(pid)
                listening_port = 0
                for conn in proc.net_connections():
                    if conn.status == 'LISTEN':
                        listening_port = conn.laddr.port
                        break
                found.append((pid, listening_port, root_cwd))
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
    return found


def kill_all_designer_dev_servers() -> list[dict]:
    """Kill every dev server find_all_designer_dev_servers() finds and clear
    the in-memory port/pid caches. Best-effort: a process that's already
    gone by the time we get to it is not an error."""
    killed = []
    for pid, port, project_cwd in find_all_designer_dev_servers():
        try:
            proc = psutil.Process(pid)
            proc.kill()
            killed.append({"pid": pid, "port": port, "project": project_cwd})
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    _project_ports.clear()
    return killed


def _project_path_for_id(project_id: str) -> Path | None:
    project_file = (settings.projects_dir / f"{project_id}.json").resolve()
    if not project_file.exists():
        return None
    import json
    with open(project_file, 'r') as f:
        directory_name = json.load(f).get("directory_name", project_id)
    return (settings.projects_dir / directory_name).resolve()


def resolve_local_graphql_port(project_id: str) -> int:
    """Best-effort resolution of the port THIS project's local `dg dev`/
    `dagster dev` is actually bound to. Every local-GraphQL caller across
    projects.py/runs.py used to hardcode 3000 -- find_available_port scans
    3000-3009, so any project started while another already held 3000
    (very normal: multiple Designer projects, or anything else on 3000)
    silently landed on a different port and every one of those hardcoded
    callers would then fail to connect, even with `dg dev` running fine.

    Checks the in-memory (port, pid) cache this module maintains first,
    then falls back to scanning live processes for one that matches this
    project's directory.

    Returns 0 -- not a real port, never connectable -- when nothing is
    discoverable for THIS project, rather than guessing 3000 (the old
    behavior). That guess was actively dangerous, not just imprecise: if
    anything else happened to be listening on 3000 -- another Designer
    project's dev server, a leftover test instance, literally anything --
    every caller here would silently render THAT project's run history as
    if it belonged to the one the user actually asked about, with no error
    at all (confirmed live: a stray dev server left running elsewhere
    answered on 3000 and its runs showed up under a totally unrelated
    project). Every caller already treats a failed connection as "local
    dev isn't running" (see runs.py's httpx.ConnectError handling) and
    shows a clean "start it" message -- connecting to port 0 always fails
    fast with exactly that same error, so this gets the right UX for free
    with no call-site changes.
    """
    if project_id in _project_ports:
        cached_port, cached_pid = _project_ports[project_id]
        try:
            if psutil.Process(cached_pid).is_running():
                return cached_port
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            del _project_ports[project_id]

    project_path = _project_path_for_id(project_id)
    is_running, pid, port_found = check_dagster_webserver(project_path=project_path)
    if is_running and port_found:
        if pid is not None:
            _project_ports[project_id] = (port_found, pid)
        return port_found

    return 0


@router.get("/status/{project_id}")
async def get_dagster_ui_status(project_id: str) -> DagsterUIStatus:
    """
    Get the status of the Dagster UI webserver for a project.

    Args:
        project_id: Project ID

    Returns:
        Status of the Dagster UI
    """
    # Check cache first
    if project_id in _project_ports:
        cached_port, cached_pid = _project_ports[project_id]
        # Verify the process is still running
        try:
            proc = psutil.Process(cached_pid)
            if proc.is_running():
                return DagsterUIStatus(
                    running=True,
                    url=f"http://localhost:{cached_port}",
                    port=cached_port,
                    pid=cached_pid,
                )
            else:
                # Process died, remove from cache
                del _project_ports[project_id]
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            # Process doesn't exist, remove from cache
            del _project_ports[project_id]

    # Get project path
    project_file = (settings.projects_dir / f"{project_id}.json").resolve()
    if not project_file.exists():
        raise HTTPException(status_code=404, detail=f"Project {project_id} not found")

    # Read project metadata to get directory name
    import json
    with open(project_file, 'r') as f:
        project_data = json.load(f)

    directory_name = project_data.get("directory_name", project_id)
    project_path = (settings.projects_dir / directory_name).resolve()

    if not project_path.exists():
        raise HTTPException(status_code=404, detail=f"Project directory not found")

    is_running, pid, port_found = check_dagster_webserver(project_path=project_path)

    if is_running and port_found:
        # Cache it for next time
        _project_ports[project_id] = (port_found, pid)
        return DagsterUIStatus(
            running=True,
            url=f"http://localhost:{port_found}",
            port=port_found,
            pid=pid,
        )

    return DagsterUIStatus(
        running=False,
        url="http://localhost:3000",
        port=3000,
        pid=None,
    )


@router.post("/start/{project_id}")
async def start_dagster_ui(project_id: str):
    """
    Start the Dagster UI webserver for a project.

    Args:
        project_id: Project ID

    Returns:
        Status and URL of the started webserver
    """
    import sys
    print(f"[START DAGSTER UI] Called for project: {project_id}", flush=True)
    sys.stdout.flush()

    # Check if this project is already being started by another request
    if project_id in _starting_projects:
        print(f"[START DAGSTER UI] Project {project_id} is already being started, waiting...", flush=True)
        # Wait up to 5 seconds for the other start to complete
        wait_time = 0
        while project_id in _starting_projects and wait_time < 5:
            await asyncio.sleep(0.5)
            wait_time += 0.5

        # If still starting after 5 seconds, return error
        if project_id in _starting_projects:
            raise HTTPException(
                status_code=409,
                detail="Another request is already starting Dagster UI for this project. Please wait and try again."
            )

        # Check if the other request succeeded in starting it
        if project_id in _project_ports:
            cached_port, cached_pid = _project_ports[project_id]
            return {
                "message": "Dagster UI was started by another request",
                "url": f"http://localhost:{cached_port}",
                "port": cached_port,
                "pid": cached_pid,
            }

    # Mark this project as being started
    _starting_projects.add(project_id)

    try:  # Outer try to ensure cleanup
        # Get project path (resolve to absolute path)
        project_file = (settings.projects_dir / f"{project_id}.json").resolve()
        if not project_file.exists():
            raise HTTPException(status_code=404, detail=f"Project {project_id} not found")

        # Read project metadata to get directory name
        import json
        with open(project_file, 'r') as f:
            project_data = json.load(f)

        directory_name = project_data.get("directory_name", project_id)
        project_path = (settings.projects_dir / directory_name).resolve()

        if not project_path.exists():
            raise HTTPException(status_code=404, detail=f"Project directory not found")

        # Check if already running for this specific project
        is_running, pid, port_found = check_dagster_webserver(project_path=project_path)
        if is_running and port_found:
            return {
                "message": "Dagster UI is already running",
                "url": f"http://localhost:{port_found}",
                "port": port_found,
                "pid": pid,
            }

        # Find an available port
        try:
            port = find_available_port(start_port=3000)
        except RuntimeError as e:
            raise HTTPException(status_code=500, detail=str(e))

        # Get venv python path for uv run
        venv_python = venv_bin_path(project_path / ".venv", "python")
        if not venv_python.exists():
            raise HTTPException(
                status_code=500,
                detail="Project virtual environment not found. Please reinstall dependencies."
            )

        # project_service.create_project deliberately skips installing
        # dagster-webserver at creation time to keep setup fast, with a
        # comment promising it'd be "installed on-demand when user opens
        # Dagster UI" -- that on-demand step was never actually written, so
        # any project that doesn't ALSO happen to declare dagster-webserver
        # itself (e.g. under uv's own [dependency-groups].dev, which `uv
        # sync` installs by default -- NOT the older PEP 621
        # [project.optional-dependencies], which it doesn't) could never
        # start a dev server at all. Confirmed live: `dg dev` failed with
        # "The dagster-webserver Python package must be installed" for a
        # quickstart project whose pyproject.toml listed it only under
        # optional-dependencies. Mirrors the equivalent on-demand install
        # project_service.py already does for a missing `dg` binary.
        site_packages = next((project_path / ".venv").glob("lib/python*/site-packages"), None)
        has_webserver = bool(site_packages and (site_packages / "dagster_webserver").exists())
        if not has_webserver:
            print(f"[START DAGSTER UI] dagster-webserver not found in venv for {project_id}, installing...", flush=True)
            install_result = await asyncio.to_thread(
                subprocess.run,
                [find_uv_binary("uv"), "pip", "install", "--python", str(venv_python.absolute()), "dagster-webserver"],
                cwd=str(project_path),
                capture_output=True,
                text=True,
                timeout=180,
            )
            if install_result.returncode != 0:
                raise HTTPException(
                    status_code=500,
                    detail={
                        "message": "Failed to install dagster-webserver",
                        "error": install_result.stderr[-2000:] if install_result.stderr else "unknown error",
                    }
                )
            print(f"[START DAGSTER UI] dagster-webserver installed for {project_id}", flush=True)

        try:
            # Use 'uv run' to handle environment properly
            # Try 'dg dev' first (works for both tool-created and imported projects)
            # Fall back to 'dagster dev' if dg not available

            # Check if dg is available in the project
            venv_dg = venv_bin_path(project_path / ".venv", "dg")

            uv_bin = find_uv_binary("uv")
            if venv_dg.exists():
                # Use dg dev via uv run
                cmd = [uv_bin, "run", "dg", "dev", "--port", str(port), "--host", "0.0.0.0"]
            else:
                # Fall back to dagster dev via uv run
                cmd = [uv_bin, "run", "dagster", "dev", "-p", str(port), "-h", "0.0.0.0"]

            # Same DAGSTER_HOME pinning materialize_assets/launch_backfill
            # use for their OWN `dg launch` subprocess calls -- without it,
            # THIS dev server (the one the status bar's "Dev Server" button
            # actually starts, and the one the Runs page's live GraphQL
            # queries) reads whatever Dagster's own default instance
            # location happens to be, not the project-scoped
            # .designer_dagster_home those other runs were recorded into.
            # Confirmed live: a run launched via materialize/backfill was
            # visible when `dg dev` was started with DAGSTER_HOME pinned
            # by hand, and invisible via this exact code path, since it
            # never set the variable at all -- two different instances,
            # same project, neither one wrong on its own, just disagreeing
            # about where "the" instance lives.
            import os
            env = {**os.environ}
            dagster_home = project_path.absolute() / ".designer_dagster_home"
            dagster_home.mkdir(exist_ok=True)
            env["DAGSTER_HOME"] = str(dagster_home)

            process = subprocess.Popen(
                cmd,
                cwd=str(project_path),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                text=True,
                bufsize=1,
            )

            # Wait for dg dev to output the port (usually happens within a few seconds)
            # Parse output like: "Serving Dagster UI on http://0.0.0.0:3001"
            def _wait_for_startup() -> tuple[int, list[str]]:
                """Blocks on process.stdout.readline() until the dev
                server reports its port, exits, or times out. Run off
                the event loop (asyncio.to_thread below) -- this is a
                genuinely blocking call on a long-lived subprocess pipe,
                and without offloading it, ONE project's dev-server
                start freezes the entire backend (every other open
                project's requests) for however long this takes, not
                just this request.
                """
                actual_port = port  # Default to what was requested
                start_time = time.time()
                timeout = 30  # Wait up to 30 seconds for startup
                startup_log: list[str] = []  # Capture startup output

                while time.time() - start_time < timeout:
                    line = process.stdout.readline()
                    if not line:
                        # Check if process is still running
                        if process.poll() is not None:
                            # Process exited - capture any remaining output
                            remaining_output = process.stdout.read()
                            if remaining_output:
                                startup_log.append(remaining_output)

                            error_msg = f"Dagster process exited unexpectedly with code {process.returncode}"
                            raise HTTPException(
                                status_code=500,
                                detail={
                                    "message": error_msg,
                                    "error": error_msg,
                                    "command": " ".join(cmd),
                                    "startup_log": startup_log[-50:],  # Last 50 lines
                                    "returncode": process.returncode,
                                }
                            )
                        time.sleep(0.1)
                        continue

                    # Capture the line for logging
                    startup_log.append(line.rstrip())

                    # Look for the serving message
                    match = re.search(r'Serving.*?(?:http://|on)\s*(?:\S+:)?(\d+)', line, re.IGNORECASE)
                    if match:
                        actual_port = int(match.group(1))
                        break

                return actual_port, startup_log

            actual_port, startup_log = await asyncio.to_thread(_wait_for_startup)

            # Cache the port and PID for this project
            _project_ports[project_id] = (actual_port, process.pid)

            return {
                "message": "Dagster UI started successfully",
                "url": f"http://localhost:{actual_port}",
                "port": actual_port,
                "pid": process.pid,
                "command": " ".join(cmd),
                "startup_log": startup_log[-20:],  # Return last 20 lines
            }

        except HTTPException:
            raise
        except Exception as e:
            import traceback
            tb = traceback.format_exc()
            print(f"ERROR starting Dagster UI: {str(e)}")
            print(f"Traceback:\n{tb}")
            raise HTTPException(
                status_code=500,
                detail={
                    "message": f"Failed to start Dagster UI: {str(e)}",
                    "error": str(e),
                    "traceback": tb,
                    "error_type": type(e).__name__,
                }
            )
    finally:
        # Always remove from starting set when done
        _starting_projects.discard(project_id)
        print(f"[START DAGSTER UI] Completed for project: {project_id}", flush=True)


@router.post("/stop/{project_id}")
async def stop_dagster_ui(project_id: str):
    """
    Stop the Dagster UI webserver.

    Args:
        project_id: Project ID

    Returns:
        Success message
    """
    # Get project path
    project_file = (settings.projects_dir / f"{project_id}.json").resolve()
    if not project_file.exists():
        raise HTTPException(status_code=404, detail=f"Project {project_id} not found")

    # Read project metadata to get directory name
    import json
    with open(project_file, 'r') as f:
        project_data = json.load(f)

    directory_name = project_data.get("directory_name", project_id)
    project_path = (settings.projects_dir / directory_name).resolve()

    if not project_path.exists():
        raise HTTPException(status_code=404, detail=f"Project directory not found")

    is_running, pid, port_found = check_dagster_webserver(project_path=project_path)

    if not is_running or pid is None:
        raise HTTPException(
            status_code=404,
            detail="Dagster UI is not running"
        )

    try:
        # Kill the process
        proc = psutil.Process(pid)
        proc.terminate()
        proc.wait(timeout=5)

        # Remove from cache
        if project_id in _project_ports:
            del _project_ports[project_id]

        return {
            "message": "Dagster UI stopped successfully",
            "pid": pid,
        }
    except psutil.NoSuchProcess:
        # Remove from cache even if process not found
        if project_id in _project_ports:
            del _project_ports[project_id]
        raise HTTPException(
            status_code=404,
            detail="Process not found"
        )
    except psutil.TimeoutExpired:
        # Force kill if it doesn't terminate
        proc.kill()
        # Remove from cache
        if project_id in _project_ports:
            del _project_ports[project_id]
        return {
            "message": "Dagster UI force stopped",
            "pid": pid,
        }
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to stop Dagster UI: {str(e)}"
        )


@router.post("/kill-all")
async def kill_all_dagster_processes():
    """
    Kill all Dagster-related processes system-wide.

    This is useful when Dagster processes are stuck or ports are confused.

    Returns:
        Count of processes killed
    """
    killed_pids = []
    errors = []

    # Get our own PID to avoid killing ourselves
    our_pid = psutil.Process().pid

    # Find all Dagster-related processes
    for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
        try:
            # Skip our own process and parent processes
            if proc.info['pid'] == our_pid:
                continue

            cmdline = proc.info.get('cmdline')
            if not cmdline:
                continue

            cmdline_str = ' '.join(cmdline)

            # Be more specific - only match actual Dagster executables, not just paths
            # Look for dagster commands being executed, not just "dagster" in the path
            is_dagster_process = False

            # Check if it's actually running dagster/dg commands (not just in a dagster directory)
            if any(exe in cmdline_str for exe in ['dagster-webserver', 'dagster-daemon']):
                is_dagster_process = True
            elif 'dagster dev' in cmdline_str and 'uvicorn' not in cmdline_str:
                is_dagster_process = True
            elif 'dg dev' in cmdline_str and 'uvicorn' not in cmdline_str:
                is_dagster_process = True

            # Also check if it's listening on typical Dagster ports (3000-3009)
            if not is_dagster_process:
                try:
                    for conn in proc.net_connections():
                        if conn.status == 'LISTEN' and 3000 <= conn.laddr.port <= 3009:
                            # Double-check it's not our backend (which shouldn't be on these ports anyway)
                            if 'uvicorn' not in cmdline_str and 'fastapi' not in cmdline_str:
                                is_dagster_process = True
                                break
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass

            if is_dagster_process:
                try:
                    pid = proc.info['pid']
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except psutil.TimeoutExpired:
                        # Force kill if it doesn't terminate
                        proc.kill()
                    killed_pids.append(pid)
                except (psutil.NoSuchProcess, psutil.AccessDenied) as e:
                    errors.append(f"Failed to kill process {proc.info['pid']}: {str(e)}")

        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            pass

    # Clear the cache since all processes are killed
    _project_ports.clear()

    response = {
        "message": f"Killed {len(killed_pids)} Dagster process(es)",
        "killed_pids": killed_pids,
    }

    if errors:
        response["errors"] = errors

    return response


@router.post("/stop-all")
async def stop_all_designer_dev_servers():
    """Stop every dev server Designer could have spawned (any project under
    settings.projects_dir), regardless of which app session started it.

    Unlike /kill-all, this is scoped to Designer's own projects directory --
    safe to call automatically (the Tauri shell calls this right before it
    kills the backend on every quit path, and the backend calls it once on
    its own startup to reap anything an earlier crash left behind) without
    risk of killing a `dg dev` the user is running by hand on some unrelated
    project elsewhere on their machine.
    """
    killed = kill_all_designer_dev_servers()
    return {
        "message": f"Stopped {len(killed)} dev server(s)",
        "killed": killed,
    }
