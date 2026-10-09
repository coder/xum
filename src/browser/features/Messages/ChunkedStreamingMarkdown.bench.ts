/**
 * Per-frame cost of the chunked switch-back path on one huge list or table (#5666).
 * Run: make bench BENCH=ChunkedStreamingMarkdown RUNTIME=bun
 * (Node cannot load this module chain: MarkdownCore imports KaTeX's CSS.)
 *
 * Each iteration feeds the next frame of a 120-frame prefix sequence of a 50k list to one
 * MarkdownChunker, the way a row that mounted mid-stream sees a live reply. The table case
 * feeds the same frames of a 50k table.
 */
import { bench, do_not_optimize, summary } from "mitata";
import { MarkdownChunker } from "@/browser/features/Messages/ChunkedStreamingMarkdown";
import { CHUNKED_STREAMING_CHUNK_CHARS } from "@/constants/streaming";

const FRAMES = 120;
const TOTAL = 50_000;

let list = "";
for (let k = 1; list.length < TOTAL; k++) {
  list += `- item ${k} with **bold ${k}** and *em* and \`c${k}\` [l](http://x/${k})\n`;
}
// The last 120 frames of the stream, +30 chars each.
const frames = Array.from({ length: FRAMES }, (_, i) =>
  list.slice(0, list.length - (FRAMES - 1 - i) * 30)
);
let table = "| n | value | code |\n|---:|:---|---|\n";
for (let k = 1; table.length < TOTAL; k++) {
  table += `| ${k} | **bold ${k}** and *em* | \`c${k}\` [l](http://x/${k}) |\n`;
}
const tableFrames = frames.map((frame) =>
  table.slice(0, table.length - list.length + frame.length)
);

summary(() => {
  bench("MarkdownChunker.update list 50k (per frame)", function* () {
    let chunker = new MarkdownChunker(CHUNKED_STREAMING_CHUNK_CHARS);
    let frame = 0;
    yield () => {
      if (frame === FRAMES) {
        chunker = new MarkdownChunker(CHUNKED_STREAMING_CHUNK_CHARS);
        frame = 0;
      }
      do_not_optimize(chunker.update(frames[frame++]));
    };
  });

  bench("MarkdownChunker.update table 50k (per frame)", function* () {
    let chunker = new MarkdownChunker(CHUNKED_STREAMING_CHUNK_CHARS);
    let frame = 0;
    yield () => {
      if (frame === FRAMES) {
        chunker = new MarkdownChunker(CHUNKED_STREAMING_CHUNK_CHARS);
        frame = 0;
      }
      do_not_optimize(chunker.update(tableFrames[frame++]));
    };
  });
});
