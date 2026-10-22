# /// script
# requires-python = ">=3.11"
# dependencies = [
#   # mutator gives the mutation sites (which token, which replacement); this
#   # script runs them itself. Upstream's runner fails on this repository (its
#   # import scan reads a string in a source file as a path) and follows only
#   # relative imports, while Xum's tests import with "@/". Crapper names the
#   # functions; keep its SHA and the grammar pins equal to
#   # scripts/crap/crapper_report.py.
#   "mutator @ git+https://github.com/unclebob/mutator@a5a0cb803b66e0cdb8bf471b3b08af701d424a41",
#   "crapper @ git+https://github.com/unclebob/crapper@9f1bead298b5a9d576bdd6319289fcf426e5b18a",
#   "tree-sitter==0.26.0",
#   "tree-sitter-language-pack==1.21.3",
# ]
# ///
"""Run mutants in the changed functions and print one JSON report.

Usage (through uv, which reads the pins above; mutate/check.ts calls it):

    uv run --script scripts/mutate/mutate_report.py --root DIR --changes FILE
        --lane FILE [--lcov FILE]... [--workers N] [--max-mutants N]
        [--max-seconds N] [--max-test-files N]

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
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from queue import Queue

from crapper.discover import language_of
from crapper.languages import functions_in_file
from mutator.sites import apply_site, discover_raw

# Reuse the CRAP gate's production-file rule and LCOV reader.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "crap"))
from crapper_report import is_production, load_coverage  # noqa: E402
from markers import marker_reason  # noqa: E402

MARKER = "mutation-equivalent"

MAX_TEST_FILES = 10
TIMEOUT_FACTOR = 10  # mutator's default: a mutant gets 10x the baseline,
MIN_TIMEOUT = 2.0  # and at least 2 seconds.
BASELINE_TIMEOUT = 120.0  # a test file that hangs unmutated is dropped

EXTENSIONS = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
SPECIFIER = re.compile(r"""(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"'\n]+)["']""")


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

    if specifier.startswith("@/"):
        base = "src/" + specifier[2:]
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


def import_graph(root: Path, tests: list[str], files: set[str]) -> dict[str, set[str]]:
    """Source file -> the test files that import it directly."""

    importers: dict[str, set[str]] = {}
    for test in tests:
        text = (root / test).read_text(encoding="utf-8", errors="replace")
        for specifier in SPECIFIER.findall(text):
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

    A worker whose copy of the file a crash left mutated is retired: its slot
    in `free` becomes None, so later sites get an "error" row instead of a
    result from a wrong tree, and no thread waits on a worker that never
    comes back.
    """

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
            free.put(worker)

    if worker_count == 0:
        return []
    with ThreadPoolExecutor(worker_count) as pool:
        return list(pool.map(one, sites))


def accept_marked(root: Path, rows: list[dict]) -> None:
    """A survivor under a `mutation-equivalent:` marker (markers.py) becomes
    "equivalent", with the marker's reason. Only survivors: a marked mutant that
    a test kills is still reported as killed."""

    cache: dict[str, list[str]] = {}
    for result in rows:
        if result["outcome"] != "survived":
            continue
        if result["path"] not in cache:
            cache[result["path"]] = (root / result["path"]).read_bytes().decode("utf-8").split("\n")
        reason = marker_reason(cache[result["path"]], result["line"], result["line"], MARKER)
        if reason is not None:
            result["outcome"] = "equivalent"
            result["reason"] = reason


# ---------------------------------------------------------------- main


def tracked_files(root: Path) -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z"], cwd=root, check=True, capture_output=True).stdout
    return [p for p in out.decode("utf-8").split("\0") if p]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--changes", required=True, type=Path)
    parser.add_argument("--lane", required=True, type=Path)
    parser.add_argument("--lcov", action="append", default=[], type=Path)
    parser.add_argument("--workers", type=int, default=max(1, min(4, (os.cpu_count() or 2) // 2)))
    parser.add_argument("--max-mutants", type=int, default=300)
    parser.add_argument("--max-seconds", type=float, default=15 * 60)
    parser.add_argument("--max-test-files", type=int, default=MAX_TEST_FILES)
    args = parser.parse_args(argv)
    started = time.monotonic()
    root = args.root.resolve()
    changes = json.loads(args.changes.read_text(encoding="utf-8"))
    tracked = tracked_files(root)
    files = set(tracked)
    sources = sorted(
        f["headPath"] for f in changes["files"] if f["headPath"] and is_production(f["headPath"]) and (root / f["headPath"]).is_file()
    )
    sites = [site for source in sources for site in sites_in(root, source, changes["spans"].get(source, []))]
    lane = [line.strip().removeprefix("./") for line in args.lane.read_text().splitlines() if line.strip()]
    graph = import_graph(root, [t for t in lane if (root / t).is_file()], files)
    coverage = load_coverage(args.lcov, root, sorted(files)) if args.lcov else None

    plan: dict[str, list[str]] = {}
    capped: list[str] = []
    for source in sources:
        plan[source], cut = choose_tests(source, graph, args.max_test_files)
        if cut:
            capped.append(source)

    rows: list[dict] = []
    to_run: list[Site] = []
    for site in sites:
        if not plan.get(site.path):
            rows.append(row(site, "no-test"))
        elif uncovered(site, coverage):
            rows.append(row(site, "uncovered"))
        else:
            to_run.append(site)

    dropped: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="mutate-") as scratch:
        needed = sorted({t for site in to_run for t in plan[site.path]})
        workers = [make_worker(root, tracked, Path(scratch) / f"w{i}") for i in range(min(args.workers, max(1, len(to_run))))] if to_run else []
        # Baselines: each test file must pass alone, unmutated.
        timeouts: dict[str, float] = {}
        free: Queue = Queue()
        for worker in workers:
            free.put(worker)

        def baseline(test: str) -> tuple[bool, float, bool] | str:
            # One process per worker copy at a time, as for mutants.
            worker = free.get()
            try:
                return run_test(worker, test, BASELINE_TIMEOUT)
            except Exception as error:  # noqa: BLE001 - one test, not the run
                return f"could not run: {error}"
            finally:
                free.put(worker)

        if workers:
            with ThreadPoolExecutor(len(workers)) as pool:
                results = list(pool.map(baseline, needed))
            for test, result in zip(needed, results):
                if isinstance(result, str):
                    dropped.append({"path": test, "reason": result})
                elif result[0]:
                    timeouts[test] = max(MIN_TIMEOUT, result[1] * TIMEOUT_FACTOR)
                else:
                    dropped.append({"path": test, "reason": "fails without a mutant"})
        for source in plan:
            plan[source] = [t for t in plan[source] if t in timeouts]

        budget = to_run[: args.max_mutants]
        rows += [row(site, "not-run") for site in to_run[args.max_mutants :]]
        rows += run_all(root, budget, plan, free, len(workers), timeouts, started + args.max_seconds)

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
