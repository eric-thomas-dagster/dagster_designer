import json
from pathlib import Path
from unittest.mock import patch

from app.services import component_dependencies as cd

REGISTRY = '''
_CLASS_PATHS = {
    "AgenticPipelineComponent": "assets/ai/agentic_pipeline/component.py",
    "OpenAIAgentComponent": "assets/ai/openai_agent/component.py",
    "DataFrameTransformerComponent": "assets/transforms/dataframe_transformer/component.py",
}
'''


def _project(tmp_path):
    pkg = tmp_path / ".venv/lib/python3.12/site-packages/dagster_community_components"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text(REGISTRY)
    for cid, cat, reqs in [("agentic_pipeline", "ai", "# comment\nlitellm>=1.30.0\nmcp>=1.0.0\n"), ("openai_agent", "ai", "openai>=1.0\n"),
                           ("dataframe_transformer", "transforms", "")]:
        d = pkg / "assets" / cat / cid
        d.mkdir(parents=True)
        (d / "requirements.txt").write_text(reqs)
    return tmp_path


def _use(p, folder, cls):
    f = p / "src/mod/defs" / folder / "defs.yaml"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(f"type: dagster_community_components.{cls}\nattributes:\n  asset_name: {folder}\n")


def test_requirements_come_from_the_installed_package_and_skip_comments(tmp_path):
    p = _project(tmp_path)
    assert cd.requirements_for_component(p, "agentic_pipeline") == ["litellm>=1.30.0", "mcp>=1.0.0"]
    assert cd.requirements_for_component(p, "dataframe_transformer") == []
    assert cd.requirements_for_component(p, "unknown") == []


def test_used_component_ids_resolve_class_names_through_the_registry(tmp_path):
    p = _project(tmp_path)
    _use(p, "pr_review", "AgenticPipelineComponent")
    _use(p, "a", "OpenAIAgentComponent")
    _use(p, "b", "OpenAIAgentComponent")
    (p / "src/mod/defs/other").mkdir(parents=True)
    (p / "src/mod/defs/other/defs.yaml").write_text("type: dagster_dbt.DbtProjectComponent\n")
    assert cd.used_component_ids(p) == {"agentic_pipeline", "openai_agent"}


def test_only_missing_requirements_are_installed(tmp_path):
    p = _project(tmp_path)
    with patch.object(cd, "missing_requirements", lambda proj, reqs: [r for r in reqs if r.startswith("mcp")]) as _m, \
         patch.object(cd, "install_requirements", lambda proj, reqs, timeout=900: (True, "")) as _i:
        out = cd.ensure_dependencies(p, {"agentic_pipeline"})
    assert out == {"checked": ["agentic_pipeline"], "installed": ["mcp>=1.0.0"], "failed": None}


def test_nothing_is_installed_when_everything_is_present_and_failures_are_reported(tmp_path):
    p = _project(tmp_path)
    calls = []
    with patch.object(cd, "missing_requirements", lambda proj, reqs: []), \
         patch.object(cd, "install_requirements", lambda *a, **k: calls.append(1) or (True, "")):
        assert cd.ensure_dependencies(p, {"agentic_pipeline"})["installed"] == []
    assert calls == []
    with patch.object(cd, "missing_requirements", lambda proj, reqs: list(reqs)), \
         patch.object(cd, "install_requirements", lambda *a, **k: (False, "no network")):
        out = cd.ensure_dependencies(p, {"openai_agent"})
    assert out["installed"] == [] and out["failed"] == "no network"


def test_missing_requirements_in_a_real_venv_python(tmp_path):
    """The check really runs in the project's interpreter: use this test env's python as a stand-in 'project venv'."""
    import sys
    (tmp_path / ".venv").symlink_to(Path(sys.prefix))      # this test env stands in for a project venv
    got = cd.missing_requirements(tmp_path, ["pytest>=1", "definitely-not-installed-xyz>=1", "pytest<0.0001", "colorama; sys_platform=='nonexistent'"])
    assert got == ["definitely-not-installed-xyz>=1", "pytest<0.0001"]
