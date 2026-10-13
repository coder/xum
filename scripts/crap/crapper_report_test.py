"""Hand-counted fixtures for crapper_report.py (run by `make test-crap-scripts`).

The counts pin what the adapter reports with the locked Crapper and grammar
versions. A Crapper or grammar bump that moves them must be a deliberate
change to these numbers, since every stored base snapshot moves with it.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import crapper_report  # noqa: E402

BRANCHY = """\
export function classify(value: number | null): string {
  if (value === null) {
    return "none";
  }
  for (let i = 0; i < 3; i++) {
    if (value > i && value < 10) {
      return "small";
    }
  }
  return value > 100 ? "huge" : "medium";
}

export const pick = (input?: { name?: string }) => input?.name ?? "anon";

class Store {
  get size(): number {
    return 0;
  }
  set size(value: number) {
    if (value < 0) throw new Error("negative");
  }
}
"""

SWITCHY = """\
export function Label(props: { kind: string }) {
  switch (props.kind) {
    case "a":
      return <b>A</b>;
    case "b":
      return <i>B</i>;
    default:
      return null;
  }
}

export const List = (props: { items: string[] }) => (
  <ul>
    {props.items.map((item) => (item ? <li key={item}>{item}</li> : null))}
  </ul>
);
"""


def write(root: Path, relative: str, text: str) -> str:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return relative


def run(capsys, root: Path, *args: str) -> list[dict]:
    assert crapper_report.main(["--root", str(root), *args]) == 0
    return json.loads(capsys.readouterr().out)


def summary(rows: list[dict]) -> list[tuple]:
    return [
        (row["path"], row["namespace"], row["name"], row["startLine"], row["endLine"], row["complexity"])
        for row in rows
    ]


def test_complexity_and_line_ranges_match_hand_counts(tmp_path, capsys):
    branchy = write(tmp_path, "src/demo/branchy.ts", BRANCHY)
    switchy = write(tmp_path, "src/demo/switchy.tsx", SWITCHY)

    rows = run(capsys, tmp_path, switchy, branchy)

    assert summary(rows) == [
        # 1 + if + for + if + && + ?:
        (branchy, "demo.branchy", "classify", 1, 11, 6),
        # 1 + ?. + ??
        (branchy, "demo.branchy", "pick", 13, 13, 3),
        # A getter and a setter share a name: callers must tell them apart by line.
        (branchy, "demo.branchy.Store", "size", 16, 18, 1),
        (branchy, "demo.branchy.Store", "size", 19, 21, 2),
        # 1 + two cases + default
        (switchy, "demo.switchy", "Label", 1, 10, 4),
        # The ternary inside the map callback is charged to List.
        (switchy, "demo.switchy", "List", 12, 16, 2),
    ]
    assert all(row["coverage"] is None and row["crap"] is None for row in rows)


def test_only_existing_production_files_under_src_are_scored(tmp_path, capsys):
    kept = write(tmp_path, "src/demo/branchy.ts", BRANCHY)
    skipped = [
        write(tmp_path, relative, BRANCHY)
        for relative in (
            "src/demo/branchy.test.ts",
            "src/demo/branchy.stories.tsx",
            "src/demo/branchy.testHarness.ts",
            "src/demo/branchy.bench.ts",
            "src/demo/testUtils.ts",
            "src/demo/fileLockTestHelpers.ts",
            "src/demo/lock.testChild.ts",
            "src/demo/__mocks__/fs.ts",
            "src/version.ts",
            "src/browser/stories/mocks.ts",
            "src/demo/types.d.ts",
            "scripts/tool.ts",
        )
    ]

    rows = run(capsys, tmp_path, f"./{kept}", "src/demo/deleted.ts", *skipped)

    assert {row["path"] for row in rows} == {kept}


def test_lcov_lines_give_fraction_coverage_and_crap(tmp_path, capsys):
    branchy = write(tmp_path, "src/demo/branchy.ts", BRANCHY)
    # An absolute SF path, as Jest writes it. classify has 4 of 6 lines hit;
    # pick (line 13) has no DA line, which Crapper scores as 0%.
    lcov = tmp_path / "lcov.info"
    lcov.write_text(
        f"SF:{tmp_path / branchy}\n"
        "DA:2,1\nDA:3,0\nDA:5,3\nDA:6,3\nDA:7,0\nDA:10,1\n"
        "end_of_record\n",
        encoding="utf-8",
    )

    rows = run(capsys, tmp_path, "--lcov", str(lcov), branchy)
    by_name = {row["name"]: row for row in rows if row["name"] != "size"}

    assert by_name["classify"]["coverage"] == 0.6667
    # 6^2 * (1/3)^3 + 6
    assert by_name["classify"]["crap"] == 7.3333
    assert by_name["pick"]["coverage"] == 0.0
    # 3^2 * 1^3 + 3
    assert by_name["pick"]["crap"] == 12.0


def test_records_of_one_file_from_many_reports_merge_by_line(tmp_path, capsys):
    branchy = write(tmp_path, "src/demo/branchy.ts", BRANCHY)
    # Crapper alone keeps one record per file. Unit and integration shards each
    # hit part of classify (lines 2-10), and together they hit all six lines.
    # The second report also repeats the file inside itself, under the CI
    # checkout's absolute path, which is not --root.
    unit = tmp_path / "unit.info"
    unit.write_text(f"SF:{branchy}\nDA:2,1\nDA:3,1\nDA:5,2\nDA:6,0\nDA:10,0\nend_of_record\n", encoding="utf-8")
    # Each later record misses a line an earlier one hit. Every report hits
    # classify's entry (line 2), as any report that ran it does.
    integration = tmp_path / "integration.info"
    integration.write_text(
        f"SF:/runner/work/xum/xum/{branchy}\nDA:2,1\nDA:5,0\nDA:6,4\nDA:7,0\nend_of_record\n"
        f"SF:/runner/work/xum/xum/{branchy}\nDA:3,0\nDA:7,1\nend_of_record\n"
        # Jest on Windows.
        f"SF:C:\\a\\xum\\{branchy.replace('/', chr(92))}\nDA:10,1\nend_of_record\n"
        "SF:/runner/work/xum/xum/src/other.ts\nDA:1,1\nend_of_record\n",
        encoding="utf-8",
    )

    rows = run(capsys, tmp_path, "--lcov", str(unit), "--lcov", str(integration), branchy)

    classify = next(row for row in rows if row["name"] == "classify")
    assert classify["coverage"] == 1.0
    assert classify["crap"] == 6.0


def test_rename_reports_new_path_with_old_path_coverage(tmp_path, capsys):
    old = write(tmp_path, "src/demo/branchy.ts", BRANCHY)
    lcov = tmp_path / "lcov.info"
    lcov.write_text(f"SF:{old}\nDA:13,1\nend_of_record\n", encoding="utf-8")

    rows = run(capsys, tmp_path, "--lcov", str(lcov), "--rename", old, "src/lib/picker.ts", old)

    pick = next(row for row in rows if row["name"] == "pick")
    assert (pick["path"], pick["namespace"], pick["coverage"]) == ("src/lib/picker.ts", "lib.picker", 1.0)


def test_rename_parses_with_the_old_files_grammar(tmp_path, capsys):
    # The JavaScript grammar finds no function in this TypeScript source.
    typed = (
        "export function f<T extends { a?: number }>(x: T): number {\n"
        "  const y = x as unknown as { a: number };\n"
        "  if (y.a > 1) return 1;\n"
        "  return x.a ?? 0;\n"
        "}\n"
    )
    old = write(tmp_path, "src/demo/typed.ts", typed)

    rows = run(capsys, tmp_path, "--rename", old, "src/demo/typed.js", old)

    assert summary(rows) == [("src/demo/typed.js", "demo.typed", "f", 1, 5, 3)]


# Bun 1.3.12 repro: a process that calls lib's function lists only its
# executable lines (1, 4, 6, 7, 9). A process that only imports lib lists
# every line of the never-run function at 0, comments and blanks included.
LIB = """\
export function grow(x: number): number {
  // Comments and blank lines carry no code.

  const y = x + 1;
  /* Block comment. */
  if (y > 2) {
    return y;
  }
  return 0;
}
"""
LIB_LOADED_ONLY = "".join(f"DA:{line},0\n" for line in range(1, 9))

NESTED = """\
export function trimAll(items: string[]): number {
  const out = items.map((item) => {
    // Trim first.

    return item.trim();
  });
  return out.length;
}
"""


def lcov_file(root: Path, name: str, relative: str, records: str) -> str:
    path = root / name
    path.write_text(f"SF:{relative}\n{records}end_of_record\n", encoding="utf-8")
    return str(path)


def coverage_of(capsys, root: Path, relative: str, name: str, *reports: str) -> float:
    args = [arg for report in reports for arg in ("--lcov", report)]
    rows = run(capsys, root, *args, relative)
    return next(row["coverage"] for row in rows if row["name"] == name)


def test_a_report_that_only_loaded_the_file_adds_no_misses(tmp_path, capsys):
    lib = write(tmp_path, "src/demo/lib.ts", LIB)
    ran = lcov_file(tmp_path, "ran.info", lib, "DA:1,1\nDA:4,2\nDA:6,2\nDA:7,1\nDA:9,1\n")
    loaded = lcov_file(tmp_path, "loaded.info", lib, LIB_LOADED_ONLY)

    # The old line union scored 5 of 9 lines: 0.5556.
    assert coverage_of(capsys, tmp_path, lib, "grow", ran, loaded) == 1.0
    assert coverage_of(capsys, tmp_path, lib, "grow", loaded, ran) == 1.0


def test_a_partly_run_function_keeps_its_missed_code_lines(tmp_path, capsys):
    lib = write(tmp_path, "src/demo/lib.ts", LIB)
    # Line 7 (return y) never ran.
    ran = lcov_file(tmp_path, "ran.info", lib, "DA:1,1\nDA:4,1\nDA:6,1\nDA:7,0\nDA:9,1\n")
    loaded = lcov_file(tmp_path, "loaded.info", lib, LIB_LOADED_ONLY)

    assert coverage_of(capsys, tmp_path, lib, "grow", ran, loaded) == 0.8


def test_a_function_no_report_ran_scores_zero(tmp_path, capsys):
    lib = write(tmp_path, "src/demo/lib.ts", LIB)
    loaded = lcov_file(tmp_path, "loaded.info", lib, LIB_LOADED_ONLY)
    other = lcov_file(tmp_path, "other.info", lib, LIB_LOADED_ONLY)

    rows = run(capsys, tmp_path, "--lcov", loaded, "--lcov", other, lib)

    assert [(row["name"], row["coverage"], row["crap"]) for row in rows] == [("grow", 0.0, 6.0)]


def test_comment_and_blank_lines_of_an_unrun_callback_do_not_count(tmp_path, capsys):
    nested = write(tmp_path, "src/demo/nested.ts", NESTED)
    # Called with no items: the map callback never ran, so Bun lists all of its
    # lines (3-6) at 0. Code lines are 1, 2, 5 and 7; only 5 is a miss.
    ran = lcov_file(
        tmp_path, "ran.info", nested, "DA:1,1\nDA:2,1\nDA:3,0\nDA:4,0\nDA:5,0\nDA:6,0\nDA:7,1\nDA:8,1\n"
    )

    # The old line union scored 4 of 8 lines: 0.5.
    assert coverage_of(capsys, tmp_path, nested, "trimAll", ran) == 0.75


def test_code_lines_only_a_loading_report_lists_do_not_count(tmp_path, capsys):
    # A run lists a multi-line call once, at its first line. A process that only
    # loaded the file lists the argument lines too, at 0: they are code, so the
    # line filter keeps them, and only skipping that report removes the misses.
    call = write(
        tmp_path,
        "src/demo/call.ts",
        "export function floor(x: number): number {\n  return Math.max(\n    x,\n    0\n  );\n}\n",
    )
    ran = lcov_file(tmp_path, "ran.info", call, "DA:1,1\nDA:2,1\nDA:6,1\n")
    loaded = lcov_file(tmp_path, "loaded.info", call, "".join(f"DA:{line},0\n" for line in range(1, 6)))

    # The old line union scored 3 of 6 lines: 0.5.
    assert coverage_of(capsys, tmp_path, call, "floor", ran, loaded) == 1.0


def test_code_after_a_block_comment_counts(tmp_path, capsys):
    guard = write(
        tmp_path,
        "src/demo/guard.ts",
        "export function guard(x: number): number {\n"
        "  if (x < 0) {\n"
        "    /* ignore */ return 0;\n"
        "  }\n"
        "  /* Doubles x.\n"
        "   * Twice. */ return x * 2;\n"
        "}\n",
    )
    # The early return on line 3 never ran.
    ran = lcov_file(tmp_path, "ran.info", guard, "DA:1,1\nDA:2,1\nDA:3,0\nDA:6,1\n")

    assert coverage_of(capsys, tmp_path, guard, "guard", ran) == 0.75


def test_a_load_time_hit_inside_an_uncalled_arrow_is_not_a_run(tmp_path, capsys):
    arrow = write(
        tmp_path,
        "src/demo/arrow.ts",
        "export const arrow = (x: number): number => {\n"
        "  // comment\n"
        "\n"
        "  const y = x + 1;\n"
        "  return y;\n"
        "};\n",
    )
    # Bun 1.3.12, file imported and arrow never called.
    loaded = lcov_file(tmp_path, "loaded.info", arrow, "DA:1,0\nDA:2,0\nDA:3,0\nDA:4,0\nDA:5,2\n")
    ran = lcov_file(tmp_path, "ran.info", arrow, "DA:1,29\nDA:4,18\nDA:5,10\n")

    assert coverage_of(capsys, tmp_path, arrow, "arrow", loaded) == 0.0
    assert coverage_of(capsys, tmp_path, arrow, "arrow", loaded, ran) == 1.0


def test_comments_are_found_by_the_parse_not_by_line_prefixes(tmp_path, capsys):
    view = write(
        tmp_path,
        "src/demo/view.tsx",
        "export function View(props: { on: boolean }) {\n"
        "  const glob = props.on ? \"src/**/*.ts\" : \"\";\n"
        "  const items = [1].map((item) => {\n"
        "    /* A comment that\n"
        "       spans lines.\n"
        "    */\n"
        "    return item;\n"
        "  });\n"
        "  return (\n"
        "    <div>\n"
        "      {/* JSX comment */}\n"
        "      {glob}{items}\n"
        "    </div>\n"
        "  );\n"
        "}\n",
    )
    # The map callback never ran (Bun lists its lines 4-8 at 0, lines 4-6 are
    # its comment). Code lines: 1, 2, 3, 7, 9, 10, 12, 13; only 7 is a miss.
    # The glob string's "/*" must not start a comment that hides later lines.
    ran = lcov_file(
        tmp_path,
        "ran.info",
        view,
        "DA:1,1\nDA:2,1\nDA:3,1\nDA:4,0\nDA:5,0\nDA:6,0\nDA:7,0\nDA:8,0\n"
        "DA:9,1\nDA:10,1\nDA:11,0\nDA:12,1\nDA:13,1\n",
    )

    assert coverage_of(capsys, tmp_path, view, "View", ran) == 0.875


def test_empty_literal_lines_stay_code(tmp_path, capsys):
    log = write(
        tmp_path,
        "src/demo/log.ts",
        "export function log(on: boolean): void {\n"
        "  if (on) {\n"
        "    console.log(\n"
        "      {},\n"
        "      [],\n"
        "    );\n"
        "  }\n"
        "  [];\n"
        "}\n",
    )
    # The branch never ran. Its argument lines and the `[];` statement are code.
    ran = lcov_file(tmp_path, "ran.info", log, "DA:1,1\nDA:2,1\nDA:3,0\nDA:4,0\nDA:5,0\nDA:8,1\n")

    assert coverage_of(capsys, tmp_path, log, "log", ran) == 0.5


def test_javascript_files_use_their_own_grammar_for_comments(tmp_path, capsys):
    script = write(
        tmp_path,
        "src/demo/workflow.cjs",
        "function step(items) {\n  return items.map((item) => {\n    // Skip empty items.\n\n    return item;\n  });\n}\n",
    )
    # The callback never ran. Code lines are 1, 2 and 5: only its `return` misses.
    ran = lcov_file(tmp_path, "ran.info", script, "DA:1,1\nDA:2,1\nDA:3,0\nDA:4,0\nDA:5,0\nDA:6,0\nDA:7,1\n")

    assert coverage_of(capsys, tmp_path, script, "step", ran) == 0.6667
