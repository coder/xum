import type { TimelineEventDraft } from "@/common/orpc/schemas/timeline";

export interface TimelineRecorder {
  record(workspaceId: string, draft: TimelineEventDraft): void;
  // Call before deleting a session directory. Rejecting later records is as important as draining
  // the queue: an append recreates the directory, so a straggler would resurrect a deleted
  // workspace even after a successful flush.
  closeWorkspace(workspaceId: string): Promise<void>;
  // Call when a removal that already closed the workspace aborts: the workspace stays usable, so
  // leaving it closed would silently discard its events for the rest of the process.
  reopenWorkspace(workspaceId: string): void;
}

export const NOOP_TIMELINE_RECORDER: TimelineRecorder = {
  record: () => undefined,
  closeWorkspace: () => Promise.resolve(),
  reopenWorkspace: () => undefined,
};
