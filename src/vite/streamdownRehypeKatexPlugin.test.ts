import { describe, expect, test } from "bun:test";
import { streamdownRehypeKatexPlugin } from "./streamdownRehypeKatexPlugin";

const STREAMDOWN_IMPORTER = "/repo/node_modules/streamdown/dist/chunk-ZQMXWODK.js";

// Drives the plugin's hooks the way Rollup does, as streamdownShikiLangsPlugin.test.ts does.
function harness() {
  const plugin = streamdownRehypeKatexPlugin();
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

describe("streamdownRehypeKatexPlugin", () => {
  test("stubs Streamdown's rehype-katex import with a no-op plugin", async () => {
    const h = harness();
    // Windows importer paths use backslashes.
    const id = h.resolve("rehype-katex", STREAMDOWN_IMPORTER.replaceAll("/", "\\"));
    // eslint-disable-next-line no-restricted-syntax -- evaluates the generated stub module, not a project import
    const mod = (await import(`data:text/javascript,${String(h.load(id))}`)) as {
      default: () => unknown;
    };
    expect(mod.default()).toBeUndefined();
    h.finish();
    expect(h.errors).toEqual([]);
  });

  test("keeps Xum's own rehype-katex import and Streamdown's other imports", () => {
    const h = harness();
    expect(
      h.resolve("rehype-katex", "/repo/src/browser/features/Messages/KatexStreamdown.tsx")
    ).toBeNull();
    expect(h.resolve("rehype-raw", STREAMDOWN_IMPORTER)).toBeNull();
    expect(h.load("/repo/src/main.tsx")).toBeNull();
  });

  test("fails the build when nothing was stubbed", () => {
    const h = harness();
    h.finish();
    expect(h.errors).toHaveLength(1);
  });
});
