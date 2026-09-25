import * as fsPromises from "fs/promises";
import * as path from "node:path";

import { Err, Ok, type Result } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import { isTaskAttemptId } from "@/node/utils/taskAttemptId";
import writeFileAtomic from "@/node/utils/writeFileAtomic";

/**
 * Owner-written, immutable settlement receipts for sub-agent attempts.
 *
 * A receipt names ONE attempt (WorkspaceConfigEntry.taskAttemptId) and asserts that its owner
 * settled it after the last point at which any execution could still publish a report for it.
 * Unlike the in-memory ownership/settlement ledgers in TaskService, receipts survive a backend
 * restart, so a fresh process can classify a prior-process attempt as terminal-without-report
 * instead of indeterminate.
 *
 * Layout: sessions/<ownerWorkspaceId>/subagent-attempt-settlements/<taskId>/<attemptId>.json —
 * one file per attempt, written by temp file + rename (writeFileAtomic), never modified or
 * deleted. Concurrent writers of DIFFERENT attempts never touch the same file; the process-local
 * workspaceFileLocks used by the read-modify-write failure artifacts are therefore not needed.
 *
 * Scope: a receipt is evidence that ONE backend settled the attempt, never proof that no report
 * exists. With two backends on one root, another backend can run a turn under the same attempt id
 * without rotating it and still publish a report after this receipt (#4545). Consumers must read
 * the report artifact first: a receipt followed by a report is "reported".
 *
 * Producers are TaskService's settlement paths (persistOwnedAttemptSettlement and the stop-record
 * release). The only reader so far is the lineage proof at reawaken/reactivation; the classifier
 * that would consume receipts for workflow replacement is enabled by a later change.
 */
export const SUBAGENT_ATTEMPT_SETTLEMENT_RECEIPT_VERSION = 1 as const;
const SUBAGENT_ATTEMPT_SETTLEMENTS_DIR_NAME = "subagent-attempt-settlements";

export type SubagentAttemptSettlementSource =
  | "execution-settled"
  | "idle-settled"
  | "launch-failed"
  | "reservation-canceled"
  | "reservation-failed";

const SETTLEMENT_SOURCES: ReadonlySet<string> = new Set<SubagentAttemptSettlementSource>([
  "execution-settled",
  "idle-settled",
  "launch-failed",
  "reservation-canceled",
  "reservation-failed",
]);

export interface SubagentAttemptSettlementReceipt {
  version: typeof SUBAGENT_ATTEMPT_SETTLEMENT_RECEIPT_VERSION;
  taskId: string;
  attemptId: string;
  /** Immediate parent in the agent-task tree at settlement (matches the config entry). */
  parentWorkspaceId: string;
  source: SubagentAttemptSettlementSource;
  /** ISO 8601. */
  settledAt: string;
}

export type SubagentAttemptSettlementReceiptReadResult =
  | { kind: "found"; receipt: SubagentAttemptSettlementReceipt }
  | { kind: "not_found" }
  | { kind: "unreadable"; error: string };

