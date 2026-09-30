import assert from "@/common/utils/assert";
import {
  diffClutterSnapshots,
  formatClutterNote,
  getClutterWatchRoots,
  snapshotClutterRoots,
  type ClutterSnapshot,
  type ClutterWatchRoot,
} from "@/node/runtime/homeClutterWatch";
import { log } from "@/node/services/log";

import type {
  AgentNotification,
  NotificationPollContext,
  NotificationSource,
} from "@/node/services/agentNotifications/NotificationEngine";

// Every tool result waits for this scan, so a slow or stalled home dir (network/FUSE mount)
// must never hold results back; a skipped poll just defers detection to the next tool call.
const SNAPSHOT_TIMEOUT_MS = 250;

async function snapshotWithin(
  roots: readonly ClutterWatchRoot[],
  timeoutMs: number
): Promise<ClutterSnapshot | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([snapshotClutterRoots(roots), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tells the model, at most once per turn, that new entries appeared directly in the shared home
 * folders (~, ~/.cache, ...) and that $XUM_SCRATCH_DIR is the place for temporary files.
 *
 * Why a notification source instead of a tool-result note: the text must reach the model only,
 * never the user's transcript, and the user asked for it to stay quiet (once per turn). One
 * instance lives for one stream attempt (getToolsForModel builds a fresh engine), so "emitted"
 * resets every turn. Diffing against a turn-level baseline after every tool call also catches
 * entries made by background processes since the previous call.
 */
export class HomeClutterReminderSource implements NotificationSource {
  private readonly homeDir: string;
  private readonly workspaceId: string | undefined;
  private readonly roots: ClutterWatchRoot[];
  private baseline: Promise<ClutterSnapshot | null>;
  /** Detected but not yet delivered (a failed tool call cannot carry notifications). */
  private readonly pending = new Set<string>();
  private emitted = false;

  constructor(args: { homeDir: string; workspaceId?: string }) {
    this.homeDir = args.homeDir;
    this.workspaceId = args.workspaceId;
    this.roots = getClutterWatchRoots(args.homeDir);
    // Start now (turn start) so entries created by the first tool call are not in the baseline.
    this.baseline = snapshotWithin(this.roots, SNAPSHOT_TIMEOUT_MS);
  }

  async poll(ctx: NotificationPollContext): Promise<AgentNotification[]> {
    assert(typeof ctx.toolName === "string", "toolName must be a string");

    const before = await this.baseline;
    const after = await snapshotWithin(this.roots, SNAPSHOT_TIMEOUT_MS);
    if (after == null) {
      // Timed out: keep the old baseline so nothing created meanwhile is lost.
      return [];
    }
    this.baseline = Promise.resolve(after);
    if (before == null) {
      // No usable baseline yet (the turn-start scan timed out); start comparing from here.
      return [];
    }

    const added = diffClutterSnapshots(this.roots, before, after);
    if (added.length > 0) {
      // Always log, so the new-entry rate stays measurable even after the model was told.
      log.info("New entries outside the workspace appeared during a turn", {
        workspaceId: this.workspaceId,
        afterTool: ctx.toolName,
        entries: added,
      });
      if (!this.emitted) {
        for (const entry of added) this.pending.add(entry);
      }
    }
    // The notification wrapper drops notifications of failed tool calls, so only a successful
    // call may consume the once-per-turn reminder.
    if (this.emitted || this.pending.size === 0 || !ctx.toolSucceeded) {
      return [];
    }
    this.emitted = true;
    const entries = [...this.pending].sort();
    this.pending.clear();
    return [
      {
        source: "home_clutter_reminder",
        content: `<notification>\n${formatClutterNote(entries, this.homeDir)}\n</notification>`,
      },
    ];
  }
}
