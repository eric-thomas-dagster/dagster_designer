"""Routes "Ask Dagster AI" to the best thing actually available, instead
of the third-party `<scout-copilot>` widget (an external SaaS embed,
unrelated to the user's own Claude/OpenAI setup, and the thing users
reported as flaky).

Three tiers, cheapest-best first:
  1. Claude Code CLI installed, with the official `dagster-expert` skill
     (dagster-io/skills marketplace) -- shell out to it headlessly. Best
     answers: dg CLI awareness, 40+ tool integrations, maintained by
     Dagster Labs independently of this app.
  2. No CLI, but the user has an OpenAI/Anthropic key configured in
     Designer's own Settings (the same store genie_service.py uses) --
     fall back to a direct API call with a Dagster-focused system
     prompt. Not as capable as the real skill, but self-contained and
     far more reliable than an external widget.
  3. Neither -- caller shows a "set up AI" prompt.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
from typing import AsyncIterator

import httpx

CLAUDE_BIN_NAME = "claude"
DAGSTER_SKILLS_MARKETPLACE = "dagster-io/skills"
DAGSTER_EXPERT_PLUGIN = "dagster-expert@dagster"

FALLBACK_SYSTEM_PROMPT = (
    "You are a helpful expert on Dagster, the open-source data orchestration "
    "framework, and Dagster+, its managed cloud offering. Answer questions about "
    "software-defined assets, components, resources, schedules, sensors, "
    "partitions, the `dg` CLI, and Dagster+ deployment/CI-CD concepts. Be "
    "concise and concrete — prefer a short code snippet over a long "
    "explanation when one would help. If you're not sure of exact current API "
    "names, say so rather than inventing plausible-looking ones."
)


def find_claude_cli() -> str | None:
    return shutil.which(CLAUDE_BIN_NAME)


async def _run(cmd: list[str], timeout: float = 30.0) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError(f"{cmd[0]} timed out after {timeout}s")
    return proc.returncode or 0, stdout.decode(errors="replace"), stderr.decode(errors="replace")


async def dagster_expert_installed(claude_bin: str) -> bool:
    try:
        code, stdout, _ = await _run([claude_bin, "plugin", "list", "--json"], timeout=15.0)
    except Exception:
        return False
    if code != 0:
        return False
    try:
        plugins = json.loads(stdout)
    except json.JSONDecodeError:
        return False
    return any(
        p.get("enabled") and str(p.get("id", "")).startswith("dagster-expert@")
        for p in plugins
        if isinstance(p, dict)
    )


async def status() -> dict:
    claude_bin = find_claude_cli()
    installed = await dagster_expert_installed(claude_bin) if claude_bin else False
    return {
        "cli_available": bool(claude_bin),
        "dagster_expert_installed": installed,
        "openai_available": bool(os.getenv("OPENAI_API_KEY")),
        "anthropic_available": bool(os.getenv("ANTHROPIC_API_KEY")),
    }


async def ensure_dagster_expert_installed() -> dict:
    """Best-effort auto-install: add the marketplace (no-op if already
    added -- `marketplace add` on an existing one just fails harmlessly,
    which we swallow), then install the plugin non-interactively. Real,
    scriptable Claude Code CLI commands -- verified against `--help`
    before wiring this up, not guessed."""
    claude_bin = find_claude_cli()
    if not claude_bin:
        raise RuntimeError("Claude Code CLI not found on PATH")

    if await dagster_expert_installed(claude_bin):
        return {"already_installed": True}

    # Best-effort -- if the marketplace is already added this errors,
    # which is fine, we only care that it ends up present.
    try:
        await _run([claude_bin, "plugin", "marketplace", "add", DAGSTER_SKILLS_MARKETPLACE], timeout=30.0)
    except Exception:
        pass

    code, stdout, stderr = await _run(
        [claude_bin, "plugin", "install", DAGSTER_EXPERT_PLUGIN, "-y", "--json"], timeout=60.0,
    )
    if code != 0:
        raise RuntimeError(f"claude plugin install failed: {(stderr or stdout).strip()[:400]}")
    return {"already_installed": False, "install_output": stdout.strip()}


async def stream_cli_chat(question: str) -> AsyncIterator[str]:
    """Yield raw stream-json lines from a headless `claude -p
    "/dagster-expert <question>"` invocation as they arrive. Caller
    (the API endpoint) forwards each line straight to the client --
    parsing into displayable text happens on the frontend, which
    already needs to distinguish event types (assistant text vs. the
    final result vs. rate-limit info)."""
    claude_bin = find_claude_cli()
    if not claude_bin:
        raise RuntimeError("Claude Code CLI not found on PATH")

    prompt = f"/dagster-expert {question}"
    proc = await asyncio.create_subprocess_exec(
        claude_bin, "-p", prompt, "--output-format", "stream-json", "--verbose",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert proc.stdout is not None
    try:
        async for line in proc.stdout:
            decoded = line.decode(errors="replace").rstrip("\n")
            if decoded:
                yield decoded
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        await proc.wait()


async def fallback_chat(question: str, history: list[dict] | None = None) -> str:
    """Direct API call, no CLI/skill involved -- Tier 2. Prefers
    Anthropic when both keys are set, matching the existing AI bar's
    model-preference ordering."""
    anthropic_key = os.getenv("ANTHROPIC_API_KEY")
    openai_key = os.getenv("OPENAI_API_KEY")
    if not anthropic_key and not openai_key:
        raise RuntimeError("No AI provider configured — add a key in Settings.")

    messages = [{"role": h["role"], "content": h["content"]} for h in (history or [])]
    messages.append({"role": "user", "content": question})

    async with httpx.AsyncClient(timeout=60.0) as client:
        if anthropic_key:
            headers = {
                "x-api-key": anthropic_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            }
            workspace_id = os.getenv("ANTHROPIC_WORKSPACE_ID")
            if workspace_id:
                headers["anthropic-workspace-id"] = workspace_id
            r = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers=headers,
                json={
                    "model": "claude-sonnet-4-5",
                    "max_tokens": 1024,
                    "system": FALLBACK_SYSTEM_PROMPT,
                    "messages": messages,
                },
            )
            if r.status_code != 200:
                raise RuntimeError(f"Anthropic error {r.status_code}: {r.text[:400]}")
            data = r.json()
            blocks = data.get("content") or []
            return next((b.get("text", "") for b in blocks if b.get("type") == "text"), "")
        else:
            r = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {openai_key}", "Content-Type": "application/json"},
                json={
                    "model": "gpt-4o",
                    "messages": [{"role": "system", "content": FALLBACK_SYSTEM_PROMPT}, *messages],
                },
            )
            if r.status_code != 200:
                raise RuntimeError(f"OpenAI error {r.status_code}: {r.text[:400]}")
            data = r.json()
            return (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