export function getSubagentAttemptSettlementReceiptPath(
  ownerWorkspaceSessionDir: string,
  taskId: string,
  attemptId: string
): string {
  return path.join(
    ownerWorkspaceSessionDir,
    SUBAGENT_ATTEMPT_SETTLEMENTS_DIR_NAME,
    encodeURIComponent(taskId),
    `${attemptId}.json`
  );
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function parseReceipt(raw: string): Result<SubagentAttemptSettlementReceipt, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    return Err(`receipt is not valid JSON: ${getErrorMessage(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Err("receipt body is not an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== SUBAGENT_ATTEMPT_SETTLEMENT_RECEIPT_VERSION) {
    return Err(`unsupported receipt version ${String(obj.version)}`);
  }
  if (typeof obj.taskId !== "string" || obj.taskId.length === 0) {
    return Err("receipt has no taskId");
  }
  if (!isTaskAttemptId(obj.attemptId)) {
    return Err("receipt has a malformed attemptId");
  }
  if (typeof obj.parentWorkspaceId !== "string" || obj.parentWorkspaceId.length === 0) {
    return Err("receipt has no parentWorkspaceId");
  }
  if (typeof obj.source !== "string" || !SETTLEMENT_SOURCES.has(obj.source)) {
    return Err(`receipt has an unknown source ${String(obj.source)}`);
  }
  if (typeof obj.settledAt !== "string" || Number.isNaN(Date.parse(obj.settledAt))) {
    return Err("receipt has no valid settledAt");
  }
  return Ok({
    version: SUBAGENT_ATTEMPT_SETTLEMENT_RECEIPT_VERSION,
    taskId: obj.taskId,
    attemptId: obj.attemptId,
    parentWorkspaceId: obj.parentWorkspaceId,
    source: obj.source as SubagentAttemptSettlementSource,
    settledAt: obj.settledAt,
  });
}

/**
 * Strict read: ENOENT is the only `not_found`; every other failure (I/O, JSON, schema, an id
 * mismatch between path and body) is `unreadable`, which consumers must treat as no evidence.
 */
export async function readSubagentAttemptSettlementReceiptStrict(
  ownerWorkspaceSessionDir: string,
  taskId: string,
  attemptId: string
): Promise<SubagentAttemptSettlementReceiptReadResult> {
  if (!isTaskAttemptId(attemptId)) {
    return { kind: "unreadable", error: `malformed attempt id ${String(attemptId)}` };
  }
  const receiptPath = getSubagentAttemptSettlementReceiptPath(
    ownerWorkspaceSessionDir,
    taskId,
    attemptId
  );
  let raw: string;
  try {
    raw = await fsPromises.readFile(receiptPath, "utf-8");
  } catch (error: unknown) {
    if (isEnoent(error)) return { kind: "not_found" };
    return { kind: "unreadable", error: getErrorMessage(error) };
  }
  const parsed = parseReceipt(raw);
  if (!parsed.success) return { kind: "unreadable", error: parsed.error };
  if (parsed.data.taskId !== taskId || parsed.data.attemptId !== attemptId) {
    return {
      kind: "unreadable",
      error: `receipt names ${parsed.data.taskId}/${parsed.data.attemptId}, expected ${taskId}/${attemptId}`,
    };
  }
  return { kind: "found", receipt: parsed.data };
}

/**
 * Write the receipt into every listed owner session dir (the parent and its ancestors, resolved
 * by the caller from the entry captured at settlement). Idempotent: an existing file for the same
 * attempt is left untouched and counts as written; a file naming a different attempt at the same
 * path can only mean an id collision and is reported as an error. Never throws and never times
 * out internally — the caller owns the promise and its completion, however late.
 */
export async function writeSubagentAttemptSettlementReceipt(params: {
  ownerWorkspaceSessionDirs: readonly string[];
  receipt: Omit<SubagentAttemptSettlementReceipt, "version">;
}): Promise<Result<void, string>> {
  const { receipt } = params;
  if (!isTaskAttemptId(receipt.attemptId)) {
    return Err(`refusing to write a receipt for malformed attempt id ${String(receipt.attemptId)}`);
  }
  if (params.ownerWorkspaceSessionDirs.length === 0) {
    return Err("no owner session dir to write the receipt into");
  }
  const body = JSON.stringify(
    {
      version: SUBAGENT_ATTEMPT_SETTLEMENT_RECEIPT_VERSION,
      ...receipt,
    } satisfies SubagentAttemptSettlementReceipt,
    null,
    2
  );
  const errors: string[] = [];
  for (const ownerDir of params.ownerWorkspaceSessionDirs) {
    const receiptPath = getSubagentAttemptSettlementReceiptPath(
      ownerDir,
      receipt.taskId,
      receipt.attemptId
    );
    try {
      const existing = await readSubagentAttemptSettlementReceiptStrict(
        ownerDir,
        receipt.taskId,
        receipt.attemptId
      );
      if (existing.kind === "found") {
        // Immutable: an existing receipt for this attempt stands, but only when it vouches for
        // the same parent. One naming another parent (copied or corrupted state) is not this
        // settlement's evidence, and lineage would reject it after a restart, so the write
        // fails (the caller leaves the attempt closing) instead of reporting success.
        if (existing.receipt.parentWorkspaceId !== receipt.parentWorkspaceId) {
          errors.push(
            `${receiptPath}: existing receipt names parent ${existing.receipt.parentWorkspaceId}, not ${receipt.parentWorkspaceId}`
          );
        }
        continue;
      }
      if (existing.kind === "unreadable") {
        errors.push(`${receiptPath}: existing receipt unreadable (${existing.error})`);
        continue;
      }
      await fsPromises.mkdir(path.dirname(receiptPath), { recursive: true });
      await writeFileAtomic(receiptPath, body, "utf-8");
    } catch (error: unknown) {
      errors.push(`${receiptPath}: ${getErrorMessage(error)}`);
    }
  }
  return errors.length === 0 ? Ok(undefined) : Err(errors.join("; "));
}
