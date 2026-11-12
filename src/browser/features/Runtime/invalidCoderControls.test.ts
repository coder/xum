import { describe, expect, test } from "bun:test";
import { invalidCoderControls } from "./CoderControls";

const base = {
  hasError: false,
  mode: "new" as const,
  template: undefined,
  templatesError: null,
  presetsError: null,
  workspacesError: null,
};

describe("invalidCoderControls", () => {
  test("marks nothing while the form is valid and its lists loaded", () => {
    expect(invalidCoderControls(base)).toEqual({});
  });

  test("a refused Send marks the one control it is waiting for", () => {
    expect(invalidCoderControls({ ...base, hasError: true })).toEqual({ template: true });
    expect(invalidCoderControls({ ...base, hasError: true, template: "docker" })).toEqual({
      preset: true,
    });
    expect(
      invalidCoderControls({ ...base, hasError: true, mode: "existing", template: "docker" })
    ).toEqual({ workspace: true });
  });

  test("a list that failed to load marks its control, with or without a refused Send", () => {
    expect(invalidCoderControls({ ...base, presetsError: "boom" })).toEqual({ preset: true });
    expect(invalidCoderControls({ ...base, hasError: true, workspacesError: "boom" })).toEqual({
      template: true,
      workspace: true,
    });
  });
});
