/**
 * A task checkout whose plugin-override sanitize failed at launch, and that a
 * failed reclaim may have left behind (published row, or leftover files):
 * stale `plugin:` enables in it could start MCP servers the user never enabled
 * (#4674). MCP discovery and sends refuse it with this typed error until the
 * task is removed; inspection, Stop, archive and remove stay available.
 */
export const UNSANITIZED_TASK_CHECKOUT_CODE = "task_checkout_unsanitized";

export class UnsanitizedTaskCheckoutError extends Error {
  readonly code = UNSANITIZED_TASK_CHECKOUT_CODE;

  constructor(readonly workspaceId: string) {
    super(
      "This task's checkout could not be sanitized after a failed launch, so MCP servers and messages are disabled for it. Remove or archive the task."
    );
    this.name = "UnsanitizedTaskCheckoutError";
  }
}
