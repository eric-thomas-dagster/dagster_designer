"""Decide whether a check/materialization metadata entry can be trended.

Some checks used to report numbers as text ("1234", "12.5%", "1,234") and
now report real int/float entries. Both must chart as one series under the
same label, so anything that reads as a plain number counts.

Deliberately conservative -- a wrong guess plots noise: no units ("12 ms"),
no dates or versions, no ids with leading zeros ("00123", zip codes), no
nan/inf.
"""

import json
import math
import re

_PLAIN = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")
_THOUSANDS = re.compile(r"^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$")
_LEADING_ZERO_ID = re.compile(r"^[+-]?0\d")


def coerce_number(value, *, allow_bool: bool = False) -> float | None:
    """A finite float for a number or a number-looking string, else None.
    Booleans are 1/0 only when `allow_bool` (a pass/fail flag makes a fine
    per-metric series but a poor headline number)."""
    if isinstance(value, bool):
        return float(value) if allow_bool else None
    if isinstance(value, (int, float)):
        f = float(value)
        return f if math.isfinite(f) else None
    if not isinstance(value, str):
        return None
    s = value.strip()
    if s and s[0] in "$€£":
        s = s[1:].strip()
    if s.endswith("%"):
        s = s[:-1].strip()
    if _THOUSANDS.match(s):
        s = s.replace(",", "")
    if not _PLAIN.match(s) or _LEADING_ZERO_ID.match(s):
        return None
    f = float(s)
    return f if math.isfinite(f) else None


def entry_number(entry: dict, *, allow_bool: bool = False) -> float | None:
    """The trendable number of a normalized {label, type, value} entry.
    Native numbers of any entry type count (as before); text entries count
    when they look numeric; markdown/json/url/path/timestamp never do."""
    value = entry.get("value")
    if isinstance(value, (int, float)):
        return coerce_number(value, allow_bool=allow_bool)
    if entry.get("type") in ("text", "TextMetadataEntry"):
        return coerce_number(value)
    return None


_MAX_JSON_DEPTH = 3
_MAX_JSON_LEAVES = 50


def _walk_json(prefix: str, node, depth: int, out: list[tuple[str, float]]) -> None:
    if len(out) >= _MAX_JSON_LEAVES:
        return
    if isinstance(node, dict):
        if depth >= _MAX_JSON_DEPTH:
            return
        for k, v in node.items():
            _walk_json(f"{prefix}.{k}", v, depth + 1, out)
        return
    n = coerce_number(node, allow_bool=True)
    if n is not None:
        out.append((prefix, n))


def series_numbers(entry: dict) -> list[tuple[str, float]]:
    """Every (series label, number) one metadata entry contributes to the
    per-metric charts: a scalar gives one point under its own label (bools
    as 1/0); a JSON dict -- e.g. {"nulls": {"a": 3}} -- gives one series per
    numeric leaf, labelled `label.nulls.a`. Lists and non-numeric leaves are
    ignored."""
    label = entry.get("label")
    if not label:
        return []
    value = entry.get("value")
    if entry.get("type") in ("json", "JsonMetadataEntry"):
        try:
            doc = json.loads(value) if isinstance(value, str) else value
        except ValueError:
            return []
        out: list[tuple[str, float]] = []
        _walk_json(label, doc, 0, out) if isinstance(doc, dict) else None
        if not isinstance(doc, dict):
            n = coerce_number(doc, allow_bool=True)
            if n is not None:
                out.append((label, n))
        return out
    n = entry_number(entry, allow_bool=True)
    return [(label, n)] if n is not None else []
