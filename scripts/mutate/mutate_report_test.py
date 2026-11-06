"""Tests of the mutation runner's choices: which sites, which tests, which skip.

Run through `make test-mutate-scripts`, which supplies mutator, Crapper and
pytest. The end-to-end run (real bun processes) is in check.test.ts.
"""

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mutate_report import Site, import_graph, resolve, sites_in, choose_tests, uncovered  # noqa: E402


def write(root: Path, files: dict[str, str]) -> None:
    for path, text in files.items():
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_text(text)


def test_resolve_reads_alias_relative_extension_and_index_imports():
    files = {"src/a/b.ts", "src/a/c.tsx", "src/a/d/index.ts"}
    assert resolve("src/a/x.test.ts", "@/a/b", files) == "src/a/b.ts"
    assert resolve("src/a/x.test.ts", "./c", files) == "src/a/c.tsx"
    assert resolve("src/a/x.test.ts", "./b.js", files) == "src/a/b.ts"
    assert resolve("src/a/e/x.test.ts", "../d", files) == "src/a/d/index.ts"
    assert resolve("src/a/x.test.ts", "react", files) is None
    # The tsconfig aliases all map to src/, and Bun's ?query suffix names the same file.
    for alias in ("@shared/", "xum/", "mux/"):
        assert resolve("vscode/src/x.test.ts", f"{alias}a/b", files) == "src/a/b.ts"
    assert resolve("src/a/x.test.ts", "./c?real=1", files) == "src/a/c.tsx"


def test_the_graph_reads_dynamic_imports_but_not_strings(tmp_path):
    write(
        tmp_path,
        {
            "src/a.ts": "",
            "src/b.ts": "",
            "src/t.test.ts": 'const m = await import("@/a");\nconst s = "from ./b";\n',
        },
    )
    graph = import_graph(tmp_path, ["src/t.test.ts"], {"src/a.ts", "src/b.ts"})
    assert graph == {"src/a.ts": {"src/t.test.ts"}}


def test_the_graph_skips_type_only_commented_and_fixture_imports(tmp_path):
    # None of these load the module at run time, so none can kill a mutant there.
    test = "\n".join(
        [
            'import type { A } from "@/a";',
            'export type { A2 } from "@/a";',
            '// import { b } from "@/b";',
            'const fixture = `import { c } from "@/c";`;',
            'const text = "import { c } from \'@/c\'";',
            'import { d } from "@/d";',
            'export * from "@/e";',
            'const f = require("./f");',
            'import { type G } from "@/g";',  # Bun drops it: every specifier is a type
            'import { type H, h } from "@/h";',  # h is a value, so the module loads
            'export { type I } from "@/i";',
            'export { type J, type J2 } from "@/j";',  # erased too: more than one type specifier
            'export { type K, k } from "@/k";',  # k is a value, so the module loads
        ]
    )
    files = {f"src/{name}.ts" for name in "abcdefghijk"}
    write(tmp_path, {**{path: "" for path in files}, "src/t.test.ts": test})
    graph = import_graph(tmp_path, ["src/t.test.ts"], files)
    assert sorted(graph) == ["src/d.ts", "src/e.ts", "src/f.ts", "src/h.ts", "src/k.ts"]


def test_tests_for_puts_the_colocated_test_first_then_the_nearest_and_cuts():
    source = "src/a/b/x.ts"
    graph = {
        source: {
            "src/far/away/y.test.ts",
            "src/a/b/z.test.ts",
            "src/a/b/x.test.ts",
            "src/a/w.test.ts",
        }
    }
    chosen, cut = choose_tests(source, graph, 3)
    assert chosen == ["src/a/b/x.test.ts", "src/a/b/z.test.ts", "src/a/w.test.ts"]
    assert cut is True
    assert choose_tests(source, graph, 10)[1] is False


