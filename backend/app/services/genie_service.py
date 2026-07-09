"""Genie planning service.

Single-shot LLM planner inspired by dagster-component-templates/assets/ai/planned_catalog_agent.
Given a natural-language task and the current graph, returns a proposed set of picks
(component_type + asset_name + upstream_asset_names + config) that the frontend
can apply to the graph.

Uses the community templates manifest to know what components are available.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any

import httpx

MANIFEST_URL = (
    "https://raw.githubusercontent.com/eric-thomas-dagster/dagster-component-templates/"
    "main/manifest.json"
)

DEFAULT_MODEL = "gpt-4o-mini"

# Components that exist in the manifest but shouldn't be surfaced to users or the LLM.
# DependencyGraphComponent is our fallback mechanism for persisting manual graph
# edges — components with `upstream_asset_keys` / `left_asset_key` / etc. should
# be used instead.
_HIDDEN_COMPONENT_IDS = {"dependency_graph"}

# Manifest cache — in-memory (15 min TTL) with a disk fallback so we survive
# GitHub's 60/hr unauthenticated rate-limit on raw.githubusercontent.com.
_manifest_cache: dict[str, Any] = {"data": None, "fetched_at": 0.0}
_MANIFEST_TTL = 900.0  # seconds

# Look up disk cache next to the backend package.
from pathlib import Path as _Path

_DISK_CACHE_PATH = _Path(__file__).resolve().parent.parent.parent / ".manifest_cache.json"


@dataclass
class GeniePick:
    component_type: str
    asset_name: str
    upstream_asset_names: list[str]
    config: dict[str, Any]
    reason: str


@dataclass
class GeniePlan:
    picks: list[GeniePick]
    task: str
    model_used: str
    tokens_prompt: int
    tokens_completion: int
    notes: list[str]


class GenieError(RuntimeError):
    pass


def _load_disk_cache() -> dict[str, Any] | None:
    try:
        if _DISK_CACHE_PATH.exists():
            return json.loads(_DISK_CACHE_PATH.read_text())
    except Exception:
        pass
    return None


def _save_disk_cache(data: dict[str, Any]) -> None:
    try:
        _DISK_CACHE_PATH.write_text(json.dumps(data))
    except Exception:
        pass


async def fetch_manifest() -> dict[str, Any]:
    import time
    now = time.time()
    cached = _manifest_cache.get("data")
    if cached and (now - _manifest_cache.get("fetched_at", 0.0)) < _MANIFEST_TTL:
        return cached

    # If in-memory is empty, warm from disk before hitting the network so
    # we have a fallback if the network call fails.
    if not cached:
        disk = _load_disk_cache()
        if disk:
            _manifest_cache["data"] = disk
            _manifest_cache["fetched_at"] = 0.0  # force refresh attempt
            cached = disk

    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(MANIFEST_URL, timeout=15.0)
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPStatusError as e:
        if cached:
            return cached
        raise GenieError(
            f"Could not fetch component manifest ({e.response.status_code}). "
            "GitHub may be rate-limiting unauthenticated requests; try again in an hour."
        ) from e
    except httpx.HTTPError as e:
        if cached:
            return cached
        raise GenieError(f"Could not fetch component manifest: {e}") from e

    _manifest_cache["data"] = data
    _manifest_cache["fetched_at"] = now
    _save_disk_cache(data)
    return data


def _pip_available(pkg: str) -> bool:
    """Cheap check whether a pip package is importable in the backend's env."""
    import importlib.util
    try:
        return importlib.util.find_spec(pkg) is not None
    except (ImportError, ValueError):
        return False


