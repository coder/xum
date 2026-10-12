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
shard hit and another missed could score as missed.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

from crapper.coverage import CoverageBundle, FileCoverage
from crapper.crap import make_entry
from crapper.discover import is_test_file, language_of
from crapper.languages import functions_in_file

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


def merge_lcov(texts: list[str], root: Path, files: list[str]) -> dict[str, dict[int, int]]:
    """Line hits per repo-relative file, summed over every record of that file.

    Coverage is line-only: Bun's LCOV has no BRDA records, and Crapper prefers
    branch data when a file has any, so Jest-only branch records would hide
    the unit-test line hits of the same function.
    """

    merged: dict[str, dict[int, int]] = {}
    lines: dict[int, int] | None = None
    for text in texts:
        for raw in text.splitlines():
            record = raw.strip()
            if record.startswith("SF:"):
                file = repo_relative(record[3:], root, files)
                lines = None if file is None else merged.setdefault(file, {})
            elif record == "end_of_record":
                lines = None
            elif lines is not None and record.startswith("DA:"):
                line, hits = record[3:].split(",")[:2]
                lines[int(line)] = lines.get(int(line), 0) + int(hits)
    return merged


def load_coverage(lcov: list[Path], root: Path, files: list[str]) -> CoverageBundle | None:
    if not lcov:
        return None
    texts = [path.read_text(encoding="utf-8", errors="replace") for path in lcov]
    bundle = CoverageBundle()
    for file, hits in merge_lcov(texts, root, files).items():
        record = FileCoverage()
        record.update({line: (1 if count > 0 else 0, 1) for line, count in hits.items()})
        bundle.lcov[file] = record
    # Lets Crapper refuse a short LCOV path that only suffix-matches a longer file.
    bundle.bind_sources(files)
    return bundle


def score(root: Path, files: list[str], bundle: CoverageBundle | None) -> list[dict]:
    rows: list[dict] = []
    for relative in files:
        source = (root / relative).read_text(encoding="utf-8", errors="replace")
        language = language_of(relative)
        assert language is not None, relative
        for function in functions_in_file(language, source, relative, str(root)):
            percent = None
            if bundle is not None:
                found = bundle.percent_for(function)
                percent = 0.0 if found is None else found
            entry = make_entry(function, percent)
            rows.append(
                {
                    "path": relative,
                    "name": entry.name,
                    "namespace": entry.namespace,
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
    parser.add_argument("files", nargs="*")
    args = parser.parse_args(argv)
    root = args.root.resolve()
    candidates = [normalize(path) for path in args.files] or tracked_src_files(root)
    # A raw changed-file list can name deleted files: there is nothing to score.
    files = sorted({path for path in candidates if is_production(path) and (root / path).is_file()})
    rows = score(root, files, load_coverage(args.lcov, root, files))
    json.dump(rows, sys.stdout)
    sys.stdout.write("\n")
    if args.top > 0:
        print_top(rows, args.top)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
