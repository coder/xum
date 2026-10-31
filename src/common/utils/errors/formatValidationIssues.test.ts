import { describe, expect, it } from "bun:test";
import { formatIssuePath } from "./formatValidationIssues";

describe("formatIssuePath", () => {
  it("renders identifiers, indexes, quoted keys and segment objects as an access path", () => {
    expect(formatIssuePath(["mcp", 0, { key: "x-header" }, { key: "value" }])).toBe(
      'mcp[0]["x-header"].value'
    );
  });

  it("names a missing or malformed path as the root", () => {
    expect(formatIssuePath(undefined)).toBe("<root>");
    expect(formatIssuePath([])).toBe("<root>");
    expect(formatIssuePath("branch" as unknown as [])).toBe("<root>");
  });
});