def test_only_sites_in_a_touched_function_count(tmp_path):
    write(
        tmp_path,
        {
            "src/m.ts": (
                "export function kept(n: number) {\n"  # 1
                "  return n > 1;\n"  # 2
                "}\n"  # 3
                "export function edited(n: number) {\n"  # 4
                "  return n === 0;\n"  # 5
                "}\n"
            )
        },
    )
    sites = sites_in(tmp_path, "src/m.ts", [[5, 5]])
    assert {site.function for site in sites} == {"edited"}
    assert ("===", "!==") in {(site.original, site.mutant) for site in sites}


def test_non_ascii_text_before_a_site_keeps_the_byte_offsets(tmp_path):
    write(tmp_path, {"src/m.ts": 'export function f(n: number) {\n  const s = "→";\n  return n === 0;\n}\n'})
    (site,) = [s for s in sites_in(tmp_path, "src/m.ts", [[1, 4]]) if s.original == "==="]
    data = (tmp_path / "src/m.ts").read_bytes()
    assert data[site.start : site.end] == b"==="


def site(line: int) -> Site:
    return Site("src/m.ts", "f", line, line, 0, 1, "<", "<=")


def test_lcov_skips_only_sites_on_lines_no_report_hit():
    coverage = {"src/m.ts": [{3: 0, 4: 2}, {3: 0}]}
    assert uncovered(site(3), coverage) is True
    assert uncovered(site(4), coverage) is False
    assert uncovered(site(4), {}) is True  # a file no report lists did not run
    assert uncovered(site(3), None) is False  # no LCOV: every site runs


def test_a_site_whose_test_runs_without_coverage_is_not_skipped_as_uncovered():
    from mutate_report import triage

    rows, to_run = triage([site(3)], {"src/m.ts": ["src/m.test.ts"]}, {"src/m.ts": [{3: 0}]}, set())
    assert [r["outcome"] for r in rows] == ["uncovered"] and to_run == []
    # src/m.test.ts writes no LCOV (a `no-coverage:` file), so line 3 can still run.
    rows, to_run = triage([site(3)], {"src/m.ts": ["src/m.test.ts"]}, {"src/m.ts": [{3: 0}]}, {"src/m.test.ts"})
    assert rows == [] and to_run == [site(3)]


def test_baselines_get_only_the_time_left_before_the_run_deadline():
    from mutate_report import baselines

    given = []

    def runner(_worker, _test, timeout):
        given.append(timeout)
        return True, 0.1, False

    timeouts, dropped = baselines(["a", "b"], queue_of("w"), 1, time.monotonic() + 30, runner)
    assert sorted(timeouts) == ["a", "b"] and dropped == [] and max(given) <= 30
    timeouts, dropped = baselines(["a"], queue_of("w"), 1, time.monotonic() - 1, runner)
    assert timeouts == {} and [d["path"] for d in dropped] == ["a"]
    assert len(given) == 2  # past the deadline, no baseline starts


def fake_bun(tmp_path, monkeypatch, behaviors: dict[str, str]) -> None:
    """Puts a `bun` on PATH whose `bun test ./<file>` runs the shell snippet chosen by <file>."""

    cases = "\n".join(f"  ./{name}) {body} ;;" for name, body in behaviors.items())
    bin_dir = tmp_path / "fake-bin"
    bin_dir.mkdir()
    script = bin_dir / "bun"
    script.write_text(f'#!/bin/sh\ncase "$2" in\n{cases}\nesac\n')
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")


