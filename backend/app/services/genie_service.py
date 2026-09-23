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

# Default upgraded from gpt-4o-mini after dogfooding showed mini
# systematically hallucinates schema shapes for whole-pipeline components
# (agentic_pipeline etc.) — wrong `partition_key_parser` shape, wrong op
# names, wrong per-step arg structure. gpt-4o holds structure much better;
# per-plan cost is still cents. Users can override per-request via the AI
# bar model picker (Sonnet 4.5 is strongest if ANTHROPIC_API_KEY is set).
DEFAULT_MODEL = "gpt-4o"

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

# Community-components authoring guide (CLAUDE.md). Human-authored prose
# maintained by the community-templates author explicitly to guide LLM
# assistants — covers common gotchas, per-op shapes for
# AgenticPipelineComponent, config-driven partitioning patterns, and
# composition rules. Same TTL/disk-fallback pattern as the manifest.
CLAUDE_MD_URL = (
    "https://raw.githubusercontent.com/eric-thomas-dagster/"
    "dagster-community-components-cli/main/CLAUDE.md"
)
_claude_md_cache: dict[str, Any] = {"data": None, "fetched_at": 0.0}
_CLAUDE_MD_TTL = 900.0  # seconds
_CLAUDE_MD_DISK_CACHE_PATH = (
    _Path(__file__).resolve().parent.parent.parent / ".claude_md_cache.txt"
)


@dataclass
class GeniePick:
    component_type: str
    asset_name: str
    upstream_asset_names: list[str]
    config: dict[str, Any]
    reason: str
    # "add" (default) installs a new component instance, matching every
    # pick before this field existed. "edit" merges `config` into an
    # EXISTING instance's attributes (asset_name must match one in
    # existing_assets). "remove" deletes an existing instance outright
    # (config is ignored).
    action: str = "add"


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


async def fetch_claude_md() -> str:
    """Fetch the community-templates CLAUDE.md authoring guide, or fall
    back to an empty string if unreachable. Cached in-memory with a disk
    fallback so we survive both GitHub rate-limiting and full network
    outages. Same TTL as the manifest.

    The CLAUDE.md is human-authored to guide LLM assistants that build
    with the community catalog. It covers concrete field shapes for
    AgenticPipelineComponent (16 ops), config-driven partitioning
    (`partition_key_parser`, `PartitionedAssetLauncherJobComponent`),
    reusable `personas:` / `agents:` blocks, and common gotchas. Way
    more nuanced than the manifest hints alone.
    """
    import time
    now = time.time()
    cached = _claude_md_cache.get("data")
    if cached and (now - _claude_md_cache.get("fetched_at", 0.0)) < _CLAUDE_MD_TTL:
        return cached

    if not cached:
        try:
            if _CLAUDE_MD_DISK_CACHE_PATH.exists():
                cached = _CLAUDE_MD_DISK_CACHE_PATH.read_text()
                _claude_md_cache["data"] = cached
                _claude_md_cache["fetched_at"] = 0.0  # force refresh attempt
        except Exception:
            pass

    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(CLAUDE_MD_URL, timeout=15.0)
            r.raise_for_status()
            text = r.text
    except httpx.HTTPError:
        # Fall through to whatever cache we have — CLAUDE.md is a nice-to-have,
        # not a blocker for plan generation.
        return cached or ""

    _claude_md_cache["data"] = text
    _claude_md_cache["fetched_at"] = now
    try:
        _CLAUDE_MD_DISK_CACHE_PATH.write_text(text)
    except Exception:
        pass
    return text


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

    # NOTE: previously step 2 dropped components whose `requires_pip`
    # wasn't installed in Designer's BACKEND venv. That was wrong-headed
    # — components execute in the SANDBOX venv (or the Dagster+ target's
    # image), never in Designer's backend. Deps get installed at
    # component-install time via `dagster-component add`'s
    # `pip install requirements.txt` step. Filtering here made
    # `agentic_pipeline`, LLM agents, and other litellm/mcp-dependent
    # components invisible to the planner even though they'd install
    # fine at the sandbox level. Filter removed; if a picked component
    # can't install its own deps, that fails visibly at install time
    # with a clear error — better than being silently unpickable.

    # Tokenize the task, splitting on non-alphanumeric AND on CamelCase
    # boundaries. Users often type class-name references like
    # `FilesystemMonitorSensorComponent` or `AssetJobComponent`; without
    # CamelCase splitting those collapse to one huge token that doesn't
    # match any component's tokens, tanking the prefilter score. Split
    # boundaries: lower→Upper (e.g. `Filesystem`|`Monitor`), and
    # Upper-run→Upper-lower (e.g. `HTTPServer` → `HTTP`|`Server`).
    _boundary = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", task)
    _boundary = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", _boundary)
    tokens = {t.lower() for t in re.split(r"[^a-z0-9_]+", _boundary.lower()) if len(t) >= 3}

    def score(c: dict[str, Any]) -> int:
        if not tokens:
            return 0
        hints = c.get("agent_hints") or {}
        # Everything the manifest author authored for discovery goes into
        # the score blob. Previously we missed: `id` (so a task saying
        # "agentic pipeline" scored 0 on component id=agentic_pipeline
        # unless those words also happened to appear in name/desc/tags),
        # `keywords` (author-declared alt names), `when_to_use`
        # (author-declared "why pick this"), `example_prompts` (authored
        # user-shaped queries to match against). Result: whole-pipeline
        # components ranked way below where they should.
        blob = " ".join([
            (c.get("id") or "").replace("_", " "),
            (c.get("name") or ""),
            (c.get("description") or ""),
            " ".join(c.get("tags") or []),
            " ".join(c.get("keywords") or []),
            (c.get("category") or ""),
            str(hints.get("inputs") or ""),
            str(hints.get("outputs") or ""),
            str(hints.get("side_effects") or ""),
            str(hints.get("when_to_use") or ""),
            " ".join(hints.get("example_prompts") or []),
        ]).lower()
        return sum(1 for t in tokens if t in blob)

    scored = sorted(components, key=lambda c: -score(c))

    # Force-include components whose id (or the CamelCase class-name form
    # derived from it) is mentioned literally in the task. Without this,
    # a task saying `AssetJobComponent` gets outscored by 250 higher-
    # ranking generic matches and the exact-mentioned component never
    # makes it to the LLM. Class-name form: `asset_job` → `AssetJob`
    # (plus optional `Component` suffix).
    def _classname(cid: str) -> str:
        return ''.join(p.capitalize() for p in cid.split('_'))
    task_lower = task.lower()
    task_norm = re.sub(r"[^a-z0-9]", "", task_lower)  # for CamelCase-collapsed matches
    forced_ids: list[str] = []
    for c in components:
        cid = c.get("id") or ""
        if not cid:
            continue
        cn = _classname(cid).lower()
        # Match forms: `asset_job`, `assetjob`, `AssetJobComponent` (via
        # CamelCase or snake_case) — presence anywhere in the task.
        if cid in task_lower or cn in task_norm:
            forced_ids.append(cid)

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

    # Pass 0: guarantee inclusion for components the task names directly
    # (via id or CamelCase class-name form). These are always what the
    # user meant; letting them get outscored by 250 generic matches is
    # the wrong default.
    forced_set = set(forced_ids)
    for c in components:
        if c["id"] in forced_set and len(picked) < cap:
            add(c)

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


