import { Effect } from "effect";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import assert from "@/common/utils/assert";
import {
  MEMORY_INTUITION_CANDIDATE_THRESHOLD,
  MEMORY_INTUITION_EVAL_MAX_CHUNKS,
  MEMORY_INTUITION_EVAL_MAX_ENTRIES,
  MEMORY_INTUITION_MAX_EXCERPT_CHARS,
  MEMORY_INTUITION_MAX_RESULTS,
  MEMORY_INTUITION_RECOGNITION_THRESHOLD,
} from "@/common/constants/memory";
import { canonicalRequestBytes, type EvaluationState } from "@/common/types/evaluation";
import type { IntuitionReportToolArgs, IntuitionStats } from "@/common/types/tools";
import type { EvaluationModelInstance, EvaluationService } from "./evaluation/evaluationService";
import { runEvaluationToOutcome } from "./evaluation/evaluationOutcome";
import { log } from "./log";
import type { IntuitionReadResult } from "./memoryIntuition";
import { stripMemoryFrontmatter, type MemoryIndexEntry } from "./memoryService";

/**
 * Evaluation recall: when the Intuition model resolves as an evaluation model,
 * answer a cue with at most two JSON evaluation requests instead of the
 * multi-step tool loop. Stage 1 asks one boolean per index entry (path and
 * description only); stage 2 asks one boolean per memory chunk read from the
 * most promising files. The caller still re-verifies every item through
 * `classifyIntuitionReport`, so this module only proposes report items.
 */

/** Honest fixed explanation: evaluation answers carry probabilities, not reasons. */
export const EVAL_WHY = "Selected by the relevance evaluator; excerpt verified against memory.";

export const normalizeWhitespace = (text: string) => text.replace(/\s+/gu, " ").trim();

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

type BooleanQuestions = Record<string, { type: "boolean"; instructions: string }>;

// Trusted, fixed instructions refer to items by id only: the cue and memory text
// are untrusted and travel exclusively in `state`, which the adapter frames as data.
const entryQuestion = (id: string) => ({
  type: "boolean" as const,
  instructions: `Judging only from its path and description, is memory "${id}" in state.memories likely to contain information that helps with state.cue?`,
});
const excerptQuestion = (id: string) => ({
  type: "boolean" as const,
  instructions: `Does excerpt "${id}" in state.excerpts contain information that directly helps with state.cue?`,
});

function excerptRequest(cue: string, chunks: readonly PickedChunk[]) {
  const questions: BooleanQuestions = {};
  const excerpts = chunks.map((chunk, i) => {
    const id = `e${i}`;
    questions[id] = excerptQuestion(id);
    return { id, path: chunk.path, text: chunk.text };
  });
  return { state: { cue, excerpts }, questions };
}

export type EvaluationRecallOutcome =
  | { kind: "items"; items: IntuitionReportToolArgs["items"] }
  | { kind: "error"; message: string }
  | { kind: "timed_out" };

