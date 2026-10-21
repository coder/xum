# /// script
# requires-python = ">=3.11"
# dependencies = [
#   # dryer gives the structural fingerprints and the Jaccard score; Crapper
#   # gives the function names, so a DRY finding names the same function that
#   # crap-check names. Keep the Crapper SHA and the grammar pins equal to
#   # scripts/crap/crapper_report.py: a grammar bump can move every fingerprint.
#   "dryer @ git+https://github.com/unclebob/dryer@66ff6d21a42c04afcad89c78a80066176d1294b0",
#   "crapper @ git+https://github.com/unclebob/crapper@9f1bead298b5a9d576bdd6319289fcf426e5b18a",
#   "tree-sitter==0.26.0",
#   "tree-sitter-language-pack==1.21.3",
# ]
# ///
"""Find near-duplicate functions that a diff makes, and print them as JSON.

Usage (through uv, which reads the pins above; dry/check.ts calls it):

    uv run --script scripts/dry/dryer_report.py --root DIR --base-root DIR
        --changes FILE [--threshold N] [--min-lines N] [--min-nodes N]

`--changes` is a JSON file: {"files": [{"basePath", "headPath"}...],
"spans": {headPath: [[start, end]...]}} (scripts/crap/changes.ts). The base
content of every changed file sits at its base path under `--base-root`.

Upstream `dryer` compares every function with every other one, which takes
more than 15 minutes on src/ (about 14,000 functions). This script compares
only the changed functions with all the others, so the cost grows with the
diff. A pair is reported only when the diff made it: a changed function that
is new, or a pair whose two functions did not match at the base.
"""

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

from dryer.discover import language_of
from dryer.extract import entries_in_source
from dryer.shape import jaccard
from crapper.discover import language_of as crapper_language
from crapper.languages import functions_in_file

# Reuse the CRAP gate's production-file rule, so both gates see the same files.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "crap"))
from crapper_report import is_production, tracked_src_files  # noqa: E402

# dryer's defaults (dryer/src/dryer/cli.py).
THRESHOLD = 0.82
MIN_LINES = 4
MIN_NODES = 20


@dataclass(frozen=True)
class Form:
    """One dryer entry, named after the Crapper function that holds it."""

    path: str
    name: str
    start_line: int
    end_line: int
    fingerprints: frozenset


def holder_name(functions, start_line: int) -> str:
    """The tightest Crapper function that holds the line names the form."""

    holders = [f for f in functions if f.start_line <= start_line <= f.end_line]
    holder = min(holders, key=lambda f: f.end_line - f.start_line, default=None)
    return holder.name if holder else f"@{start_line}"


def crapper_functions(root: Path, relative: str) -> list:
    language = crapper_language(relative)
    if language is None:
        return []
    source = (root / relative).read_text(encoding="utf-8", errors="replace")
    return functions_in_file(language, source, relative, str(root))


def forms_in(root: Path, relative: str, shown: str, min_lines: int, min_nodes: int, named: bool) -> list[Form]:
    """The comparable forms of one file. `shown` is the head path of a renamed file.

    Naming parses the file a second time, so only changed files are named here
    (their keys pair head and base forms). Other forms get a line key, and
    name_reported() names the few that a pair reports.
    """

    language = language_of(relative)
    if language is None:
        return []
    source = (root / relative).read_text(encoding="utf-8", errors="replace")
    entries, _warning = entries_in_source(language, source, relative, shown)
    functions = crapper_functions(root, relative) if named else []
    return [
        Form(shown, holder_name(functions, e.start_line) if named else f"@{e.start_line}", e.start_line, e.end_line, e.fingerprints)
        for e in entries
        if e.end_line - e.start_line + 1 >= min_lines and e.nodes >= min_nodes
    ]


def name_reported(root: Path, pairs: list[dict]) -> None:
    cache: dict[str, list] = {}
    for pair in pairs:
        for side in (pair["left"], pair["right"]):
            if side["name"].startswith("@"):
                functions = cache.setdefault(side["path"], crapper_functions(root, side["path"]))
                side["name"] = holder_name(functions, side["startLine"])


