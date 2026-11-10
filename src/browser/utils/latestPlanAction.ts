import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";

export const NO_RUNNABLE_PLAN_MESSAGE =
  "No plan to implement: the latest plan's Implement / Continue in Auto is missing or disabled.";

/**
 * Run the latest plan card's primary action (Implement, or Continue in Auto in Auto mode) for a
 * workspace. The card marks the request handled synchronously (#4963); false means no card could
 * run it, and the caller says so (NO_RUNNABLE_PLAN_MESSAGE).
 */
export function runLatestPlanAction(workspaceId: string): boolean {
  const request = createCustomEvent(CUSTOM_EVENTS.RUN_LATEST_PLAN_ACTION, {
    workspaceId,
    handled: false,
  });
  window.dispatchEvent(request);
  return request.detail.handled;
}