def _catalog_lines(components: list[dict[str, Any]], description_max: int = 240) -> list[str]:
    """Render the filtered catalog into terse lines for the prompt.

    Includes agent_hints (inputs/outputs/side_effects/anti_uses) inline when
    present so the planner has explicit guidance on when to pick a component.

    Truncation caps are per-field:
      - `outputs` is the most information-dense field for many components
        (e.g. synthetic_data_generator lists 5 schemas here, ~550 chars).
        Cap of 120 chars used to slice mid-schema and the planner would
        hallucinate column names — bumped to 900.
      - `side_effects` / `anti_uses` often carry critical constraints
        ("group_by columns MUST exist in upstream") — bumped to 600.
      - `inputs` bumped to 400.
    Total prompt size grows but stays well under Sonnet/GPT-4o's context.
    """
    lines: list[str] = []
    for c in components:
        desc = (c.get("description") or "")[:description_max]
        cat = c.get("category") or "?"
        tags = ",".join((c.get("tags") or [])[:4])
        parts = [f'- id="{c["id"]}" category={cat} tags=[{tags}]', desc]
        hints = c.get("agent_hints") or {}
        # Machine-readable value types when present. Surfacing them
        # explicitly lets the planner reason about chain compatibility
        # ("A produces pd.DataFrame → B accepts pd.DataFrame ✓") rather
        # than inferring from free-text descriptions.
        it = hints.get("input_type", "__missing__")
        ot = hints.get("output_type", "__missing__")
        if it != "__missing__":
            parts.append(f"input_type: {it or 'None'}")
        if ot != "__missing__":
            parts.append(f"output_type: {ot or 'None'}")
        # `produces` is a machine-readable list of Dagster primitives this
        # component instance creates when loaded. When it contains
        # `multi_asset`, ONE instance emits N first-class assets via a
        # `steps:` + `outputs.assets:` mechanism — the planner must NOT
        # propose multiple instances of the same component_type in that
        # case. Surfacing this here (instead of relying on free text)
        # gives the RULES block below something concrete to match on.
        prod = c.get("produces")
        if prod:
            parts.append(f"produces: {prod}")
        # `when_to_use` is the manifest-owned "why would I pick this"
        # hint — for whole-pipeline components (agentic_pipeline,
        # ml_pipeline, polars_pipeline, warehouse_pipeline) it explicitly
        # calls out the ONE-YAML shape. Previously omitted entirely, so
        # the planner had no chance to read it. Cap large — the reasoning
        # depends on nuance.
        if hints.get("when_to_use"):
            parts.append(f"when_to_use: {str(hints['when_to_use'])[:900]}")
        if hints.get("inputs"):
            parts.append(f"in: {str(hints['inputs'])[:400]}")
        if hints.get("outputs"):
            parts.append(f"out: {str(hints['outputs'])[:900]}")
        if hints.get("side_effects"):
            parts.append(f"use_when: {str(hints['side_effects'])[:600]}")
        if hints.get("anti_uses"):
            parts.append(f"avoid_when: {str(hints['anti_uses'])[:600]}")
        # `example_yaml_snippets` — authored, fully-formed per-op examples
        # (agentic_pipeline in particular ships snippets for every op:
        # llm_call, route, debate, critique_loop, synthesize, mcp_call,
        # tool_use_loop, handoff …). Without these, the LLM invents field
        # names — `server: github` (should be a dict), `tool:` (should be
        # `mcp_tool_name`), `proposers: [strings]` (should be dicts). With
        # them, the LLM copies the shape verbatim. This is the biggest
        # single lever we have short of full schema-injection.
        snippets = hints.get("example_yaml_snippets")
        if isinstance(snippets, dict) and snippets:
            snippet_str = json.dumps(snippets, separators=(",", ":"))
            parts.append(f"example_yaml_snippets: {snippet_str[:6000]}")
        # `steps_schemas` — discriminated-union JSON Schema for whole-pipeline
        # components. Cheaper than shipping the full schema.json; the LLM
        # can use this to validate its per-step field choices before
        # emitting. Cap generously — cost-of-tokens is small vs cost of
        # a bad plan the user has to hand-fix.
        steps_schemas = hints.get("steps_schemas")
        if isinstance(steps_schemas, dict) and steps_schemas:
            ss_str = json.dumps(steps_schemas, separators=(",", ":"))
            parts.append(f"steps_schemas: {ss_str[:8000]}")
        lines.append(" :: ".join(parts))
    return lines


