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
"spans": {headPath: [[start, end]...]}, "hunks": {headPath: [[baseStart,
baseCount, headStart, headCount]...]}} (scripts/crap/changes.ts). The base
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
from markers import Comments  # noqa: E402

MARKER = "dry-duplicate-ok"

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


def forms_in(root: Path, relative: str, shown: str, min_lines: int, min_nodes: int) -> list[Form]:
    """The comparable forms of one file. `shown` is the head path of a renamed file.

    Forms get a line name here. Naming parses the file a second time with
    Crapper, so name_reported() names only the few forms that a pair reports.
    """

    language = language_of(relative)
    if language is None:
        return []
    source = (root / relative).read_text(encoding="utf-8", errors="replace")
    entries, _warning = entries_in_source(language, source, relative, shown)
    return [
        Form(shown, f"@{e.start_line}", e.start_line, e.end_line, e.fingerprints)
        for e in entries
        if e.end_line - e.start_line + 1 >= min_lines and e.nodes >= min_nodes
    ]


def accept_marked(root: Path, pairs: list[dict], spans: dict[str, list[list[float]]]) -> None:
    """Sets "accepted" to the reason of a `dry-duplicate-ok:` marker (markers.py).

    Only a changed side counts. Otherwise a marker on an old function would
    excuse every future copy of it.
    """

    cache: dict[str, Comments] = {}
    for pair in pairs:
        for side in (pair["left"], pair["right"]):
            changed = any(side["startLine"] <= end and start <= side["endLine"] for start, end in spans.get(side["path"], []))
            if not changed:
                continue
            if side["path"] not in cache:
                source = (root / side["path"]).read_text(encoding="utf-8", errors="replace")
                cache[side["path"]] = Comments(source, side["path"])
            reason = cache[side["path"]].reason(side["startLine"], side["endLine"], MARKER)
            if reason is not None:
                pair["accepted"] = reason
                break


def name_reported(root: Path, pairs: list[dict]) -> None:
    cache: dict[str, list] = {}
    for pair in pairs:
        for side in (pair["left"], pair["right"]):
            if side["name"].startswith("@"):
                # Not setdefault: its default argument would parse the file every time.
                if side["path"] not in cache:
                    cache[side["path"]] = crapper_functions(root, side["path"])
                side["name"] = holder_name(cache[side["path"]], side["startLine"])


def keyed(forms: list[Form]) -> dict[str, Form]:
    """path::name, with an ordinal for a 2nd form on one line (dryer can nest them)."""

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


def base_line(line: int, hunks: list[list[int]]) -> int | None:
    """The base line of a head line, or None when the diff added it.

    `hunks` are the file's `git diff -U0` hunks (scripts/crap/changes.ts). A
    side with count 0 sits after its start line, so it begins one line later.
    """

    offset = 0
    for base_start, base_count, head_start, head_count in sorted(hunks, key=lambda h: h[2]):
        head_from = head_start if head_count else head_start + 1
        if line < head_from:
            break
        if line < head_from + head_count:
            return None
        base_from = base_start if base_count else base_start + 1
        offset = (base_from + base_count) - (head_from + head_count)
    return line + offset


def counterpart(form: Form, base_forms: list[Form], hunks: list[list[int]]) -> Form | None:
    """The base form that holds most of `form`'s lines, by git's own alignment.

    Matching by name cannot tell a new copy from the function it copies when
    both have one name. Git's hunks can: a function made only of added lines
    has no base form, so every pair with it is new.
    """

    mapped = [b for line in range(form.start_line, form.end_line + 1) if (b := base_line(line, hunks)) is not None]
    best, most = None, 0
    for candidate in base_forms:
        count = sum(1 for b in mapped if candidate.start_line <= b <= candidate.end_line)
        if count > most:
            best, most = candidate, count
    return best


def new_pairs(
    head: dict[str, Form],
    base_by_path: dict[str, list[Form]],
    changed_paths: set[str],
    spans: dict[str, list[list[float]]],
    hunks: dict[str, list[list[int]]],
    threshold: float,
) -> list[dict]:
    """Pairs with a changed function on one side that the diff made.

    `head` holds every production form. `base_by_path` holds the base forms
    of the changed files only, under their head path (a deleted file under its
    base path): an unchanged file is the same at the base, so its head form
    stands in for its base form.

    A form made only of added lines can still be old code that moved from
    another file (or from another place git did not pair). It stands for the
    removed base form (one that no head form maps back to) that it matches
    best, so moving a function does not report its old pairs as new.
    """

    own = {
        id(form): counterpart(form, base_by_path.get(form.path, []), hunks.get(form.path, []))
        for form in head.values()
        if form.path in changed_paths
    }
    kept = {id(base) for base in own.values() if base is not None}
    removed = [base for forms in base_by_path.values() for base in forms if id(base) not in kept]

    def moved_from(form: Form) -> Form | None:
        scored = [(similar(form.fingerprints, base.fingerprints, threshold), base) for base in removed]
        return max(((score, base) for score, base in scored if score is not None), key=lambda sb: sb[0], default=(0, None))[1]

    def at_base(form: Form) -> Form | None:
        if form.path not in changed_paths:
            return form
        return own[id(form)] or moved_from(form)

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
            left_base, right_base = at_base(left), at_base(right)
            # Two distinct base forms: one base function split in two is not an old pair.
            old = left_base is not None and right_base is not None and left_base is not right_base
            if old and similar(left_base.fingerprints, right_base.fingerprints, threshold):
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
            head_forms += forms_in(args.root, relative, relative, args.min_lines, args.min_nodes)
    base_forms: list[Form] = []
    for f in files:
        # A file renamed from a test into production has no base forms, and
        # all of its functions are new to production, even the lines the diff
        # did not touch (a pure rename has no hunks). A deleted file keeps its
        # base path: its functions may have moved.
        if f["basePath"] and is_production(f["basePath"]):
            shown = f["headPath"] or f["basePath"]
            base_forms += forms_in(args.base_root, f["basePath"], shown, args.min_lines, args.min_nodes)
        elif f["basePath"] and f["headPath"] and is_production(f["headPath"]):
            spans[f["headPath"]] = [[1, float("inf")]]

    head = keyed(head_forms)
    base_by_path: dict[str, list[Form]] = {}
    for form in base_forms:
        base_by_path.setdefault(form.path, []).append(form)
    hunks = changes.get("hunks", {})
    pairs = new_pairs(head, base_by_path, changed_paths, spans, hunks, args.threshold)
    name_reported(args.root, pairs)
    accept_marked(args.root, pairs, spans)
    report = {
        "compared": len(head),
        "changedFunctions": sum(1 for form in head.values() if touched(form, spans)),
        "pairs": pairs,
    }
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
