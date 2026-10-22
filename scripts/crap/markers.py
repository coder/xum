"""Accept markers that the quality gates read from source comments.

A marker accepts one finding on purpose and says why, next to the code it
excuses, so a reviewer sees both in the diff:

    // dry-duplicate-ok: the two parsers must change apart (v1 and v2 formats)
    // mutation-equivalent: m[2] is never "", so ?? and || agree

The DRY gate (dry/dryer_report.py) reads `dry-duplicate-ok` in a function or
in the comment lines right above it. The mutation gate (mutate/mutate_report.py)
reads `mutation-equivalent` on the mutant's line or in the comment lines right
above it. A marker needs a reason; a bare marker accepts nothing.
"""

import re

COMMENT_LINE = re.compile(r"^\s*(//|/\*|\*)")


def marker_reason(lines: list[str], first: int, last: int, marker: str) -> str | None:
    """The reason of the first `marker:` in lines first..last (1-based) or in
    the comment-only lines directly above `first`, or None."""

    pattern = re.compile(rf"(?://|/\*|\*)\s*{re.escape(marker)}:\s*(.*?)\s*(?:\*/)?\s*$")
    above = first - 1
    while above >= 1 and COMMENT_LINE.match(lines[above - 1]):
        above -= 1
    for number in range(above + 1, min(last, len(lines)) + 1):
        match = pattern.search(lines[number - 1])
        if match and match.group(1):
            return match.group(1)
    return None
