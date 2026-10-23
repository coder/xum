/**
 * The golden script of the session folder (phase 2, PR 1).
 *
 * Phase 2 moves HistoryService's node:fs calls behind an Effect service (SessionFiles). The move
 * must keep every byte that Xum writes to sessions/<workspaceId>/, because older builds read the
 * same files after a downgrade. This harness drives a fixed script of public HistoryService calls
 * and takes a snapshot of the folder after each step: the exact recursive listing and the content
 * of every file. historyFiles.golden.test.ts compares the snapshots with a fixture recorded on the
 * code before the move. The call-trace test (historyFiles.trace.test.ts) runs the same STEPS.
 *
 * Every input is fixed (ids, timestamps, the cancellation nonce), so only the values listed in
 * RANDOM_FIELDS differ between runs.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import type { ContinuousCompactionJournal } from "@/common/orpc/schemas/continuousCompaction";
import { createMuxMessage, type MuxMessage, type MuxMetadata } from "@/common/types/message";
import type { Result } from "@/common/types/result";
import { POST_COMPACTION_STATE_FILENAME } from "@/constants/compaction";
import { CONTINUOUS_COMPACTION_GENERATION_FILE } from "@/constants/continuousCompaction";
import type { Config } from "@/node/config";
import { CompactionPendingState } from "@/node/services/compactionPendingState";
import type { HistoryService } from "@/node/services/historyService";
import type { SessionFiles } from "./sessionFiles";

export const GOLDEN_WORKSPACE_ID = "golden-history-files";

export interface GoldenStepContext {
  historyService: HistoryService;
  workspaceId: string;
  sessionDir: string;
}

export interface GoldenStep {
  name: string;
  run(context: GoldenStepContext): Promise<void>;
}

export interface GoldenSnapshot {
  step: string;
  /** Sorted paths relative to the session folder. Directories end with "/". */
  listing: string[];
  /** Every file in the listing, as UTF-8 text, after normalizeSessionFile. */
  files: Record<string, string>;
}

const T0 = Date.UTC(2026, 0, 1);

// Build each message inside its step: appendToHistory writes historySequence into the object it
// gets, so a shared message would carry a sequence into a second run of the script.
const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  second: number,
  metadata: MuxMetadata = {}
): MuxMessage => createMuxMessage(id, role, text, { timestamp: T0 + second * 1000, ...metadata });

function expectOk(result: Result<unknown>, call: string): void {
  assert(result.success, `${call} failed: ${result.success ? "" : String(result.error)}`);
}

