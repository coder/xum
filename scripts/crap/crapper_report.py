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

    uv run --script scripts/crap/crapper_report.py [--root DIR] [--lcov FILE]
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
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

from crapper.coverage import CoverageBundle, parse_lcov
from crapper.crap import make_entry
from crapper.discover import is_test_file, language_of
from crapper.languages import functions_in_file

# Code under src/ that never ships. Crapper already skips `*.test.ts(x)`.
NON_PRODUCTION_SUFFIXES = (".stories.tsx", ".stories.ts", ".testHarness.ts", ".testHarness.tsx")
NON_PRODUCTION_DIRS = ("src/browser/stories/",)


def is_production(relative: str) -> bool:
    if not relative.startswith("src/") or language_of(relative) is None:
        return False
    if is_test_file(relative) or relative.endswith(NON_PRODUCTION_SUFFIXES):
        return False
    return not relative.startswith(NON_PRODUCTION_DIRS)


def tracked_src_files(root: Path) -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-z", "--", "src"],
        cwd=root,
        check=True,
        capture_output=True,
    ).stdout
    return [path for path in out.decode("utf-8").split("\0") if path]


def load_coverage(lcov: Path | None, files: list[str]) -> CoverageBundle | None:
    if lcov is None:
        return None
    bundle = CoverageBundle(lcov=parse_lcov(lcov.read_text(encoding="utf-8", errors="replace")))
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
    parser.add_argument("--lcov", type=Path)
    parser.add_argument("--top", type=int, default=0, help="also print the worst N to stderr")
    parser.add_argument("files", nargs="*")
    args = parser.parse_args(argv)
    root = args.root.resolve()
    candidates = args.files or tracked_src_files(root)
    files = sorted({path for path in candidates if is_production(path)})
    rows = score(root, files, load_coverage(args.lcov, files))
    json.dump(rows, sys.stdout)
    sys.stdout.write("\n")
    if args.top > 0:
        print_top(rows, args.top)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
