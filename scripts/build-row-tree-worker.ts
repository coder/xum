#!/usr/bin/env bun
/**
 * Bundles the static view row-tree worker (src/browser/workers/staticRowTree.worker.ts) for
 * `xum server`. tsconfig.main cannot compile the browser components it renders (a CSS import,
 * import.meta), so esbuild bundles them. Lazy `import()` edges (Shiki grammars, Mermaid, KaTeX)
 * stay out: server rendering never runs the effects that load them, and they would add ~20 MB.
 */
import { statSync } from "node:fs";
import * as esbuild from "esbuild";

const outfile = process.argv[2] ?? "dist/workers/staticRowTree.worker.js";
// The bundle is about 3.4 MB. A lazy import that turns static would add Shiki, Mermaid or an AI SDK.
const MAX_BYTES = 5 * 1024 * 1024;

await esbuild.build({
  entryPoints: ["src/browser/workers/staticRowTree.worker.ts"],
  outfile,
  bundle: true,
  minify: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".css": "empty" },
  logLevel: "error",
  plugins: [
    {
      name: "lazy-imports-external",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) =>
          args.kind === "dynamic-import" ? { path: args.path, external: true } : undefined
        );
      },
    },
  ],
});

const bytes = statSync(outfile).size;
if (bytes > MAX_BYTES) {
  throw new Error(`${outfile} is ${bytes} bytes, over ${MAX_BYTES}: did a lazy import become static?`);
}
