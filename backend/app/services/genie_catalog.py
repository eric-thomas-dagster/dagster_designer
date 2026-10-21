"""Which components each Genie flow can plan with, and which deterministic checks apply to them.

This used to live as hard-coded id sets scattered through genie_service.py, which meant a new component was invisible to a
builder until someone edited Python (that is how ``context_engineering_pipeline`` went missing from the Agent Builder).
The manifest can now declare it, and the sets below are only the defaults used when it doesn't:

* ``builders``: list of builder ids (``agents_pipelines``, ``rag``) whose scoped pool should include the component.
* ``genie_checks``: list of deterministic checks to run on picks of this component. Known values:
  ``model_provider`` (every step that names a model needs ``model`` + ``api_key_env_var``),
  ``per_row_misuse`` (reject a linear chain of per-row ops forced into a whole-pipeline component) and
  ``context_pipeline`` (op ordering / execution-mode / model rules for knowledge-base builds).
* ``requires_resources``: list of ``{component_id, config_path, reason}``. When the pick's config has a value at
  ``config_path`` (dotted, e.g. ``receipts.resource_key``), that value names a resource the plan needs installed.
"""

from __future__ import annotations

from typing import Any, Iterable

BUILDER_AGENTS_PIPELINES = "agents_pipelines"
BUILDER_RAG = "rag"

CHECK_MODEL_PROVIDER = "model_provider"
CHECK_PER_ROW_MISUSE = "per_row_misuse"
CHECK_CONTEXT_PIPELINE = "context_pipeline"

# Always part of the Agent Builder's pool: the whole-pipeline component, the per-row LLM components its prompt tells it
# to reach for, and the knowledge-base build + query pair an agent retrieves from.
DEFAULT_AGENT_BUILDER_IDS = frozenset({
    "agentic_pipeline", "litellm_inference_asset", "openai_llm", "openrouter_llm",
    "context_engineering_pipeline", "rag_pipeline",
})

# The RAG & Vector Search bin: building a knowledge base and querying it back.
DEFAULT_RAG_BUILDER_IDS = frozenset({"context_engineering_pipeline", "rag_pipeline"})
_RAG_TAGS = {"rag", "vector", "vector-store", "embedding", "embeddings", "retrieval"}

# Pipeline components with deterministic checks. Anything not listed here (and not declaring `genie_checks`) gets none.
DEFAULT_PIPELINE_CHECKS: dict[str, frozenset[str]] = {
    "agentic_pipeline": frozenset({CHECK_MODEL_PROVIDER, CHECK_PER_ROW_MISUSE}),
    "ml_pipeline": frozenset({CHECK_MODEL_PROVIDER, CHECK_PER_ROW_MISUSE}),
    "polars_pipeline": frozenset({CHECK_MODEL_PROVIDER, CHECK_PER_ROW_MISUSE}),
    "warehouse_pipeline": frozenset({CHECK_MODEL_PROVIDER, CHECK_PER_ROW_MISUSE}),
    "context_engineering_pipeline": frozenset({CHECK_CONTEXT_PIPELINE}),
}

# Resource a pick needs when a given config path is set. rag_pipeline and context_engineering_pipeline both read/write
# receipts through the same store resource.
DEFAULT_REQUIRED_RESOURCES: dict[str, tuple[dict[str, str], ...]] = {
    "context_engineering_pipeline": (
        {"component_id": "context_receipt_store", "config_path": "receipts.resource_key",
         "reason": "reads retrieval receipts back into every rebuild"},
    ),
    "rag_pipeline": (
        {"component_id": "context_receipt_store", "config_path": "receipts.resource_key",
         "reason": "records every retrieval so the knowledge base can learn from real use"},
    ),
}


def declared_builders(component: dict[str, Any]) -> set[str]:
    raw = component.get("builders")
    return {b for b in raw if isinstance(b, str)} if isinstance(raw, list) else set()


def builder_pool_ids(components: Iterable[dict[str, Any]], builder: str) -> set[str]:
    """Ids the manifest (or the defaults) assign to ``builder`` -- only ids that exist in ``components``."""
    comps = [c for c in components if c.get("id")]
    present = {c["id"] for c in comps}
    defaults = {
        BUILDER_AGENTS_PIPELINES: DEFAULT_AGENT_BUILDER_IDS,
        BUILDER_RAG: DEFAULT_RAG_BUILDER_IDS,
    }.get(builder, frozenset())
    ids = {c["id"] for c in comps if builder in declared_builders(c)}
    ids |= set(defaults) & present
    if builder == BUILDER_RAG:
        ids |= {c["id"] for c in comps if c.get("category") == "ai" and _RAG_TAGS & set(c.get("tags") or [])}
    return ids


def pipeline_checks_by_type(components: Iterable[dict[str, Any]] | None = None) -> dict[str, frozenset[str]]:
    """Checks per component id: manifest ``genie_checks`` wins over the defaults."""
    out = dict(DEFAULT_PIPELINE_CHECKS)
    for c in components or []:
        declared = c.get("genie_checks")
        if c.get("id") and isinstance(declared, list):
            out[c["id"]] = frozenset(x for x in declared if isinstance(x, str))
    return out


def _dig(config: Any, dotted: str) -> Any:
    node = config
    for part in dotted.split("."):
        if not isinstance(node, dict):
            return None
        node = node.get(part)
    return node


def required_resources(
    picks: Iterable[Any], components: Iterable[dict[str, Any]] | None = None
) -> list[dict[str, str]]:
    """Resources the picked configs refer to, de-duplicated: ``[{component_id, resource_key, reason, needed_by}]``.

    ``picks`` are objects with ``component_type``, ``asset_name``, ``config`` and ``action`` (GeniePick).
    """
    rules = dict(DEFAULT_REQUIRED_RESOURCES)
    for c in components or []:
        declared = c.get("requires_resources")
        if c.get("id") and isinstance(declared, list):
            rules[c["id"]] = tuple(r for r in declared if isinstance(r, dict) and r.get("component_id") and r.get("config_path"))
    found: dict[tuple[str, str], dict[str, str]] = {}
    for p in picks:
        if getattr(p, "action", "add") == "remove":
            continue
        for rule in rules.get(p.component_type, ()):
            key = _dig(p.config or {}, rule["config_path"])
            if not isinstance(key, str) or not key.strip() or key.upper().startswith("TODO"):
                continue
            found.setdefault((rule["component_id"], key.strip()), {
                "component_id": rule["component_id"],
                "resource_key": key.strip(),
                "reason": rule.get("reason", ""),
                "needed_by": p.asset_name,
            })
    return list(found.values())
