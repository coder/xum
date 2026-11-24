import { test, expect } from "bun:test";
import { handleStringReplace, handleLineReplace } from "./file_edit_replace_shared";

test("file_edit_replace_string error includes agent note field", () => {
  const result = handleStringReplace(
    {
      path: "test.ts",
      old_string: "nonexistent",
      new_string: "replacement",
    },
    "some file content"
  );

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error).toContain("old_string not found");
    expect(result.note).toBeDefined();
    expect(result.note).toContain("EDIT FAILED");
    expect(result.note).toContain("file was NOT modified");
  }
});

test("file_edit_replace_string ambiguous match error includes note", () => {
  const result = handleStringReplace(
    {
      path: "test.ts",
      old_string: "duplicate",
      new_string: "replacement",
    },
    "duplicate text with duplicate word"
  );

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error).toContain("appears 2 times");
    expect(result.note).toBeDefined();
    expect(result.note).toContain("EDIT FAILED");
    expect(result.note).toContain("file was NOT modified");
  }
});

test("file_edit_replace_lines validation error includes note", () => {
  const result = handleLineReplace(
    {
      path: "test.ts",
      start_line: 10,
      end_line: 9,
      new_lines: ["new content"],
    },
    "line 1\nline 2"
  );

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error).toContain("end_line must be >= start_line");
    expect(result.note).toBeDefined();
    expect(result.note).toContain("EDIT FAILED");
    expect(result.note).toContain("file was NOT modified");
  }
});
