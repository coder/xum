# /// script
# requires-python = ">=3.11"
# dependencies = [
#   # Crapper is the scorer; this adapter only adds file paths and line ranges,
#   # which Crapper's own `.metrics/crap.edn` omits. Pin the SHA and the exact
#   # grammar versions together: cyclomatic complexity counts come from the
#   # tree-sitter grammar, so a grammar bump can move every score.
#   "crapper @ git+https://github.com/unclebob/crapper@9f1bead298b5a9d576bdd6319289fcf426e5b18a",
#   "tree-sitter==0.26.0",
#   "tree-sitter-language-pack==1.21.3",
# ]
# ///
"""Score functions with Crapper and print one JSON row per function.

Usage (through uv, which reads the pins above):

    uv run --script scripts/crap/crapper_report.py [--root DIR] [--lcov FILE]...
        [--top N] [FILE ...]

With no FILE, it scores every production file that git tracks under `src/`.
Given FILEs (relative to --root), it keeps only the production files among
them, so callers can pass a raw changed-file list. Rows go to stdout as a JSON
array sorted by path and start line:

    {path, name, namespace, startLine, endLine, complexity, coverage, crap,
     bunInlinedConstSuspect}

`coverage` is a fraction from 0 to 1 and `crap` is CC^2 * (1 - coverage)^3 +
CC. Both are null without --lcov. `bunInlinedConstSuspect` is true when a Bun
coverage bug probably hid some of the function's coverage (see
inlined_const_suspect); it is always false without --lcov. With --lcov, a function the report does not
mention scores 0% coverage (Crapper's rule). This script never runs tests:
Crapper's own coverage command ignores every report when it fails.

Pass every LCOV report (unit and integration shards) as its own --lcov. This
script merges them, because Crapper keeps only one record per source file: a
later `SF:` record for the same file replaces the earlier one, so a line one
shard hit and another missed could score as missed. Per function, it uses only
the reports that ran the function and skips lines without code (see
code_lines): a shard that only loaded the file would otherwise add misses.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

from crapper.crap import make_entry
from crapper.discover import is_test_file, language_of
from crapper.languages import functions_in_file

from crapper.languages.treesitter import descendants, parse

# Crapper's own module-name and grammar rules (src/a/b.ts -> a.b; .tsx -> tsx),
# private at the pinned SHA.
from crapper.languages.typescript import _grammar as typescript_grammar
from crapper.languages.typescript import _module_namespace as module_namespace

# Code under src/ that never ships. Mirrors isProductionSource() in
# scripts/check-test-seam-comments.ts (keep the two in step), plus bench files.
# Crapper's is_test_file() also skips test/, tests/, spec/ and *.test.* files.
SUPPORT_DIRS = {"__tests__", "__mocks__", "test", "tests", "testing", "mocks", "stories"}
SUPPORT_NAMES = (
    re.compile(r"\.(?:test|spec)[\w-]*\.[cm]?[jt]sx?$"),
    re.compile(r"\.(?:stories|generated|bench)\.[cm]?[jt]sx?$"),
    re.compile(r"^test[A-Z_.-]"),
    re.compile(r"Test(?:Helpers?|Harness|Utils|Fixtures?|Overlay|Child)\b"),
    re.compile(r"\.\w*[fF]ixtures?\.[cm]?[jt]sx?$"),
)


def is_production(relative: str) -> bool:
    if not relative.startswith("src/") or language_of(relative) is None:
        return False
    if is_test_file(relative) or relative == "src/version.ts":
        return False
    *dirs, name = relative.split("/")
    if SUPPORT_DIRS.intersection(dirs):
        return False
    return not any(pattern.search(name) for pattern in SUPPORT_NAMES)


def normalize(relative: str) -> str:
    path = relative.replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    return path


def tracked_src_files(root: Path) -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-z", "--", "src"],
        cwd=root,
        check=True,
        capture_output=True,
    ).stdout
    return [path for path in out.decode("utf-8").split("\0") if path]


def repo_relative(sf_path: str, root: Path, files: list[str]) -> str | None:
    """Maps an LCOV `SF:` path to one of `files`, or None for other files.

    Bun writes repo-relative paths, Jest absolute ones from the CI checkout,
    which can differ from `root`. An absolute path matches the scored file it
    ends with, longest first.
    """

    path = sf_path.strip().replace("\\", "/").removeprefix("file://")
    while path.startswith("./"):
        path = path[2:]
    # A Windows drive path (C:/checkout/src/a.ts) is absolute too.
    if not (path.startswith("/") or re.match(r"^[A-Za-z]:/", path)):
        return path if path in files else None
    try:
        relative = Path(path).relative_to(root).as_posix()
        if relative in files:
            return relative
    except ValueError:
        pass
    matches = [file for file in files if path.endswith("/" + file)]
    return max(matches, key=len) if matches else None


def hits_per_report(texts: list[str], root: Path, files: list[str]) -> dict[str, list[dict[int, int]]]:
    """Line hits per repo-relative file, one map per report that lists the file.

    Records of one file inside one report are summed. Reports stay apart so
    function_percent can pick, per function, the reports that ran it.

    Coverage is line-only: Bun's LCOV has no BRDA records, and Crapper prefers
    branch data when a file has any, so Jest-only branch records would hide
    the unit-test line hits of the same function.
    """

    merged: dict[str, list[dict[int, int]]] = {}
    for text in texts:
        report: dict[str, dict[int, int]] = {}
        lines: dict[int, int] | None = None
        for raw in text.splitlines():
            record = raw.strip()
            if record.startswith("SF:"):
                file = repo_relative(record[3:], root, files)
                lines = None if file is None else report.setdefault(file, {})
            elif record == "end_of_record":
                lines = None
            elif lines is not None and record.startswith("DA:"):
                line, hits = record[3:].split(",")[:2]
                lines[int(line)] = lines.get(int(line), 0) + int(hits)
        for file, lines_hit in report.items():
            merged.setdefault(file, []).append(lines_hit)
    return merged


def load_coverage(lcov: list[Path], root: Path, files: list[str]) -> dict[str, list[dict[int, int]]] | None:
    if not lcov:
        return None
    texts = [path.read_text(encoding="utf-8", errors="replace") for path in lcov]
    return hits_per_report(texts, root, files)


# Bun lists a function's lines in two ways. A process that runs the function
# lists only its executable lines. A process that only loads the file lists
# every line of a function that never ran (and of a nested callback that never
# ran) at 0, blank, comment and brace lines included. Repro (Bun 1.3.12): a
# 9-line function lists DA 1,4,6,7,9 when called and DA 1-8 at 0 when only
# imported, so a line union scores the fully tested function 56%. Lines that
# hold only comments or punctuation carry no code, so they never count.
# Closers and separators only: a line of `[];` or `({});` can be a statement.
PUNCTUATION_ONLY = re.compile(r"[\s})\];,]*")


def code_lines(source: str, grammar_path: str) -> list[bool]:
    """Whether each line of `source` (split on newlines) holds code.

    Comments come from the tree-sitter parse, not from the line text, so a
    comment that spans lines, a JSX `{/* ... */}` and code after `*/` are all
    classified right, and `/*` inside a string ("src/**/*.ts") starts nothing.
    A JSX expression that holds only comments counts as a comment, braces
    included.
    """

    data, tree = parse(source, typescript_grammar(grammar_path))
    masked = bytearray(data)
    for node in descendants(tree.root_node):
        comment_only_jsx = node.type == "jsx_expression" and all(
            child.type == "comment" for child in node.named_children
        )
        if node.type != "comment" and not comment_only_jsx:
            continue
        for index in range(node.start_byte, node.end_byte):
            if masked[index] != ord("\n"):
                masked[index] = ord(" ")
    text = masked.decode("utf-8", errors="replace")
    return [PUNCTUATION_ONLY.fullmatch(line) is None for line in text.split("\n")]


def ran_function(span: dict[int, int]) -> bool:
    """Whether a report's lines of one function show that the function ran.

    The first line a report lists in the function's range is its entry, hit
    whenever the function runs. When it never ran, Bun lists that line at 0
    but can still count a later line of the range as hit at load (Bun 1.3.12:
    an uncalled `export const f = () => {...}` lists lines 1-4 at 0 and its
    `return` line at 2), so a hit elsewhere proves nothing.
    """

    return bool(span) and span[min(span)] > 0


def function_percent(reports: list[dict[int, int]], start: int, end: int, is_code: list[bool]) -> float | None:
    """Line coverage percent of lines start..end, or None when no report lists the file.

    Only the reports that ran the function count (see ran_function), so a
    process that loaded the file but never ran the function adds no misses.
    Their hits are summed per line, over code lines only. When no report ran
    the function, it scores 0%.
    """

    if not reports:
        return None
    spans = [{line: hits for line, hits in report.items() if start <= line <= end} for report in reports]
    merged: dict[int, int] = {}
    for span in spans:
        if not ran_function(span):
            continue
        for line, hits in span.items():
            if line <= len(is_code) and is_code[line - 1]:
                merged[line] = merged.get(line, 0) + hits
    if not merged:
        return 0.0
    return 100.0 * sum(1 for hits in merged.values() if hits > 0) / len(merged)


# Bun bug: an inlined `const` zeroes the lines above an uncalled user.
#
# REMOVAL TRIGGER: oven-sh/bun issue TBD ("bun test --coverage: an uncalled
# function that uses an inlined `const` zeroes every line from that const down
# to the function"). Seen on Bun 1.2.15 through 1.4.3, not on Node. When a
# Bun release fixes it and the repo's Bun pin (package.json packageManager)
# reaches that release, delete this block, the bunInlinedConstSuspect row
# field and its handling in scripts/crap/policy.ts and scripts/crap/ci.ts.
#
# Bun's transpiler inlines a `const` whose value is a literal. When a function
# that uses the const never runs in a test process, that process's LCOV lists
# every line from the literal's line down to the uncalled function at 0 hits,
# lines that ran included. Repro (Bun 1.4.3), with a test that only imports m:
#
#     const A = 1;                                  DA:1,12
#     const B = 2;                                  DA:2,0
#     const C = 3;                                  DA:3,0
#                                                   DA:4,0
#     export function unused(x: number): number {   DA:5,0
#       return x + B;
#     }
#
# With `let B = 2` it lists DA:2,10 and DA:3,12. A function between B and
# `unused` that the test calls lists all its lines at 0 too, so the report
# hides that it ran, and the file's real coverage is lost.
#
# The detector flags a function F only when one report shows the bug's exact
# shape: an unbroken run of listed 0-hit lines (blank lines included, which a
# process that ran the code never lists) that starts on the line of a literal
# const's value and ends inside a later function U that uses the const. Lines
# from the const down to U's start are suspect: that report may have run any
# of them. F is flagged when it overlaps them and scores below 100%. A flagged
# row keeps its score: a function that never ran also matches when it sits in
# that range, so the gate warns instead of dropping it.
INLINED_LITERALS = {"string", "number", "true", "false", "null", "undefined"}
# Wrappers that keep a literal inlinable (checked on Bun 1.4.3).
LITERAL_WRAPPERS = {"parenthesized_expression", "as_expression", "satisfies_expression"}
FUNCTION_NODES = {
    "function_declaration",
    "generator_function_declaration",
    "function_expression",
    "generator_function",
    "arrow_function",
    "method_definition",
}


def inlined_literal(node) -> bool:
    """Whether Bun inlines a const with this initializer.

    Kept to the cases checked on Bun 1.4.3: `1n`, `Number(2)`, `"a" + "b"` and
    `let`/`var` do not trigger the bug. Bun also folds `a${1}` into a literal;
    only templates with no substitution count here.
    """

    while node.type in LITERAL_WRAPPERS and node.named_children:
        node = node.named_children[0]
    if node.type == "unary_expression" and node.child_count == 2 and node.children[0].type == "-":
        node = node.children[1]
        return node.type == "number" and not node.text.endswith(b"n")
    if node.type == "number":
        return not node.text.endswith(b"n")
    if node.type == "template_string":
        return not any(child.type == "template_substitution" for child in node.children)
    return node.type in INLINED_LITERALS or (node.type == "identifier" and node.text == b"undefined")


def runs_whenever_called(body, declaration) -> bool:
    """Whether nothing in `body` before `declaration` can skip it: no return, throw or call.

    Every earlier statement must be a declaration whose values are all literals
    (inlined_literal) or absent, so the declaration runs whenever the function
    does.
    """

    for statement in body.named_children:
        if statement.start_byte >= declaration.start_byte:
            return True
        if statement.type == "comment":
            continue
        if statement.type != "lexical_declaration":
            return False
        for declarator in statement.named_children:
            value = declarator.child_by_field_name("value")
            if value is not None and not inlined_literal(value):
                return False
    return True


def literal_const_scopes(root) -> dict[str, list[tuple[int, object]]]:
    """Literal consts by name: (value line, scope node) for each declaration.

    Only module-scope consts and consts directly in a function body: a block
    inside a function (an `if` body) may not run when the function does. A
    body const after a statement that can return, throw or call is skipped
    too: when the function leaves early, a correct report also lists the const
    and an uncalled closure that uses it at 0.
    """

    consts: dict[str, list[tuple[int, object]]] = {}
    for node in descendants(root):
        if node.type != "lexical_declaration" or node.child_count == 0 or node.children[0].type != "const":
            continue
        scope = node.parent
        if scope is not None and scope.type == "export_statement":
            scope = scope.parent
        is_function_body = (
            scope is not None and scope.type == "statement_block" and scope.parent.type in FUNCTION_NODES
        )
        if scope is None or not (scope.type == "program" or is_function_body):
            continue
        if is_function_body and not runs_whenever_called(scope, node):
            continue
        for declarator in node.named_children:
            name = declarator.child_by_field_name("name")
            value = declarator.child_by_field_name("value")
            if name is None or value is None or name.type != "identifier" or not inlined_literal(value):
                continue
            consts.setdefault(name.text.decode("utf-8"), []).append((value.start_point[0] + 1, scope))
    return consts


def inlined_const_users(source: str, grammar_path: str) -> set[tuple[int, int, int]]:
    """(literal line, user start, user end) per literal const and later function that uses it.

    A use is an identifier with the const's name inside the const's scope, in
    a function that starts below the literal. Shadowing is not resolved.
    """

    _, tree = parse(source, typescript_grammar(grammar_path))
    consts = literal_const_scopes(tree.root_node)
    users: set[tuple[int, int, int]] = set()
    if not consts:
        return users
    for node in descendants(tree.root_node):
        if node.type not in {"identifier", "shorthand_property_identifier"}:
            continue
        declarations = consts.get(node.text.decode("utf-8"))
        if not declarations:
            continue
        functions = []
        current = node.parent
        while current is not None:
            if current.type in FUNCTION_NODES:
                functions.append(current)
            current = current.parent
        for line, scope in declarations:
            if not scope.start_byte <= node.start_byte < scope.end_byte:
                continue
            for function in functions:
                start, end = function.start_point[0] + 1, function.end_point[0] + 1
                if start > line:
                    users.add((line, start, end))
    return users


def zero_runs(report: dict[int, int]) -> dict[int, tuple[int, int]]:
    """The run (first, last) of consecutive listed 0-hit lines, keyed by its first line."""

    runs: dict[int, tuple[int, int]] = {}
    run: list[int] = []
    for line in sorted(report):
        if report[line] == 0 and run and line == run[-1] + 1:
            run.append(line)
            continue
        if run:
            runs[run[0]] = (run[0], run[-1])
        run = [line] if report[line] == 0 else []
    if run:
        runs[run[0]] = (run[0], run[-1])
    return runs


def suspect_windows(report: dict[int, int], users: set[tuple[int, int, int]]) -> list[tuple[int, int]]:
    """Line spans one report zeroed through the inlined-const bug: literal line to user start - 1."""

    runs = zero_runs(report)
    windows = []
    for line, start, end in users:
        run = runs.get(line)
        if run is not None and start <= run[1] <= end:
            windows.append((line, start - 1))
    return windows


def inlined_const_suspect(windows: list[list[tuple[int, int]]], start: int, end: int, percent: float) -> bool:
    """Whether the inlined-const bug may have hidden some of this function's coverage (see above).

    A zeroed report may have run any line in its window, and other reports
    cannot show which lines it covered, so only full coverage clears the flag.
    """

    overlaps = any(first <= end and start <= last for report_windows in windows for first, last in report_windows)
    return overlaps and percent < 100.0


def score(
    root: Path, files: list[str], coverage: dict[str, list[dict[int, int]]] | None, renames: dict[str, str]
) -> list[dict]:
    rows: list[dict] = []
    for relative in files:
        source = (root / relative).read_text(encoding="utf-8", errors="replace")
        language = language_of(relative)
        assert language is not None, relative
        # A renamed file is parsed (grammar), filtered and matched to coverage at
        # its own path, but named after its new path and module, so its functions
        # keep their identity.
        shown = renames.get(relative, relative)
        old_module = module_namespace(relative, str(root))
        new_module = module_namespace(shown, str(root))
        is_code: list[bool] | None = None
        reports = [] if coverage is None else coverage.get(relative, [])
        windows: list[list[tuple[int, int]]] = []
        for function in functions_in_file(language, source, relative, str(root)):
            percent = None
            suspect = False
            if coverage is not None:
                if is_code is None:
                    # Every scored src/ file is TypeScript or JavaScript today; other
                    # grammars keep every listed line.
                    typescript = language == "typescript"
                    is_code = code_lines(source, relative) if typescript else [True] * len(source.split("\n"))
                    users = inlined_const_users(source, relative) if typescript and reports else set()
                    windows = [suspect_windows(report, users) for report in reports] if users else []
                found = function_percent(reports, function.start_line, function.end_line, is_code)
                percent = 0.0 if found is None else found
                suspect = inlined_const_suspect(windows, function.start_line, function.end_line, percent)
            entry = make_entry(function, percent)
            assert entry.namespace.startswith(old_module), (entry.namespace, old_module)
            rows.append(
                {
                    "path": shown,
                    "name": entry.name,
                    "namespace": new_module + entry.namespace[len(old_module) :],
                    "startLine": function.start_line,
                    "endLine": function.end_line,
                    "complexity": entry.complexity,
                    "coverage": None if entry.coverage is None else round(entry.coverage / 100, 4),
                    "crap": entry.crap,
                    "bunInlinedConstSuspect": suspect,
                }
            )
    rows.sort(key=lambda row: (row["path"], row["startLine"], row["name"]))
    return rows


def print_top(rows: list[dict], count: int) -> None:
    def rank(row: dict) -> float:
        return row["crap"] if row["crap"] is not None else row["complexity"]

    def show(row: dict) -> None:
        crap = "" if row["crap"] is None else f"  crap {row['crap']:.1f}"
        print(
            f"  cc {row['complexity']:>4}{crap}  {row['path']}:{row['startLine']}  {row['name']}",
            file=sys.stderr,
        )

    worst = sorted(rows, key=rank, reverse=True)[:count]
    print(f"{len(rows)} functions. Worst {len(worst)}:", file=sys.stderr)
    for row in worst:
        show(row)
    suspects = [row for row in rows if row["bunInlinedConstSuspect"]]
    if suspects:
        print(
            f"{len(suspects)} functions whose coverage the Bun inlined-const bug may hide"
            f" (bunInlinedConstSuspect, see crapper_report.py). Worst {min(count, len(suspects))}:",
            file=sys.stderr,
        )
        for row in sorted(suspects, key=rank, reverse=True)[:count]:
            show(row)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--lcov", type=Path, action="append", default=[])
    parser.add_argument("--top", type=int, default=0, help="also print the worst N to stderr")
    parser.add_argument(
        "--rename",
        nargs=2,
        action="append",
        default=[],
        metavar=("FILE", "AS"),
        help="score FILE but report its functions under the path AS",
    )
    parser.add_argument("files", nargs="*")
    args = parser.parse_args(argv)
    root = args.root.resolve()
    candidates = [normalize(path) for path in args.files] or tracked_src_files(root)
    # A raw changed-file list can name deleted files: there is nothing to score.
    files = sorted({path for path in candidates if is_production(path) and (root / path).is_file()})
    rows = score(root, files, load_coverage(args.lcov, root, files), dict(args.rename))
    json.dump(rows, sys.stdout)
    sys.stdout.write("\n")
    if args.top > 0:
        print_top(rows, args.top)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
