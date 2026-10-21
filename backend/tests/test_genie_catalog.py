"""genie_catalog: manifest-declared builder membership, check flags and resource requirements."""

from app.services import genie_catalog as cat
from app.services.genie_service import (
    GeniePick,
    _SCOPE_COMPONENT_ID_RESOLVERS,
    _model_provider_gap,
    _per_row_partition_misuse,
    agents_pipelines_component_ids,
)


def _c(id_, category="ai", **extra):
    return {"id": id_, "category": category, "tags": [], **extra}


def _pick(component_type, config, name="a", action="add"):
    return GeniePick(component_type=component_type, asset_name=name, upstream_asset_names=[], config=config, reason="", action=action)


class TestBuilderPools:
    def test_manifest_declared_builder_adds_a_brand_new_component(self):
        comps = [_c("shiny_new_agentish_thing", builders=["agents_pipelines"]), _c("other")]
        assert "shiny_new_agentish_thing" in agents_pipelines_component_ids(comps)
        assert "other" not in agents_pipelines_component_ids(comps)

    def test_defaults_apply_when_the_manifest_declares_nothing(self):
        comps = [_c("context_engineering_pipeline"), _c("rag_pipeline"), _c("agentic_pipeline")]
        assert cat.builder_pool_ids(comps, cat.BUILDER_RAG) == {"context_engineering_pipeline", "rag_pipeline"}

    def test_rag_pool_picks_up_rag_tagged_ai_components(self):
        comps = [_c("pgvector_search", tags=["vector"]), _c("sensor_x", category="sensor", tags=["vector"])]
        assert cat.builder_pool_ids(comps, cat.BUILDER_RAG) == {"pgvector_search"}

    def test_defaults_are_ignored_for_ids_not_in_the_manifest(self):
        assert cat.builder_pool_ids([_c("something_else")], cat.BUILDER_RAG) == set()

    def test_rag_is_a_registered_scope(self):
        comps = [_c("rag_pipeline"), _c("context_engineering_pipeline")]
        assert _SCOPE_COMPONENT_ID_RESOLVERS["rag"](comps) == {"rag_pipeline", "context_engineering_pipeline"}

    def test_unknown_builder_is_empty(self):
        assert cat.builder_pool_ids([_c("x", builders=["agents_pipelines"])], "nope") == set()


class TestCheckFlags:
    def test_defaults_cover_the_agentic_family_and_the_context_pipeline(self):
        checks = cat.pipeline_checks_by_type([])
        assert cat.CHECK_PER_ROW_MISUSE in checks["agentic_pipeline"]
        assert checks["context_engineering_pipeline"] == {cat.CHECK_CONTEXT_PIPELINE}

    def test_manifest_genie_checks_override_defaults_and_add_new_components(self):
        checks = cat.pipeline_checks_by_type([
            _c("agentic_pipeline", genie_checks=[]),
            _c("my_new_pipeline", genie_checks=["model_provider"]),
        ])
        assert checks["agentic_pipeline"] == frozenset()
        assert checks["my_new_pipeline"] == {cat.CHECK_MODEL_PROVIDER}

    def test_context_pipeline_is_not_subject_to_the_agentic_only_checks(self):
        # chunk/classify/embed is a perfectly good LINEAR chain of non-"whole pipeline" ops, and local embedders carry a
        # `model` with no api_key_env_var -- both would be hard-blocked if this were in the agentic family.
        cfg = {"steps": [
            {"id": "c", "op": "chunk"},
            {"id": "e", "op": "embed", "provider": "sentence_transformers", "model": "all-MiniLM-L6-v2"},
            {"id": "w", "op": "write_vector_store", "provider": "chromadb"},
        ]}
        picks = [_pick("context_engineering_pipeline", cfg)]
        assert _per_row_partition_misuse(picks) is False
        assert _model_provider_gap(picks) is False

    def test_a_manifest_flag_can_opt_a_new_component_into_the_model_check(self):
        checks = cat.pipeline_checks_by_type([_c("my_new_pipeline", genie_checks=["model_provider"])])
        picks = [_pick("my_new_pipeline", {"steps": [{"id": "s", "op": "llm_call"}]})]
        assert _model_provider_gap(picks) is False  # not in the defaults
        assert _model_provider_gap(picks, checks) is True


class TestRequiredResources:
    def test_receipts_resource_key_becomes_a_requirement(self):
        picks = [_pick("context_engineering_pipeline", {"receipts": {"resource_key": "context_receipts"}}, name="kb")]
        assert cat.required_resources(picks) == [{
            "component_id": "context_receipt_store", "resource_key": "context_receipts",
            "reason": "reads retrieval receipts back into every rebuild", "needed_by": "kb",
        }]

    def test_two_picks_sharing_a_key_are_listed_once(self):
        picks = [
            _pick("context_engineering_pipeline", {"receipts": {"resource_key": "r"}}, name="kb"),
            _pick("rag_pipeline", {"receipts": {"resource_key": "r"}}, name="qa"),
        ]
        assert len(cat.required_resources(picks)) == 1

    def test_missing_todo_and_removed_picks_are_skipped(self):
        picks = [
            _pick("rag_pipeline", {}, name="a"),
            _pick("rag_pipeline", {"receipts": {"resource_key": "TODO_key"}}, name="b"),
            _pick("rag_pipeline", {"receipts": {"resource_key": "r"}}, name="c", action="remove"),
            _pick("agentic_pipeline", {"receipts": {"resource_key": "r"}}, name="d"),
        ]
        assert cat.required_resources(picks) == []

    def test_manifest_requires_resources_extend_the_defaults(self):
        comps = [_c("my_component", requires_resources=[{"component_id": "my_store", "config_path": "store.key"}])]
        picks = [_pick("my_component", {"store": {"key": "s1"}}, name="x")]
        assert [r["component_id"] for r in cat.required_resources(picks, comps)] == ["my_store"]
