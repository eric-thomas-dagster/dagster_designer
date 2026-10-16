from app.api.projects import _find_dbt_projects


def test_staged_copy_under_local_defs_state_is_not_listed(tmp_path):
    real = tmp_path / "dbt" / "shop"
    staged = tmp_path / "src" / "m" / "defs" / ".local_defs_state" / "DbtProjectComponent__shop__" / "project"
    for d in (real, staged):
        d.mkdir(parents=True)
        (d / "dbt_project.yml").write_text("name: shop\nversion: '1'\n")
    found = _find_dbt_projects(tmp_path)
    assert [f.relative_path for f in found] == ["dbt/shop"]
