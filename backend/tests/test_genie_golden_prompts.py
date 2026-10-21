"""Golden-prompt checks for Genie's deterministic layers (no LLM call).

Each case is a user task plus what the catalog prefilter must surface (or must not) -- the layer that decides which
components the planner can even see, and where "context request fell back to agentic_pipeline"-style regressions start.
Add a row when a real task misroutes.
"""

import pytest

from app.services.genie_service import SYSTEM_PROMPT, _keyword_prefilter, agents_pipelines_component_ids

CATALOG = [
    {"id": "agentic_pipeline", "category": "ai", "tags": [], "name": "Agentic Pipeline", "description": "Multi-step LLM agents: route, debate, synthesize."},
    {"id": "context_engineering_pipeline", "category": "ai", "tags": [], "name": "Context Engineering Pipeline",
     "description": "Chunk, classify, embed and index raw text into a governed knowledge base."},
    {"id": "rag_pipeline", "category": "ai", "tags": ["ai", "rag", "pipeline"], "name": "RAG Pipeline", "description": "Retrieve, rerank and answer from a vector store."},
    {"id": "context_receipt_store", "category": "resource", "tags": ["resource", "context", "receipts"], "name": "Context Receipt Store", "description": "Records retrievals."},
    {"id": "dataframe_transformer", "category": "transformation", "tags": ["dataframe"], "name": "DataFrame Transformer", "description": "Pandas transforms."},
    {"id": "dataframe_from_csv", "category": "source", "tags": ["source", "csv"], "name": "CSV Source", "description": "Read a CSV."},
]


def _surfaced(task):
    picked, _priority, _schema = _keyword_prefilter(CATALOG, task)
    return {c["id"] for c in picked}


@pytest.mark.parametrize("task", [
    "build a knowledge base from our support tickets",
    "chunk and embed our product docs for retrieval",
    "context engineering for the contracts folder",
    "index call transcripts into a vector store",
])
def test_knowledge_base_requests_surface_the_build_component(task):
    assert "context_engineering_pipeline" in _surfaced(task)


@pytest.mark.parametrize("task", [
    "sum revenue by game",
    "dedupe orders by id",
])
def test_plain_data_tasks_do_not_pay_for_the_ai_category(task):
    assert not {"context_engineering_pipeline", "rag_pipeline", "agentic_pipeline"} & _surfaced(task)


def test_the_receipt_store_resource_is_never_offered_to_the_planner():
    assert "context_receipt_store" not in _surfaced("track retrieval receipts for my knowledge base")


def test_the_agent_builder_can_plan_a_knowledge_base_for_an_agent():
    assert {"context_engineering_pipeline", "rag_pipeline", "agentic_pipeline"} <= agents_pipelines_component_ids(CATALOG)


def test_planner_prompt_routes_knowledge_bases_to_the_build_component():
    assert "context_engineering_pipeline" in SYSTEM_PROMPT
    assert "context_receipts" in SYSTEM_PROMPT
