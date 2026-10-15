import type { Plugin } from "vite";

/**
 * Stubs Streamdown's static `rehype-katex` import (T3, #5971).
 *
 * Streamdown's entry imports rehype-katex for its default rehype plugins and to check whether a
 * caller's plugin list holds it. Xum always passes its own list and loads KaTeX only for messages
 * with math (MarkdownCore -> KatexStreamdown), so this import was the only thing that kept KaTeX
 * (~600 KiB raw) in the transcript's first-load chunk. With the stub, Streamdown never finds
 * rehype-katex in Xum's list, so it also stops injecting its CDN KaTeX stylesheet
 * (streamdown.ai) for math; KatexStreamdown imports the local CSS instead. Only imports from
 * Streamdown's own files are stubbed: Xum's import keeps the real plugin.
 *
 * Build only, like streamdownShikiLangsPlugin: the dev server pre-bundles Streamdown with
 * esbuild, so the import never reaches this plugin there. A build that stubs nothing fails, so a
 * Streamdown upgrade that changes shape cannot silently bring KaTeX back.
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
      // A no-op rehype plugin: never equal to Xum's rehype-katex, and harmless if Streamdown's
      // defaults ever run.
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
