import { describe, expect, test } from "bun:test";
import { streamdownShikiLangsPlugin } from "./streamdownShikiLangsPlugin";

const STREAMDOWN_IMPORTER = "/repo/node_modules/streamdown/dist/chunk-ZQMXWODK.js";

// Drives the plugin's hooks the way Rollup does, without a real build. `errors` records
// `this.error` calls (Rollup throws there; recording keeps the assertion explicit).
function harness() {
  const plugin = streamdownShikiLangsPlugin();
  const errors: string[] = [];
  const ctx = { error: (message: string) => errors.push(message) };
  const run = (hook: unknown, ...args: unknown[]): unknown => {
    if (typeof hook !== "function") throw new Error("expected a function hook");
    return (hook as (...hookArgs: unknown[]) => unknown).apply(ctx, args);
  };
  run(plugin.buildStart);
  return {
    errors,
    resolve: (source: string, importer: string) => run(plugin.resolveId, source, importer, {}),
    load: (id: unknown) => run(plugin.load, id),
    finish: () => run(plugin.generateBundle, {}, {}, true),
  };
}

describe("streamdownShikiLangsPlugin", () => {
  test("stubs Streamdown's static grammar imports with an empty grammar list", async () => {
    const h = harness();
    // Windows importer paths use backslashes.
    const id = h.resolve("shiki/langs/bash.mjs", STREAMDOWN_IMPORTER.replaceAll("/", "\\"));
    expect(id).toEqual(expect.any(String));
    const code = h.load(id);
    expect(typeof code).toBe("string");
    // eslint-disable-next-line no-restricted-syntax -- evaluates the generated stub module, not a project import
    const mod = (await import(`data:text/javascript,${String(code)}`)) as { default: unknown };
    expect(mod.default).toEqual([]);
    h.finish();
    expect(h.errors).toEqual([]);
  });

  test("leaves Shiki's own grammar imports and Streamdown's other imports alone", () => {
    const h = harness();
    expect(h.resolve("shiki/langs/bash.mjs", "/repo/node_modules/shiki/dist/langs.mjs")).toBeNull();
    expect(h.resolve("@shikijs/langs/bash", STREAMDOWN_IMPORTER)).toBeNull();
    expect(h.resolve("shiki", STREAMDOWN_IMPORTER)).toBeNull();
    expect(h.load("/repo/src/main.tsx")).toBeNull();
  });

  test("fails the build when nothing was stubbed", () => {
    const h = harness();
    h.finish();
    expect(h.errors).toHaveLength(1);
  });
});
