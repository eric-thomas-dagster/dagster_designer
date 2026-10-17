from app.services.asset_references import apply_cascade, find_references


def _w(p, text):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    return p


def _project(tmp_path):
    d = tmp_path / "defs"
    _w(d / "raw_customers" / "defs.yaml", "type: pkg.SyntheticDataGeneratorComponent\nattributes:\n  asset_name: raw_customers\n")
    _w(d / "customer_master_schedule" / "defs.yaml", "type: pkg.CronScheduleComponent\nattributes:\n  schedule_name: s\n  asset_keys:\n    - raw_customers\n  job_name: customer_master_job\n")
    _w(d / "multi_schedule" / "defs.yaml", "type: pkg.CronScheduleComponent\nattributes:\n  asset_keys:\n    - raw_customers   # keep comment\n    - raw_orders\n")
    _w(d / "raw_customers_check" / "defs.yaml", "type: pkg.EnhancedDataQualityChecks\nattributes:\n  asset_key: raw_customers\n  checks: []\n")
    _w(d / "with_domain" / "defs.yaml", "type: pkg.DataFrameTransformerComponent\nattributes:\n  asset_name: with_domain\n  upstream_asset_key: raw_customers\n")
    _w(d / "unrelated" / "defs.yaml", "type: pkg.X\nattributes:\n  table: raw_customers\n")
    return d


def test_find_references_reports_lists_and_scalars_and_ignores_other_fields(tmp_path):
    d = _project(tmp_path)
    refs = {r.component: r for r in find_references(d, "raw_customers", skip_dir=d / "raw_customers")}
    assert set(refs) == {"customer_master_schedule", "multi_schedule", "raw_customers_check", "with_domain"}
    assert refs["customer_master_schedule"].list_fields == ["asset_keys"] and not refs["customer_master_schedule"].scalar_fields
    assert refs["raw_customers_check"].scalar_fields == ["asset_key"] and refs["raw_customers_check"].is_automation
    assert not refs["with_domain"].is_automation


def test_cascade_fixes_automation_removes_only_what_is_pointless_and_never_touches_downstream_assets(tmp_path):
    d = _project(tmp_path)
    out = apply_cascade(d, "raw_customers", skip_dir=d / "raw_customers")
    assert sorted(out["removed"]) == ["customer_master_schedule", "raw_customers_check"]   # only target was the deleted asset
    assert out["edited"] == ["multi_schedule"] and out["left"] == ["with_domain"]
    assert not (d / "customer_master_schedule").exists() and not (d / "raw_customers_check").exists()
    multi = (d / "multi_schedule" / "defs.yaml").read_text()
    assert "raw_orders" in multi and "raw_customers" not in multi
    assert "upstream_asset_key: raw_customers" in (d / "with_domain" / "defs.yaml").read_text()   # reported, not rewritten
    assert (d / "unrelated" / "defs.yaml").exists()


def test_references_say_what_will_happen_to_each_component(tmp_path):
    d = _project(tmp_path)
    by = {r.component: r.removed_with_asset for r in find_references(d, "raw_customers", skip_dir=d / "raw_customers")}
    assert by == {"customer_master_schedule": True, "raw_customers_check": True, "multi_schedule": False, "with_domain": False}
