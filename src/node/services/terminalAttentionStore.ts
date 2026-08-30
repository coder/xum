import type { Dirent } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

import assert from "@/common/utils/assert";
import type { WorkspaceSessionLocator } from "@/node/config";
import { log } from "@/node/services/log";
import { isErrnoWithCode } from "@/node/utils/fs";

/**
 * Persisted, idempotent record that an owner workspace still needs to resume after terminal
 * background work. Source-specific output stays in its authoritative store; this outbox only owns
 * accepted-delivery dedupe and crash recovery.
 */
export const TERMINAL_ATTENTION_DIR = "terminal-attention";

const TERMINAL_ATTENTION_OUTPUT_DELIVERIES = [
  "already_injected",
  "requires_task_await",
  "workflow_result_context",
] as const;
export type TerminalAttentionOutputDelivery = (typeof TERMINAL_ATTENTION_OUTPUT_DELIVERIES)[number];

const TERMINAL_ATTENTION_OUTCOMES = ["completed", "failed", "interrupted", "error"] as const;
export type TerminalAttentionOutcome = (typeof TERMINAL_ATTENTION_OUTCOMES)[number];

const TERMINAL_ATTENTION_SOURCE_KINDS = ["agent_task", "workspace_turn", "workflow_run"] as const;
export type TerminalAttentionSourceKind = (typeof TERMINAL_ATTENTION_SOURCE_KINDS)[number];

const TERMINAL_ATTENTION_STATUSES = ["pending", "delivered", "superseded"] as const;
export type TerminalAttentionStatus = (typeof TERMINAL_ATTENTION_STATUSES)[number];

function outputDeliveryForSource(
  sourceKind: TerminalAttentionSourceKind
): TerminalAttentionOutputDelivery {
  switch (sourceKind) {
    case "agent_task":
      return "already_injected";
    case "workspace_turn":
      return "requires_task_await";
    case "workflow_run":
      return "workflow_result_context";
  }
}

export interface TerminalAttentionNotification {
  id: string;
  ownerWorkspaceId: string;
  sourceKind: TerminalAttentionSourceKind;
  sourceId: string;
  /** Optional internal execution generation; keeps repeated stable-child assignments independent. */
  generationId?: string;
  outputDelivery: TerminalAttentionOutputDelivery;
  terminalOutcome: TerminalAttentionOutcome;
  status: TerminalAttentionStatus;
  createdAt: string;
  deliveredAt?: string;
}

const TerminalAttentionNotificationSchema = z.object({
  id: z.string().min(1),
  ownerWorkspaceId: z.string().min(1),
  sourceKind: z.enum(TERMINAL_ATTENTION_SOURCE_KINDS),
  sourceId: z.string().min(1),
  generationId: z.string().min(1).optional(),
  outputDelivery: z.enum(TERMINAL_ATTENTION_OUTPUT_DELIVERIES),
  terminalOutcome: z.enum(TERMINAL_ATTENTION_OUTCOMES),
  status: z.enum(TERMINAL_ATTENTION_STATUSES),
  createdAt: z.string().min(1),
  deliveredAt: z.string().optional(),
});

/**
 * Disk-backed store for terminal attention notifications, one JSON file per notification under the
 * owner workspace session dir. Pure local I/O with a single dependency (getSessionDir); self-heals
 * by skipping malformed files at read time.
 */
export class TerminalAttentionStore {
  constructor(private readonly config: Pick<WorkspaceSessionLocator, "sessionsDir">) {}

  private dir(ownerWorkspaceId: string): string {
    assert(ownerWorkspaceId.trim().length > 0, "TerminalAttentionStore requires ownerWorkspaceId");
    return path.join(this.config.sessionsDir, ownerWorkspaceId, TERMINAL_ATTENTION_DIR);
  }

  /** Stable id keyed by source and optional execution generation for per-assignment idempotency. */
  static notificationId(
    sourceKind: TerminalAttentionSourceKind,
    sourceId: string,
    generationId?: string
  ): string {
    return generationId == null
      ? `${sourceKind}:${sourceId}`
      : `${sourceKind}:${sourceId}:${generationId}`;
  }

  private file(ownerWorkspaceId: string, id: string): string {
    return path.join(this.dir(ownerWorkspaceId), `${encodeURIComponent(id)}.json`);
  }

