// Xum runs this repair itself and passes parseIncompleteMarkdown={false} to Streamdown, so the
// remend copy that Streamdown pins (1.0.2) is not used. remend 1.4.0 is linear in its input; 1.0.2
// rescanned it per marker, which cost 313 ms (list) to 454 ms (code fence) per frame on one 60k
// block (#5666).
import remend, { INCOMPLETE_IMAGE_PLACEHOLDER } from "remend";
import { parseMarkdownIntoBlocks } from "streamdown";

// 1.4.0 adds these three passes and 1.0.2 has none of them. Keep them off so that the repair only
// changes in the ways measured for #5666.
const REMEND_OPTIONS = { comparisonOperators: false, htmlTags: false, singleTilde: false };
const INCOMPLETE_IMAGE_SUFFIX = `](${INCOMPLETE_IMAGE_PLACEHOLDER})`;
const MAX_IMAGE_CUTS = 4;

/**
 * remend 1.4.0 closes an unclosed image with a placeholder URL, which Xum's URL filter renders as
 * "[Image blocked: alt]". 1.0.2 cut the text at the image instead; keep that while the image is on
 * the last line (repeat for `![a ![b`). For an image on an earlier line, 1.0.2's cut also deleted
 * every later line, so only drop the placeholder there.
 */
function repairBlock(block: string): string {
  let text = block;
  for (let cuts = 0; ; cuts++) {
    const repaired = remend(text, REMEND_OPTIONS);
    // A suffix that the input already ends with is the author's text, not a placeholder.
    if (!repaired.endsWith(INCOMPLETE_IMAGE_SUFFIX) || text.endsWith(INCOMPLETE_IMAGE_SUFFIX)) {
      return repaired;
    }
    const imageStart = text.lastIndexOf("![");
    if (cuts === MAX_IMAGE_CUTS || imageStart === -1 || imageStart < text.lastIndexOf("\n")) {
      return repaired.slice(0, -INCOMPLETE_IMAGE_SUFFIX.length);
    }
    text = text.slice(0, imageStart);
  }
}

/**
 * Repair unclosed markdown syntax (bold, links, code fences, ...) in the last block only.
 *
 * remend 1.0.2 checked each marker it found by rescanning its input from the start, so its cost
 * grew quadratically with the input. Streamdown's streaming mode used to run it on the whole reply on
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
    return repairBlock(markdown);
  }
  return markdown.slice(0, markdown.length - lastBlock.length) + repairBlock(lastBlock);
}
