/**
 * Exited records each workspace keeps in memory. Before this bound, exited records left the map
 * only when the workspace closed, and one long session held 599 of them (F29 heap snapshot).
 * Older exited records are dropped only once the agent has read their terminal status.
 */
export const MAX_EXITED_BACKGROUND_PROCESSES_PER_WORKSPACE = 50;

/**
 * Expired-ID tombstones each workspace keeps, so the tombstones stay bounded in a long session.
 * An ID evicted past this bound reads as unknown again.
 */
export const MAX_EXPIRED_BACKGROUND_PROCESS_IDS_PER_WORKSPACE = 1000;

/** The result for a process ID whose exited record was dropped by that bound. */
export function formatExpiredBackgroundProcessMessage(processId: string): string {
  return `Output of background process ${processId} expired: Xum keeps only the newest ${MAX_EXITED_BACKGROUND_PROCESSES_PER_WORKSPACE} exited processes per workspace, and this process had exited and its result was already read. Do not retry.`;
}
