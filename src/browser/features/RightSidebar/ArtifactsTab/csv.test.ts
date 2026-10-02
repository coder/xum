import { describe, expect, test } from "bun:test";
import { parseDelimited } from "./csv";

describe("parseDelimited", () => {
  test("handles quoted fields, escaped quotes, embedded newlines and CRLF", () => {
    const text = 'name,note\r\n"Smith, J","said ""hi""\r\nthen left"\r\nplain,x\r\n';
    expect(parseDelimited(text, ",", 100)).toEqual({
      rows: [
        ["name", "note"],
        ["Smith, J", 'said "hi"\r\nthen left'],
        ["plain", "x"],
      ],
      totalRows: 3,
      maxRowWidth: 2,
    });
  });

  test("keeps ragged rows and empty fields", () => {
    expect(parseDelimited("a,b,c\n1\n2,,\n\n", ",", 100).rows).toEqual([
      ["a", "b", "c"],
      ["1"],
      ["2", "", ""],
      [""],
    ]);
  });

  test("supports TSV, a BOM, CR-only endings and no trailing newline", () => {
    expect(parseDelimited("\uFEFFa\tb\r1\t2", "\t", 100).rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("caps kept rows but counts every row", () => {
    const text = Array.from({ length: 10 }, (_, i) => `r${i}`).join("\n");
    const parsed = parseDelimited(text, ",", 3);
    expect(parsed.rows).toEqual([["r0"], ["r1"], ["r2"]]);
    expect(parsed.totalRows).toBe(10);
  });

  test("treats an empty file as no rows", () => {
    expect(parseDelimited("", ",", 10)).toEqual({ rows: [], totalRows: 0, maxRowWidth: 0 });
  });

  test("keeps at most maxColumns fields per row but counts the full width", () => {
    // A comma-only row would otherwise hold 10,001 strings.
    const parsed = parseDelimited(`${",".repeat(10_000)}\nx`, ",", 10, 200);
    expect(parsed.rows[0]).toHaveLength(200);
    expect(parsed.rows[1]).toEqual(["x"]);
    expect(parsed.maxRowWidth).toBe(10_001);
  });
});
