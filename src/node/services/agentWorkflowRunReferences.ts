import * as fs from "node:fs/promises";
import * as path from "node:path";

import writeFileAtomic from "write-file-atomic";

import assert from "@/common/utils/assert";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";

export interface AgentWorkflowRunReference {
  runId: string;
  createdAtMs: number;
}

const AGENT_WORKFLOW_RUN_REFERENCES_FILE = "agent-workflow-runs.json";

// Backward clock corrections (e.g. an NTP step after booting with a fast clock) can make a
// legitimately recorded reference look future-dated. Tolerate that bounded skew so the run's
// terminal wake is not dropped; only implausibly future values are treated as corruption.
const MAX_FUTURE_SKEW_MS = 60 * 60_000;

const referenceFileLocks = new MutexMap<string>();

function referencesPath(workspaceSessionDir: string): string {
  assert(workspaceSessionDir.length > 0, "agent workflow references require session dir");
  return path.join(workspaceSessionDir, AGENT_WORKFLOW_RUN_REFERENCES_FILE);
}

function parseReferences(value: unknown): AgentWorkflowRunReference[] {
  if (value == null || typeof value !== "object") {
    return [];
  }
  const references = (value as Record<string, unknown>).references;
  if (!Array.isArray(references)) {
    return [];
  }

  const parsedByRunId = new Map<string, AgentWorkflowRunReference>();
  const now = Date.now();
  for (const reference of references) {
    if (reference == null || typeof reference !== "object") {
      continue;
    }
    const record = reference as Record<string, unknown>;
    if (typeof record.runId !== "string" || record.runId.length === 0) {
      continue;
    }
    if (typeof record.createdAtMs !== "number" || !Number.isFinite(record.createdAtMs)) {
      continue;
    }
    // Reject implausibly future-dated references (corruption) instead of clamping at read
    // time: a per-read clamp re-evaluates to "now" on every read, so the entry would outrank
    // every later user/reset boundary until wall time catches up. Values within
    // MAX_FUTURE_SKEW_MS are kept as-is (backward clock correction, not corruption). Rejected
    // entries are replaced with a sane timestamp by the next legitimate record.
    if (record.createdAtMs > now + MAX_FUTURE_SKEW_MS) {
      continue;
    }
    // Collapse corrupted duplicate entries to the newest sane timestamp so order-sensitive
    // consumers cannot pick a stale duplicate and declare a legitimately re-recorded run
    // superseded.
    const existing = parsedByRunId.get(record.runId);
    if (existing == null || record.createdAtMs > existing.createdAtMs) {
      parsedByRunId.set(record.runId, { runId: record.runId, createdAtMs: record.createdAtMs });
    }
  }
  return Array.from(parsedByRunId.values());
}

export async function readAgentWorkflowRunReferences(
  workspaceSessionDir: string
): Promise<AgentWorkflowRunReference[]> {
  try {
    const raw = await fs.readFile(referencesPath(workspaceSessionDir), "utf-8");
    return parseReferences(JSON.parse(raw) as unknown);
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    return [];
  }
}

export async function recordAgentWorkflowRunReference(input: {
  workspaceSessionDir: string;
  runId: string;
  createdAtMs?: number;
}): Promise<void> {
  assert(input.runId.length > 0, "agent workflow reference requires runId");
  const filePath = referencesPath(input.workspaceSessionDir);

  await referenceFileLocks.withLock(filePath, async () => {
    const existing = await readAgentWorkflowRunReferences(input.workspaceSessionDir);
    const byRunId = new Map(existing.map((reference) => [reference.runId, reference]));
    // Clamp like parseReferences: never persist a future-dated timestamp.
    const createdAtMs = Math.min(input.createdAtMs ?? Date.now(), Date.now());
    const previous = byRunId.get(input.runId);
    byRunId.set(input.runId, {
      runId: input.runId,
      // Latest record wins: workflow_resume re-records the reference, and a resume issued after
      // a manual user message must re-establish provenance for supersession-timestamp
      // comparisons (isWorkflowInvocationCurrent, listAgentReferencedWorkflowRunIds).
      createdAtMs: previous ? Math.max(previous.createdAtMs, createdAtMs) : createdAtMs,
    });

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeFileAtomic(
      filePath,
      JSON.stringify({ references: Array.from(byRunId.values()) }, null, 2)
    );
  });
}
