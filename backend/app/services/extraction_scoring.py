"""Compare extracted values with the values a person said were right (the golden set).

Pure and dependency-free so the same rules can be reused wherever extraction quality is judged: the workbench's accuracy figure
and, later, the asset check that runs unattended -- a "93% on the samples" in the UI has to mean what the check reports.

What counts as "the same value" is deliberately forgiving about formatting and strict about content:
  * empty is empty: None, "" and whitespace-only all match each other (a field that should be blank and came back blank is right);
  * strings ignore case and runs of whitespace;
  * money/number formatting is ignored when it is clearly formatting ("$1,250.50" == 1250.5 == "1250.50"), but two plain digit strings
    compare as text, so an id "00123" never matches "123";
  * numbers match within half a cent; booleans are never numbers;
  * lists compare without regard to order (line items), dicts key-by-key ignoring empty values.
"""

from __future__ import annotations

import json
import re
from typing import Any

_NUMBER_TOLERANCE = 0.005
_FORMATTED_NUMBER = re.compile(r"^[-+]?\s*[$€£¥]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$")
_SYMBOLS = re.compile(r"[$€£¥,\s]")


def _is_empty(v: Any) -> bool:
    return v is None or (isinstance(v, str) and not v.strip())


def _clean_text(s: str) -> str:
    return " ".join(s.split()).casefold()


def _formatted_number(s: str) -> float | None:
    """A float if `s` is a number written with currency symbol, thousands commas or a decimal point; None for plain digit
    strings (ids, zip codes, phone numbers) and for anything that isn't a number."""
    t = s.strip()
    if not _FORMATTED_NUMBER.match(t):
        return None
    has_formatting = bool(re.search(r"[$€£¥,.]", t))
    return float(_SYMBOLS.sub("", t)) if has_formatting else None


def _as_number(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return None


def values_match(expected: Any, got: Any) -> bool:
    if _is_empty(expected) or _is_empty(got):
        return _is_empty(expected) and _is_empty(got)
    if isinstance(expected, bool) or isinstance(got, bool):
        return isinstance(expected, bool) and isinstance(got, bool) and expected == got
    if isinstance(expected, dict) or isinstance(got, dict):
        if not (isinstance(expected, dict) and isinstance(got, dict)):
            return False
        keys = {k for k in {*expected, *got} if not (_is_empty(expected.get(k)) and _is_empty(got.get(k)))}
        return all(values_match(expected.get(k), got.get(k)) for k in keys)
    if isinstance(expected, (list, tuple)) or isinstance(got, (list, tuple)):
        if not (isinstance(expected, (list, tuple)) and isinstance(got, (list, tuple))) or len(expected) != len(got):
            return False
        remaining = list(got)
        for e in expected:  # order-insensitive: every expected item needs its own unused match
            for i, g in enumerate(remaining):
                if values_match(e, g):
                    del remaining[i]
                    break
            else:
                return False
        return True
    en, gn = _as_number(expected), _as_number(got)
    if en is not None and gn is not None:
        return abs(en - gn) <= _NUMBER_TOLERANCE
    if en is not None or gn is not None:  # a real number vs text
        num, text = (en, got) if en is not None else (gn, expected)
        other = _formatted_number(str(text)) if isinstance(text, str) else None
        if other is None and isinstance(text, str) and re.fullmatch(r"[-+]?\d+(\.\d+)?", text.strip()):
            other = float(text.strip())
        return other is not None and abs(num - other) <= _NUMBER_TOLERANCE
    es, gs = str(expected), str(got)
    ef, gf = _formatted_number(es), _formatted_number(gs)
    if ef is not None and gf is not None:
        return abs(ef - gf) <= _NUMBER_TOLERANCE
    return _clean_text(es) == _clean_text(gs)


def score_document(extracted: dict[str, Any] | None, expected: dict[str, Any]) -> dict[str, bool]:
    """{field: matches} for every field a person marked. A document that failed to extract gets False for each marked field."""
    return {field: values_match(want, (extracted or {}).get(field)) for field, want in expected.items()}


def summarize(per_document: list[dict[str, bool]]) -> dict[str, Any]:
    """Overall and per-field accuracy across documents. `accuracy` is None until something is marked."""
    by_field: dict[str, dict[str, int]] = {}
    marked = correct = 0
    for doc in per_document:
        for field, ok in doc.items():
            entry = by_field.setdefault(field, {"marked": 0, "correct": 0})
            entry["marked"] += 1
            entry["correct"] += int(ok)
            marked += 1
            correct += int(ok)
    return {
        "marked": marked,
        "correct": correct,
        "accuracy": round(correct / marked, 4) if marked else None,
        "by_field": {f: {**e, "accuracy": round(e["correct"] / e["marked"], 4)} for f, e in by_field.items()},
    }


def parse_typed_value(text: str) -> Any:
    """What a person typed as "the right value": JSON if it parses as an object/array/number/bool/null, otherwise the text itself.
    So `[{"desc": "x"}]` is a list, `1250.5` a number, `INV-1042` a string, and a blank means "should be empty"."""
    t = text.strip()
    if not t:
        return None
    if t[0] in "[{" or t in ("true", "false", "null") or re.fullmatch(r"[-+]?\d+(\.\d+)?", t):
        try:
            return json.loads(t)
        except ValueError:
            return t
    return t
