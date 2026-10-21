"""Regression tests for Genie's catalog-scoping helpers."""

from app.services.genie_service import agents_pipelines_component_ids


def _component(id_, category="ai", tags=None):
    return {"id": id_, "category": category, "tags": tags or []}


class TestAgentsPipelinesComponentIds:
    def test_exact_agent_tag_is_included(self):
        comps = [_component("anthropic_agent", tags=["ai", "llm", "agent", "agentic"])]
        assert agents_pipelines_component_ids(comps) == {"anthropic_agent"}

    def test_multi_agent_tag_is_included(self):
        comps = [_component("agentic_pipeline", tags=["ai", "agent", "multi-agent"])]
        assert "agentic_pipeline" in agents_pipelines_component_ids(comps)

    def test_id_ending_in_agent_is_included_even_without_the_tag(self):
        # Real manifest gap: vanta_evidence_response_agent has no "agent"
        # tag despite its name.
        comps = [_component("vanta_evidence_response_agent", tags=["ai", "llm", "compliance"])]
        assert agents_pipelines_component_ids(comps) == {"vanta_evidence_response_agent"}

    def test_loose_agentic_tag_alone_is_not_enough(self):
        # The real bug this function exists to avoid: "agentic" is applied
        # broadly (LLM providers, classifiers, HITL gates, evaluators) as
        # a loose "works well in agent workflows" hint, not a real signal
        # that the component itself IS an agent.
        comps = [
            _component("groq_llm", tags=["ai", "llm", "groq", "agentic"]),
            _component("text_classifier", tags=["ai", "text", "classifier", "agentic"]),
            _component("human_approval_gate", tags=["ai", "human-in-the-loop", "agentic"]),
            _component("llm_evaluator", tags=["ai", "llm", "evaluation", "agentic"]),
        ]
        assert agents_pipelines_component_ids(comps) == set()

    def test_pipeline_id_suffix_alone_is_not_enough(self):
        # huggingface_pipeline is a plain inference pipeline, not an agent. (rag_pipeline and
        # context_engineering_pipeline ARE offered, but by explicit default -- see TestKnowledgeBasePair -- not by suffix.)
        comps = [_component("huggingface_pipeline", tags=["ai", "huggingface", "transformers"])]
        assert agents_pipelines_component_ids(comps) == set()

    def test_non_ai_category_is_excluded_even_with_agent_tag(self):
        comps = [_component("some_sensor", category="sensor", tags=["agent"])]
        assert agents_pipelines_component_ids(comps) == set()

    def test_empty_catalog_returns_empty_set(self):
        assert agents_pipelines_component_ids([]) == set()

    def test_quick_file_and_database_sources_are_included_when_present(self):
        # Most tasks answer "where's the data coming from" with a category
        # (file/database), not a specific existing asset -- confirmed live
        # as the dominant case. Without these in the pool, the LLM has no
        # component available to actually build that source, so the
        # BUILDING A NEW FILE OR DATABASE SOURCE SYSTEM_PROMPT rule would
        # have nothing to work with.
        comps = [
            _component("agentic_pipeline", tags=["ai", "agent", "multi-agent"]),
            _component("dataframe_from_csv", category="source", tags=["source", "dataframe", "from", "csv"]),
            _component("dataframe_from_sql", category="source", tags=["source", "dataframe", "from", "sql"]),
            _component("database_query", category="source", tags=["source", "database", "query"]),
        ]
        result = agents_pipelines_component_ids(comps)
        assert result == {"agentic_pipeline", "dataframe_from_csv", "dataframe_from_sql", "database_query"}

    def test_other_source_category_components_are_not_swept_in(self):
        # Only the three curated quick-source ids -- not every "source"
        # category component (that would reopen the whole ~700-component
        # catalog this scope exists to avoid).
        comps = [_component("mongodb_reader", category="source", tags=["source", "mongodb", "reader"])]
        assert agents_pipelines_component_ids(comps) == set()


class TestAgenticPipelineAlwaysInThePool:
    def test_included_even_with_the_real_manifests_empty_tags(self):
        # The real manifest gives agentic_pipeline tags=[] and an id with no `_agent` suffix -- it used to be silently
        # left out of the Agent Builder's pool, so the planner split reviewers into separate agents instead.
        comps = [_component("agentic_pipeline", category="ai", tags=[]), _component("huggingface_pipeline", category="ai", tags=["hf"])]
        assert agents_pipelines_component_ids(comps) == {"agentic_pipeline"}

    def test_per_row_llm_components_the_prompt_recommends_are_available(self):
        comps = [_component(i, category="ai") for i in ("litellm_inference_asset", "openai_llm", "openrouter_llm", "groq_llm")]
        assert agents_pipelines_component_ids(comps) == {"litellm_inference_asset", "openai_llm", "openrouter_llm"}


class TestKnowledgeBasePair:
    def test_build_and_query_components_are_in_the_agent_pool_with_empty_tags(self):
        comps = [_component("context_engineering_pipeline", tags=[]), _component("rag_pipeline", tags=["rag"])]
        assert agents_pipelines_component_ids(comps) == {"context_engineering_pipeline", "rag_pipeline"}

    def test_receipt_store_resource_is_never_pooled(self):
        comps = [_component("context_receipt_store", category="resource", tags=["resource", "context", "ai"])]
        assert agents_pipelines_component_ids(comps) == set()