export const STEPS: readonly GoldenStep[] = [
  {
    name: "a. append user and assistant rows",
    async run({ historyService, workspaceId }) {
      expectOk(
        await historyService.appendToHistory(workspaceId, message("user-1", "user", "Hello", 0)),
        "appendToHistory(user-1)"
      );
      expectOk(
        await historyService.appendToHistory(
          workspaceId,
          message("assistant-1", "assistant", "Hi there", 1, { model: "anthropic:test" })
        ),
        "appendToHistory(assistant-1)"
      );
    },
  },
  {
    name: "b. write and commit a partial",
    async run({ historyService, workspaceId }) {
      // A stream appends its empty placeholder row first. commitPartial deletes a partial that has
      // no row of its own as orphaned.
      expectOk(
        await historyService.appendToHistory(
          workspaceId,
          message("assistant-2", "assistant", "", 2, { model: "anthropic:test" })
        ),
        "appendToHistory(assistant-2 placeholder)"
      );
      const partial = message("assistant-2", "assistant", "Streamed answer", 2, {
        historySequence: 2,
        model: "anthropic:test",
        partial: true,
      });
      expectOk(await historyService.writePartial(workspaceId, partial), "writePartial");
      expectOk(await historyService.commitPartial(workspaceId, partial.id), "commitPartial");
    },
  },
  {
    name: "c. edit an assistant row",
    async run({ historyService, workspaceId }) {
      const edited = message("assistant-1", "assistant", "Hi there, edited", 1, {
        historySequence: 1,
        model: "anthropic:test",
      });
      expectOk(await historyService.updateHistory(workspaceId, edited), "updateHistory");
    },
  },
  {
    name: "d. append a compaction boundary (rotates rows into chat-archive.jsonl)",
    async run({ historyService, workspaceId }) {
      const boundary = message("boundary-1", "assistant", "Compacted summary", 3, {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
        muxMetadata: { type: "compaction-summary" },
      });
      expectOk(await historyService.appendToHistory(workspaceId, boundary), "appendToHistory");
    },
  },
  {
    name: "e. write the journal, the pending state and the cancellation record",
    async run({ historyService, workspaceId, sessionDir }) {
      // The minimal valid calls come from historyService.replacement.test.ts (journal),
      // historyService.compactionPending.test.ts (pending state) and
      // compactionCancellation.storage.test.ts (cancellation).
      const journal = historyService.getContinuousCompactionJournal(workspaceId);
      await journal.advanceGeneration();
      const generation = await journal.captureGeneration();
      const prepared: ContinuousCompactionJournal = {
        version: 1,
        publicationGeneration: generation,
        boundary: message("journal-summary", "assistant", "Prepared summary", 4, {
          compactionBoundary: true,
          compactionEpoch: 2,
        }),
        staticCopies: [],
        liveTailCopySpec: {
          sourceMessageId: "live",
          sourceHistorySequence: 4,
          copyId: "copy",
          partIndex: 0,
          metadataTemplate: { synthetic: true, rlmPreservedTailCopy: true },
        },
        postCompactionAttachments: [],
        prefixSourceRows: [],
        systemPrefix: [],
        cacheEnabled: false,
        preparation: {
          modelString: "anthropic:test",
          providerForMessages: "anthropic",
          effectiveThinkingLevel: "off",
          effectiveAgentId: "exec",
          toolNamesForSentinel: [],
        },
        providerFamily: "anthropic",
        parentModel: "anthropic:test",
        summaryModel: "anthropic:test",
        headFingerprint: "head",
        sourceFingerprint: "source",
        headEnd: { id: "boundary-1", sequence: 3 },
        epoch: 1,
        streamMessageId: "live",
        streamHistorySequence: 4,
        stepNumber: 0,
        firstTailToolCallId: "tool",
      };
      const written = await journal.write(
        prepared,
        [{ role: "user", content: "Prepared prefix" }],
        () => true
      );
      assert(written, "journal.write refused the journal");

      const pending = new CompactionPendingState(
        path.join(sessionDir, POST_COMPACTION_STATE_FILENAME),
        historyService.getCompactionPendingHistory(workspaceId),
        historyService.files
      );
      assert(
        await pending.prepare({
          attachments: { diffs: [], loadedSkills: [], readFiles: ["/golden.ts"] },
          boundaryMessageId: "journal-summary",
          // The pending state belongs to the publication that holds this journal.
          publication: { generation, journal: written },
          isCurrent: () => true,
        }),
        "pending.prepare wrote no state"
      );

      // `settled` makes the record version 2, so the file also gets settledGeneration.
      const outcome = await historyService.getCompactionCancellationStorage(workspaceId).mutate(
        {
          kind: "publish",
          record: { version: 1, nonce: "golden-nonce", scope: { kind: "unresolved" } },
          publication: { attempts: 1 },
          settled: Promise.resolve(true),
        },
        () => true,
        () => undefined
      );
      assert.equal(outcome, "applied");
    },
  },
  {
    name: "f. truncate after an archived message",
    async run({ historyService, workspaceId }) {
      expectOk(
        await historyService.truncateAfterMessage(workspaceId, "assistant-2"),
        "truncateAfterMessage"
      );
    },
  },
  {
    name: "g. write a partial that stays on disk",
    async run({ historyService, workspaceId }) {
      const partial = message("assistant-3", "assistant", "Still streaming", 5, {
        historySequence: 2,
        model: "anthropic:test",
        partial: true,
      });
      expectOk(await historyService.writePartial(workspaceId, partial), "writePartial");
    },
  },
  {
    name: "h. accept one row (guarded append), then two rows (staged publication)",
    async run({ historyService, workspaceId }) {
      // Only an accepted replacement passes a publication observer, so this is the public path to
      // the guarded append (one row) and to the staged publication (several rows). Ordinary input
      // (preserveCancellation) keeps the Stop of step e in place.
      const batches = [
        [message("user-2", "user", "One more", 6)],
        [message("user-3", "user", "And two", 7), message("user-4", "user", "rows", 8)],
      ];
      for (const messages of batches) {
        const capture = await historyService.captureCompactionReplacement(workspaceId);
        assert(capture.success, "captureCompactionReplacement failed");
        const accepted = await historyService.acceptCompactionReplacement(
          workspaceId,
          capture.data,
          { kind: "append", messages, preserveCancellation: true },
          { isCurrent: () => true, onCommitted: () => undefined }
        );
        expectOk(accepted, "acceptCompactionReplacement");
        assert(accepted.success && accepted.data.kind === "accepted", "the rows were not accepted");
      }
    },
  },
];

