import assert from "@/common/utils/assert";
import { log } from "@/node/services/log";

export interface AgentNotification {
  source: string;
  content: string;
}

export interface NotificationPollContext {
  toolName: string;
  toolSucceeded: boolean;
  /** False when the tool result (e.g. a string) has no place to attach notifications. */
  resultCanCarryNotifications?: boolean;
  now: number;
}

export interface NotificationSource {
  poll(ctx: NotificationPollContext): Promise<AgentNotification[]>;
}

export class NotificationEngine {
  private readonly sources: NotificationSource[];
  private readonly seenContents = new Set<string>();

  constructor(sources: NotificationSource[]) {
    assert(Array.isArray(sources), "sources must be an array");
    this.sources = sources;
  }

  async pollAfterToolCall(ctx: NotificationPollContext): Promise<string[]> {
    const results: string[] = [];

    for (const source of this.sources) {
      try {
        const notifications = await source.poll(ctx);
        for (const notification of notifications) {
          if (!notification?.content) continue;
          if (this.seenContents.has(notification.content)) continue;
          this.seenContents.add(notification.content);
          results.push(notification.content);
        }
      } catch (error) {
        const ctorName = (source as { constructor?: { name?: unknown } }).constructor?.name;
        const sourceName = typeof ctorName === "string" ? ctorName : "unknown";

        log.debug("[NotificationEngine] poll failed", {
          error,
          source: sourceName,
        });
      }
    }

    return results;
  }
}
