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

    {path, name, namespace, startLine, endLine, complexity, coverage, crap}

`coverage` is a fraction from 0 to 1 and `crap` is CC^2 * (1 - coverage)^3 +
CC. Both are null without --lcov. With --lcov, a function the report does not
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
        for function in functions_in_file(language, source, relative, str(root)):
            percent = None
            if coverage is not None:
                if is_code is None:
                    # Every scored src/ file is TypeScript or JavaScript today; other
                    # grammars keep every listed line.
                    is_code = (
                        code_lines(source, relative)
                        if language == "typescript"
                        else [True] * len(source.split("\n"))
                    )
                found = function_percent(coverage.get(relative, []), function.start_line, function.end_line, is_code)
                percent = 0.0 if found is None else found
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
                }
            )
    rows.sort(key=lambda row: (row["path"], row["startLine"], row["name"]))
    return rows


def print_top(rows: list[dict], count: int) -> None:
    def rank(row: dict) -> float:
        return row["crap"] if row["crap"] is not None else row["complexity"]

    worst = sorted(rows, key=rank, reverse=True)[:count]
    print(f"{len(rows)} functions. Worst {len(worst)}:", file=sys.stderr)
    for row in worst:
        crap = "" if row["crap"] is None else f"  crap {row['crap']:.1f}"
        print(
            f"  cc {row['complexity']:>4}{crap}  {row['path']}:{row['startLine']}  {row['name']}",
            file=sys.stderr,
        )


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
