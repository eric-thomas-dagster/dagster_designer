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