SYSTEM_PROMPT = (
    "You are a Dagster pipeline planner. Given a user task and a catalog of available "
    "components, produce a JSON plan of picks that add, edit, or remove assets in the "
    "graph. Chain new assets by referencing upstream asset names.\n\n"
    "Output ONLY a JSON object with this shape:\n"
    '  {"picks": [\n'
    '     {"action": "add", "component_type": "<EXACT id from catalog>", "asset_name": "<unique snake_case>", '
    '"upstream_asset_names": ["<prior asset_name>", ...], '
    '"config": {"<field>": "<value>"}, '
    '"reason": "<why this step>"},\n'
    '     ...\n'
    '  ]}\n\n'
    "EDITING OR REMOVING EXISTING ASSETS (critical): the task isn't always "
    "additive. If the user asks to change, reconfigure, or fix something about "
    "an EXISTING asset (one listed under Existing assets below), emit "
    '{"action": "edit", "asset_name": "<the EXISTING asset\'s exact name>", '
    '"config": {"<field>": "<new value>", ...}, "reason": "..."} — config here '
    "holds ONLY the fields to change, merged into that asset's current "
    "attributes (not a full replacement, and omit component_type/"
    "upstream_asset_names entirely). If the user asks to delete, remove, get "
    "rid of, or says they didn't want an existing asset, emit "
    '{"action": "remove", "asset_name": "<the EXISTING asset\'s exact name>", '
    '"reason": "..."} — no config, no component_type. asset_name for edit/'
    "remove MUST exactly match a name from Existing assets — never invent one "
    "or target something not in that list. Default action is \"add\" when "
    "omitted, matching every rule below (which all describe add behavior).\n\n"
    "RULES (strict, apply to \"add\" picks):\n"
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
    "- VALUE-TYPE COMPATIBILITY (when both catalog entries carry `input_type:` "
    "  and `output_type:`): a downstream pick's `input_type` MUST match its "
    "  upstream's `output_type`. E.g. an upstream with `output_type: pd.DataFrame` "
    "  can feed a downstream with `input_type: pd.DataFrame`. A sink whose "
    "  `output_type` is `None` cannot itself be upstream of anything. If types "
    "  don't line up, either (a) insert a compatible transform between them, or "
    "  (b) pick a different upstream/downstream, or (c) drop the mismatched pick. "
    "  When one side has no `input_type`/`output_type` declared, don't reject — "
    "  fall back to the free-text `in:` / `out:` descriptions.\n"
    "- SOURCE PICKING (data generators): when the user names a domain (orders, "
    "  customers, transactions, products, support_tickets, invoices, users, etc.), "
    "  PREFER `synthetic_data_generator` — its `out:` hint enumerates fixed "
    "  schemas for common domains with real column names (e.g. orders → total, "
    "  num_items, category). Do NOT pick `parametric_data_generator` for these "
    "  cases — it emits generic numeric/categorical columns you'd have to "
    "  hand-configure, which fails silently when downstream picks reference "
    "  domain-typical columns (`total`, `customer_id`, `order_date`) that "
    "  parametric doesn't produce by default. Only pick "
    "  `parametric_data_generator` when the user explicitly asks for statistical "
    "  fixtures, model-test data, or custom numeric distributions.\n"
    "- If refining a previous plan, keep what still fits and only change what the user "
    "  asked to change.\n"
    "- WHOLE-PIPELINE COMPONENTS (critical): if a catalog entry lists "
    "  `produces: [...multi_asset...]`, that component emits N first-class "
    "  Dagster assets from a SINGLE instance via its own `steps:` list "
    "  and an `outputs.assets: [step_id, ...]` field in its config. "
    "  Propose EXACTLY ONE pick of that component_type. Model every "
    "  workflow step (fetch, triage, debate, critique, synthesize, etc.) "
    "  as an entry inside the ONE pick's `config.steps` list, and list "
    "  every emitted step id in `config.outputs.assets`. Do NOT create "
    "  separate picks per verb — that produces N unrelated broken "
    "  instances instead of ONE multi-asset pipeline. This applies to "
    "  `agentic_pipeline`, `ml_pipeline`, `polars_pipeline`, "
    "  `warehouse_pipeline`, and any other entry whose `produces` "
    "  includes `multi_asset` or whose `when_to_use` mentions 'one "
    "  YAML' / 'one instance' / 'whole pipeline'.\n"
    "- CROSS-PICK COORDINATION (critical): when your plan contains "
    "  multiple picks whose configs reference each other (e.g. a "
    "  `sensor` component's `job_name` field pointing at an "
    "  `asset_job` component's `job_name`, or an `asset_job`'s "
    "  `asset_keys` field naming assets emitted by another pick), the "
    "  referenced VALUES must match VERBATIM across picks. If pick B's "
    "  `job_name` is `mir_progression_job`, then pick A's `job_name` "
    "  reference to it must also be `mir_progression_job`, not "
    "  `process_files_job` or a schema-example value. Trace every "
    "  cross-reference (job names, asset keys, sensor targets, "
    "  approval directories, run configs) and make sure both sides "
    "  agree. Sensor→job, job→asset, gate→upstream, approval_dir → "
    "  sink path — all of these are cross-pick references that need "
    "  hand-alignment.\n"
    "- EXAMPLES ARE NOT VALUES (critical): when a component's "
    "  description or agent_hints show example config values (e.g. "
    "  `data_files_sensor` / `process_files_job` / `/data/incoming` / "
    "  `[orders_raw, daily_revenue]`), those are ILLUSTRATIONS, not "
    "  defaults to paste. Every string, path, and asset-key in your "
    "  config must be derived from the USER'S TASK context, or from "
    "  another pick's names in this same plan. If the user asks for a "
    "  `mir` triage pipeline, do NOT emit `data_files_sensor` or "
    "  `orders_raw` — emit `mir_approval_monitor`, `mir_progression_job`, "
    "  `[mir_report_approval_gate]`, etc. When unsure, use a "
    "  `TODO_<field>` placeholder so the user can see what's missing "
    "  — never copy an example value that has no relationship to the "
    "  task.\n"
    "- PARTITIONING FIELDS (critical): setting `partition_key_parser` "
    "  alone does NOT enable partitioning. To make a partitioned "
    "  agentic_pipeline (or any partitioned component) actually "
    "  partition, ALL of the following must be set together in "
    "  `config`:\n"
    "    * `partition_type: dynamic` (or daily/weekly/monthly/hourly/"
    "  static/multi as appropriate)\n"
    "    * `dynamic_partition_name: <name>` when partition_type is "
    "  `dynamic` (the DynamicPartitionsDefinition name — e.g. "
    "  `mir_investigations`). Do NOT use `dynamic_partitions_def` or "
    "  `dynamic_partitions_name` — the field name is "
    "  `dynamic_partition_name` (singular).\n"
    "    * `partition_key_parser: \"<template>\"` — plain STRING "
    "  template like `{owner}/{repo}#{issue_number:int}`, NOT a dict.\n"
    "  Setting only `partition_key_parser` without partition_type + "
    "  dynamic_partition_name means the parser has no partition keys "
    "  to parse — the pipeline stays unpartitioned and "
    "  `{partition.owner}` etc. won't interpolate at runtime.\n"
    "- FIELD-SHAPE FIDELITY (critical): when a catalog entry provides "
    "  `example_yaml_snippets:` or `steps_schemas:`, treat those as the "
    "  ground truth for field names, nesting, and required sub-objects. "
    "  Copy the shape VERBATIM from the snippets — do NOT invent field "
    "  names like `tool:`, `server: <string>`, `output_format:`, or "
    "  `response_format:` when the snippet/schema shows the actual "
    "  field name (e.g. `mcp_tool_name:`, `server: {name, type, "
    "  command: [...]}` as a DICT). Every required field in "
    "  `steps_schemas` for the chosen op MUST appear in your step "
    "  config with a real value (e.g. every LLM op needs BOTH `model:` "
    "  AND `api_key_env_var:` at the step's top level, not inside "
    "  `args:`). For debate ops, every proposer AND arbitrator is a "
    "  full `{model, api_key_env_var, system_prompt}` dict — not a "
    "  bare string. For critique_loop, both `drafter:` and `critic:` "
    "  are required dicts. When a config field is a template (like "
    "  `partition_key_parser` on agentic_pipeline), emit a STRING "
    "  template like `{owner}/{repo}#{issue_number:int}`, not a "
    "  structured dict — read the field's description in "
    "  `steps_schemas` / manifest to confirm shape.\n"
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
    "\n"
    "COLUMN REFERENCES (critical):\n"
    "- Case A — upstream has a KNOWN FIXED schema (e.g. synthetic_data_generator "
    "  where the `out:` hint lists specific columns per schema_type): every "
    "  column name in your config MUST appear in that hint. Do NOT invent or "
    "  substitute. Example: synthetic_data_generator schema_type=orders emits "
    "  `total` (NOT `amount`); schema_type=transactions emits `amount`. Pick "
    "  the right one.\n"
    "- Case B — upstream has a DYNAMIC schema (file readers, database queries, "
    "  user-supplied data, or transformers passing upstream columns through): "
    "  use column names the USER explicitly mentioned in the task, OR use "
    "  `TODO_<column_name>` placeholders. Do NOT invent plausible column names "
    "  ('amount', 'value', 'total', 'price') the user never mentioned — those "
    "  will break at runtime.\n"
    "- For transformers (filter, sort, replace, summarize, etc.), remember "
    "  columns are whatever the ROOT source produces. Trace back through the "
    "  chain to find them: transformer → source. If the root source is in "
    "  Case A, use its fixed schema; if Case B, use the user's words or "
    "  TODOs.\n"
    "- Case C — upstream is ANOTHER PICK IN THIS SAME PLAN (not a materialized "
    "  asset): the downstream pick can only reference columns the upstream "
    "  pick actually produces. Compute the upstream's output set explicitly:\n"
    "    * summarize / group-by aggregators output ONLY: group_by columns + "
    "  aggregation output keys (e.g. `total_revenue` from "
    "  `aggregations.total_revenue`). Nothing else survives.\n"
    "    * projection transformers (filter, sort, dedupe, filter_columns): "
    "  output = input columns minus drops/keeps plus renames.\n"
    "    * calculated-column transformers: output = input columns + the new "
    "  computed column names.\n"
    "    * dataframe_to_csv / parquet_sink / other file sinks with a `columns` "
    "  field: those columns MUST be a subset of the upstream pick's output "
    "  set. Do NOT list `date`/`revenue`/`region` on a CSV sink whose upstream "
    "  is a summarize that only produced `customer_id` and `total_purchase`.\n"
    "  If the user's task implies a column the upstream doesn't produce, "
    "  either add an upstream pick that produces it, or drop the reference.\n"
)


