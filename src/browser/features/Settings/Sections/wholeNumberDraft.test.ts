import { describe, expect, test } from "bun:test";
import { parseWholeNumberDraft } from "./wholeNumberDraft";

const options = { max: 10, empty: "empty" as const, error: "bad" };

describe("parseWholeNumberDraft", () => {
  test("reads an empty or blank field as the field's empty value", () => {
    expect(parseWholeNumberDraft("", options)).toEqual({ value: "empty" });
    expect(parseWholeNumberDraft("   ", options)).toEqual({ value: "empty" });
  });

  test.each([
    ["0", 0],
    [" 7 ", 7],
    ["10", 10],
    ["007", 7],
  ])("reads %p as %p", (draft, value) => {
    expect(parseWholeNumberDraft(draft, options)).toEqual({ value });
  });

  // Each parses as a number in JavaScript, or is past the field's largest value.
  test.each(["11", "-1", "2.5", "1e1", "0x5", "+5", "abc"])("refuses %p", (draft) => {
    expect(parseWholeNumberDraft(draft, options)).toEqual({ error: "bad" });
  });
});
