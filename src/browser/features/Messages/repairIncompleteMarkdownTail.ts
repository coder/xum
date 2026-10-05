import remend from "remend";
import { parseMarkdownIntoBlocks } from "streamdown";

/**
 * Repair unclosed markdown syntax (bold, links, code fences, ...) in the last block only.
 *
 * remend checks each marker it finds by rescanning its input from the start, so its cost grows
 * quadratically with the input. Streamdown's streaming mode used to run it on the whole reply on
 * every content change, and the smoothing engine changes the content every frame. On a dense reply
 * it cost 12 ms at 30k chars and 47 ms at 60k chars per frame (V8). Past about 30k chars that work
 * filled every frame, so React never got to the lower-priority transition that commits Streamdown's
 * blocks, and a live reply stopped growing on screen until the stream ended (#5655).
 *
 * Only the block that is still being written can hold an unclosed construct: earlier blocks are
 * complete. Streamdown splits the repaired text with the same function, so its earlier blocks keep
 * the same text. Repairing the whole reply also let an odd marker in an earlier block (for example
 * `a * b` inside a code block) append a stray closer at the end of the reply.
 */
export function repairIncompleteMarkdownTail(markdown: string): string {
  const blocks = parseMarkdownIntoBlocks(markdown);
  const lastBlock = blocks.at(-1);
  // The block split normally slices its input. If it ever does not (for example a lexer that
  // rewrites line endings), repair the whole text as before rather than guess an offset.
  if (blocks.length < 2 || lastBlock === undefined || !markdown.endsWith(lastBlock)) {
    return remend(markdown);
  }
  return markdown.slice(0, markdown.length - lastBlock.length) + remend(lastBlock);
}