def _distill_claude_md(text: str, max_chars: int = 18000) -> str:
    """Extract the sections of CLAUDE.md most useful to a component
    planner. The full doc is ~600 lines of prose covering CLI usage,
    walkthrough marketing, version pinning, etc. — only a fraction is
    load-bearing for producing a valid config.

    Match sections whose HEADER contains any of: gotcha, opt-in, ops,
    partition, agentic, rules, generating YAML, config-driven,
    approval, personas, agents, walkthrough (bulleted lists only),
    recent additions. Skip generic CLI-usage sections.
    """
    if not text:
        return ""
    # Split into (header, body) pairs. Any heading level ## / ### / ####.
    parts: list[tuple[str, str]] = []
    current_head: str | None = None
    current_body: list[str] = []
    for line in text.splitlines():
        if re.match(r"^#{2,4}\s+", line):
            if current_head is not None:
                parts.append((current_head, "\n".join(current_body)))
            current_head = line
            current_body = []
        else:
            current_body.append(line)
    if current_head is not None:
        parts.append((current_head, "\n".join(current_body)))

    keep_keywords = (
        "gotcha", "opt-in", "generating yaml", "partition", "agentic",
        "rules of thumb", "composing", "config-driven", "approval",
        "personas", "agents", "how to help", "canonical", "cheatsheet",
        "recent additions", "component categories", "validation levels",
        "field shapes", "field-shape",
    )
    skip_keywords = (
        "cli commands", "quick task",  # cheatsheet already kept below
        "where `add` installs", "after installing", "version pinning",
        "pairs with", "when to recommend",
    )

    kept: list[str] = []
    running = 0
    for header, body in parts:
        h_lower = header.lower()
        if any(k in h_lower for k in skip_keywords):
            continue
        if not any(k in h_lower for k in keep_keywords):
            continue
        chunk = f"{header}\n{body}"
        if running + len(chunk) > max_chars:
            # Truncate the tail rather than dropping the section entirely.
            remaining = max_chars - running
            if remaining > 500:
                kept.append(chunk[:remaining] + "\n[...truncated]")
            break
        kept.append(chunk)
        running += len(chunk)
    return "\n\n".join(kept)


