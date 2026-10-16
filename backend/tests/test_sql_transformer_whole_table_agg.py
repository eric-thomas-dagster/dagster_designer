"""Aggregations with no group_by compile to one row over the whole table
(SELECT MAX(x) FROM t) instead of being ignored."""
import importlib.util
import pathlib

import pytest

_PATH = pathlib.Path(__file__).resolve().parent.parent / "dagster_designer_components" / "sql_transformer.py"


@pytest.fixture(scope="module")
def mod():
    try:
        spec = importlib.util.spec_from_file_location("sql_transformer_under_test", _PATH)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        return m
    except ImportError as e:  # sqlalchemy/dagster not in this venv
        pytest.skip(f"sql_transformer deps unavailable: {e}")


def _sql(mod, **cfg):
    cfg.setdefault("upstream_table", "main.t")
    return mod._build_group_by_sql(cfg, mod._csv(cfg.pop("group_by", None)), mod._json_dict(cfg.pop("agg_functions", None)), "duckdb")


def test_aggregation_without_group_by_has_no_group_by_clause(mod):
    sql = _sql(mod, agg_functions='{"amount": "max"}').upper()
    assert "MAX(" in sql and "GROUP BY" not in sql


def test_group_by_still_emits_group_by(mod):
    sql = _sql(mod, group_by="last_name", agg_functions='{"amount": "max"}').upper()
    assert "GROUP BY" in sql
