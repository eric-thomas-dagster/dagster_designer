from app.services.component_type_resolver import PREFIX, load_registry, resolve_component_type

REGISTRY = '''
_CLASS_PATHS = {
    "DataFrameTransformerComponent": "assets/transforms/dataframe_transformer/component.py",
    "SFTPToDatabaseAssetComponent": "assets/ingestion/sftp_to_database_asset/component.py",
    "DataframeExtractFieldComponent": "assets/transforms/dataframe_extract_field/component.py",
}
'''


def _project(tmp_path):
    pkg = tmp_path / ".venv/lib/python3.12/site-packages/dagster_community_components"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text(REGISTRY)
    return tmp_path


def test_wrong_casing_from_the_cli_is_corrected_by_component_id(tmp_path):
    p = _project(tmp_path)
    assert resolve_component_type(p, "dataframe_transformer", PREFIX + "DataframeTransformerComponent") == PREFIX + "DataFrameTransformerComponent"
    assert resolve_component_type(p, "sftp_to_database_asset", PREFIX + "SftpToDatabaseAssetComponent") == PREFIX + "SFTPToDatabaseAssetComponent"


def test_a_correct_type_and_foreign_types_are_left_alone(tmp_path):
    p = _project(tmp_path)
    assert resolve_component_type(p, "dataframe_extract_field", PREFIX + "DataframeExtractFieldComponent") == PREFIX + "DataframeExtractFieldComponent"
    assert resolve_component_type(p, "x", "dagster_dbt.DbtProjectComponent") == "dagster_dbt.DbtProjectComponent"
    assert resolve_component_type(p, "unknown_id", PREFIX + "NopeComponent") == PREFIX + "NopeComponent"


def test_no_installed_package_means_no_change(tmp_path):
    assert load_registry(tmp_path) == {}
    assert resolve_component_type(tmp_path, "dataframe_transformer", PREFIX + "DataframeTransformerComponent") == PREFIX + "DataframeTransformerComponent"


def test_package_requirements_are_found_for_a_package_mode_install(tmp_path):
    from app.api.templates_registry import package_requirements_path
    assert package_requirements_path(tmp_path, "agentic_pipeline") is None
    d = tmp_path / ".venv/lib/python3.12/site-packages/dagster_community_components/assets/ai/agentic_pipeline"
    d.mkdir(parents=True)
    (d / "requirements.txt").write_text("litellm>=1.30.0\nmcp>=1.0.0\n")
    assert package_requirements_path(tmp_path, "agentic_pipeline") == d / "requirements.txt"
    assert package_requirements_path(tmp_path, "nope") is None
