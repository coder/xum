"""Run mutants in the changed functions and print one JSON report.

mutator gives the mutation sites (which token, which replacement); this script
runs them itself. Upstream's runner fails on this repository (its import scan
reads a string in a source file as a path) and follows only relative imports,
while Xum's tests import with "@/".

Usage (through uv, with the mutate group of pyproject.toml; mutate/check.ts
calls it):

    uv run --locked --only-group mutate python scripts/mutate/mutate_report.py
        --root DIR --changes FILE --lane FILE [--lcov FILE]... [--workers N]
        [--max-mutants N] [--max-seconds N] [--max-test-files N]

`--changes` is the JSON of scripts/crap/changes.ts ({"files", "spans"}).
`--lane` lists the Bun unit-lane test files (scripts/test-unit-ci.sh
--list-all), one per line. A mutant runs against the unit tests that import
its source file: the colocated test first, then the nearest others, at most
--max-test-files. Each test file runs in its own `bun test` process, because
test files that share a process can break each other (shared temp config).
The first failing file kills the mutant. A timeout kills it too.

Every worker owns a private copy of the tracked files, so a mutant never
touches the real checkout and "@/" imports reach the mutated file.
"""

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from queue import Queue

from crapper.discover import language_of
from crapper.languages import functions_in_file
from mutator.sites import apply_site, discover_raw
from tree_sitter_language_pack import get_parser

# Reuse the CRAP gate's production-file rule and LCOV reader.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "crap"))
from crapper_report import inlined_const_users, is_production, load_coverage, suspect_windows  # noqa: E402
from markers import Comments  # noqa: E402

MARKER = "mutation-equivalent"

MAX_TEST_FILES = 10
TIMEOUT_FACTOR = 10  # mutator's default: a mutant gets 10x the baseline,
MIN_TIMEOUT = 2.0  # and at least 2 seconds.
BASELINE_TIMEOUT = 120.0  # a test file that hangs unmutated is dropped
DEADLINE = "the run's deadline came first"

EXTENSIONS = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
# The tsconfig.json, tsconfig.tooling.json and vscode/tsconfig.json paths: all map to src/.
ALIASES = ("@/", "@shared/", "xum/", "mux/")


@dataclass(frozen=True)
class Site:
    path: str
    function: str
    line: int
    anchor_line: int
    start: int
    end: int
    original: str
    mutant: str


# ---------------------------------------------------------------- test choice


def resolve(importer: str, specifier: str, files: set[str]) -> str | None:
    """The repo-relative file that an import specifier in `importer` names."""

    # Bun's `?real=1`-style suffix loads the same file.
    specifier = specifier.split("?", 1)[0]
    alias = next((a for a in ALIASES if specifier.startswith(a)), None)
    if alias is not None:
        base = "src/" + specifier[len(alias) :]
    elif specifier.startswith("."):
        base = os.path.normpath(os.path.join(os.path.dirname(importer), specifier))
    else:
        return None
    stem = base
    for ext in EXTENSIONS:
        if base.endswith(ext):
            stem = base[: -len(ext)]
            break
    for candidate in (base, *(stem + ext for ext in EXTENSIONS), *(f"{stem}/index{ext}" for ext in EXTENSIONS)):
        if candidate in files:
            return candidate
    return None


def only_types(statement) -> bool:
    """Whether every named specifier is `type X`: `import { type A } from "m"`.

    Bun drops such an import (checked on Bun 1.4.3: "m" does not load), so
    the test is no importer. One value specifier, a default or a namespace
    import keeps it.
    """

    clause = next((c for c in statement.named_children if c.type in ("import_clause", "export_clause")), None)
    if clause is None:
        return False
    named = clause if clause.type == "export_clause" else next((c for c in clause.named_children if c.type == "named_imports"), None)
    if named is None or (clause.type == "import_clause" and len(clause.named_children) > 1):
        return False  # a default or namespace import loads the module (an export clause holds only specifiers)
    specifiers = [c for c in named.named_children if c.type in ("import_specifier", "export_specifier")]
    return bool(specifiers) and all(c.child_count > 0 and c.children[0].type == "type" for c in specifiers)


