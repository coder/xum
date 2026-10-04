import type { DraftResolveSendsInput, DraftResolveSendsOutput } from "@/common/orpc/schemas/drafts";
import type { DraftService } from "@/node/services/draftService";
import type { WorkspaceService } from "@/node/services/workspaceService";

/** getSendStatus accepts at most this many ids per call (schemas.workspace.getSendStatus). */
const LOOKUP_BATCH = 100;

/**
 * drafts.resolveSends (ComposerSends.tla Lookup): ask the receiver about every pending send of a
 * workspace draft, then apply the final answers under the draft lock. The lookups run OUTSIDE the
 * draft lock (getSendStatus takes the history lock: no nested draft/history locks), grouped by
 * the receiver each entry names; DraftService.applySendStatuses rechecks under the lock that each
 * entry still exists and still names the receiver that was asked. Idempotent: two windows may
 * resolve the same draft at once. A failed lookup applies nothing and rejects (the client keeps
 * the entries unresolved and retries).
 */
export async function resolveDraftSends(
  services: { draftService: DraftService; workspaceService: WorkspaceService },
  input: DraftResolveSendsInput
): Promise<DraftResolveSendsOutput> {
  const { scope } = input;
  const except = new Set(input.exceptSendIds ?? []);
  const entries = (await services.draftService.getPendingSends(scope)).filter(
    ({ sendId }) => !except.has(sendId)
  );
  if (entries.length === 0) return { statuses: [] };
  const byReceiver = new Map<string, string[]>();
  for (const { sendId, receiverId } of entries) {
    byReceiver.set(receiverId, [...(byReceiver.get(receiverId) ?? []), sendId]);
  }
  const answers: Array<{ sendId: string; receiverId: string; status: string }> = [];
  let currentReceiverId: string | undefined;
  for (const [receiverId, sendIds] of byReceiver) {
    for (let start = 0; start < sendIds.length; start += LOOKUP_BATCH) {
      const result = await services.workspaceService.getSendStatus(
        scope.workspaceId,
        sendIds.slice(start, start + LOOKUP_BATCH),
        receiverId
      );
      if (!result.success) throw new Error(`Send status lookup failed: ${result.error}`);
      currentReceiverId = result.data.receiverId;
      for (const { sendId, status } of result.data.statuses) {
        answers.push({ sendId, receiverId, status });
      }
    }
  }
  await services.draftService.applySendStatuses(scope, answers);
  return {
    ...(currentReceiverId !== undefined ? { receiverId: currentReceiverId } : {}),
    statuses: answers.map(({ sendId, status }) => ({
      sendId,
      status: status as DraftResolveSendsOutput["statuses"][number]["status"],
    })),
  };
}
