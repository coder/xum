import type { Plugin } from "vite";

/**
 * Stubs the Shiki grammars that Streamdown imports statically (T3, #5971).
 *
 * Streamdown's entry imports 15 grammars (`shiki/langs/<lang>.mjs`, which re-export
 * `@shikijs/langs/<lang>`) only to build its own `bundledLanguages` map for its CodeBlock.
 * Xum never renders that CodeBlock: MarkdownComponents overrides `code` and `pre`, and Xum
 * highlights in a worker that loads grammars on demand. Those grammars still landed in the
 * renderer's first-load chunk (~1 MiB raw). Each stub keeps its key in Streamdown's map, so
 * `isBundledLanguage` answers the same. Only imports from Streamdown's own files are stubbed:
 * Shiki's `bundledLanguages` (the main-thread fallback) imports `@shikijs/langs/*` directly and
 * keeps the real grammars as lazy chunks.
 *
 * Build only: the dev server pre-bundles Streamdown with esbuild, so these imports never reach
 * the plugin there. The user asked for the build to fail loudly if Streamdown changes shape, so
 * a build that stubs nothing is an error instead of a silent size regression.
 */
const SHIKI_LANG_SOURCE = /^shiki\/langs\/[^/]+\.mjs$/;
const STREAMDOWN_MARKER = "/node_modules/streamdown/";
const STUB_PREFIX = "\0xum-streamdown-shiki-lang:";

export function streamdownShikiLangsPlugin(): Plugin {
  let stubbed = 0;
  return {
    name: "xum:streamdown-shiki-langs",
    apply: "build",
    enforce: "pre",
    buildStart() {
      stubbed = 0;
    },
    resolveId(source, importer) {
      if (!SHIKI_LANG_SOURCE.test(source) || importer == null) return null;
      if (!importer.replaceAll("\\", "/").includes(STREAMDOWN_MARKER)) return null;
      stubbed++;
      return STUB_PREFIX + source;
    },
    load(id) {
      return id.startsWith(STUB_PREFIX) ? "export default [];" : null;
    },
    generateBundle() {
      if (stubbed === 0) {
        this.error(
          "streamdownShikiLangsPlugin stubbed no Shiki grammar: Streamdown changed shape. " +
            "Revisit src/vite/streamdownShikiLangsPlugin.ts (and remove it if Streamdown no " +
            "longer imports shiki/langs/*.mjs statically)."
        );
      }
    },
  };
}
