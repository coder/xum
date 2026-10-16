import { describe, expect, test } from "bun:test";
import { builtinModules } from "node:module";
import * as esbuild from "esbuild";

// staticRowTree renders on the server with react-dom/server, and only the row-tree worker of
// `xum server` may load it. Every module either side reaches is checked, lazy imports included.
// parse5 is not checked: rehype-raw already brings it to the renderer.
const SSR_CODE = /staticRowTree\.(tsx|worker\.ts)$|react-dom\/(server|cjs\/react-dom-server)/;
// The renderer draws markdown with Streamdown itself; the main process must not load it.
const MAIN_PROCESS_BANNED = new RegExp(`${SSR_CODE.source}|/streamdown/`);

async function reached(
  entryPoints: string[],
  platform: "browser" | "node",
  banned: RegExp
): Promise<string[]> {
  const result = await esbuild.build({
    entryPoints,
    bundle: true,
    write: false,
    metafile: true,
    splitting: true,
    format: "esm",
    platform,
    outdir: "/nonexistent",
    logLevel: "silent",
    loader: Object.fromEntries(
      [".css", ".svg", ".png", ".woff", ".woff2", ".ttf", ".wasm", ".md", ".node"].map((e) => [
        e,
        "empty",
      ])
    ),
    // Vite and the runtime resolve these; only the module graph matters here.
    external: [
      "*?raw",
      "*?url",
      "*?worker",
      "node:*",
      "@novnc/*",
      "electron",
      "vscode",
      ...builtinModules,
    ],
  });
  const inputs = Object.keys(result.metafile.inputs);
  expect(inputs.length).toBeGreaterThan(500); // the whole graph was walked
  return inputs.filter((file) => banned.test(file));
}

describe("server rendering code stays in the row-tree worker", () => {
  test("the renderer app does not reach it", async () => {
    expect(await reached(["src/browser/main.tsx"], "browser", SSR_CODE)).toEqual([]);
  }, 30_000);

  test("desktop main, the CLI, the server and the VS Code extension do not reach it", async () => {
    const entries = [
      "src/desktop/main.ts",
      "src/cli/index.ts",
      "src/cli/server.ts",
      "vscode/src/extension.ts",
    ];
    expect(await reached(entries, "node", MAIN_PROCESS_BANNED)).toEqual([]);
  }, 60_000);
});
