import { describe, expect, it } from "bun:test";
import { MAX_SHOWN_VALIDATION_ISSUES } from "@/constants/errors";
import { formatIssuePath, getMessageWithInputValidationIssues } from "./formatValidationIssues";

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

describe("getMessageWithInputValidationIssues", () => {
  it("keeps the original message when reading the error's data throws", () => {
    const error = new Error("stream failed");
    Object.defineProperty(error, "data", {
      get() {
        throw new Error("getter exploded");
      },
    });

    expect(getMessageWithInputValidationIssues(error)).toBe("stream failed");
  });

  it("lists at most the shown issue count and says how many it left out", () => {
    const issues = Array.from({ length: MAX_SHOWN_VALIDATION_ISSUES + 2 }, (_, index) => ({
      path: ["items", index],
      message: "Invalid input",
    }));
    const error = Object.assign(new Error("Input validation failed"), { data: { issues } });

    const message = getMessageWithInputValidationIssues(error);

    expect(message).toContain(`items[${MAX_SHOWN_VALIDATION_ISSUES - 1}]`);
    expect(message).not.toContain(`items[${MAX_SHOWN_VALIDATION_ISSUES}]`);
    expect(message).toEndWith("+2 more");
  });
});
