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
        # rag_pipeline and huggingface_pipeline are real "pipeline"
        # components but not agents -- rag_pipeline belongs to the
        # separate RAG & Vector Search bin, huggingface_pipeline is a
        # plain inference pipeline.
        comps = [
            _component("rag_pipeline", tags=["ai", "rag", "pipeline"]),
            _component("huggingface_pipeline", tags=["ai", "huggingface", "transformers"]),
        ]
        assert agents_pipelines_component_ids(comps) == set()

    def test_non_ai_category_is_excluded_even_with_agent_tag(self):
        comps = [_component("some_sensor", category="sensor", tags=["agent"])]
        assert agents_pipelines_component_ids(comps) == set()

    def test_empty_catalog_returns_empty_set(self):
        assert agents_pipelines_component_ids([]) == set()
