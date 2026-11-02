import pytest

from app.core.metadata_numeric import coerce_number, entry_number
from app.services.dagster_plus_client import numeric_metadata_value


@pytest.mark.parametrize("raw,expected", [
    (5, 5.0), (2.5, 2.5), ("1234", 1234.0), (" 12.5 ", 12.5), ("-3", -3.0),
    ("1,234", 1234.0), ("1,234,567.89", 1234567.89), ("12.5%", 12.5),
    ("$1,200", 1200.0), ("1e3", 1000.0), (".5", 0.5), ("0.05", 0.05), ("0", 0.0),
])
def test_looks_numeric(raw, expected):
    assert coerce_number(raw) == expected


@pytest.mark.parametrize("raw", [
    "", "abc", "N/A", "nan", "inf", "-inf", "12 ms", "1.2.3", "2024-01-05",
    "00123", "007", "1,23", "12,34,567", None, [], {}, float("nan"), float("inf"),
])
def test_does_not_look_numeric(raw):
    assert coerce_number(raw) is None


def test_entry_number_only_coerces_text_and_native_numbers():
    assert entry_number({"type": "text", "value": "42"}) == 42.0
    assert entry_number({"type": "TextMetadataEntry", "value": "42"}) == 42.0
    assert entry_number({"type": "float", "value": 1.5}) == 1.5
    assert entry_number({"type": "markdown", "value": "42"}) is None
    assert entry_number({"type": "json", "value": "42"}) is None
    assert entry_number({"type": "url", "value": "42"}) is None


def _entries(*items):
    out = []
    for label, typename, field, value in items:
        out.append({"__typename": typename, "label": label, field: value})
    return out


def test_text_and_numeric_runs_share_label_and_choice():
    old = _entries(("row_count", "TextMetadataEntry", "text", "1,204"),
                   ("Execution Duration", "FloatMetadataEntry", "floatValue", 0.2))
    new = _entries(("row_count", "IntMetadataEntry", "intValue", 1204),
                   ("Execution Duration", "FloatMetadataEntry", "floatValue", 0.2))
    assert numeric_metadata_value(old) == (1204.0, "row_count")
    assert numeric_metadata_value(new) == (1204.0, "row_count")


def test_non_numeric_text_is_not_picked():
    e = _entries(("status", "TextMetadataEntry", "text", "ok"))
    assert numeric_metadata_value(e) is None


from app.core.metadata_numeric import series_numbers


def test_bool_is_a_series_point_but_never_the_headline():
    assert coerce_number(True) is None
    assert coerce_number(True, allow_bool=True) == 1.0
    assert coerce_number(False, allow_bool=True) == 0.0
    assert entry_number({"type": "bool", "value": True}) is None
    assert series_numbers({"label": "passed", "type": "bool", "value": True}) == [("passed", 1.0)]
    e = _entries(("passed", "BoolMetadataEntry", "boolValue", True),
                 ("row_count", "IntMetadataEntry", "intValue", 7))
    assert numeric_metadata_value(e) == (7.0, "row_count")
    assert numeric_metadata_value(_entries(("passed", "BoolMetadataEntry", "boolValue", True))) is None


def test_json_dict_expands_to_one_series_per_numeric_key():
    e = {"label": "stats", "type": "json",
         "value": '{"nulls": {"a": 3, "b": "0"}, "ok": true, "note": "fine", "cols": [1, 2]}'}
    assert dict(series_numbers(e)) == {"stats.nulls.a": 3.0, "stats.nulls.b": 0.0, "stats.ok": 1.0}


def test_json_edge_cases():
    assert series_numbers({"label": "x", "type": "json", "value": "not json"}) == []
    assert series_numbers({"label": "x", "type": "json", "value": "[1, 2]"}) == []
    assert series_numbers({"label": "x", "type": "json", "value": "5"}) == [("x", 5.0)]
    assert series_numbers({"label": "x", "type": "json", "value": {"a": 2}}) == [("x.a", 2.0)]
    assert series_numbers({"label": "", "type": "int", "value": 1}) == []
    deep = {"label": "d", "type": "json", "value": '{"a": {"b": {"c": {"d": 1}}}, "e": 2}'}
    assert series_numbers(deep) == [("d.e", 2.0)]  # nested past 3 levels is dropped
    many = {"label": "m", "type": "json", "value": "{" + ",".join(f'"k{i}": {i}' for i in range(80)) + "}"}
    assert len(series_numbers(many)) == 50


def test_text_and_native_scalars_still_series():
    assert series_numbers({"label": "r", "type": "text", "value": "1,204"}) == [("r", 1204.0)]
    assert series_numbers({"label": "r", "type": "float", "value": 0.5}) == [("r", 0.5)]
    assert series_numbers({"label": "r", "type": "markdown", "value": "5"}) == []
