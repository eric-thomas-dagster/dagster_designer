"""Let Claude Code (with the official dagster-expert skill) explain or fix a
project that fails validation.

Safety model -- verified against the real CLI, not assumed:
  * It runs headlessly (`claude -p`) with cwd = the project folder.
  * "explain" uses --permission-mode dontAsk and no edit tools: it can read and
    run `dg check defs` / `dg list defs`, nothing else (even its `sed` fallback
    through Bash is denied).
  * "fix" uses --permission-mode acceptEdits. Edit/Write are deliberately NOT
    in --allowedTools: allow-listing them let the agent write OUTSIDE the
    project folder; with acceptEdits alone, edits are accepted only inside the
    working directory and writes elsewhere are denied.
  * `.env*` can't be read or edited, and arbitrary shell commands are denied.
  * Before a fix, the files it could touch are snapshotted so the whole change
    can be reviewed as a diff and undone in one click.
"""
from __future__ import annotations

import asyncio
import difflib
import json
import os
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator, Literal

from ..core.config import settings

Mode = Literal["explain", "fix"]

# Rough ceilings: a bare invocation costs ~$0.2-0.3 (skills/plugins load into
# context), so these leave room for real work without being open-ended.
MAX_BUDGET_USD = {"explain": "1.00", "fix": "3.00"}
RUN_TIMEOUT_SECONDS = 15 * 60

_READ_TOOLS = ["Read", "Glob", "Grep", "Bash(dg check defs:*)", "Bash(dg list defs:*)"]
_SECRET_DENY = ["Read(**/.env*)", "Edit(**/.env*)", "Write(**/.env*)", "NotebookEdit(**/.env*)"]
_NO_EDIT = ["Edit", "Write", "NotebookEdit"]

# What a snapshot covers, and what's never worth snapshotting/diffing.
TRACKED_ROOTS = ["src", "pyproject.toml", "dbt", "dagster_cloud.yaml", "dg.toml"]
_SKIP_DIRS = {"__pycache__", ".local_defs_state", "target", "dbt_packages", "logs", ".venv", "node_modules", ".git"}
_MAX_DIFF_LINES = 400
_KEEP_SNAPSHOTS = 5

_SNAPSHOT_ID_RE = re.compile(r"^\d{8}T\d{12}Z-[0-9a-f]{6}$")
_locks: dict[str, asyncio.Lock] = {}


def project_lock(project_id: str) -> asyncio.Lock:
    return _locks.setdefault(project_id, asyncio.Lock())


# ---------------------------------------------------------------- CLI args ---

def build_cli_args(mode: Mode, prompt: str) -> list[str]:
    """Everything after the `claude` binary. Kept pure so it's unit-testable."""
    args = [
        "-p", prompt,
        "--output-format", "stream-json", "--verbose",
        "--no-session-persistence",
        "--max-budget-usd", MAX_BUDGET_USD[mode],
        # Don't let a project-local .claude/settings widen the permissions.
        "--setting-sources", "user",
    ]
    if mode == "explain":
        args += ["--permission-mode", "dontAsk", "--allowedTools", *_READ_TOOLS,
                 "--disallowedTools", *_SECRET_DENY, *_NO_EDIT]
    else:
        args += ["--permission-mode", "acceptEdits", "--allowedTools", *_READ_TOOLS,
                 "--disallowedTools", *_SECRET_DENY]
    return args


def build_prompt(mode: Mode, error_text: str, project_name: str, root_module: str, install_mode: str) -> str:
    error_text = (error_text or "").strip()
    if len(error_text) > 12_000:
        error_text = error_text[:6_000] + "\n...[truncated]...\n" + error_text[-6_000:]
    shell_rule = (
        "Shell access is deliberately minimal: the ONLY commands you may run are `dg check defs` and `dg list defs`, "
        "typed exactly like that from the current directory (you are already in the project folder: no `cd`, no `uv run`, "
        "no pipes or `&&`). Everything else is blocked and nobody is available to approve it, so use the Read/Glob/Grep "
        "tools to look at files. Never ask for approval; if something is blocked, work around it or say so.\n\n"
    )
    common = (
        f"A Dagster Designer project named '{project_name}' fails validation (`dg check defs` / `dg list defs`). "
        f"Python root module: `{root_module}`. Component install mode: `{install_mode}` "
        f"(`as_package` means components are referenced from the dagster-community-components package, "
        f"not vendored into the project).\n\n"
        f"Validation error output:\n```\n{error_text}\n```\n\n"
        + shell_rule
    )
    if mode == "explain":
        return (
            "/dagster-expert " + common
            + "Do NOT modify any files. Investigate (read the relevant defs.yaml files; you may run `dg check defs`), "
              "then explain the root cause in plain language and say exactly which file(s) you would change and how. "
              "Keep it concise."
        )
    return (
        "/dagster-expert " + common
        + "Fix it. Rules: work only inside this project directory; change only what the error requires (prefer "
          "correcting a component's defs.yaml attributes, or removing a clearly-invalid stub file); never touch "
          ".env files, credentials or the data/ directory; do not install packages. Verify with `dg check defs` "
          "and keep going until it passes, or stop and explain why it can't be fixed safely. Finish with a short "
          "summary: the root cause and each file you changed."
    )


# --------------------------------------------------------------- snapshots ---

def _snapshot_root(project_id: str) -> Path:
    return settings.data_dir / "ai-fix-snapshots" / project_id


def _skip(path_parts: tuple[str, ...], name: str) -> bool:
    return (
        any(p in _SKIP_DIRS or p.endswith(".egg-info") for p in path_parts)
        or name.endswith(".pyc")
    )


