"""Decide whether a check/materialization metadata entry can be trended.

Some checks used to report numbers as text ("1234", "12.5%", "1,234") and
now report real int/float entries. Both must chart as one series under the
same label, so anything that reads as a plain number counts.

Deliberately conservative -- a wrong guess plots noise: no units ("12 ms"),
no dates or versions, no ids with leading zeros ("00123", zip codes), no
nan/inf.
"""

import math
import re

_PLAIN = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")
_THOUSANDS = re.compile(r"^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$")
_LEADING_ZERO_ID = re.compile(r"^[+-]?0\d")


def coerce_number(value) -> float | None:
    """A finite float for a number or a number-looking string, else None."""
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


def entry_number(entry: dict) -> float | None:
    """The trendable number of a normalized {label, type, value} entry.
    Native numbers of any entry type count (as before); text entries count
    when they look numeric; markdown/json/url/path/timestamp never do."""
    value = entry.get("value")
    if isinstance(value, (int, float)):
        return coerce_number(value)
    if entry.get("type") in ("text", "TextMetadataEntry"):
        return coerce_number(value)
    return None
