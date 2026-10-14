import { flattenToolHookValueToEnv } from "./toolHookEnv";

describe("flattenToolHookValueToEnv", () => {
  it("flattens a simple object", () => {
    expect(flattenToolHookValueToEnv({ script: "echo hi" }, "MUX_TOOL_INPUT")).toEqual({
      MUX_TOOL_INPUT_SCRIPT: "echo hi",
    });
  });

  it("flattens nested objects", () => {
    expect(
      flattenToolHookValueToEnv(
        {
          opts: {
            timeout: 30,
          },
        },
        "MUX_TOOL_INPUT"
      )
    ).toEqual({
      MUX_TOOL_INPUT_OPTS_TIMEOUT: "30",
    });
  });

  it("flattens arrays and provides a _COUNT", () => {
    expect(
      flattenToolHookValueToEnv(
        {
          items: ["a", "b"],
        },
        "MUX_TOOL_INPUT"
      )
    ).toEqual({
      MUX_TOOL_INPUT_ITEMS_COUNT: "2",
      MUX_TOOL_INPUT_ITEMS_0: "a",
      MUX_TOOL_INPUT_ITEMS_1: "b",
    });
  });

  it("flattens arrays of objects", () => {
    expect(
      flattenToolHookValueToEnv(
        {
          items: [{ name: "x" }, { name: "y" }],
        },
        "MUX_TOOL_INPUT"
      )
    ).toEqual({
      MUX_TOOL_INPUT_ITEMS_COUNT: "2",
      MUX_TOOL_INPUT_ITEMS_0_NAME: "x",
      MUX_TOOL_INPUT_ITEMS_1_NAME: "y",
    });
  });

  it("converts numbers and booleans to strings", () => {
    expect(flattenToolHookValueToEnv({ num: 42, flag: true }, "PREFIX")).toEqual({
      PREFIX_NUM: "42",
      PREFIX_FLAG: "true",
    });
  });

  it("does not emit a root env var for non-object values", () => {
    expect(flattenToolHookValueToEnv("hello", "MUX_TOOL_INPUT")).toEqual({});
  });

  it("sanitizes keys so env var names are shell-friendly", () => {
    expect(flattenToolHookValueToEnv({ "a-b": { "c.d": 1 } }, "PFX")).toEqual({
      PFX_A_B_C_D: "1",
    });
  });

  it("splits camelCase keys into underscore-separated words", () => {
    expect(flattenToolHookValueToEnv({ filePath: "x" }, "PFX")).toEqual({
      PFX_FILE_PATH: "x",
    });
  });

  it("does not collapse empty key parts back to the prefix", () => {
    expect(flattenToolHookValueToEnv({ " ": "x" }, "PFX")).toEqual({
      PFX_EMPTY: "x",
    });
  });

  it("omits values larger than maxValueLength (does not truncate)", () => {
    expect(
      flattenToolHookValueToEnv(
        {
          big: "abcdef",
          ok: "x",
        },
        "PFX",
        { maxValueLength: 5 }
      )
    ).toEqual({
      PFX_OK: "x",
    });
  });

  it("omits values that contain NUL bytes, which no env var can hold", () => {
    expect(flattenToolHookValueToEnv({ output: "a\0b", ok: "x" }, "PFX")).toEqual({ PFX_OK: "x" });
  });

  it("emits legacy FILE_PATH alias when canonical PATH is present", () => {
    // After the file_path → path rename, existing hooks may reference
    // MUX_TOOL_INPUT_FILE_PATH. The flattener emits it as an alias.
    expect(flattenToolHookValueToEnv({ path: "src/app.ts" }, "MUX_TOOL_INPUT")).toEqual({
      MUX_TOOL_INPUT_PATH: "src/app.ts",
      MUX_TOOL_INPUT_FILE_PATH: "src/app.ts",
    });
  });

  it("does not emit FILE_PATH alias when PATH is absent", () => {
    const result = flattenToolHookValueToEnv({ script: "echo hi" }, "MUX_TOOL_INPUT");
    expect(result).not.toHaveProperty("MUX_TOOL_INPUT_FILE_PATH");
  });
});
