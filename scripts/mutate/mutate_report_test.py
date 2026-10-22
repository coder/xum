"""Tests of the mutation runner's choices: which sites, which tests, which skip.

Run through `make test-mutate-scripts`, which supplies mutator, Crapper and
pytest. The end-to-end run (real bun processes) is in check.test.ts.
"""

import sys
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
        ]
    )
    files = {f"src/{name}.ts" for name in "abcdef"}
    write(tmp_path, {**{path: "" for path in files}, "src/t.test.ts": test})
    graph = import_graph(tmp_path, ["src/t.test.ts"], files)
    assert sorted(graph) == ["src/d.ts", "src/e.ts", "src/f.ts"]


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
    import time
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