def _tracked_files(project_dir: Path) -> dict[str, Path]:
    """relative posix path -> absolute path, for every tracked regular file."""
    out: dict[str, Path] = {}
    for root in TRACKED_ROOTS:
        base = project_dir / root
        if base.is_file():
            out[root] = base
        elif base.is_dir():
            for f in base.rglob("*"):
                if not f.is_file() or f.is_symlink():
                    continue
                rel = f.relative_to(project_dir)
                if _skip(rel.parts[:-1], f.name):
                    continue
                out[rel.as_posix()] = f
    return out


def create_snapshot(project_id: str, project_dir: Path) -> str:
    # microsecond precision so ids sort by creation time (pruning keeps the newest)
    snapshot_id = f"{datetime.now(timezone.utc):%Y%m%dT%H%M%S%fZ}-{uuid.uuid4().hex[:6]}"
    dest = _snapshot_root(project_id) / snapshot_id
    for rel, src in _tracked_files(project_dir).items():
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
    dest.mkdir(parents=True, exist_ok=True)  # an empty project still gets a snapshot dir
    _prune_old_snapshots(project_id)
    return snapshot_id


def _prune_old_snapshots(project_id: str) -> None:
    root = _snapshot_root(project_id)
    snaps = sorted(p for p in root.iterdir() if p.is_dir()) if root.exists() else []
    for old in snaps[:-_KEEP_SNAPSHOTS]:
        shutil.rmtree(old, ignore_errors=True)


def _snapshot_dir(project_id: str, snapshot_id: str) -> Path:
    if not _SNAPSHOT_ID_RE.match(snapshot_id or ""):
        raise ValueError("Invalid snapshot id")
    d = _snapshot_root(project_id) / snapshot_id
    if not d.is_dir():
        raise FileNotFoundError("Snapshot not found (it may have been kept or undone already)")
    return d


def _snapshot_files(snap: Path) -> dict[str, Path]:
    return {f.relative_to(snap).as_posix(): f for f in snap.rglob("*") if f.is_file()}


def _read_text(p: Path) -> list[str] | None:
    try:
        return p.read_text(encoding="utf-8").splitlines(keepends=True)
    except (UnicodeDecodeError, OSError):
        return None


def diff_snapshot(project_id: str, project_dir: Path, snapshot_id: str) -> list[dict]:
    """Per-file changes since the snapshot: {path, status, diff}."""
    snap = _snapshot_dir(project_id, snapshot_id)
    before = _snapshot_files(snap)
    after = _tracked_files(project_dir)
    changes: list[dict] = []
    for rel in sorted(set(before) | set(after)):
        b, a = before.get(rel), after.get(rel)
        if b and a:
            if b.read_bytes() == a.read_bytes():
                continue
            status = "modified"
        elif a:
            status = "added"
        else:
            status = "deleted"
        old, new = (_read_text(b) if b else []), (_read_text(a) if a else [])
        if old is None or new is None:
            diff = "(binary file)"
        else:
            lines = list(difflib.unified_diff(old, new, f"a/{rel}", f"b/{rel}", n=3))
            if len(lines) > _MAX_DIFF_LINES:
                lines = lines[:_MAX_DIFF_LINES] + [f"... ({len(lines) - _MAX_DIFF_LINES} more lines)\n"]
            diff = "".join(lines)
        changes.append({"path": rel, "status": status, "diff": diff})
    return changes


def restore_snapshot(project_id: str, project_dir: Path, snapshot_id: str) -> list[str]:
    """Undo: put modified/deleted files back, remove added ones. Returns the
    paths touched. The snapshot is deleted afterwards."""
    changes = diff_snapshot(project_id, project_dir, snapshot_id)
    snap = _snapshot_dir(project_id, snapshot_id)
    touched: list[str] = []
    for c in changes:
        target = project_dir / c["path"]
        if c["status"] == "added":
            target.unlink(missing_ok=True)
            parent = target.parent
            # prune now-empty directories the agent created (never above project_dir)
            while parent != project_dir and parent.exists() and not any(parent.iterdir()):
                parent.rmdir()
                parent = parent.parent
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(snap / c["path"], target)
        touched.append(c["path"])
    shutil.rmtree(snap, ignore_errors=True)
    return touched


def discard_snapshot(project_id: str, snapshot_id: str) -> None:
    shutil.rmtree(_snapshot_dir(project_id, snapshot_id), ignore_errors=True)


# --------------------------------------------------------------- the run -----

async def stream_task(
    claude_bin: str, project_dir: Path, mode: Mode, prompt: str, env: dict[str, str],
) -> AsyncIterator[str]:
    """Yield the CLI's stream-json lines, then a final designer event."""
    proc = await asyncio.create_subprocess_exec(
        claude_bin, *build_cli_args(mode, prompt),
        cwd=str(project_dir), env=env,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    assert proc.stdout is not None and proc.stderr is not None
    stderr_task = asyncio.create_task(proc.stderr.read())
    timed_out = False
    try:
        async with asyncio.timeout(RUN_TIMEOUT_SECONDS):
            async for line in proc.stdout:
                decoded = line.decode(errors="replace").rstrip("\n")
                if decoded:
                    yield decoded
            await proc.wait()
    except TimeoutError:
        timed_out = True
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            await proc.wait()
    stderr = (await stderr_task).decode(errors="replace").strip()[-600:]
    yield json.dumps({
        "type": "designer", "event": "finished",
        "returncode": proc.returncode, "timed_out": timed_out, "stderr": stderr,
    })