export async function runEvaluationRecall(args: {
  model: EvaluationModelInstance;
  evaluationService: EvaluationService;
  cue: string;
  /** Hook-authorized, cue-ranked index selection. */
  entries: readonly MemoryIndexEntry[];
  /** The invocation's hook-filtered, allowed-set, byte-budgeted memory view. */
  readMemoryView: (path: string) => Promise<IntuitionReadResult>;
  scoreText: (text: string) => number;
  signal: AbortSignal;
  deadlineAt: number;
  stats: IntuitionStats;
  /** Called once per completed request whose input and output counts are both known. */
  onUsage: (usage: LanguageModelV2Usage, providerMetadata?: Record<string, unknown>) => void;
}): Promise<EvaluationRecallOutcome> {
  const evaluate = async (state: EvaluationState, questions: BooleanQuestions) => {
    const outcome = await runEvaluationToOutcome(
      Effect.suspend(() => {
        // Runs only once the bridge's pre-checks pass, so `steps` counts sent requests.
        args.stats.steps++;
        return args.evaluationService.evaluate({ model: args.model, state, questions });
      }),
      { runtimeAbortSignal: args.signal, deadlineAt: args.deadlineAt }
    );
    if (outcome.status === "completed") {
      const { usage, usageProviderMetadata: metadata } = outcome.result;
      // Unknown counts are skipped: recording them as zero would under-count spend.
      if (usage.inputTokens !== null && usage.outputTokens !== null) {
        args.onUsage(
          {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
          },
          metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
            ? { ...metadata }
            : undefined
        );
      }
    }
    return outcome;
  };
  const probabilityOf = (answers: Record<string, { probability: number }>, id: string) => {
    const answer = answers[id];
    assert(answer !== undefined, "validated evaluation answers must cover every question");
    return answer.probability;
  };

  // Stage 1: shortlist files from index metadata alone.
  const judged = args.entries.slice(0, MEMORY_INTUITION_EVAL_MAX_ENTRIES);
  args.stats.indexEntriesOmitted += args.entries.length - judged.length;
  const entryQuestions: BooleanQuestions = {};
  const memories = judged.map((entry, i) => {
    const id = `m${i}`;
    entryQuestions[id] = entryQuestion(id);
    return { id, path: entry.path, description: entry.description };
  });
  const first = await evaluate({ cue: args.cue, memories }, entryQuestions);
  if (first.status === "interrupted" || (first.status === "failed" && first.code === "deadline"))
    return { kind: "timed_out" };
  if (first.status === "failed")
    return {
      kind: "error",
      message: `Memory relevance evaluation failed (${first.reason}/${first.code}).`,
    };
  const shortlist = judged
    .map((entry, i) => ({
      path: entry.path,
      relevance: probabilityOf(first.result.answers, `m${i}`),
    }))
    .filter((file) => file.relevance >= MEMORY_INTUITION_CANDIDATE_THRESHOLD)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, MEMORY_INTUITION_MAX_RESULTS);
  if (shortlist.length === 0) return { kind: "items", items: [] };
  const leads = shortlist.map((file) => ({ ...file, excerpt: "", why: EVAL_WHY }));

  // Read one file at a time so the shared byte budget is spent in relevance order;
  // failed or over-budget reads simply stay leads.
  const sources: ChunkSource[] = [];
  for (const file of shortlist) {
    const view = await args.readMemoryView(file.path);
    if (!view.success || view.effectivePath !== file.path || view.rawContent === undefined)
      continue;
    // Chunk the hook-filtered view (never disclose redacted bytes) but keep only text
    // that is also verbatim in the raw file: hook annotations are not memories.
    const raw = normalizeWhitespace(view.rawContent);
    sources.push({
      path: file.path,
      chunks: chunkMemoryText(stripMemoryFrontmatter(view.output)).filter((chunk) =>
        raw.includes(normalizeWhitespace(chunk))
      ),
    });
  }
  // readMemoryView turns an abort into an ordinary failed read, so an expired deadline
  // would otherwise look like "no readable files" and return leads as `uncertain`.
  if (args.signal.aborted) return { kind: "timed_out" };
  let picked = pickChunks(sources, args.scoreText);
  let request = excerptRequest(args.cue, picked);
  // The static budget assumes ordinary UTF-8 text; escape-heavy text or very long
  // paths can still exceed the cap, so drop the lowest-priority chunks until it fits.
  while (picked.length > 0 && !canonicalRequestBytes(request).ok) {
    picked = picked.slice(0, -1);
    request = excerptRequest(args.cue, picked);
  }
  if (picked.length === 0) return { kind: "items", items: leads };

  // Stage 2: score the chunks; a file is recognized only through its best chunk.
  const second = await evaluate(request.state, request.questions);
  if (second.status === "interrupted" || (second.status === "failed" && second.code === "deadline"))
    return { kind: "timed_out" };
  if (second.status === "failed") {
    // Stage 1 was already billed; never retry with the loop. Unverified files stay leads.
    log.debug("[intuition] excerpt evaluation failed; returning leads only", {
      reason: second.reason,
      code: second.code,
    });
    return { kind: "items", items: leads };
  }
  const best = new Map<string, { excerpt: string; relevance: number }>();
  picked.forEach((chunk, i) => {
    const relevance = probabilityOf(second.result.answers, `e${i}`);
    const previous = best.get(chunk.path);
    if (!previous || relevance > previous.relevance)
      best.set(chunk.path, { excerpt: chunk.text, relevance });
  });
  return {
    kind: "items",
    items: leads.map((lead) => {
      const chunk = best.get(lead.path);
      return chunk && chunk.relevance >= MEMORY_INTUITION_RECOGNITION_THRESHOLD
        ? { ...lead, ...chunk }
        : lead;
    }),
  };
}
