import assert from "@/common/utils/assert";

/**
 * Reserved fields that may be injected into tool results for model-only consumption.
 *
 * IMPORTANT: These fields MUST be stripped before persisting tool outputs to disk or
 * sending them to the UI.
 */
export const MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD = "__mux_notifications" as const;

/** Only plain-object results have a place for model-only notifications. */
export function canCarryModelOnlyToolNotifications(result: unknown): boolean {
  return result != null && typeof result === "object" && !Array.isArray(result);
}

export function attachModelOnlyToolNotifications(
  result: unknown,
  notifications: string[]
): unknown {
  assert(Array.isArray(notifications), "notifications must be an array");
  if (notifications.length === 0) {
    return result;
  }

  if (!canCarryModelOnlyToolNotifications(result)) {
    return result;
  }

  const record = result as Record<string, unknown>;
  const existing = record[MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD];
  const merged = Array.isArray(existing)
    ? [
        ...(existing as unknown[]).filter((item): item is string => typeof item === "string"),
        ...notifications,
      ]
    : notifications;

  return {
    ...record,
    [MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD]: merged,
  };
}

/**
 * Strip model-only fields from tool results before persisting them to history/partial.
 */
export function stripInternalToolResultFields(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }

  if (!(MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD in result)) {
    return result;
  }

  const { [MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD]: _notifications, ...rest } = result as Record<
    string,
    unknown
  >;
  void _notifications;
  return rest;
}
