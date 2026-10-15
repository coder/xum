import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";
import type { Pluggable } from "unified";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import assert from "@/common/utils/assert";

type StreamdownProps = ComponentProps<typeof Streamdown>;

// KaTeX runs last, as it did before this split: it adds its trusted classes and styles after
// sanitize and harden.
const KATEX_PLUGIN: Pluggable = [rehypeKatex, { errorColor: "var(--color-muted-foreground)" }];

// Streamdown re-parses when it gets a new plugin array, so each list gets one KaTeX variant.
const pluginsWithKatex = new WeakMap<Pluggable[], Pluggable[]>();

/**
 * Streamdown with KaTeX. MarkdownCore loads this module only for a message that contains math
 * (T3, #5971), so KaTeX's JS and CSS stay out of the transcript's first load. Vite's preload
 * resolves the import only after this chunk's CSS has loaded, so math never shows unstyled.
 */
export default function KatexStreamdown(props: StreamdownProps) {
  assert(props.rehypePlugins != null, "MarkdownCore always passes its rehype plugin list");
  let plugins = pluginsWithKatex.get(props.rehypePlugins);
  if (plugins == null) {
    plugins = [...props.rehypePlugins, KATEX_PLUGIN];
    pluginsWithKatex.set(props.rehypePlugins, plugins);
  }
  return <Streamdown {...props} rehypePlugins={plugins} />;
}
