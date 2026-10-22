"""Tests of the rule that decides which duplicate pairs a diff made.

Run through `make test-dry-scripts`, which supplies dryer, Crapper and pytest.
Fingerprints here are small hand-made sets, so each score is easy to count.
"""

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "crap"))

from dryer_report import Form, base_line, keyed, new_pairs  # noqa: E402

SHAPE = frozenset("abcdefghij")  # 10 fingerprints
NEAR = frozenset("abcdefghi") | {"z"}  # 9 shared of 11: score 0.818, below 0.82
OTHER = frozenset("klmnopqrst")


def form(path, name, start, fingerprints):
    return Form(path, name, start, start + 5, fingerprints)


def run(head, base, changed_paths, spans, hunks=None):
    by_path = {}
    for f in base:
        by_path.setdefault(f.path, []).append(f)
    # Without hunks, a changed file's lines all map to the same base lines.
    hunks = hunks if hunks is not None else {path: [] for path in changed_paths}
    return new_pairs(keyed(head), by_path, set(changed_paths), spans, hunks, 0.82)


def names(pairs):
    return sorted(tuple(sorted((p["left"]["name"], p["right"]["name"]))) for p in pairs)


def test_a_new_copy_of_old_code_is_reported():
    old = form("src/a.ts", "cents", 1, SHAPE)
    copy = form("src/b.ts", "fee", 1, SHAPE)
    pairs = run([old, copy], [], ["src/b.ts"], {"src/b.ts": [[1, 6]]})
    assert names(pairs) == [("cents", "fee")]
    assert pairs[0]["left"]["name"] == "fee"  # the changed side comes first


def test_an_edit_to_one_side_of_an_old_pair_is_quiet():
    cents = form("src/a.ts", "cents", 1, SHAPE)
    count = form("src/a.ts", "count", 10, SHAPE)
    base_cents = form("src/a.ts", "cents", 1, SHAPE)
    base_count = form("src/a.ts", "count", 10, SHAPE)
    pairs = run([cents, count], [base_cents, base_count], ["src/a.ts"], {"src/a.ts": [[2, 2]]})
    assert pairs == []


def test_an_edit_that_makes_a_new_match_is_reported():
    # At the base, `fee` had another shape. The edit turned it into a copy.
    fee = form("src/b.ts", "fee", 1, SHAPE)
    cents = form("src/a.ts", "cents", 1, SHAPE)
    pairs = run(
        [fee, cents], [form("src/b.ts", "fee", 1, OTHER)], ["src/b.ts"], {"src/b.ts": [[3, 3]]}, {"src/b.ts": [[3, 1, 3, 1]]}
    )
    assert names(pairs) == [("cents", "fee")]


def test_a_pair_below_the_threshold_is_quiet():
    pairs = run(
        [form("src/a.ts", "cents", 1, SHAPE), form("src/b.ts", "fee", 1, NEAR)],
        [],
        ["src/b.ts"],
        {"src/b.ts": [[1, 6]]},
    )
    assert pairs == []


def test_a_pair_with_two_changed_sides_is_reported_once():
    one = form("src/a.ts", "one", 1, SHAPE)
    two = form("src/a.ts", "two", 10, SHAPE)
    pairs = run([one, two], [], ["src/a.ts"], {"src/a.ts": [[1, 20]]})
    assert names(pairs) == [("one", "two")]


def test_an_untouched_function_in_a_changed_file_does_not_start_a_pair():
    # Only `edited` changed. `a` and `b` are an old pair in the same file.
    a = form("src/a.ts", "a", 1, SHAPE)
    b = form("src/a.ts", "b", 10, SHAPE)
    edited = form("src/a.ts", "edited", 20, OTHER)
    base = [form("src/a.ts", "a", 1, SHAPE), form("src/a.ts", "b", 10, SHAPE), form("src/a.ts", "edited", 20, OTHER)]
    assert run([a, b, edited], base, ["src/a.ts"], {"src/a.ts": [[21, 21]]}) == []