  /**
   * Insert a pending notification if none exists yet for this source. Idempotent: an existing
   * record (pending/delivered/superseded) is left untouched so we never resurrect a delivered
   * wake-up or duplicate a pending one.
   */
  async enqueueIfAbsent(
    notification: Omit<
      TerminalAttentionNotification,
      "id" | "status" | "createdAt" | "outputDelivery" | "terminalOutcome"
    > & {
      createdAt?: string;
      terminalOutcome?: TerminalAttentionOutcome;
    }
  ): Promise<TerminalAttentionNotification | null> {
    const id = TerminalAttentionStore.notificationId(
      notification.sourceKind,
      notification.sourceId,
      notification.generationId
    );
    const existing = await this.get(notification.ownerWorkspaceId, id);
    if (existing != null) {
      return null;
    }
    const record: TerminalAttentionNotification = {
      id,
      ownerWorkspaceId: notification.ownerWorkspaceId,
      sourceKind: notification.sourceKind,
      sourceId: notification.sourceId,
      ...(notification.generationId != null ? { generationId: notification.generationId } : {}),
      outputDelivery: outputDeliveryForSource(notification.sourceKind),
      terminalOutcome: notification.terminalOutcome ?? "completed",
      status: "pending",
      createdAt: notification.createdAt ?? new Date().toISOString(),
    };
    await this.write(record);
    return record;
  }

  async get(ownerWorkspaceId: string, id: string): Promise<TerminalAttentionNotification | null> {
    let raw: string;
    try {
      raw = await fsPromises.readFile(this.file(ownerWorkspaceId, id), "utf-8");
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return null;
      throw error;
    }
    return this.parse(raw);
  }

  async listPending(ownerWorkspaceId: string): Promise<TerminalAttentionNotification[]> {
    const dir = this.dir(ownerWorkspaceId);
    let entries: string[];
    try {
      entries = await fsPromises.readdir(dir);
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return [];
      throw error;
    }
    const records: TerminalAttentionNotification[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const raw = await fsPromises.readFile(path.join(dir, entry), "utf-8").catch(() => null);
      if (raw == null) continue;
      const parsed = this.parse(raw);
      if (parsed?.status === "pending") {
        records.push(parsed);
      }
    }
    // Stable order for deterministic coalescing.
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return records;
  }

  async listPendingOwnerWorkspaceIds(): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await fsPromises.readdir(this.config.sessionsDir, { withFileTypes: true });
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return [];
      throw error;
    }

    const ownerWorkspaceIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if ((await this.listPending(entry.name)).length > 0) {
        ownerWorkspaceIds.push(entry.name);
      }
    }
    ownerWorkspaceIds.sort();
    return ownerWorkspaceIds;
  }

  async delete(ownerWorkspaceId: string, id: string): Promise<void> {
    await fsPromises.rm(this.file(ownerWorkspaceId, id), { force: true });
  }

  async markPending(ownerWorkspaceId: string, id: string): Promise<void> {
    const record = await this.get(ownerWorkspaceId, id);
    if (record?.status !== "delivered") {
      return;
    }
    const { deliveredAt: _deliveredAt, ...pendingRecord } = record;
    await this.write({ ...pendingRecord, status: "pending" });
  }

  async markDelivered(ownerWorkspaceId: string, id: string): Promise<void> {
    await this.transition(ownerWorkspaceId, id, "delivered");
  }

  async markSuperseded(ownerWorkspaceId: string, id: string): Promise<void> {
    await this.transition(ownerWorkspaceId, id, "superseded");
  }

  private async transition(
    ownerWorkspaceId: string,
    id: string,
    status: "delivered" | "superseded"
  ): Promise<void> {
    const record = await this.get(ownerWorkspaceId, id);
    if (record?.status !== "pending") {
      return;
    }
    await this.write({
      ...record,
      status,
      ...(status === "delivered" ? { deliveredAt: new Date().toISOString() } : {}),
    });
  }

  private async write(record: TerminalAttentionNotification): Promise<void> {
    const dir = this.dir(record.ownerWorkspaceId);
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(
      this.file(record.ownerWorkspaceId, record.id),
      JSON.stringify(record, null, 2),
      "utf-8"
    );
  }

  private parse(raw: string): TerminalAttentionNotification | null {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = TerminalAttentionNotificationSchema.safeParse(json);
    if (!parsed.success) {
      log.debug("Skipping malformed terminal attention notification", { error: parsed.error });
      return null;
    }
    return parsed.data;
  }
}
