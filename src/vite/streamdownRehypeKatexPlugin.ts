import type { Plugin } from "vite";

/**
 * Stubs Streamdown's static `rehype-katex` import (T3, #5971). Streamdown imports it for its
 * default plugins and to check a caller's list. Xum passes its own list and loads KaTeX only for
 * messages with math (MarkdownCore -> katexRehypePlugin), so this import alone kept KaTeX in the
 * transcript's first-load chunk. With the stub Streamdown never finds rehype-katex in Xum's list,
 * so it also stops injecting its CDN KaTeX stylesheet (streamdown.ai); Xum loads the local CSS.
 * Only Streamdown's own imports are stubbed. Build only, like streamdownShikiLangsPlugin (the dev
 * server pre-bundles Streamdown). A build that stubs nothing fails, so a Streamdown upgrade cannot
 * silently bring KaTeX back.
 */
const STREAMDOWN_MARKER = "/node_modules/streamdown/";
const STUB_ID = "\0xum-streamdown-rehype-katex";

export function streamdownRehypeKatexPlugin(): Plugin {
  let stubbed = 0;
  return {
    name: "xum:streamdown-rehype-katex",
    apply: "build",
    enforce: "pre",
    buildStart() {
      stubbed = 0;
    },
    resolveId(source, importer) {
      if (source !== "rehype-katex" || importer == null) return null;
      if (!importer.replaceAll("\\", "/").includes(STREAMDOWN_MARKER)) return null;
      stubbed++;
      return STUB_ID;
    },
    load(id) {
      // A no-op rehype plugin, harmless if Streamdown's defaults ever run.
      return id === STUB_ID ? "export default function rehypeKatexStub() {}" : null;
    },
    generateBundle() {
      if (stubbed === 0) {
        this.error(
          "streamdownRehypeKatexPlugin stubbed nothing: Streamdown changed shape. Revisit " +
            "src/vite/streamdownRehypeKatexPlugin.ts (and remove it if Streamdown no longer " +
            "imports rehype-katex statically)."
        );
      }
    },
  };
}
