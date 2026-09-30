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
  private baseline: Promise<ClutterSnapshot>;
  private emitted = false;

  constructor(args: { homeDir: string; workspaceId?: string }) {
    this.homeDir = args.homeDir;
    this.workspaceId = args.workspaceId;
    this.roots = getClutterWatchRoots(args.homeDir);
    // Start now (turn start) so entries created by the first tool call are not in the baseline.
    this.baseline = snapshotClutterRoots(this.roots);
  }

  async poll(ctx: NotificationPollContext): Promise<AgentNotification[]> {
    assert(typeof ctx.toolName === "string", "toolName must be a string");

    const before = await this.baseline;
    const after = await snapshotClutterRoots(this.roots);
    this.baseline = Promise.resolve(after);

    const added = diffClutterSnapshots(this.roots, before, after);
    if (added.length === 0) {
      return [];
    }
    // Always log, so the new-entry rate stays measurable even after the model was told.
    log.info("New entries outside the workspace appeared during a turn", {
      workspaceId: this.workspaceId,
      afterTool: ctx.toolName,
      entries: added,
    });
    if (this.emitted) {
      return [];
    }
    this.emitted = true;
    return [
      {
        source: "home_clutter_reminder",
        content: `<notification>\n${formatClutterNote(added, this.homeDir)}\n</notification>`,
      },
    ];
  }
}