def keyed(forms: list[Form]) -> dict[str, Form]:
    """path::name, with an ordinal for the 2nd and later in line order (as policy.ts keyRows)."""

    result: dict[str, Form] = {}
    seen: dict[str, int] = {}
    for form in sorted(forms, key=lambda f: f.start_line):
        key = f"{form.path}::{form.name}"
        seen[key] = seen.get(key, 0) + 1
        result[key if seen[key] == 1 else f"{key}[{seen[key]}]"] = form
    return result


def touched(form: Form, spans: dict[str, list[list[float]]]) -> bool:
    return any(form.start_line <= end and start <= form.end_line for start, end in spans.get(form.path, []))


def similar(a: frozenset, b: frozenset, threshold: float) -> float | None:
    # Exact pre-filter: Jaccard <= min/max of the two set sizes.
    small, large = sorted((len(a), len(b)))
    if large == 0 or small / large < threshold:
        return None
    score = jaccard(a, b)
    return score if score >= threshold else None


def new_pairs(
    head: dict[str, Form],
    base: dict[str, Form],
    changed_paths: set[str],
    spans: dict[str, list[list[float]]],
    threshold: float,
) -> list[dict]:
    """Pairs with a changed function on one side that the diff made.

    `head` holds every production form. `base` holds the base forms of the
    changed files only: an unchanged file is the same at the base, so its head
    form stands in for its base form.
    """

    def at_base(key: str, form: Form) -> Form | None:
        return base.get(key) if form.path in changed_paths else form

    pairs: dict[tuple[str, str], dict] = {}
    items = list(head.items())
    for key, left in items:
        if not touched(left, spans):
            continue
        for other, right in items:
            if other == key:
                continue
            score = similar(left.fingerprints, right.fingerprints, threshold)
            if score is None:
                continue
            left_base, right_base = at_base(key, left), at_base(other, right)
            if left_base and right_base and similar(left_base.fingerprints, right_base.fingerprints, threshold):
                continue  # the same two functions matched before the diff
            pair = tuple(sorted((key, other)))
            if pair not in pairs:
                pairs[pair] = {"score": round(score, 4), "left": span(left), "right": span(right)}
    return sorted(pairs.values(), key=lambda p: (-p["score"], p["left"]["path"], p["left"]["startLine"]))


def span(form: Form) -> dict:
    return {"path": form.path, "name": form.name, "startLine": form.start_line, "endLine": form.end_line}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--base-root", required=True, type=Path)
    parser.add_argument("--changes", required=True, type=Path)
    parser.add_argument("--threshold", type=float, default=THRESHOLD)
    parser.add_argument("--min-lines", type=int, default=MIN_LINES)
    parser.add_argument("--min-nodes", type=int, default=MIN_NODES)
    args = parser.parse_args(argv)
    changes = json.loads(args.changes.read_text(encoding="utf-8"))
    spans = changes["spans"]
    files = changes["files"]
    changed_paths = {f["headPath"] for f in files if f["headPath"]}

    head_forms: list[Form] = []
    for relative in tracked_src_files(args.root):
        # A deleted-but-tracked file is gone from the working tree.
        if is_production(relative) and (args.root / relative).is_file():
            named = relative in changed_paths
            head_forms += forms_in(args.root, relative, relative, args.min_lines, args.min_nodes, named)
    base_forms: list[Form] = []
    for f in files:
        # A file renamed from a test into production has no base forms.
        if f["basePath"] and f["headPath"] and is_production(f["basePath"]):
            base_forms += forms_in(args.base_root, f["basePath"], f["headPath"], args.min_lines, args.min_nodes, True)

    head = keyed(head_forms)
    pairs = new_pairs(head, keyed(base_forms), changed_paths, spans, args.threshold)
    name_reported(args.root, pairs)
    report = {
        "compared": len(head),
        "changedFunctions": sum(1 for form in head.values() if touched(form, spans)),
        "pairs": pairs,
    }
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