def test_the_script_names_functions_after_crapper(tmp_path):
    # End to end through dryer and Crapper: two real TypeScript copies.
    body = '  if (n === 0) return "0";\n  if (n < 100) return "1-99";\n  if (n < 1000) return "100-999";\n  return "1000+";\n}\n'
    src = tmp_path / "src"
    src.mkdir()
    (src / "a.ts").write_text(f"export function cents(n: number): string {{\n{body}")
    (src / "b.ts").write_text(f"export function fee(n: number): string {{\n{body}")
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    base = tmp_path / "base"
    base.mkdir()
    changes = tmp_path / "changes.json"
    changes.write_text(json.dumps({"files": [{"basePath": None, "headPath": "src/b.ts"}], "spans": {"src/b.ts": [[1, 6]]}}))
    script = Path(__file__).resolve().parent / "dryer_report.py"
    out = subprocess.run(
        [sys.executable, str(script), "--root", str(tmp_path), "--base-root", str(base), "--changes", str(changes)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    report = json.loads(out)
    assert report["changedFunctions"] == 1
    assert [(p["left"]["name"], p["right"]["name"]) for p in report["pairs"]] == [("fee", "cents")]


def test_base_line_follows_additions_and_deletions():
    # Lines 5-6 added after base line 4; base lines 10-11 deleted after head line 11.
    hunks = [[4, 0, 5, 2], [10, 2, 11, 0]]
    assert [base_line(n, hunks) for n in (4, 5, 6, 7, 11, 12)] == [4, None, None, 5, 9, 12]


def test_a_new_copy_with_the_name_of_an_old_match_is_reported():
    # Base: render (1-6) and cents (20-25) already match. The diff inserts a
    # second render, an exact copy, above the first. A name cannot tell the two
    # renders apart; git's hunk can: the new one is all added lines.
    copy = form("src/a.ts", "@1", 1, SHAPE)
    old = form("src/a.ts", "@8", 8, SHAPE)
    cents = form("src/a.ts", "@27", 27, SHAPE)
    base = [form("src/a.ts", "@1", 1, SHAPE), form("src/a.ts", "@20", 20, SHAPE)]
    pairs = run([copy, old, cents], base, ["src/a.ts"], {"src/a.ts": [[1, 7]]}, {"src/a.ts": [[0, 0, 1, 7]]})
    assert names(pairs) == [("@1", "@27"), ("@1", "@8")]


def test_a_marker_needs_a_reason_and_sits_in_or_right_above_the_span():
    from markers import Comments

    def marker_reason(lines, first, last, marker):
        return Comments("\n".join(lines), "a.ts").reason(first, last, marker)

    lines = [
        "const a = 1;",  # 1
        "/**",  # 2
        " * dry-duplicate-ok: v1 and v2 parsers must change apart",  # 3
        " */",  # 4
        "export function parse() {",  # 5
        "  return 1; // dry-duplicate-ok:",  # 6, no reason
        "}",  # 7
        "// dry-duplicate-ok: far away",  # 8
    ]
    assert marker_reason(lines, 5, 7, "dry-duplicate-ok") == "v1 and v2 parsers must change apart"
    assert marker_reason(lines, 6, 7, "dry-duplicate-ok") is None  # line 6 has no reason, 5 is code
    assert marker_reason(lines, 1, 1, "dry-duplicate-ok") is None
    assert marker_reason(["x; /* mutation-equivalent: never empty */"], 1, 1, "mutation-equivalent") == "never empty"



def test_a_function_moved_out_of_a_deleted_file_keeps_its_old_pairs_quiet():
    # Base: cents in src/old.ts already matched count in src/c.ts. The diff
    # deletes src/old.ts and adds cents to src/b.ts (all added lines).
    moved = form("src/b.ts", "@1", 1, SHAPE)
    count = form("src/c.ts", "count", 1, SHAPE)
    base = [form("src/old.ts", "@1", 1, SHAPE)]  # a deleted file keeps its base path
    pairs = run([moved, count], base, ["src/b.ts"], {"src/b.ts": [[1, 6]]}, {"src/b.ts": [[0, 0, 1, 6]]})
    assert pairs == []


def test_a_new_copy_is_reported_when_the_original_stays():
    # Same as above, but the original stays in its file: a copy, not a move.
    copy = form("src/b.ts", "@1", 1, SHAPE)
    original = form("src/a.ts", "@1", 1, SHAPE)
    base = [form("src/a.ts", "@1", 1, SHAPE)]
    pairs = run(
        [copy, original], base, ["src/a.ts", "src/b.ts"], {"src/b.ts": [[1, 6]]}, {"src/b.ts": [[0, 0, 1, 6]], "src/a.ts": []}
    )
    assert names(pairs) == [("@1", "@1")]


def test_one_function_split_in_two_similar_halves_is_a_new_pair():
    # Base line 1-20 was one function. The diff adds a header at 1 and 12, so
    # both halves map back into that one base form.
    base = [Form("src/a.ts", "@1", 1, 20, frozenset("abcdefghijklmnopqrst"))]
    halves = [Form("src/a.ts", "@1", 1, 9, SHAPE), Form("src/a.ts", "@12", 12, 21, SHAPE)]
    pairs = run(halves, base, ["src/a.ts"], {"src/a.ts": [[1, 1], [12, 13]]}, {"src/a.ts": [[0, 0, 1, 1], [10, 0, 12, 2]]})
    assert names(pairs) == [("@1", "@12")]


def test_naming_parses_each_reported_file_once(monkeypatch):
    import dryer_report

    calls = []
    monkeypatch.setattr(dryer_report, "crapper_functions", lambda root, rel: calls.append(rel) or [])
    side = lambda line: {"path": "src/a.ts", "name": f"@{line}", "startLine": line}
    dryer_report.name_reported(Path("."), [{"left": side(1), "right": side(9)} for _ in range(5)])
    assert calls == ["src/a.ts"]


def test_marker_text_inside_a_string_is_not_a_marker():
    from markers import Comments

    def marker_reason(lines, first, last, marker):
        return Comments("\n".join(lines), "a.ts").reason(first, last, marker)

    lines = [
        'const help = "// mutation-equivalent: example";',  # 1: a string, not a comment
        "const url = 'http://x/* dry-duplicate-ok: no */';",  # 2: a string, not a comment
        'const s = "a"; // mutation-equivalent: real reason',  # 3: a real comment after a string
        "const t = `x ${y}`; /* dry-duplicate-ok: block comment */",  # 4: a template, then a comment
    ]
    assert marker_reason(lines, 1, 1, "mutation-equivalent") is None
    assert marker_reason(lines, 2, 2, "dry-duplicate-ok") is None
    assert marker_reason(lines, 3, 3, "mutation-equivalent") == "real reason"
    assert marker_reason(lines, 4, 4, "dry-duplicate-ok") == "block comment"


def test_a_marker_is_a_whole_token_and_a_jsx_comment_counts():
    from markers import Comments

    def marker_reason(lines, first, path="a.ts"):
        return Comments("\n".join(lines), path).reason(first, first, "mutation-equivalent")

    assert marker_reason(["x; // no-mutation-equivalent: not actually equivalent"], 1) is None
    assert marker_reason(["x; // see mutation-equivalent: a reason"], 1) == "a reason"
    jsx = [
        "const v = (",  # 1
        "  <div>",  # 2
        "    {/* mutation-equivalent: the label is never empty */}",  # 3
        "    {label || 'none'}",  # 4
        "  </div>",  # 5
        ");",  # 6
    ]
    assert marker_reason(jsx, 4, "a.tsx") == "the label is never empty"



def test_two_old_duplicates_moved_together_stay_quiet():
    # Base: a and b in src/a.ts already matched. The diff moves both into
    # src/b.ts as added lines, and src/a.ts keeps other code (no rename).
    base = [form("src/a.ts", "@1", 1, SHAPE), form("src/a.ts", "@20", 20, SHAPE), form("src/a.ts", "@40", 40, OTHER)]
    head = [form("src/b.ts", "@1", 1, SHAPE), form("src/b.ts", "@10", 10, SHAPE), form("src/a.ts", "@1", 1, OTHER)]
    hunks = {"src/b.ts": [[0, 0, 1, 16]], "src/a.ts": [[1, 39, 0, 0]]}
    pairs = run(head, base, ["src/a.ts", "src/b.ts"], {"src/b.ts": [[1, 16]]}, hunks)
    assert pairs == []


def test_a_third_copy_of_two_moved_duplicates_is_new():
    # Base: two duplicates in src/a.ts. The diff moves them into src/b.ts and
    # adds a third copy: each removed form covers one moved form, not two.
    base = [form("src/a.ts", "@1", 1, SHAPE), form("src/a.ts", "@20", 20, SHAPE), form("src/a.ts", "@40", 40, OTHER)]
    head = [form("src/b.ts", f"@{n}", n, SHAPE) for n in (1, 10, 20)] + [form("src/a.ts", "@1", 1, OTHER)]
    hunks = {"src/b.ts": [[0, 0, 1, 26]], "src/a.ts": [[1, 39, 0, 0]]}
    pairs = run(head, base, ["src/a.ts", "src/b.ts"], {"src/b.ts": [[1, 26]]}, hunks)
    assert names(pairs) == [("@1", "@20"), ("@10", "@20")]
