"""API endpoints for Dagster webserver management."""

import subprocess
import psutil
import socket
import re
import time
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core.config import settings

router = APIRouter(prefix="/dagster-ui", tags=["dagster-ui"])

# In-memory cache of project_id -> (port, pid) for the session
_project_ports: dict[str, tuple[int, int]] = {}


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
    # First check for any process listening on Dagster ports (3000-3009)
    for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
        try:
            # Check all network connections for this process
            for conn in proc.net_connections():
                if conn.status == 'LISTEN':
                    found_port = conn.laddr.port
                    # Common Dagster ports are 3000-3009
                    if 3000 <= found_port <= 3009:
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
    venv_python = project_path / ".venv" / "bin" / "python"
    if not venv_python.exists():
        raise HTTPException(
            status_code=500,
            detail="Project virtual environment not found. Please reinstall dependencies."
        )

    try:
        # Use 'uv run' to handle environment properly
        # Try 'dg dev' first (works for both tool-created and imported projects)
        # Fall back to 'dagster dev' if dg not available

        # Check if dg is available in the project
        venv_dg = project_path / ".venv" / "bin" / "dg"

        if venv_dg.exists():
            # Use dg dev via uv run
            cmd = ["uv", "run", "dg", "dev", "--port", str(port), "--host", "0.0.0.0"]
        else:
            # Fall back to dagster dev via uv run
            cmd = ["uv", "run", "dagster", "dev", "-p", str(port), "-h", "0.0.0.0"]

        process = subprocess.Popen(
            cmd,
            cwd=str(project_path),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            text=True,
            bufsize=1,
        )

        # Wait for dg dev to output the port (usually happens within a few seconds)
        # Parse output like: "Serving Dagster UI on http://0.0.0.0:3001"
        actual_port = port  # Default to what we requested
        start_time = time.time()
        timeout = 30  # Wait up to 30 seconds for startup
        startup_log = []  # Capture startup output

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
