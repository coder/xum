import { describe, expect, test } from "bun:test";
import { toJsonTable } from "./jsonData";

describe("toJsonTable", () => {
  test("caps explicit columns and array rows, and reports the full width", () => {
    const columns = Array.from({ length: 10_000 }, (_, i) => `c${i}`);
    const table = toJsonTable(
      { $xum: "table", columns, rows: [columns.map((_, i) => i), { c1: "named" }] },
      10,
      200
    );
    expect(table?.columns).toHaveLength(200);
    expect(table?.rows[0]).toHaveLength(200);
    expect(table?.rows[1]?.[1]).toBe("named");
    expect(table?.totalColumns).toBe(10_000);
  });

  test("an array row wider than the columns raises the reported width", () => {
    const table = toJsonTable({ $xum: "table", rows: [[1, 2, 3, 4, 5]] }, 10, 3);
    expect(table?.rows[0]).toEqual(["1", "2", "3"]);
    expect(table?.totalColumns).toBe(5);
  });
});
