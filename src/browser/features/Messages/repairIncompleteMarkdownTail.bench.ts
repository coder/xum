/**
 * Per-frame cost of the streaming markdown repair on one huge block (#5666).
 * Run: make bench BENCH=repairIncompleteMarkdownTail
 *
 * Each iteration repairs the next frame of a 120-frame sequence (+30 chars per frame), the way the
 * smoothing engine feeds a live reply. The image cases are the worst inputs for the image rule.
 */
import { bench, do_not_optimize, summary } from "mitata";
import { repairIncompleteMarkdownTail } from "@/browser/features/Messages/repairIncompleteMarkdownTail";

/** mitata passes this to generator benchmarks; get() returns the current .args() value. */
interface BenchState {
  get(name: string): unknown;
}

const FRAMES = 120;
const FRAME_CHARS = 30;

function oneBlock(kind: string, total: number): string {
  let out = "";
  let k = 1;
  const add = (line: (k: number) => string) => {
    while (out.length < total) out += line(k++);
  };
  if (kind === "list")
    add((k) => `- item ${k} with **bold ${k}** and *em* and \`c${k}\` [l](http://x/${k})\n`);
  if (kind === "para")
    add((k) => `Sentence ${k} has **bold** and *it* and \`c${k}\` and a [link](http://x/${k}). `);
  if (kind === "table") {
    out = "| # | Name | Value | Note |\n| --- | --- | ---: | --- |\n";
    add((k) => `| ${k} | **name ${k}** | ${k * 7} | \`v${k}\` *ok* |\n`);
  }
  if (kind === "code") {
    out = "```ts\n";
    add((k) => `const v${k} = a * ${k} + b; // *note* \`${k}\` [x]\n`);
  }
  // Image rule worst cases: many unclosed images on the last line (the rule cuts up to 4 times),
  // and one unclosed image far back in a one-line paragraph (every frame strips the placeholder).
  if (kind === "img-last-line") {
    // The last line starts 6k chars before the end, so every frame ends inside it.
    while (out.length < total - 6000) {
      out += `- item ${k} with **bold ${k}** text\n`;
      k++;
    }
    out += "- last ";
    add((k) => `![a${k} `);
  }
  if (kind === "img-far-back") {
    out = "Start ![alt ";
    add((k) => `word ${k} and **bold** `);
  }
  return out;
}

summary(() => {
  bench("repairIncompleteMarkdownTail($kind, $chars)", function* (state: BenchState) {
    const kind = state.get("kind") as string;
    const chars = state.get("chars") as number;
    const text = oneBlock(kind, chars + FRAMES * FRAME_CHARS);
    const frames = Array.from({ length: FRAMES }, (_, i) => text.slice(0, chars + i * FRAME_CHARS));
    let i = 0;
    yield () => do_not_optimize(repairIncompleteMarkdownTail(frames[i++ % FRAMES]));
  })
    .args("kind", ["list", "para", "table", "code", "img-last-line", "img-far-back"])
    .args("chars", [20_000, 60_000]);
});
