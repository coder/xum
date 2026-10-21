import { test, expect } from "bun:test";
import { handleStringReplace } from "./file_edit_replace_shared";

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

// #2732: a miss caused only by whitespace (tabs vs spaces, trailing spaces) names the line of
// the near match in the agent note, so the model can copy the exact text. The edit stays exact.
test("file_edit_replace_string names the line of a whitespace-only mismatch", () => {
  const content =
    'package main\n\nfunc f() {\n\t\tif len(items) > 0 {  \n\t\t\tfmt.Println("x")\n\t\t}\n}\n';
  const result = handleStringReplace(
    {
      path: "file.go",
      old_string: '    if len(items) > 0 {\n      fmt.Println("x")\n',
      new_string: "replacement",
    },
    content
  );

  expect(result.success).toBe(false);
  if (!result.success) expect(result.note).toMatch(/line 4\b/u);
});

test("file_edit_replace_string names no line when nothing matches even ignoring whitespace", () => {
  const result = handleStringReplace(
    { path: "file.go", old_string: "if len(other) > 0 {", new_string: "x" },
    "func f() {\n\tif len(items) > 0 {\n\t}\n}\n"
  );

  expect(result.success).toBe(false);
  if (!result.success) expect(result.note).not.toMatch(/line \d+/u);
});

test.each([
  ["has no whitespace", "fooBar", "x = fooBaz\n"],
  ["matches twice when whitespace is ignored", "a  =  1", "a = 1\nb = 2\na =1\n"],
  [
    "is too long to search",
    Array.from({ length: 201 }, (_, i) => `t${i}`).join("  "),
    Array.from({ length: 201 }, (_, i) => `t${i}`).join(" "),
  ],
])("file_edit_replace_string names no line when old_string %s", (_name, oldString, content) => {
  const result = handleStringReplace(
    { path: "f.txt", old_string: oldString, new_string: "x" },
    content
  );

  expect(result.success).toBe(false);
  if (!result.success) expect(result.note).not.toMatch(/line \d+/u);
});