def test_a_slow_baseline_that_keeps_printing_is_not_dropped_but_a_silent_one_is(tmp_path, monkeypatch):
    # A baseline of installService.test.ts takes 80 to 145 s on a loaded host, over the old 120 s
    # cap, and the mutants of that file were then silently not run. Slow is not hung: a hang
    # prints nothing (scripts/test-unit-ci.sh cuts a file after BUN_TEST_STALL_SECS of silence).
    import mutate_report
    from mutate_report import baselines

    # Shrunk so the test runs in seconds: the stall limit is 1.5 s, and the slow file runs for 3 s.
    monkeypatch.setattr(mutate_report, "BASELINE_STALL", 1.5)
    fake_bun(
        tmp_path,
        monkeypatch,
        {
            "slow.test.ts": "for i in 1 2 3 4 5 6; do echo \"(pass) $i\"; sleep 0.5; done",
            "hung.test.ts": "echo started; sleep 30",
            "broken.test.ts": "echo '(fail) broken'; exit 1",
        },
    )
    worker = tmp_path / "w"
    worker.mkdir()
    tests = ["slow.test.ts", "hung.test.ts", "broken.test.ts"]

    timeouts, dropped = baselines(tests, queue_of(worker), 1, time.monotonic() + 60)

    assert sorted(timeouts) == ["slow.test.ts"]
    assert timeouts["slow.test.ts"] >= 3.0 * 10  # scaled from the measured 3 s, not capped
    reasons = {d["path"]: d["reason"] for d in dropped}
    assert sorted(reasons) == ["broken.test.ts", "hung.test.ts"]
    assert reasons["broken.test.ts"] == "fails without a mutant"
    assert "printed nothing" in reasons["hung.test.ts"]


def test_a_baseline_that_prints_a_lot_keeps_none_of_it(tmp_path, monkeypatch):
    # The runner needs only to see that output arrives. A baseline that loops printing would fill
    # the disk if its output were kept in a file until the run's deadline, so stdout must be a pipe
    # that the runner drains. The fake bun fails unless its stdout is a pipe.
    from mutate_report import baselines

    fake_bun(
        tmp_path,
        monkeypatch,
        {"loud.test.ts": '[ -p /dev/stdout ] || exit 1; head -c 20000000 /dev/zero | tr "\\0" x; exit 0'},
    )
    worker = tmp_path / "w"
    worker.mkdir()

    timeouts, dropped = baselines(["loud.test.ts"], queue_of(worker), 1, time.monotonic() + 60)

    assert sorted(timeouts) == ["loud.test.ts"] and dropped == []


def test_a_baseline_that_prints_only_on_stderr_is_kept_when_slow_and_never_blocks(tmp_path, monkeypatch):
    # Bun writes its "(pass) <test>" lines to stderr, so stderr is the activity signal. It must be
    # the same drained pipe as stdout: ignored, the slow file looks hung; a second pipe that nobody
    # reads, a file that prints a lot blocks on a full pipe.
    import mutate_report
    from mutate_report import baselines

    monkeypatch.setattr(mutate_report, "BASELINE_STALL", 1.5)
    fake_bun(
        tmp_path,
        monkeypatch,
        {
            "slow.test.ts": 'for i in 1 2 3 4 5 6; do echo "(pass) $i" >&2; sleep 0.5; done',
            "loud.test.ts": 'head -c 20000000 /dev/zero | tr "\\0" x >&2; exit 0',
        },
    )
    worker = tmp_path / "w"
    worker.mkdir()

    timeouts, dropped = baselines(["slow.test.ts", "loud.test.ts"], queue_of(worker), 1, time.monotonic() + 60)

    assert sorted(timeouts) == ["loud.test.ts", "slow.test.ts"] and dropped == []


def test_the_output_drain_keeps_none_of_what_it_reads():
    # A baseline that loops printing must not fill memory either. 50 MB go through in 64 KB chunks;
    # a drain that kept them would peak at 50 MB.
    import tracemalloc
    from mutate_report import drain_output

    class Stream:
        def __init__(self):
            self.left = 800

        def read1(self, size):
            self.left -= 1
            return bytes(size) if self.left >= 0 else b""

    seen = []
    tracemalloc.start()
    try:
        drain_output(Stream(), lambda: seen.append(1))
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()

    assert len(seen) == 800  # each chunk counted as activity
    assert peak < 5_000_000


