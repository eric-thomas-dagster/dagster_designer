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


# --- dangling references: root post_processing, key-maps, dependency-graph edges, and healing from a load error ---

def _messy(tmp_path):
    d = _project(tmp_path)
    _w(d / "defs.yaml", """type: dagster.DefsFolderComponent
post_processing:
  assets:
  - target: key:pr_review_security_review
    attributes:
      deps:
      - pr_review_fetch_pr_diff
  - target: key:pr_review_fetch_pr_diff
    attributes:
      group_name: x
  - target: key:stg_orders
    attributes:
      deps:
      - raw_orders
      - pr_review_fetch_pr_diff
""")
    _w(d / "checks" / "defs.yaml", "type: pkg.EnhancedDataQualityChecks\nattributes:\n  assets:\n    pr_review_fetch_pr_diff:\n      null_check: []\n")
    _w(d / "graph" / "defs.yaml", "type: pkg.DependencyGraphComponent\nattributes:\n  edges:\n  - {source: pr_review_fetch_pr_diff, target: a}\n  - {source: b, target: c}\n")
    return d


def test_find_references_sees_root_post_processing_key_maps_and_graph_edges(tmp_path):
    d = _messy(tmp_path)
    refs = {r.component: r for r in find_references(d, "pr_review_fetch_pr_diff")}
    assert set(refs) == {"defs.yaml", "checks", "graph"}
    assert refs["checks"].removed_with_asset            # a check whose only asset is gone goes with it
    assert not refs["graph"].removed_with_asset and refs["graph"].item_fields


def test_cascade_cleans_root_post_processing_and_graph_edges_but_keeps_unrelated_entries(tmp_path):
    d = _messy(tmp_path)
    out = apply_cascade(d, "pr_review_fetch_pr_diff")
    assert out["removed"] == ["checks"] and sorted(out["edited"]) == ["defs.yaml", "graph"]
    root = (d / "defs.yaml").read_text()
    assert "pr_review_fetch_pr_diff" not in root
    assert "key:stg_orders" in root and "raw_orders" in root and "key:pr_review_security_review" in root
    graph = (d / "graph" / "defs.yaml").read_text()
    assert "pr_review_fetch_pr_diff" not in graph and "source: b" in graph.replace("{", "").replace("}", "").replace("source: b,", "source: b")


def test_parse_missing_asset_keys_from_real_dagster_errors():
    from app.services.asset_references import parse_missing_asset_keys
    a = "dagster._core.errors.DagsterInvalidSubsetError: AssetKey(s) ['pr_review_fetch_pr_diff', 'x'] were selected, but no AssetsDefinition objects supply these keys."
    b = "Selected keys must be a subset of existing executable asset keys. Invalid selected keys: {AssetKey(['raw_customers']), AssetKey(['a', 'b'])}"
    assert parse_missing_asset_keys(a) == ["pr_review_fetch_pr_diff", "x"]
    assert parse_missing_asset_keys(b) == ["raw_customers", "a/b"]
    assert parse_missing_asset_keys("some unrelated error") == []


def test_heal_missing_assets_dry_run_changes_nothing_then_real_run_fixes(tmp_path):
    from app.services.asset_references import heal_missing_assets
    d = _messy(tmp_path)
    before = (d / "defs.yaml").read_text()
    preview = heal_missing_assets(d, ["pr_review_fetch_pr_diff"], dry_run=True)
    assert preview["pr_review_fetch_pr_diff"]["removed"] == ["checks"] and (d / "defs.yaml").read_text() == before and (d / "checks").exists()
    heal_missing_assets(d, ["pr_review_fetch_pr_diff"])
    assert not (d / "checks").exists() and "pr_review_fetch_pr_diff" not in (d / "defs.yaml").read_text()