def runtime_specifiers(source: bytes, tsx: bool) -> list[str]:
    """The specifiers that a test loads at run time.

    A parse, not a regex over the text: an import in a comment or a string
    fixture loads nothing, and `import type` / `export type` are erased. Only
    a test that loads the module can kill its mutants, and a phantom importer
    takes one of the capped test slots.
    """

    tree = get_parser("tsx" if tsx else "typescript").parse(source)
    found: list[str] = []
    stack = [tree.root_node]
    while stack:
        node = stack.pop()
        stack.extend(node.children)
        target = None
        if node.type in ("import_statement", "export_statement"):
            erased = (node.child_count > 1 and node.children[1].type == "type") or only_types(node)
            target = None if erased else node.child_by_field_name("source")
        elif node.type == "call_expression":
            function = node.child_by_field_name("function")
            arguments = node.child_by_field_name("arguments")
            loads = function is not None and (function.type == "import" or function.text == b"require")
            first = arguments.named_children[0] if loads and arguments is not None and arguments.named_children else None
            target = first if first is not None and first.type == "string" else None
        if target is not None:
            found.append(target.text.decode("utf-8", errors="replace")[1:-1])
    return found


def import_graph(root: Path, tests: list[str], files: set[str]) -> dict[str, set[str]]:
    """Source file -> the test files that import it directly."""

    importers: dict[str, set[str]] = {}
    for test in tests:
        source = (root / test).read_bytes()
        for specifier in runtime_specifiers(source, test.endswith((".tsx", ".jsx"))):
            target = resolve(test, specifier, files)
            if target is not None:
                importers.setdefault(target, set()).add(test)
    return importers


def colocated(source: str, test: str) -> bool:
    stem = source.rsplit(".", 1)[0]
    return test in (f"{stem}.test.ts", f"{stem}.test.tsx")


def distance(a: str, b: str) -> int:
    pa, pb = PurePosixPath(a).parent.parts, PurePosixPath(b).parent.parts
    common = 0
    for x, y in zip(pa, pb):
        if x != y:
            break
        common += 1
    return len(pa) + len(pb) - 2 * common


def choose_tests(source: str, graph: dict[str, set[str]], limit: int) -> tuple[list[str], bool]:
    """The tests to run against `source`: colocated first, then nearest. True if cut."""

    found = sorted(graph.get(source, ()), key=lambda t: (not colocated(source, t), distance(t, source), t))
    return found[:limit], len(found) > limit


# ---------------------------------------------------------------- sites


def touched(start: int, end: int, spans: list[list[float]]) -> bool:
    return any(start <= e and s <= end for s, e in spans)


def sites_in(root: Path, path: str, spans: list[list[float]]) -> list[Site]:
    """Mutation sites whose tightest enclosing function the change touched."""

    language = language_of(path)
    if language is None:
        return []
    # Bytes, not read_text: it would turn CRLF into LF and move mutator's byte offsets.
    source = (root / path).read_bytes().decode("utf-8")
    functions = functions_in_file(language, source, path, str(root))
    sites = []
    for raw in discover_raw(source, language, path):
        holders = [f for f in functions if f.start_line <= raw.line <= f.end_line]
        holder = min(holders, key=lambda f: f.end_line - f.start_line, default=None)
        if holder is None or not touched(holder.start_line, holder.end_line, spans):
            continue
        sites.append(Site(path, holder.name, raw.line, raw.anchor_line, raw.start, raw.end, raw.original, raw.mutant))
    return sites


def uncovered(site: Site, coverage: dict[str, list[dict[int, int]]] | None) -> bool:
    """With LCOV, a site whose statement line no report hit does not run."""

    if coverage is None:
        return False
    reports = coverage.get(site.path, [])
    return not any(report.get(site.anchor_line, 0) > 0 for report in reports)