def test_a_baseline_is_bounded_only_by_the_time_left_and_by_silence(tmp_path, monkeypatch):
    # Whatever a cap is called, it would cut a file that is slow but keeps printing. Two views of it:
    # the runner is given the whole time left, and a baseline that runs 300 s on the module's clock
    # (a clock that runs 100 times faster) is kept, which no cap under 300 s lets through.
    import mutate_report
    from mutate_report import baselines

    given = []

    def runner(_worker, _test, timeout):
        given.append(timeout)
        return True, 0.1, False

    baselines(["a"], queue_of("w"), 1, time.monotonic() + 100_000, runner)
    assert given[0] > 99_000

    real_monotonic = time.monotonic
    monkeypatch.setattr(mutate_report.time, "monotonic", lambda: real_monotonic() * 100)
    fake_bun(tmp_path, monkeypatch, {"slow.test.ts": 'for i in 1 2 3 4 5 6 7 8 9 10; do echo "(pass) $i"; sleep 0.3; done'})
    worker = tmp_path / "w"
    worker.mkdir()

    timeouts, dropped = baselines(["slow.test.ts"], queue_of(worker), 1, mutate_report.time.monotonic() + 10_000_000)

    assert sorted(timeouts) == ["slow.test.ts"] and dropped == []


def test_a_dropped_baseline_leaves_no_process_behind(tmp_path, monkeypatch):
    # The whole process group goes with a hung file: bun's own children must not outlive it.
    import mutate_report
    from mutate_report import baselines

    monkeypatch.setattr(mutate_report, "BASELINE_STALL", 1.0)
    pidfile = tmp_path / "child.pid"
    fake_bun(tmp_path, monkeypatch, {"hung.test.ts": f"sleep 30 & echo $! > {pidfile}; echo started; wait"})
    worker = tmp_path / "w"
    worker.mkdir()

    timeouts, dropped = baselines(["hung.test.ts"], queue_of(worker), 1, time.monotonic() + 60)

    assert timeouts == {} and "printed nothing" in dropped[0]["reason"]
    child = int(pidfile.read_text())

    def alive() -> bool:
        try:
            os.kill(child, 0)
        except ProcessLookupError:
            return False
        return True

    # A killed child can linger briefly as an unreaped zombie.
    for _ in range(100):
        if not alive():
            break
        time.sleep(0.05)
    assert not alive()


def test_a_baseline_stopped_by_the_run_deadline_says_so(tmp_path, monkeypatch):
    import mutate_report
    from mutate_report import DEADLINE, baselines

    monkeypatch.setattr(mutate_report, "BASELINE_STALL", 30.0)
    # Bounded (8 s), so a runner that ignores the deadline fails the assertion instead of hanging.
    fake_bun(tmp_path, monkeypatch, {"busy.test.ts": "for i in $(seq 1 40); do echo tick; sleep 0.2; done"})
    worker = tmp_path / "w"
    worker.mkdir()

    timeouts, dropped = baselines(["busy.test.ts"], queue_of(worker), 1, time.monotonic() + 1.5)

    assert timeouts == {} and dropped == [{"path": "busy.test.ts", "reason": DEADLINE}]


def test_a_mutant_past_the_deadline_is_not_run_and_the_file_is_restored(tmp_path):
    write(tmp_path, {"src/m.ts": "export const f = (n: number) => n < 1;\n"})
    from mutate_report import run_mutant

    s = Site("src/m.ts", "f", 1, 1, 34, 35, "<", "<=")
    assert run_mutant(tmp_path, s, ["src/m.test.ts"], {"src/m.test.ts": 5.0}, deadline=0.0) == "not-run"
    assert (tmp_path / "src/m.ts").read_text() == "export const f = (n: number) => n < 1;\n"


def queue_of(*workers):
    from queue import Queue

    q = Queue()
    for worker in workers:
        q.put(worker)
    return q


def two_sites():
    return [Site("src/m.ts", "f", 1, 1, 0, 1, "<", "<="), Site("src/m.ts", "f", 2, 2, 0, 1, ">", ">=")]


