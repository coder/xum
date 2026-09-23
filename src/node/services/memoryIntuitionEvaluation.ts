import {
  MEMORY_INTUITION_EVAL_MAX_CHUNKS,
  MEMORY_INTUITION_MAX_EXCERPT_CHARS,
} from "@/common/constants/memory";

/**
 * Evaluation recall: when the Intuition model resolves as an evaluation model,
 * answer a cue with at most two JSON evaluation requests instead of the
 * multi-step tool loop. Stage 1 asks one boolean per index entry (path and
 * description only); stage 2 asks one boolean per memory chunk read from the
 * most promising files. The caller still re-verifies every item through
 * `classifyIntuitionReport`, so this module only proposes report items.
 */

// Blank lines, or a newline before an unindented list item (nested items stay with their parent).
const BLOCK_BOUNDARY = /\r?\n[ \t]*\r?\n|\r?\n(?=(?:[-*+]|\d+[.)])[ \t])/u;
const HEADING_ONLY = /^#{1,6}[ \t][^\n]*$/u;

/**
 * Verbatim chunks of memory text, each at most MEMORY_INTUITION_MAX_EXCERPT_CHARS.
 * Long blocks become consecutive windows cut at whitespace, so evidence past the
 * excerpt cap is still reachable instead of being truncated away.
 */
export function chunkMemoryText(text: string): string[] {
  const chunks: string[] = [];
  for (const part of text.split(BLOCK_BOUNDARY)) {
    let block = part.trim();
    // A lone heading has no evidence of its own.
    if (block.length === 0 || HEADING_ONLY.test(block)) continue;
    while (block.length > MEMORY_INTUITION_MAX_EXCERPT_CHARS) {
      // Last whitespace inside the window; otherwise hard-cut, keeping surrogate pairs whole.
      let cut = block.slice(0, MEMORY_INTUITION_MAX_EXCERPT_CHARS + 1).search(/\s\S*$/u);
      if (cut <= 0) {
        cut = MEMORY_INTUITION_MAX_EXCERPT_CHARS;
        const code = block.charCodeAt(cut - 1);
        if (code >= 0xd800 && code <= 0xdbff) cut--;
      }
      chunks.push(block.slice(0, cut).trimEnd());
      block = block.slice(cut).trimStart();
    }
    chunks.push(block);
  }
  return chunks;
}

export interface ChunkSource {
  path: string;
  chunks: readonly string[];
}
export interface PickedChunk {
  path: string;
  text: string;
}

/**
 * Rank each file's chunks by `score` (ties keep document order), then take
 * them round-robin across files so one large file cannot use every slot.
 */
export function pickChunks(
  files: readonly ChunkSource[],
  score: (text: string) => number
): PickedChunk[] {
  const queues = files.map((file) =>
    file.chunks
      .map((text) => ({ text, score: score(text) }))
      .sort((a, b) => b.score - a.score)
      .map(({ text }) => ({ path: file.path, text }))
  );
  const picked: PickedChunk[] = [];
  for (let round = 0; picked.length < MEMORY_INTUITION_EVAL_MAX_CHUNKS; round++) {
    const layer = queues.flatMap((queue) => (round < queue.length ? [queue[round]] : []));
    if (layer.length === 0) break;
    picked.push(...layer.slice(0, MEMORY_INTUITION_EVAL_MAX_CHUNKS - picked.length));
  }
  return picked;
}