def _keyword_prefilter(components: list[dict[str, Any]], task: str, cap: int = 250) -> list[dict[str, Any]]:
    """Filter + rank the catalog before sending it to the planner LLM.

    Strategy (inspired by planned_catalog_agent):
    1. Drop internal/fallback components.
    2. Drop components whose `agent_hints.requires_pip` isn't installed here
       (avoids the planner picking components that would fail to import).
    3. Score every remaining component by task-keyword overlap on
       name + description + tags + category + agent_hints.inputs/outputs/side_effects.
    4. Reserve slots per essential category (source/ingestion/sink/etc.) so a
       pipeline plan always has viable endpoints.
    5. Fill remaining slots with the top overall scorers.
    """
    # 1. Drop hidden.
    components = [c for c in components if c.get("id") not in _HIDDEN_COMPONENT_IDS]

    # 2. Drop unusable-in-this-env components.
    pip_cache: dict[str, bool] = {}
    def usable(c: dict[str, Any]) -> bool:
        req = (c.get("agent_hints") or {}).get("requires_pip") or []
        if isinstance(req, str):
            req = [req]
        for pkg in req:
            if pkg not in pip_cache:
                pip_cache[pkg] = _pip_available(pkg)
            if not pip_cache[pkg]:
                return False
        return True
    components = [c for c in components if usable(c)]

    tokens = {t.lower() for t in re.split(r"[^a-z0-9_]+", task.lower()) if len(t) >= 3}

    def score(c: dict[str, Any]) -> int:
        if not tokens:
            return 0
        hints = c.get("agent_hints") or {}
        blob = " ".join([
            (c.get("name") or ""),
            (c.get("description") or ""),
            " ".join(c.get("tags") or []),
            (c.get("category") or ""),
            str(hints.get("inputs") or ""),
            str(hints.get("outputs") or ""),
            str(hints.get("side_effects") or ""),
        ]).lower()
        return sum(1 for t in tokens if t in blob)

    scored = sorted(components, key=lambda c: -score(c))

    # Reserved coverage per essential category so we always show enough breadth
    # for the LLM to build an end-to-end pipeline (source → transform → sink).
    reserved_per_category = {
        "source": 20,
        "ingestion": 20,
        "sink": 20,
        "io_manager": 8,
        "resource": 8,
    }

    picked: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    def add(comp: dict[str, Any]) -> None:
        if comp["id"] in seen_ids:
            return
        picked.append(comp)
        seen_ids.add(comp["id"])

    # Pass 1: reserve top-scoring items in essential categories.
    for cat, quota in reserved_per_category.items():
        cnt = 0
        for c in scored:
            if cnt >= quota or len(picked) >= cap:
                break
            if c.get("category") == cat:
                add(c)
                cnt += 1

    # Pass 2: fill remaining slots with the top overall scorers.
    for c in scored:
        if len(picked) >= cap:
            break
        add(c)

    return picked


def _catalog_lines(components: list[dict[str, Any]], description_max: int = 180) -> list[str]:
    """Render the filtered catalog into terse lines for the prompt.

    Includes agent_hints (inputs/outputs/side_effects/anti_uses) inline when
    present so the planner has explicit guidance on when to pick a component.
    """
    lines: list[str] = []
    for c in components:
        desc = (c.get("description") or "")[:description_max]
        cat = c.get("category") or "?"
        tags = ",".join((c.get("tags") or [])[:4])
        parts = [f'- id="{c["id"]}" category={cat} tags=[{tags}]', desc]
        hints = c.get("agent_hints") or {}
        if hints.get("inputs"):
            parts.append(f"in: {str(hints['inputs'])[:120]}")
        if hints.get("outputs"):
            parts.append(f"out: {str(hints['outputs'])[:120]}")
        if hints.get("side_effects"):
            parts.append(f"use_when: {str(hints['side_effects'])[:120]}")
        if hints.get("anti_uses"):
            parts.append(f"avoid_when: {str(hints['anti_uses'])[:120]}")
        lines.append(" :: ".join(parts))
    return lines


