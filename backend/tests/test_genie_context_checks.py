"""_context_pipeline_issues: fixable problems in knowledge-base builds."""

from app.services.genie_service import GeniePick, _context_pipeline_issues


def _kb(config, name="kb", action="add"):
    return GeniePick(component_type="context_engineering_pipeline", asset_name=name, upstream_asset_names=[], config=config, reason="", action=action)


def _good():
    return {"steps": [
        {"id": "c", "op": "chunk"},
        {"id": "e", "op": "embed", "provider": "sentence_transformers", "model": "m"},
        {"id": "w", "op": "write_vector_store", "provider": "chromadb"},
    ]}


def test_a_clean_python_build_has_no_issues():
    assert _context_pipeline_issues([_kb(_good())]) == []


def test_other_components_are_ignored():
    p = GeniePick(component_type="agentic_pipeline", asset_name="x", upstream_asset_names=[], config={"steps": [{"op": "embed"}]}, reason="")
    assert _context_pipeline_issues([p]) == []


def test_chunk_must_come_first():
    cfg = _good()
    cfg["steps"].reverse()
    assert any("first step must be `chunk`" in i for i in _context_pipeline_issues([_kb(cfg)]))


def test_unknown_op_is_reported():
    cfg = _good()
    cfg["steps"].insert(1, {"id": "x", "op": "summarize"})
    assert any("unknown op `summarize`" in i for i in _context_pipeline_issues([_kb(cfg)]))


def test_python_mode_needs_a_write_step():
    cfg = _good()
    cfg["steps"].pop()
    assert any("write_vector_store" in i for i in _context_pipeline_issues([_kb(cfg)]))


def test_sql_mode_rejects_python_only_ops_and_needs_output_table():
    cfg = {"execution_mode": "sql", "steps": [{"id": "c", "op": "chunk"}, {"id": "d", "op": "dedupe"}, {"id": "w", "op": "write_vector_store"}]}
    issues = _context_pipeline_issues([_kb(cfg)])
    assert sum("needs python mode" in i for i in issues) == 2
    assert any("`output_table` is required" in i for i in issues)


def test_sql_mode_does_not_ask_for_a_write_step_and_accepts_a_valid_build():
    cfg = {"execution_mode": "sql", "output_table": "p.d.t", "steps": [{"id": "c", "op": "chunk"}, {"id": "e", "op": "embed", "model": "m"}]}
    assert _context_pipeline_issues([_kb(cfg)]) == []


def test_custom_classifier_is_python_only():
    cfg = {"execution_mode": "sql", "output_table": "t", "steps": [{"id": "c", "op": "chunk"}, {"id": "k", "op": "classify", "mode": "custom", "fn": "a:b"}]}
    assert any("python-only" in i for i in _context_pipeline_issues([_kb(cfg)]))


def test_llm_steps_need_a_model():
    cfg = _good()
    cfg["steps"][1:1] = [{"id": "en", "op": "enrich", "mode": "summary"}, {"id": "cl", "op": "classify", "mode": "llm", "model": "TODO_model"}]
    issues = _context_pipeline_issues([_kb(cfg)])
    assert any("enrich step 'en'" in i for i in issues)
    assert any("classify step 'cl'" in i for i in issues)


def test_keyed_embedders_need_an_api_key_var_but_local_ones_do_not():
    cfg = _good()
    cfg["steps"][1] = {"id": "e", "op": "embed", "provider": "openai", "model": "text-embedding-3-small"}
    assert any("api_key_env_var" in i for i in _context_pipeline_issues([_kb(cfg)]))
    cfg["steps"][1]["api_key_env_var"] = "OPENAI_API_KEY"
    assert _context_pipeline_issues([_kb(cfg)]) == []


def test_receipts_in_python_mode_need_a_resource_key():
    cfg = _good()
    cfg["receipts"] = {"window_days": 30}
    assert any("resource_key" in i for i in _context_pipeline_issues([_kb(cfg)]))
    cfg["receipts"]["resource_key"] = "context_receipts"
    assert _context_pipeline_issues([_kb(cfg)]) == []


def test_removed_picks_are_skipped():
    assert _context_pipeline_issues([_kb({"steps": [{"op": "embed"}]}, action="remove")]) == []