def _build_user_prompt(
    task: str,
    catalog_lines: list[str],
    existing_assets: list[dict[str, Any]],
    previous_plan: list[dict[str, Any]] | None = None,
    refinement: str | None = None,
    claude_md: str = "",
) -> str:
    # Render existing assets with their observed schemas (when previewed at
    # least once) so the planner can reference REAL columns instead of
    # guessing. This is the primary defense against column hallucination on
    # dynamic-schema sources like file readers and SQL queries.
    def _existing_line(a: dict[str, Any]) -> str:
        name = a.get("name")
        ct = a.get("component_type") or "asset"
        base = f"- {name} ({ct})"
        cols = a.get("columns") or []
        if cols:
            dtypes = a.get("dtypes") or {}
            # Show up to 20 cols with types when known, so the LLM sees the
            # actual schema of already-materialized upstreams.
            col_strs = []
            for c in cols[:20]:
                t = dtypes.get(c)
                col_strs.append(f"{c}:{t}" if t else c)
            more = f" (+{len(cols) - 20} more)" if len(cols) > 20 else ""
            base += f"\n    columns: [{', '.join(col_strs)}]{more}"
        return base

    existing = "\n".join(_existing_line(a) for a in existing_assets[:80]) or "(none)"
    catalog = "\n".join(catalog_lines)
    parts = []
    # CLAUDE.md preamble — the community-templates authoring guide. Include
    # only the sections most relevant to producing well-shaped configs (the
    # opt-in flags block, common gotchas, agentic_pipeline op catalog, and
    # composition rules). Skip the ~half of the doc that's about CLI usage
    # / walkthrough marketing — not useful for a planner that already has
    # the manifest catalog. Cap keeps the prompt bounded even when the doc
    # grows over time.
    if claude_md:
        distilled = _distill_claude_md(claude_md)
        if distilled:
            parts.append(
                "Community-components authoring guide (excerpt — treat as ground truth for field shapes and composition rules):\n"
                + distilled
            )
    parts += [
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

    # Fetch manifest + CLAUDE.md in parallel — both have 15-min in-memory
    # caches so this is fast on subsequent calls.
    import asyncio as _asyncio
    manifest, claude_md = await _asyncio.gather(
        fetch_manifest(),
        fetch_claude_md(),
        return_exceptions=False,
    )
    components: list[dict[str, Any]] = manifest.get("components") or []
    if not components:
        raise GenieError("Manifest returned no components")

    filtered = _keyword_prefilter(components, task, cap=catalog_cap)
    lines = _catalog_lines(filtered)
    user_prompt = _build_user_prompt(
        task, lines, existing_assets or [], previous_plan=previous_plan, refinement=refinement,
        claude_md=claude_md,
    )

    async with httpx.AsyncClient(timeout=60.0) as client:
        if is_anthropic:
            # Anthropic Messages API. Docs at
            # https://docs.claude.com/en/api/messages. system_prompt goes in
            # its own top-level field; messages carry the user turn only.
            #
            # Workspace-scoped / identity-linked API keys require the
            # `anthropic-workspace-id` header — the request 400s with
            # `anthropic-workspace-id is required when authenticating with
            # an identity-linked API key` otherwise. Legacy account-scoped
            # keys don't need it, so only send when set.
            anthropic_headers = {
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            }
            workspace_id = os.getenv("ANTHROPIC_WORKSPACE_ID")
            if workspace_id:
                anthropic_headers["anthropic-workspace-id"] = workspace_id
            r = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers=anthropic_headers,
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

    def _resolve_component_id(raw: str) -> str | None:
        """The prompt asks for the bare catalog id (e.g. `synthetic_data_generator`),
        but LLMs sometimes echo the fully-qualified module path from a prior
        example (e.g. `project_foo.components.synthetic_data_generator.component.SyntheticDataGeneratorComponent`).
        Rather than skip those and give the user zero picks, extract the
        catalog id from anywhere in the dotted path."""
        if not raw:
            return None
        if raw in valid_ids:
            return raw
        # Try each dotted segment — the catalog id appears as one segment
        # of the fully-qualified path in every case we've observed.
        for seg in raw.split('.'):
            if seg in valid_ids:
                return seg
        # Fall back to snake_case of the final class name minus 'Component'.
        last = raw.rsplit('.', 1)[-1]
        if last.endswith('Component'):
            last = last[: -len('Component')]
        snake = ''
        for i, ch in enumerate(last):
            if ch.isupper() and i > 0:
                snake += '_'
            snake += ch.lower()
        if snake in valid_ids:
            return snake
        # Fuzzy near-miss: LLMs sometimes over-suffix ids that already
        # end with their kind (e.g. proposes `filesystem_monitor_sensor`
        # when the manifest id is `filesystem_monitor`, or
        # `dbt_asset_check_job_component` when the id is `dbt_asset_check_job`).
        # Iteratively strip trailing `_component`, `_sensor`, `_job`,
        # `_asset` segments; check for a valid id after each strip. The
        # iteration matters — some proposals stack suffixes
        # (`filesystem_monitor_sensor_component` needs BOTH stripped).
        trim_suffixes = ("_component", "_sensor", "_job", "_asset")
        cand = snake
        for _ in range(4):  # bounded — 4 strips is more than any real case
            stripped_this_pass = False
            for suffix in trim_suffixes:
                if cand.endswith(suffix):
                    cand = cand[: -len(suffix)]
                    stripped_this_pass = True
                    if cand in valid_ids:
                        return cand
                    break  # restart outer to re-check remaining suffixes
            if not stripped_this_pass:
                break
        # Substring fallback: pick the valid id that appears as a prefix
        # OR is a prefix OF the requested id. Only if the match is
        # substantial (>=3 shared tokens) so we don't accidentally snap
        # `csv_reader` → `csv`.
        req_toks = set(cand.split('_'))
        best_id: str | None = None
        best_overlap = 2  # require > 2
        for vid in valid_ids:
            v_toks = set(vid.split('_'))
            if not (v_toks <= req_toks or req_toks <= v_toks):
                continue
            overlap = len(v_toks & req_toks)
            if overlap > best_overlap:
                best_overlap = overlap
                best_id = vid
        return best_id

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
        action = p.get("action") or "add"
        if action in ("edit", "remove"):
            # Targets an EXISTING asset by name -- component_type isn't a
            # catalog id here (skip catalog resolution entirely), and the
            # name is SUPPOSED to collide with existing_names (skip
            # dedup/rename, which exists for "add" picks proposing a new
            # name that happens to clash).
            target_name = (p.get("asset_name") or "").strip()
            if not target_name:
                notes.append(f"⚠︎ Pick #{i + 1} ({action}) is missing an asset name — skipped.")
                continue
            if target_name not in existing_names:
                notes.append(
                    f"⚠︎ Pick #{i + 1} ({action}) references unknown existing asset "
                    f"'{target_name}' — skipped."
                )
                continue
            picks.append(
                GeniePick(
                    component_type=p.get("component_type") or "",
                    asset_name=target_name,
                    upstream_asset_names=[],
                    config=p.get("config") or {},
                    reason=p.get("reason") or "",
                    action=action,
                )
            )
            continue

        component_type = p.get("component_type") or ""
        if component_type == "noop":
            notes.append(p.get("reason") or "planner could not build from catalog")
            continue
        resolved = _resolve_component_id(component_type)
        if resolved is None:
            notes.append(
                f"⚠︎ Pick #{i + 1} references unknown component '{component_type}' — skipped."
            )
            continue
        if resolved != component_type:
            notes.append(
                f"ℹ Pick #{i + 1}: resolved '{component_type}' → '{resolved}'."
            )
        component_type = resolved

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

    # Value-type compatibility check on the assembled plan. Even if the
    # LLM followed the system-prompt rule, cheap belt-and-suspenders:
    # walk each pick, look up its `agent_hints.input_type` and the
    # `output_type` of every declared upstream, and warn if any pair
    # doesn't line up. Silent when either side has no declared type
    # (fall back to free-text hints).
    components_by_id: dict[str, dict] = {c["id"]: c for c in filtered}

    # Whole-pipeline collapse guard. If the LLM proposes multiple picks of
    # the SAME whole-pipeline component_type (one whose manifest
    # `produces` includes `multi_asset`), that's the "fragmented pipeline"
    # bug — five broken single-step AgenticPipeline instances instead of
    # one valid five-step pipeline. Fold everything into the first pick
    # so the user gets ONE plausibly-shaped pipeline plus a note, instead
    # of N unrelated broken ones. Step configs may still be individually
    # malformed (that's a per-op schema problem, not this guardrail's
    # scope), but at least the shape is right.
    if picks:
        by_type: dict[str, list[int]] = {}
        for idx, pk in enumerate(picks):
            by_type.setdefault(pk.component_type, []).append(idx)
        drop_indices: set[int] = set()
        for ctype, idxs in by_type.items():
            if len(idxs) < 2:
                continue
            comp = components_by_id.get(ctype) or {}
            produces = comp.get("produces") or []
            if "multi_asset" not in produces:
                continue
            keeper_idx = idxs[0]
            keeper = picks[keeper_idx]
            # Union all step configs into the keeper's `config.steps`
            # and populate `outputs.assets` with every step id we can
            # see — that's the field whose absence made the fragments
            # fail with `outputs.assets must list at least one step id`.
            merged_steps: list[Any] = []
            for i in idxs:
                cfg = picks[i].config or {}
                for s in (cfg.get("steps") or []):
                    merged_steps.append(s)
            step_ids = [str(s.get("id")) for s in merged_steps if isinstance(s, dict) and s.get("id")]
            new_config = dict(keeper.config or {})
            if merged_steps:
                new_config["steps"] = merged_steps
            outputs = dict(new_config.get("outputs") or {})
            if step_ids and not outputs.get("assets"):
                outputs["assets"] = step_ids
                new_config["outputs"] = outputs
            # `partition_key_parser` guardrail: the LLM repeatedly
            # hallucinates this as a structured dict (e.g. {type:
            # composite, keys: [...]}) but the schema requires a plain
            # template string like `{owner}/{repo}#{issue_number:int}`.
            # We can't guess the right template from the malformed dict
            # (would need domain knowledge of what the partition scheme
            # is), so strip it and tell the user to fill it in. It's an
            # optional field — removing lets pydantic validation pass.
            pkp = new_config.get("partition_key_parser")
            if pkp is not None and not isinstance(pkp, str):
                new_config.pop("partition_key_parser", None)
                notes.append(
                    f"⚠︎ Removed malformed `partition_key_parser` from "
                    f"'{keeper.asset_name}' (was a dict; schema requires a "
                    "template string like `{owner}/{repo}#{issue_number:int}`). "
                    "If this pipeline needs composite dynamic partitions, "
                    "add the template manually in defs.yaml."
                )

            picks[keeper_idx] = GeniePick(
                component_type=keeper.component_type,
                asset_name=keeper.asset_name,
                upstream_asset_names=keeper.upstream_asset_names,
                config=new_config,
                reason=keeper.reason,
            )
            dropped_names = [picks[i].asset_name for i in idxs[1:]]
            drop_indices.update(idxs[1:])
            notes.append(
                f"ℹ Collapsed {len(idxs)} picks of whole-pipeline component "
                f"'{ctype}' ({', '.join(dropped_names)}) into the single "
                f"pick '{keeper.asset_name}'. Multi-asset pipelines emit N "
                f"assets from ONE instance via `steps:` + `outputs.assets`."
            )
        if drop_indices:
            picks = [pk for i, pk in enumerate(picks) if i not in drop_indices]

    picks_by_name: dict[str, GeniePick] = {pk.asset_name: pk for pk in picks}
    for pk in picks:
        comp = components_by_id.get(pk.component_type) or {}
        pk_hints = comp.get("agent_hints") or {}
        want = pk_hints.get("input_type", "__missing__")
        if want == "__missing__":
            continue
        for up_name in pk.upstream_asset_names:
            up_pick = picks_by_name.get(up_name)
            if not up_pick:
                # Upstream is an existing asset we don't know the type of.
                continue
            up_comp = components_by_id.get(up_pick.component_type) or {}
            up_hints = up_comp.get("agent_hints") or {}
            provides = up_hints.get("output_type", "__missing__")
            if provides == "__missing__":
                continue
            if provides != want:
                notes.append(
                    f"⚠︎ Type mismatch: pick '{pk.asset_name}' ({pk.component_type}) "
                    f"expects input_type={want!r}, but upstream '{up_name}' "
                    f"({up_pick.component_type}) provides output_type={provides!r}."
                )

    # Cross-pick coordination repair loop. Even with the SYSTEM_PROMPT
    # rule about cross-pick references + not copying schema examples,
    # models still slip: a `filesystem_monitor` pick's `job_name` gets
    # set to `process_files_job` (a schema-example value) instead of the
    # `asset_job` pick's actual `job_name`. We detect obvious issues
    # server-side and — if any exist — do ONE targeted repair call
    # asking the model to fix the specific mismatches. Adds ~2s only
    # when needed; clean plans skip the second call entirely.
    coord_issues = _detect_coordination_issues(picks)
    if coord_issues and len(picks) >= 2:
        try:
            repaired_picks = await _repair_picks(
                original_picks=picks,
                issues=coord_issues,
                task=task,
                model=model,
                api_key=api_key,
                is_anthropic=is_anthropic,
            )
            if repaired_picks is not None:
                picks = repaired_picks
                notes.append(
                    f"ℹ Auto-repaired {len(coord_issues)} cross-pick coordination "
                    f"issue(s): " + "; ".join(coord_issues[:3])
                    + (f" (+{len(coord_issues) - 3} more)" if len(coord_issues) > 3 else "")
                )
        except Exception as e:
            # Repair is best-effort. If it fails, surface the ORIGINAL
            # detected issues so the user still sees what's wrong.
            for iss in coord_issues:
                notes.append(f"⚠︎ Coordination issue: {iss}")
            notes.append(f"⚠︎ Auto-repair failed: {type(e).__name__}: {str(e)[:120]}")

    usage = data.get("usage") or {}
    return GeniePlan(
        picks=picks,
        task=task,
        model_used=model,
        tokens_prompt=usage.get("prompt_tokens", 0),
        tokens_completion=usage.get("completion_tokens", 0),
        notes=notes,
    )


# ------------------------------------------------------------------
# Cross-pick coordination detection + repair (post-plan)
# ------------------------------------------------------------------


def _detect_coordination_issues(picks: list[GeniePick]) -> list[str]:
    """Detect obvious cross-pick coordination issues by scanning
    picks for references (job_name / asset_keys / upstream_asset_key)
    that don't match any name PROVIDED by another pick in the plan.

    We collect ProvidedNames by walking each pick's config and pulling
    every value that looks like a name-provider: top-level `job_name`,
    `sensor_name`, `asset_name`, plus expanded asset ids from
    `agentic_pipeline`'s `outputs.assets` (prefixed with
    `asset_name_prefix`). Then we look for referencing values that
    don't exist in that set. Each miss becomes one human-readable
    issue string.
    """
    provided_names: set[str] = set()
    for pk in picks:
        cfg = pk.config or {}
        ctype_low = (pk.component_type or "").lower()
        # Sensors and schedules REFERENCE `job_name` — they don't PROVIDE
        # it. If we treat their `job_name` as provided, self-references
        # short-circuit the coordination check (e.g. a sensor pointing
        # at `process_files_job` self-satisfies its own reference).
        is_ref_only = any(t in ctype_low for t in ("sensor", "monitor", "schedule"))
        for k in ("job_name", "sensor_name"):
            if is_ref_only and k == "job_name":
                continue
            v = cfg.get(k)
            if isinstance(v, str) and v:
                provided_names.add(v)
        # asset_job / agentic_pipeline provide asset keys via outputs
        prefix = cfg.get("asset_name_prefix")
        outputs = cfg.get("outputs") or {}
        step_ids = outputs.get("assets") if isinstance(outputs, dict) else None
        if isinstance(step_ids, list) and isinstance(prefix, str):
            for sid in step_ids:
                if isinstance(sid, str):
                    provided_names.add(f"{prefix}_{sid}")
        # human_approval_gate emits an asset named `<asset_name>` (or the
        # component_id fallback used by Designer).
        an = cfg.get("asset_name")
        if isinstance(an, str) and an:
            provided_names.add(an)
        # Also add the pick's own asset_name — the folder / instance name
        # that Designer will render.
        provided_names.add(pk.asset_name)

    issues: list[str] = []
    for pk in picks:
        cfg = pk.config or {}
        # job_name references (sensor's target)
        # We only flag when the pick ISN'T the one providing the job
        # (asset_job / partitioned_asset_launcher_job PROVIDE job_name;
        # sensors REFERENCE it). Heuristic: if the pick's component_type
        # contains `sensor` or `monitor`, treat `job_name` as reference.
        ctype = (pk.component_type or "").lower()
        if any(t in ctype for t in ("sensor", "monitor", "schedule")):
            jn = cfg.get("job_name")
            if isinstance(jn, str) and jn and jn not in provided_names:
                issues.append(
                    f"'{pk.asset_name}' references job_name={jn!r} but no pick "
                    f"in this plan provides a job by that name (jobs available: "
                    f"{sorted([n for n in provided_names if 'job' in n.lower()]) or 'none'})"
                )
        # asset_keys references (from asset_job, target_asset_keys from launcher)
        for field in ("asset_keys", "target_asset_keys"):
            keys = cfg.get(field)
            if isinstance(keys, list):
                for key in keys:
                    if not isinstance(key, str):
                        continue
                    if key not in provided_names:
                        issues.append(
                            f"'{pk.asset_name}' references {field}[{key!r}] but "
                            f"no pick in this plan emits an asset by that key"
                        )
                        break  # one per pick is enough for the model to notice
        # upstream_asset_key on gates / transformers
        up = cfg.get("upstream_asset_key")
        if isinstance(up, str) and up and up not in provided_names:
            issues.append(
                f"'{pk.asset_name}' references upstream_asset_key={up!r} but "
                f"no pick in this plan emits an asset by that key"
            )
    return issues


async def _repair_picks(
    original_picks: list[GeniePick],
    issues: list[str],
    task: str,
    model: str,
    api_key: str,
    is_anthropic: bool,
) -> list[GeniePick] | None:
    """One-shot repair call. Ships the current picks + the detected
    coordination issues back to the same model, asks for fixed configs.
    Returns None on any failure so the caller can fall back to just
    surfacing the issues as notes.
    """
    plan_json = json.dumps(
        [
            {
                "component_type": p.component_type,
                "asset_name": p.asset_name,
                "upstream_asset_names": p.upstream_asset_names,
                "config": p.config,
                "reason": p.reason,
            }
            for p in original_picks
        ],
        separators=(",", ":"),
    )
    repair_prompt = (
        f"Original user task:\n{task}\n\n"
        f"You produced this plan:\n{plan_json}\n\n"
        f"A server-side check found these cross-pick coordination "
        f"issues:\n" + "\n".join(f"  - {i}" for i in issues) + "\n\n"
        "Return the FULL plan (same shape: {\"picks\": [...]}) with the "
        "issues fixed. Only change values needed to resolve the "
        "references. Keep every unchanged field identical. Do not "
        "invent new picks or drop existing ones. Respond with ONLY the "
        "JSON object."
    )
    async with httpx.AsyncClient(timeout=60.0) as client:
        if is_anthropic:
            headers = {
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            }
            wid = os.getenv("ANTHROPIC_WORKSPACE_ID")
            if wid:
                headers["anthropic-workspace-id"] = wid
            r = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers=headers,
                json={
                    "model": model,
                    "max_tokens": 4096,
                    "system": "You are repairing a Dagster component plan. Respond with ONLY the corrected JSON object, no prose, no fences.",
                    "messages": [{"role": "user", "content": repair_prompt}],
                    "temperature": 0.1,
                },
            )
            if r.status_code != 200:
                return None
            data = r.json()
            blocks = data.get("content") or []
            text = next((b.get("text", "") for b in blocks if b.get("type") == "text"), "")
        else:
            r = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": "You are repairing a Dagster component plan. Respond with ONLY the corrected JSON object."},
                        {"role": "user", "content": repair_prompt},
                    ],
                    "response_format": {"type": "json_object"},
                    "temperature": 0.1,
                },
            )
            if r.status_code != 200:
                return None
            data = r.json()
            text = data.get("choices", [{}])[0].get("message", {}).get("content", "")

    text = text.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip("` \n")
    try:
        parsed = json.loads(text)
        raw = parsed.get("picks") or []
    except json.JSONDecodeError:
        return None

    # Reassemble GeniePick — keep asset_name / component_type / upstream
    # from the model's output but tolerate the same fields the original
    # had (LLM shouldn't have renamed them anyway).
    by_name = {p.asset_name: p for p in original_picks}
    out: list[GeniePick] = []
    for p in raw:
        name = p.get("asset_name") or ""
        original = by_name.get(name)
        if original is None:
            # New pick appeared? Skip it — we told the model not to
            # invent picks. Better to keep the original than to trust
            # a hallucinated addition.
            continue
        out.append(
            GeniePick(
                component_type=p.get("component_type") or original.component_type,
                asset_name=name,
                upstream_asset_names=p.get("upstream_asset_names") or original.upstream_asset_names,
                config=p.get("config") or original.config,
                reason=p.get("reason") or original.reason,
            )
        )
    # Sanity check: the repair must cover every original pick. If any
    # dropped, fall back to originals.
    if len(out) != len(original_picks):
        return None
    return out