def test_one_crashing_mutant_costs_one_row_not_the_report(tmp_path):
    from mutate_report import run_all

    root, worker = tmp_path / "root", tmp_path / "w0"
    write(root, {"src/m.ts": "same\n"})
    write(worker, {"src/m.ts": "same\n"})

    def runner(_worker, site, _tests, _timeouts, _deadline):
        if site.line == 1:
            raise RuntimeError("bun crashed")
        return "killed"

    rows = run_all(root, two_sites(), {"src/m.ts": ["t"]}, queue_of(worker), 1, {}, 0.0, runner)
    assert [(r["line"], r["outcome"], r.get("reason")) for r in rows] == [
        (1, "error", "RuntimeError: bun crashed"),
        (2, "killed", None),
    ]


def test_a_crash_that_leaves_the_copy_mutated_retires_the_worker(tmp_path):
    from mutate_report import run_all

    root, worker = tmp_path / "root", tmp_path / "w0"
    write(root, {"src/m.ts": "same\n"})
    write(worker, {"src/m.ts": "same\n"})

    def runner(w, site, _tests, _timeouts, _deadline):
        (w / site.path).write_text("mutated\n")  # and no restore
        raise OSError("disk full")

    rows = run_all(root, two_sites(), {"src/m.ts": ["t"]}, queue_of(worker), 1, {}, 0.0, runner)
    assert [r["outcome"] for r in rows] == ["error", "error"]
    assert rows[1]["reason"].startswith("no worker left")


def test_a_retired_worker_does_not_drain_the_sites_left_for_healthy_ones(tmp_path):
    import time
    from mutate_report import run_all

    root, bad, good = tmp_path / "root", tmp_path / "w0", tmp_path / "w1"
    for tree in (root, bad, good):
        write(tree, {"src/m.ts": "same\n"})
    sites = [Site("src/m.ts", "f", n, n, 0, 1, "<", "<=") for n in range(1, 9)]

    def runner(w, site, _tests, _timeouts, _deadline):
        if w == bad:
            (w / site.path).write_text("mutated\n")  # and no restore
            raise OSError("disk full")
        time.sleep(0.05)
        return "killed"

    rows = run_all(root, sites, {"src/m.ts": ["t"]}, queue_of(bad, good), 2, {}, 0.0, runner)
    assert sorted(r["outcome"] for r in rows) == ["error"] + ["killed"] * 7


def test_zero_workers_is_a_usage_error(tmp_path):
    import pytest
    from mutate_report import main

    with pytest.raises(SystemExit) as stop:
        main(["--root", str(tmp_path), "--changes", "c.json", "--lane", "l.txt", "--workers", "0"])
    assert stop.value.code == 2


def test_windows_is_a_tool_error_before_any_work(tmp_path, monkeypatch):
    # Process groups (os.killpg) and the bash helpers are POSIX-only.
    import mutate_report

    monkeypatch.setattr(mutate_report.os, "name", "nt")
    missing = str(tmp_path / "missing.json")  # never read
    assert mutate_report.main(["--root", str(tmp_path), "--changes", missing, "--lane", missing]) == 2


def test_a_site_in_a_bun_false_zero_window_runs_instead_of_uncovered():
    # Bun 1.4.3 zeroes every line from an inlined const down to an uncalled
    # user (scripts/crap/crapper_report.py). check() ran, but LCOV shows 0.
    from mutate_report import false_zero_windows, triage

    source = "\n".join(
        [
            "const LIMIT = 2;",  # 1
            "export function check(n: number): boolean {",  # 2
            "  return n < 1;",  # 3
            "}",  # 4
            "export function unused(n: number): number {",  # 5
            "  return n + LIMIT;",  # 6
            "}",  # 7
        ]
    )
    reports = [{1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0}]
    windows = false_zero_windows(source, "src/m.ts", reports)
    assert windows == [(1, 4)]
    plan = {"src/m.ts": ["src/m.test.ts"]}
    rows, to_run = triage([site(3)], plan, {"src/m.ts": reports}, set(), {"src/m.ts": windows})
    assert rows == [] and to_run == [site(3)]
    # Outside the window, a zero still means uncovered.
    rows, _ = triage([site(6)], plan, {"src/m.ts": reports}, set(), {"src/m.ts": windows})
    assert [r["outcome"] for r in rows] == ["uncovered"]
