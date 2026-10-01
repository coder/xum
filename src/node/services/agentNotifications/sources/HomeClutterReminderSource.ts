import assert from "@/common/utils/assert";
import {
  diffClutterSnapshots,
  formatClutterNote,
  getSharedClutterScanner,
  type ClutterScanner,
  type ClutterSnapshot,
} from "@/node/runtime/homeClutterWatch";
import { log } from "@/node/services/log";

import type {
  AgentNotification,
  NotificationPollContext,
  NotificationSource,
} from "@/node/services/agentNotifications/NotificationEngine";

// Tool results wait for the scan at most this long, so a slow or stalled home dir
// (network/FUSE mount) never holds them back; detection just moves to a later tool call.
const SNAPSHOT_TIMEOUT_MS = 250;
const MAX_LOGGED_ENTRIES = 5;

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
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
  private readonly scanner: ClutterScanner;
  /** Turn-start snapshot until the first comparison, then the last snapshot compared against. */
  private baseline: ClutterSnapshot | null = null;
  private readonly initialScan: Promise<ClutterSnapshot>;
  /** Detected but not yet delivered to the model. */
  private readonly pending = new Set<string>();
  private emitted = false;

  constructor(args: { homeDir: string; workspaceId?: string; scanner?: ClutterScanner }) {
    this.homeDir = args.homeDir;
    this.workspaceId = args.workspaceId;
    this.scanner = args.scanner ?? getSharedClutterScanner(args.homeDir);
    // Take the baseline at turn start; keep it even if it completes after a poll timed out.
    this.initialScan = this.scanner.scan();
    const keepBaseline = (snapshot: ClutterSnapshot) => {
      this.baseline ??= snapshot;
    };
    this.initialScan.then(keepBaseline, () => undefined);
  }

  private recordNewEntries(toolName: string, added: string[]): void {
    if (added.length === 0) return;
    // Debug level and a bounded sample: this runs on every poll that sees new entries.
    log.debug("New entries outside the workspace appeared during a turn", {
      workspaceId: this.workspaceId,
      afterTool: toolName,
      count: added.length,
      sample: added.slice(0, MAX_LOGGED_ENTRIES),
    });
    if (!this.emitted) {
      for (const entry of added) this.pending.add(entry);
    }
  }

  async poll(ctx: NotificationPollContext): Promise<AgentNotification[]> {
    assert(typeof ctx.toolName === "string", "toolName must be a string");

    // A scan stuck longer than the timeout (stalled mount) is not waited on again.
    const waitMs = this.scanner.busyForMs() > SNAPSHOT_TIMEOUT_MS ? 0 : SNAPSHOT_TIMEOUT_MS;
    if (this.baseline == null) {
      await within(this.initialScan, waitMs);
      if (this.baseline == null) return [];
    }
    const after = await within(this.scanner.scan(), waitMs);
    const before = this.baseline;
    // null: timed out, try again on a later call. Same object: nothing rescanned since.
    if (after != null && after !== before) {
      this.baseline = after;
      this.recordNewEntries(ctx.toolName, diffClutterSnapshots(this.scanner.roots, before, after));
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