SYSTEM_PROMPT = (
    "You are a Dagster pipeline planner. Given a user task and a catalog of available "
    "components, produce a JSON plan of assets to add to the graph. Chain them by "
    "referencing upstream asset names.\n\n"
    "Output ONLY a JSON object with this shape:\n"
    '  {"picks": [\n'
    '     {"component_type": "<EXACT id from catalog>", "asset_name": "<unique snake_case>", '
    '"upstream_asset_names": ["<prior asset_name>", ...], '
    '"config": {"<field>": "<value>"}, '
    '"reason": "<why this step>"},\n'
    '     ...\n'
    '  ]}\n\n'
    "RULES (strict):\n"
    "- component_type MUST be an EXACT string that appears as `id=\"…\"` in the "
    "  catalog below. Do NOT shorten, singularize, or invent names. If none fits, "
    "  return {\"picks\": []}.\n"
    "- asset_name MUST be new, unique, snake_case, and NEVER equal to an upstream name.\n"
    "- Naming: if the user names a domain (customers, orders, events, invoices, "
    "  etc.), use it. Otherwise DO NOT invent a domain — use generic names like "
    "  `raw_input`, `deduped_data`, `output_data`, `staged_records`. Never default "
    "  to `customers`, `orders`, or `users` when the task is domain-agnostic.\n"
    "- upstream_asset_names references EARLIER asset_name values from your own plan, "
    "  or from the existing graph.\n"
    "- Follow the task literally: if the user says 'write to CSV', include a sink "
    "  component whose id matches (e.g. `dataframe_to_csv`).\n"
    "- Prefer minimal plans (1–8 picks). Order picks so upstream comes before downstream.\n"
    "- If refining a previous plan, keep what still fits and only change what the user "
    "  asked to change.\n"
    "\n"
    "CONFIG — fill in sensible defaults so the plan is runnable end-to-end:\n"
    "- If a component writes to a file (dataframe_to_csv, dataframe_to_parquet, "
    "  dataframe_to_json, file_writer, save_to_disk, etc.), ALWAYS set the path field "
    "  to `/tmp/{asset_name}.<ext>` (e.g. `/tmp/orders_report.csv`). Never omit it.\n"
    "- If a component reads a URL or path, set the field only if the user gave one "
    "  explicitly. Otherwise use a clearly-placeholder value like `TODO_set_url` "
    "  so the user knows to fill it — do NOT invent a random URL.\n"
    "- For connection strings, credentials, bucket names, project IDs: use placeholders "
    "  like `TODO_snowflake_account`, `TODO_bucket_name`. NEVER invent real-looking "
    "  values. The user MUST edit these before running.\n"
    "- For filter/predicate/query fields, use the exact expression the user described "
    "  (e.g. `valid == True`, `amount > 0`).\n"
    "- If a required field's value is truly not derivable from the task, use "
    "  `TODO_<field_name>` so the incomplete-asset UI can surface it.\n"
)


def _build_user_prompt(
    task: str,
    catalog_lines: list[str],
    existing_assets: list[dict[str, Any]],
    previous_plan: list[dict[str, Any]] | None = None,
    refinement: str | None = None,
) -> str:
    existing = "\n".join(
        f'- {a.get("name")} ({a.get("component_type") or "asset"})' for a in existing_assets[:80]
    ) or "(none)"
    catalog = "\n".join(catalog_lines)
    parts = [
        f"Task:\n{task}",
        f"Existing assets in the graph:\n{existing}",
    ]
    if previous_plan:
        prev_lines = []
        for i, p in enumerate(previous_plan, 1):
            prev_lines.append(
                f"  {i}. {p.get('asset_name')} = {p.get('component_type')}"
                + (f" (from {', '.join(p.get('upstream_asset_names') or [])})"
                   if p.get('upstream_asset_names') else "")
            )
        parts.append("Previous plan (you produced this last turn):\n" + "\n".join(prev_lines))
    if refinement:
        parts.append(f"User refinement request:\n{refinement}\n\n"
                     "Adjust the previous plan per the refinement. Keep unchanged steps identical.")
    parts.append(f"Available components ({len(catalog_lines)} shown):\n{catalog}")
    return "\n\n".join(parts) + "\n"