def false_zero_windows(source: str, path: str, reports: list[dict[int, int]]) -> list[tuple[int, int]]:
    """Line spans where a report's zeros may be Bun's inlined-const bug.

    The CRAP gate's detector (crapper_report.py, "Bun bug: an inlined
    `const`"): a report may have run any line in such a window, so a zero
    there does not prove that a site never ran.
    """

    users = inlined_const_users(source, path) if reports else set()
    return [window for report in reports for window in suspect_windows(report, users)] if users else []


def triage(
    sites: list[Site],
    plan: dict[str, list[str]],
    coverage: dict[str, list[dict[int, int]]] | None,
    blind: set[str],
    false_zero: dict[str, list[tuple[int, int]]] | None = None,
) -> tuple[list[dict], list[Site]]:
    """Rows for the sites that do not run, and the sites that do.

    `blind` holds the tests that run without coverage (`no-coverage:` in
    scripts/test-unit-ci.sh): their hits are in no LCOV report, so a site
    that one of them covers can look uncovered. Such a site runs. So does a
    site in a `false_zero` window (false_zero_windows).
    """

    def maybe_ran(site: Site) -> bool:
        windows = (false_zero or {}).get(site.path, [])
        return any(first <= site.anchor_line <= last for first, last in windows)

    rows: list[dict] = []
    to_run: list[Site] = []
    for site in sites:
        if not plan.get(site.path):
            rows.append(row(site, "no-test"))
        elif uncovered(site, coverage) and not blind.intersection(plan[site.path]) and not maybe_ran(site):
            rows.append(row(site, "uncovered"))
        else:
            to_run.append(site)
    return rows, to_run


# ---------------------------------------------------------------- workers


def make_worker(root: Path, tracked: list[str], into: Path) -> Path:
    """A private copy of the tracked files (working-tree content) at `into`."""

    for relative in tracked:
        source = root / relative
        if not source.is_file() or source.is_symlink():
            continue
        target = into / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    if (root / "node_modules").is_dir():
        (into / "node_modules").symlink_to(root / "node_modules")
    # src/version.ts is generated (gitignored), and many modules import it.
    version = root / "src" / "version.ts"
    if version.is_file():
        shutil.copyfile(version, into / "src" / "version.ts")
    elif (into / "scripts" / "generate-version.sh").is_file():
        subprocess.run(["bash", "scripts/generate-version.sh"], cwd=into, check=True, capture_output=True)
    return into