/** The context that runGoldenScript gives every step. */
export function goldenStepContext(
  historyService: HistoryService,
  config: Config
): GoldenStepContext {
  const workspaceId = GOLDEN_WORKSPACE_ID;
  return { historyService, workspaceId, sessionDir: path.join(config.sessionsDir, workspaceId) };
}

/**
 * The only values that change from run to run. Every other byte must match. A path segment "*"
 * matches every key of an object. The comment on each entry names the source of the value.
 */
const RANDOM_FIELDS: Record<string, ReadonlyArray<readonly string[]>> = {
  // historyAppendProvenance.ts: epoch is randomUUID(); the stamps come from fs.stat.
  "history-append-provenance.json": [
    ["epoch"],
    ["files", "*", "dev"],
    ["files", "*", "ino"],
    ["files", "*", "mtimeNs"],
    ["files", "*", "ctimeNs"],
  ],
  // compactionPendingState.ts prepareUnderLock: Date.now(), randomUUID(), and the sha256 of
  // continuous-compaction-generation.
  "post-compaction.json": [["createdAt"], ["writeId"], ["publicationGeneration"]],
  // compactionCancellation.ts mutate: the sha256 of continuous-compaction-generation. The nonce
  // is the script's fixed input, so it is compared as is.
  "compaction-cancellation.json": [["settledGeneration"]],
  // The sha256 of continuous-compaction-generation that the script captured.
  "continuous-compaction.json": [["publicationGeneration"]],
};

function replaceAt(value: unknown, keys: readonly string[]): unknown {
  if (keys.length === 0) return `<random ${typeof value}>`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const [key, ...rest] = keys;
  const object = value as Record<string, unknown>;
  for (const name of key === "*" ? Object.keys(object) : [key]) {
    if (name in object) object[name] = replaceAt(object[name], rest);
  }
  return object;
}

/** Replace the random values of one session file. Other files come back unchanged. */
export function normalizeSessionFile(name: string, text: string): string {
  // continuousCompactionJournal.ts advanceGenerationUnderHistoryLock writes one randomUUID().
  if (name === CONTINUOUS_COMPACTION_GENERATION_FILE) return `<random ${text.length} chars>`;
  const fields = RANDOM_FIELDS[name];
  if (fields === undefined) return text;
  const parsed: unknown = JSON.parse(text);
  // Re-serializing is byte-exact only for compact JSON.stringify output, which these files are.
  assert.equal(JSON.stringify(parsed), text, `${name} is not compact JSON; cannot normalize it`);
  for (const keys of fields) replaceAt(parsed, keys);
  return JSON.stringify(parsed);
}

async function listRecursive(files: SessionFiles, root: string, relative = ""): Promise<string[]> {
  const entries = await files.promises.readdir(path.join(root, relative), { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) names.push(`${name}/`, ...(await listRecursive(files, root, name)));
    else names.push(name);
  }
  return names;
}

async function snapshotFolder(
  sessionFiles: SessionFiles,
  step: string,
  sessionDir: string
): Promise<GoldenSnapshot> {
  const listing = (await listRecursive(sessionFiles, sessionDir)).sort();
  const files: Record<string, string> = {};
  for (const name of listing) {
    if (name.endsWith("/")) continue;
    const bytes = await sessionFiles.promises.readFile(path.join(sessionDir, name));
    const text = bytes.toString("utf8");
    // The fixture stores text, so it must decode back to the same bytes.
    assert(Buffer.from(text, "utf8").equals(bytes), `${name} is not valid UTF-8`);
    files[name] = normalizeSessionFile(path.posix.basename(name), text);
  }
  return { step, listing, files };
}

/**
 * Run the steps in order on a fresh HistoryService and snapshot the session folder after each.
 * The snapshots read through `files`, the SessionFiles that historyService writes to.
 */
export async function runGoldenScript(
  historyService: HistoryService,
  config: Config,
  steps: readonly GoldenStep[],
  files: SessionFiles
): Promise<GoldenSnapshot[]> {
  const context = goldenStepContext(historyService, config);
  const snapshots: GoldenSnapshot[] = [];
  for (const step of steps) {
    await step.run(context);
    snapshots.push(await snapshotFolder(files, step.name, context.sessionDir));
  }
  return snapshots;
}