async def plan(
    task: str,
    existing_assets: list[dict[str, Any]] | None = None,
    model: str = DEFAULT_MODEL,
    catalog_cap: int = 250,
    previous_plan: list[dict[str, Any]] | None = None,
    refinement: str | None = None,
) -> GeniePlan:
    if not task or not task.strip():
        raise GenieError("Empty task")

    is_anthropic = model.lower().startswith("claude")
    if is_anthropic:
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise GenieError(
                "ANTHROPIC_API_KEY is not set on the backend. Set it in the shell env "
                "where you run the backend, then restart."
            )
    else:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise GenieError(
                "OPENAI_API_KEY is not set on the backend. Set it in the shell env "
                "where you run the backend, then restart."
            )

    manifest = await fetch_manifest()
    components: list[dict[str, Any]] = manifest.get("components") or []
    if not components:
        raise GenieError("Manifest returned no components")

    filtered = _keyword_prefilter(components, task, cap=catalog_cap)
    lines = _catalog_lines(filtered)
    user_prompt = _build_user_prompt(
        task, lines, existing_assets or [], previous_plan=previous_plan, refinement=refinement
    )

    async with httpx.AsyncClient(timeout=60.0) as client:
        if is_anthropic:
            # Anthropic Messages API. Docs at
            # https://docs.claude.com/en/api/messages. system_prompt goes in
            # its own top-level field; messages carry the user turn only.
            r = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": model,
                    "max_tokens": 4096,
                    "system": SYSTEM_PROMPT + "\n\nRespond with ONLY the JSON object, no prose, no code fences.",
                    "messages": [{"role": "user", "content": user_prompt}],
                    "temperature": 0.2,
                },
            )
            if r.status_code != 200:
                raise GenieError(f"Anthropic error {r.status_code}: {r.text[:400]}")
            data = r.json()
            # Content is a list of blocks; the first text block holds the reply.
            try:
                blocks = data.get("content") or []
                content = next((b.get("text", "") for b in blocks if b.get("type") == "text"), "")
                # Claude sometimes wraps in ```json fences despite instructions;
                # strip if present.
                stripped = content.strip()
                if stripped.startswith("```"):
                    stripped = stripped.split("```", 2)[1]
                    if stripped.startswith("json"):
                        stripped = stripped[len("json"):]
                    content = stripped.strip("` \n")
                parsed = json.loads(content)
                raw_picks = parsed.get("picks") or []
                usage = data.get("usage") or {}
                data["usage"] = {
                    "prompt_tokens": usage.get("input_tokens", 0),
                    "completion_tokens": usage.get("output_tokens", 0),
                }
            except (KeyError, IndexError, json.JSONDecodeError) as e:
                raise GenieError(f"Could not parse Claude response: {e}") from e
        else:
            r = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": user_prompt},
                    ],
                    "response_format": {"type": "json_object"},
                    "temperature": 0.2,
                },
            )
            if r.status_code != 200:
                raise GenieError(f"OpenAI error {r.status_code}: {r.text[:400]}")
            data = r.json()

            try:
                content = data["choices"][0]["message"]["content"]
                parsed = json.loads(content)
                raw_picks = parsed.get("picks") or []
            except (KeyError, IndexError, json.JSONDecodeError) as e:
                raise GenieError(f"Could not parse LLM response: {e}") from e

    valid_ids = {c["id"] for c in filtered}
    picks: list[GeniePick] = []
    seen_names: set[str] = {str(a["name"]) for a in (existing_assets or []) if a.get("name")}
    notes: list[str] = []

    existing_names = {str(a["name"]) for a in (existing_assets or []) if a.get("name")}

    def _dedupe(name: str, used: set[str]) -> str:
        """Return a unique variant of `name` not in `used`. Appends `_v2`,
        `_v3`, … until we find a fresh one."""
        if name not in used:
            return name
        n = 2
        while f"{name}_v{n}" in used:
            n += 1
        return f"{name}_v{n}"

    for i, p in enumerate(raw_picks):
        component_type = p.get("component_type") or ""
        if component_type == "noop":
            notes.append(p.get("reason") or "planner could not build from catalog")
            continue
        if component_type not in valid_ids:
            notes.append(
                f"⚠︎ Pick #{i + 1} references unknown component '{component_type}' — skipped."
            )
            continue

        original_name = (p.get("asset_name") or "").strip()
        if not original_name:
            notes.append(f"⚠︎ Pick #{i + 1} is missing an asset name — skipped.")
            continue
        # Rename on collision rather than skip: existing_names + seen_names
        # form the "used" set. If the LLM meant to reference an existing
        # asset we'd prefer that upstream_asset_names be used; but if it's
        # proposing a new asset with a colliding name, giving it a suffix
        # keeps the plan actionable.
        used = existing_names | seen_names
        asset_name = _dedupe(original_name, used)
        if asset_name != original_name:
            notes.append(
                f"ℹ Renamed pick #{i + 1} '{original_name}' → '{asset_name}' (name was already in use)."
            )
        seen_names.add(asset_name)

        upstream = p.get("upstream_asset_names") or []
        if isinstance(upstream, str):
            upstream = [upstream]
        upstream = [u for u in upstream if u]

        picks.append(
            GeniePick(
                component_type=component_type,
                asset_name=asset_name,
                upstream_asset_names=upstream,
                config=p.get("config") or {},
                reason=p.get("reason") or "",
            )
        )

    usage = data.get("usage") or {}
    return GeniePlan(
        picks=picks,
        task=task,
        model_used=model,
        tokens_prompt=usage.get("prompt_tokens", 0),
        tokens_completion=usage.get("completion_tokens", 0),
        notes=notes,
    )
