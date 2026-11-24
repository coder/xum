"""Accept markers that the quality gates read from source comments.

A marker accepts one finding on purpose and says why, next to the code it
excuses, so a reviewer sees both in the diff:

    // dry-duplicate-ok: the two parsers must change apart (v1 and v2 formats)
    // mutation-equivalent: m[2] is never "", so ?? and || agree

The DRY gate (dry/dryer_report.py) reads `dry-duplicate-ok` in a function or
in the comment lines right above it. The mutation gate (mutate/mutate_report.py)
reads `mutation-equivalent` on the mutant's line or in the comment lines right
above it. A marker needs a reason; a bare marker accepts nothing. Only real comments
count: tree-sitter finds them, so marker text inside a string or a template
(`"// mutation-equivalent: x"`) accepts nothing.
"""

import re

from crapper.languages.treesitter import descendants, parse


def grammar(path: str) -> str:
    """mutator's grammar choice (mutator/sites.py _grammar) for a scored file."""

    if path.endswith((".tsx", ".jsx")):
        return "tsx"
    if path.endswith((".js", ".mjs", ".cjs")):
        return "javascript"
    return "typescript"


class Comments:
    """The comments of one source file, by 1-based line."""

    def __init__(self, source: str, path: str):
        data, tree = parse(source, grammar(path))
        self.lines = source.split("\n")
        # line -> comment text on that line; line -> whether only comments sit on it
        self.text: dict[int, list[str]] = {}
        spans: dict[int, list[tuple[int, int]]] = {}
        for node in descendants(tree.root_node):
            # The braces of a JSX expression that holds only comments
            # (`{/* ... */}`, on one line or many) are part of the comment.
            if node.type == "jsx_expression" and node.named_children and all(
                c.type == "comment" for c in node.named_children
            ):
                for brace in (node.children[0], node.children[-1]):
                    spans.setdefault(brace.start_point[0] + 1, []).append((brace.start_point[1], brace.end_point[1]))
                continue
            if node.type != "comment":
                continue
            rows = data[node.start_byte : node.end_byte].decode("utf-8").split("\n")
            for offset, text in enumerate(rows):
                row = node.start_point[0] + offset
                self.text.setdefault(row + 1, []).append(text)
                start = node.start_point[1] if offset == 0 else 0
                end = node.end_point[1] if offset == len(rows) - 1 else len(self.lines[row].encode("utf-8"))
                spans.setdefault(row + 1, []).append((start, end))
        self.comment_only = set()
        for line, ranges in spans.items():
            raw = bytearray(self.lines[line - 1].encode("utf-8"))
            for start, end in ranges:
                raw[start:end] = b" " * (end - start)
            if not bytes(raw).translate(None, b" \t\r"):
                self.comment_only.add(line)

    def reason(self, first: int, last: int, marker: str) -> str | None:
        """The reason of the first `marker:` in a comment on lines first..last
        or on the comment-only lines directly above `first`, or None."""

        # A whole token: `no-mutation-equivalent:` is another word, not the marker.
        pattern = re.compile(rf"(?<![\w-]){re.escape(marker)}:\s*(.*?)\s*(?:\*/)?\s*$")
        above = first - 1
        while above >= 1 and above in self.comment_only:
            above -= 1
        for line in range(above + 1, last + 1):
            for text in self.text.get(line, []):
                match = pattern.search(text)
                if match and match.group(1):
                    return match.group(1)
        return None
