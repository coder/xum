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
    # Each later record misses a line an earlier one hit.
    integration = tmp_path / "integration.info"
    integration.write_text(
        f"SF:/runner/work/xum/xum/{branchy}\nDA:2,0\nDA:6,4\nDA:7,0\nend_of_record\n"
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