def run_test(worker: Path, test: str, timeout: float) -> tuple[bool, float, bool]:
    """(passed, seconds, timed_out). A timeout fails. The process group dies with it."""

    started = time.monotonic()
    # ./ makes bun treat the argument as a path, not a name filter.
    proc = subprocess.Popen(
        ["bun", "test", f"./{test}"],
        cwd=worker,
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        code = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
        return False, time.monotonic() - started, True
    return code == 0, time.monotonic() - started, False


def run_mutant(worker: Path, site: Site, tests: list[str], timeouts: dict[str, float], deadline: float) -> str:
    """killed, survived, or not-run when the run's deadline cut it short."""

    path = worker / site.path
    original = path.read_bytes()
    # mutator's offsets are UTF-8 byte offsets; apply_site works on bytes.
    path.write_bytes(apply_site(original.decode("utf-8"), site.start, site.end, site.mutant).encode("utf-8"))
    try:
        for test in tests:
            left = deadline - time.monotonic()
            if left <= 0:
                return "not-run"
            passed, _seconds, timed_out = run_test(worker, test, min(timeouts[test], left))
            if timed_out and left < timeouts[test]:
                return "not-run"  # the deadline, not the test, stopped it
            if not passed:
                return "killed"
        return "survived"
    finally:
        path.write_bytes(original)


def run_all(
    root: Path,
    sites: list[Site],
    plan: dict[str, list[str]],
    free: Queue,
    worker_count: int,
    timeouts: dict[str, float],
    deadline: float,
    runner=run_mutant,
) -> list[dict]:
    """Run each site on a free worker. One crash costs one row, not the report.

    A worker whose copy of the file a crash left mutated is retired, and the
    other workers run the sites left. Only when the last worker retires does
    `free` get None, so later sites get an "error" row instead of a result
    from a wrong tree, and no thread waits on a worker that never comes back.
    """

    alive = [worker_count]
    lock = threading.Lock()

    def one(site: Site) -> dict:
        if not plan[site.path]:
            return row(site, "no-test")
        worker = free.get()
        if worker is None:
            free.put(None)
            return row(site, "error", "no worker left: an earlier crash left its copy mutated")
        try:
            return row(site, runner(worker, site, plan[site.path], timeouts, deadline))
        except Exception as error:  # noqa: BLE001 - one mutant, not the run
            try:
                clean = (worker / site.path).read_bytes() == (root / site.path).read_bytes()
            except OSError:
                clean = False
            if not clean:
                worker = None
            return row(site, "error", f"{type(error).__name__}: {error}")
        finally:
            if worker is not None:
                free.put(worker)
            else:
                with lock:
                    alive[0] -= 1
                    if alive[0] == 0:
                        free.put(None)

    if worker_count == 0:
        return []
    with ThreadPoolExecutor(worker_count) as pool:
        return list(pool.map(one, sites))


def accept_marked(root: Path, rows: list[dict]) -> None:
    """A survivor under a `mutation-equivalent:` marker (markers.py) becomes
    "equivalent", with the marker's reason. Only survivors: a marked mutant that
    a test kills is still reported as killed."""

    cache: dict[str, Comments] = {}
    for result in rows:
        if result["outcome"] != "survived":
            continue
        if result["path"] not in cache:
            source = (root / result["path"]).read_bytes().decode("utf-8")
            cache[result["path"]] = Comments(source, result["path"])
        reason = cache[result["path"]].reason(result["line"], result["line"], MARKER)
        if reason is not None:
            result["outcome"] = "equivalent"
            result["reason"] = reason


def baselines(
    tests: list[str], free: Queue, worker_count: int, deadline: float, runner=run_test
) -> tuple[dict[str, float], list[dict]]:
    """Run each test file alone, unmutated: (mutant timeouts, dropped tests).

    A baseline gets at most the time left before the run's deadline, so the
    run ends with a report before the CI step's own timeout kills it.
    """

    def one(test: str) -> tuple[bool, float, bool] | str:
        # One process per worker copy at a time, as for mutants.
        worker = free.get()
        try:
            left = deadline - time.monotonic()
            if left <= 0:
                return DEADLINE
            passed, seconds, timed_out = runner(worker, test, min(BASELINE_TIMEOUT, left))
            return DEADLINE if timed_out and left < BASELINE_TIMEOUT else (passed, seconds, timed_out)
        except Exception as error:  # noqa: BLE001 - one test, not the run
            return f"could not run: {error}"
        finally:
            free.put(worker)

    timeouts: dict[str, float] = {}
    dropped: list[dict] = []
    if worker_count == 0:
        return timeouts, dropped
    with ThreadPoolExecutor(worker_count) as pool:
        results = list(pool.map(one, tests))
    for test, result in zip(tests, results):
        if isinstance(result, str):
            dropped.append({"path": test, "reason": result})
        elif result[0]:
            timeouts[test] = max(MIN_TIMEOUT, result[1] * TIMEOUT_FACTOR)
        else:
            dropped.append({"path": test, "reason": "fails without a mutant"})
    return timeouts, dropped


# ---------------------------------------------------------------- main


def tracked_files(root: Path) -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z"], cwd=root, check=True, capture_output=True).stdout
    return [p for p in out.decode("utf-8").split("\0") if p]


def read_list(path: Path) -> list[str]:
    """Repo-relative paths, one per line, as scripts/test-unit-ci.sh lists them."""

    return [line.strip().removeprefix("./") for line in path.read_text().splitlines() if line.strip()]


def positive(value: str) -> int:
    """argparse type: 0 workers would run no mutant and report none."""

    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError(f"must be at least 1, got {number}")
    return number


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--changes", required=True, type=Path)
    parser.add_argument("--lane", required=True, type=Path)
    parser.add_argument("--lcov", action="append", default=[], type=Path)
    # The lane tests that write no LCOV (scripts/test-unit-ci.sh --list-no-coverage).
    parser.add_argument("--no-coverage-tests", type=Path)
    parser.add_argument("--workers", type=positive, default=max(1, min(4, (os.cpu_count() or 2) // 2)))
    parser.add_argument("--max-mutants", type=int, default=300)
    parser.add_argument("--max-seconds", type=float, default=15 * 60)
    parser.add_argument("--max-test-files", type=int, default=MAX_TEST_FILES)
    args = parser.parse_args(argv)
    if os.name == "nt":
        # run_test kills each test's process group (os.killpg), and the
        # workers run bash helpers: both need a POSIX host.
        print("mutate-check needs Linux or macOS: it runs no mutant on Windows", file=sys.stderr)
        return 2
    started = time.monotonic()
    root = args.root.resolve()
    changes = json.loads(args.changes.read_text(encoding="utf-8"))
    tracked = tracked_files(root)
    files = set(tracked)
    sources = sorted(
        f["headPath"] for f in changes["files"] if f["headPath"] and is_production(f["headPath"]) and (root / f["headPath"]).is_file()
    )
    sites = [site for source in sources for site in sites_in(root, source, changes["spans"].get(source, []))]
    lane = read_list(args.lane)
    graph = import_graph(root, [t for t in lane if (root / t).is_file()], files)
    coverage = load_coverage(args.lcov, root, sorted(files)) if args.lcov else None
    blind = set(read_list(args.no_coverage_tests)) if args.no_coverage_tests else set()

    plan: dict[str, list[str]] = {}
    capped: list[str] = []
    for source in sources:
        plan[source], cut = choose_tests(source, graph, args.max_test_files)
        if cut:
            capped.append(source)

    false_zero = {
        source: false_zero_windows((root / source).read_bytes().decode("utf-8"), source, coverage.get(source, []))
        for source in sources
    } if coverage is not None else None
    rows, to_run = triage(sites, plan, coverage, blind, false_zero)
    deadline = started + args.max_seconds
    # Cap first, so no baseline runs for a test that only the cut mutants use.
    budget = to_run[: args.max_mutants]
    rows += [row(site, "not-run") for site in to_run[args.max_mutants :]]

    with tempfile.TemporaryDirectory(prefix="mutate-") as scratch:
        needed = sorted({t for site in budget for t in plan[site.path]})
        workers = [make_worker(root, tracked, Path(scratch) / f"w{i}") for i in range(min(args.workers, len(budget)))]
        free: Queue = Queue()
        for worker in workers:
            free.put(worker)
        timeouts, dropped = baselines(needed, free, len(workers), deadline)
        for source in plan:
            plan[source] = [t for t in plan[source] if t in timeouts]
        rows += run_all(root, budget, plan, free, len(workers), timeouts, deadline)

    accept_marked(root, rows)
    rows.sort(key=lambda r: (r["path"], r["line"], r["original"], r["mutant"]))
    report = {
        "mutants": rows,
        "tests": {source: plan[source] for source in sources},
        "cappedTests": capped,
        "droppedTests": dropped,
        "seconds": round(time.monotonic() - started, 1),
    }
    print(json.dumps(report))
    return 0


def row(site: Site, outcome: str, reason: str | None = None) -> dict:
    result = {
        "path": site.path,
        "function": site.function,
        "line": site.line,
        "original": site.original,
        "mutant": site.mutant,
        "outcome": outcome,
    }
    if reason is not None:
        result["reason"] = reason
    return result


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
