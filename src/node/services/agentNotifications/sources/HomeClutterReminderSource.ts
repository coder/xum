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
const MAX_LOGGED_ENTRIES = 5;

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
  /** Latest completed snapshot; null until the first scan finishes. */
  private baseline: ClutterSnapshot | null = null;
  /**
   * At most one scan runs at a time. readdir cannot be cancelled, so on a stalled filesystem a
   * timed-out scan stays in flight and later polls skip instead of piling up more reads.
   */
  private inFlight: Promise<ClutterSnapshot> | null = null;
  /** Detected but not yet delivered to the model. */
  private readonly pending = new Set<string>();
  private emitted = false;

  constructor(args: { homeDir: string; workspaceId?: string }) {
    this.homeDir = args.homeDir;
    this.workspaceId = args.workspaceId;
    this.roots = getClutterWatchRoots(args.homeDir);
    // Start now (turn start) so entries created by the first tool call are not in the baseline.
    this.startScan();
  }

  /** Starts a scan and records it as the in-flight one; the caller checks the slot is free. */
  private startScan(): void {
    assert(this.inFlight == null, "a clutter scan is already in flight");
    const scan = snapshotClutterRoots(this.roots);
    this.inFlight = scan;
    // A scan that outlived its timeout frees the slot whenever it finally settles.
    const release = () => this.releaseScan(scan);
    scan.then(release, release);
  }

  private releaseScan(scan: Promise<ClutterSnapshot>): void {
    if (this.inFlight === scan) this.inFlight = null;
  }

  /** Resolves with the scan, or null if it does not finish within the timeout. */
  private async awaitScan(scan: Promise<ClutterSnapshot>): Promise<ClutterSnapshot | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SNAPSHOT_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([scan, timeout]);
      // Release synchronously so the next scan can start right away (the settle callback
      // above may not have run yet at this point).
      if (result != null) this.releaseScan(scan);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async poll(ctx: NotificationPollContext): Promise<AgentNotification[]> {
    assert(typeof ctx.toolName === "string", "toolName must be a string");

    if (this.baseline == null && this.inFlight != null) {
      // The turn-start scan is the baseline; give it the same bounded wait.
      this.baseline = await this.awaitScan(this.inFlight);
    }
    if (this.inFlight != null) {
      // A previous scan is still stuck; do not pile up more reads behind it.
      return [];
    }
    this.startScan();
    const scan = this.inFlight;
    assert(scan != null, "startScan must record the in-flight scan");
    const after = await this.awaitScan(scan);
    if (after == null) {
      // Timed out: keep the old baseline so nothing created meanwhile is lost, and try again
      // on the next tool call.
      return [];
    }
    const before = this.baseline;
    this.baseline = after;
    if (before == null) {
      return [];
    }

    const added = diffClutterSnapshots(this.roots, before, after);
    if (added.length > 0) {
      // Debug level and a bounded sample: this runs on every poll that sees new entries.
      log.debug("New entries outside the workspace appeared during a turn", {
        workspaceId: this.workspaceId,
        afterTool: ctx.toolName,
        count: added.length,
        sample: added.slice(0, MAX_LOGGED_ENTRIES),
      });
      if (!this.emitted) {
        for (const entry of added) this.pending.add(entry);
      }
    }
    // Only a result that will actually carry the notification may consume the once-per-turn
    // reminder: failed calls and non-object results (strings from MCP tools) drop it.
    const canDeliver = ctx.toolSucceeded && ctx.resultCanCarryNotifications !== false;
    if (this.emitted || this.pending.size === 0 || !canDeliver) {
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
