import type { APIClient } from "@/browser/contexts/API";

/** The ids among `sendIds` the backend accepted (a history row carries them). Rejects on failure. */
export async function acceptedSendIds(
  api: APIClient,
  workspaceId: string,
  sendIds: readonly string[]
): Promise<Set<string>> {
  const result = await api.workspace.getSendStatus({ workspaceId, sendIds: [...sendIds] });
  if (!result.success) throw new Error(result.error);
  return new Set(
    result.data.statuses.filter(({ status }) => status === "accepted").map(({ sendId }) => sendId)
  );
}

/**
 * Whether the backend accepted an edit send whose reply failed (idempotent sends): an edit has no
 * pending-send draft entry (its pre-edit draft is memory-only), so the composer asks directly.
 * Anything but "accepted" (including a failed lookup) keeps today's put-back of the edit text.
 */
export async function isEditSendAccepted(
  api: APIClient,
  workspaceId: string,
  sendId: string
): Promise<boolean> {
  try {
    const result = await api.workspace.getSendStatus({ workspaceId, sendIds: [sendId] });
    return (
      result.success &&
      result.data.statuses.some((entry) => entry.sendId === sendId && entry.status === "accepted")
    );
  } catch {
    return false;
  }
}
