import pytest

from app.services import extraction_golden_service as golden
from app.services.extraction_scoring import parse_typed_value, score_document, summarize, values_match


@pytest.mark.parametrize("expected,got", [
    (None, None), (None, ""), ("", "   "), ("  ", None),
    ("ACME Corp", "acme corp"), ("ACME  Corp\n", " ACME Corp"),
    (1250.5, 1250.5), (1250.5, "1250.50"), (1250.5, "$1,250.50"), ("$1,250.50", "1250.5"), ("1,250.50", "1250.50"),
    (1250.5, 1250.504), (3, 3.0), (3, "3"), ("€ 12.00", 12),
    (True, True), (False, False),
    (["a", "b"], ["b", "a"]),
    ([{"desc": "x", "qty": 2}], [{"qty": 2.0, "desc": "X"}]),
    ({"a": 1, "b": None}, {"a": "1"}),
])
def test_values_that_should_match(expected, got):
    assert values_match(expected, got), (expected, got)


@pytest.mark.parametrize("expected,got", [
    (None, "x"), ("x", None), ("", 0), (0, None), (0, ""),
    ("00123", "123"), ("02134", "2134"), (123, "0123x"),
    ("ACME", "ACME Corp"),
    (1250.5, 1250.51), (1250.5, "$1,250.51"), ("1,250.50", "1,250.51"),
    (True, "true"), (True, 1), (1, True), (False, None),
    (["a", "b"], ["a"]), (["a"], ["a", "a"]), (["a", "a"], ["a", "b"]),
    ([{"desc": "x"}], [{"desc": "y"}]),
    ({"a": 1}, {"a": 2}), ({"a": 1}, [1]), ([1], {"a": 1}),
])
def test_values_that_should_not_match(expected, got):
    assert not values_match(expected, got), (expected, got)


def test_a_list_cannot_match_one_item_twice():
    assert not values_match(["a", "a"], ["a", "b"])
    assert values_match(["a", "a"], ["a", "a"])


def test_score_document_covers_only_marked_fields_and_fails_a_document_that_did_not_extract():
    expected = {"total": 12.5, "vendor": "ACME", "po": None}
    got = {"total": "12.50", "vendor": "Other", "po": None, "extra": "ignored"}
    assert score_document(got, expected) == {"total": True, "vendor": False, "po": True}
    assert score_document(None, expected) == {"total": False, "vendor": False, "po": True}  # blank is right for a field marked empty


def test_summarize_overall_and_per_field():
    s = summarize([{"total": True, "vendor": False}, {"total": True}, {"total": False, "vendor": False}])
    assert (s["marked"], s["correct"], s["accuracy"]) == (5, 2, 0.4)
    assert s["by_field"]["total"] == {"marked": 3, "correct": 2, "accuracy": 0.6667}
    assert s["by_field"]["vendor"]["accuracy"] == 0.0


def test_summarize_with_nothing_marked_has_no_accuracy():
    assert summarize([]) == {"marked": 0, "correct": 0, "accuracy": None, "by_field": {}}
    assert summarize([{}, {}])["accuracy"] is None


@pytest.mark.parametrize("typed,expected", [
    ("", None), ("   ", None), ("INV-1042", "INV-1042"), ("1250.5", 1250.5), ("42", 42), ("-3", -3),
    ("true", True), ("null", None), ('[{"a": 1}]', [{"a": 1}]), ('{"a": 1}', {"a": 1}),
    ("[not json", "[not json"),
    ("00123", "00123"),  # an id with leading zeros is text; turning it into 123 would make the golden value wrong
])
def test_typed_values(typed, expected):
    assert parse_typed_value(typed) == expected


# --- golden store ---------------------------------------------------------------------------------------------------------

def test_golden_roundtrip_and_explicit_empty(tmp_path):
    assert golden.load(tmp_path, "invoices")["documents"] == {}
    golden.set_expected(tmp_path, "invoices", "abc", "/x/a.pdf", "total", 12.5)
    data = golden.set_expected(tmp_path, "invoices", "abc", "/x/a.pdf", "po", None)
    assert golden.expected_for(data, "abc") == {"total": 12.5, "po": None}  # null is a mark, not "unmarked"
    assert golden.load(tmp_path, "invoices") == data
    assert golden.expected_for(data, "other") == {}


def test_clearing_the_last_mark_removes_the_document(tmp_path):
    golden.set_expected(tmp_path, "inv", "abc", "/a.pdf", "total", 1)
    golden.set_expected(tmp_path, "inv", "abc", "/a.pdf", "vendor", "x")
    assert golden.clear_expected(tmp_path, "inv", "abc", "total")["documents"]["abc"]["expected"] == {"vendor": "x"}
    assert golden.clear_expected(tmp_path, "inv", "abc", "vendor")["documents"] == {}
    assert golden.clear_expected(tmp_path, "inv", "abc", "vendor")["documents"] == {}  # idempotent


def test_asset_names_cannot_escape_the_golden_folder(tmp_path):
    p = golden.golden_path(tmp_path, "../../etc/passwd")
    assert p.parent == tmp_path / ".designer" / "golden" and ".." not in p.name


def test_a_corrupt_file_reads_as_empty_not_an_error(tmp_path):
    p = golden.golden_path(tmp_path, "inv")
    p.parent.mkdir(parents=True)
    p.write_text("{not json")
    assert golden.load(tmp_path, "inv")["documents"] == {}


def test_document_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(golden, "MAX_DOCUMENTS", 2)
    golden.set_expected(tmp_path, "inv", "a", "/a", "f", 1)
    golden.set_expected(tmp_path, "inv", "b", "/b", "f", 1)
    golden.set_expected(tmp_path, "inv", "a", "/a", "g", 1)  # an existing document can still gain marks
    with pytest.raises(ValueError):
        golden.set_expected(tmp_path, "inv", "c", "/c", "f", 1)
