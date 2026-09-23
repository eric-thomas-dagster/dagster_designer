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
import re
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

_skill_files_cache: dict[str, str] | None = None
_skill_files_loaded = False

# Total on-disk content is ~220KB / ~55K tokens across 173 files -- fits
# in a single request in *theory* (well under even gpt-4o's 128K context),
# but blowing the whole budget on system-prompt content isn't safe in
# practice: hit a real 429 from an org-level OpenAI rate limit of 30K
# tokens/minute on the very first live test, well below what the model's
# context window alone would suggest is fine. So this is relevance-
# filtered per question instead, mirroring genie_service.py's own
# _keyword_prefilter pattern for the same kind of problem (a big catalog,
# a specific task, pick what's actually relevant).
_REFERENCE_CHAR_BUDGET = 20_000  # ~5K tokens of reference content, leaves headroom under a 30K TPM cap


def _find_dagster_expert_skill_dir() -> "os.PathLike[str] | None":
    """Locate the dagster-expert skill's files on disk, if the user has
    it installed via Claude Code — regardless of whether we're routing
    through the CLI (Tier 1) or not, this content is just markdown and
    reusable as context for a direct API call too. Checked in the
    two places `claude plugin install` and the marketplace's own
    checkout actually put it; picks the highest version under `cache/`
    if more than one is present."""
    import glob as _glob
    from pathlib import Path as _Path

    cache_hits = sorted(_glob.glob(
        str(_Path.home() / ".claude/plugins/cache/*/dagster-expert/*/skills/dagster-expert/SKILL.md")
    ))
    if cache_hits:
        return _Path(cache_hits[-1]).parent

    marketplace_hits = _glob.glob(
        str(_Path.home() / ".claude/plugins/marketplaces/*/skills/dagster-expert/SKILL.md")
    )
    if marketplace_hits:
        return _Path(marketplace_hits[0]).parent
    return None


def _load_dagster_expert_files() -> dict[str, str] | None:
    """{relative_path: content} for SKILL.md + every reference doc.
    Loaded once and cached for the process lifetime -- the skill's
    on-disk content doesn't change mid-session."""
    global _skill_files_cache, _skill_files_loaded
    if _skill_files_loaded:
        return _skill_files_cache

    _skill_files_loaded = True
    skill_dir = _find_dagster_expert_skill_dir()
    if not skill_dir:
        return None

    from pathlib import Path as _Path
    skill_dir = _Path(skill_dir)
    files: dict[str, str] = {}
    skill_md = skill_dir / "SKILL.md"
    if skill_md.exists():
        files["SKILL.md"] = skill_md.read_text(errors="replace")
    for md_file in sorted((skill_dir / "references").rglob("*.md")):
        rel = str(md_file.relative_to(skill_dir))
        files[rel] = md_file.read_text(errors="replace")

    if not files:
        return None
    _skill_files_cache = files
    return _skill_files_cache


def _select_reference_context(question: str, budget_chars: int = _REFERENCE_CHAR_BUDGET) -> str | None:
    """Real dagster-expert content, filtered to what's relevant to this
    question rather than dumped in full (see _REFERENCE_CHAR_BUDGET's
    comment for why). SKILL.md's own core sections (everything before
    its generated reference index -- concepts, dg CLI basics) are always
    included since they're small and broadly useful; reference files are
    ranked by keyword overlap against the question and added greedily
    until the budget's spent, most relevant first.
    """
    files = _load_dagster_expert_files()
    if not files:
        return None

    skill_md = files.get("SKILL.md", "")
    core = skill_md.split("## Reference Index", 1)[0].strip()

    q_words = {w for w in re.findall(r"[a-z0-9]+", question.lower()) if len(w) > 2}

    scored: list[tuple[int, str]] = []
    for path, content in files.items():
        if path == "SKILL.md":
            continue
        haystack = f"{path} {content[:400]}".lower()
        h_words = set(re.findall(r"[a-z0-9]+", haystack))
        score = len(q_words & h_words)
        if score > 0:
            scored.append((score, path))
    scored.sort(key=lambda t: (-t[0], t[1]))

    parts = [f"# SKILL.md (core)\n\n{core}"]
    used = len(parts[0])
    for _, path in scored:
        content = files[path]
        if used + len(content) > budget_chars and used > len(parts[0]):
            break
        parts.append(f"# {path}\n\n{content}")
        used += len(content)

    return "\n\n---\n\n".join(parts)


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
        # Whether Tier 2 (direct API fallback) will use the real
        # dagster-expert reference docs as its system prompt, vs. the
        # generic one -- found independently of dagster_expert_installed
        # since that check is scoped to the CLI's OWN plugin list, not a
        # filesystem scan; a plugin can be present on disk (e.g. via the
        # marketplace checkout) without `claude` being on PATH at all.
        "reference_docs_available": _find_dagster_expert_skill_dir() is not None,
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
    model-preference ordering.

    Uses real dagster-expert reference content (see
    _select_reference_context), filtered to what's relevant to this
    question, as the system prompt when the skill is found on disk --
    regardless of which provider ends up answering, so an OpenAI user
    with no Claude Code installed still gets Dagster Labs' actual
    material, just without the live `dg` CLI tool access Tier 1 has.
    Falls back to the generic prompt when the skill isn't installed
    locally at all.
    """
    anthropic_key = os.getenv("ANTHROPIC_API_KEY")
    openai_key = os.getenv("OPENAI_API_KEY")
    if not anthropic_key and not openai_key:
        raise RuntimeError("No AI provider configured — add a key in Settings.")

    system_prompt = _select_reference_context(question) or FALLBACK_SYSTEM_PROMPT

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
                    "system": system_prompt,
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
                    "messages": [{"role": "system", "content": system_prompt}, *messages],
                },
            )
            if r.status_code != 200:
                raise RuntimeError(f"OpenAI error {r.status_code}: {r.text[:400]}")
            data = r.json()
            return (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
