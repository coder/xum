/**
 * Notification tool - sends system notifications to the user
 *
 * This tool allows AI agents to notify users of important events using the
 * operating system's native notification system (macOS Notification Center,
 * Windows Toast notifications, Linux notification daemon).
 *
 * Uses Electron's cross-platform Notification API when available, with graceful
 * fallback for non-Electron environments. Clicking a notification navigates
 * the user to the workspace that sent it.
 */

import { tool } from "ai";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { NotifyToolResult } from "@/common/types/tools";
import {
  MAX_NOTIFICATION_BODY_LENGTH,
  MAX_NOTIFICATION_TITLE_LENGTH,
  truncateText,
} from "@/node/services/desktopNotifications/desktopNotifications";
import { electronDesktopNotifications } from "@/node/services/desktopNotifications/electronDesktopNotifications";

/**
 * Notify tool factory for AI assistant
 * Creates a tool that sends system notifications to the user
 */
export const createNotifyTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.notify.description,
    inputSchema: TOOL_DEFINITIONS.notify.schema,
    execute: async ({ title, message }, options): Promise<NotifyToolResult> => {
      // Validate title
      if (!title || title.trim().length === 0) {
        return {
          success: false,
          error: "Notification title is required and cannot be empty",
        };
      }

      const trimmedTitle = title.trim();
      const trimmedMessage = message?.trim();

      const truncatedTitle = truncateText(trimmedTitle, MAX_NOTIFICATION_TITLE_LENGTH);
      const truncatedMessage = trimmedMessage
        ? truncateText(trimmedMessage, MAX_NOTIFICATION_BODY_LENGTH)
        : undefined;

      // Absent: the Node layer, for configs that tests build by hand.
      const notifications = config.desktopNotifications ?? electronDesktopNotifications;
      const result = await notifications.show({
        title: truncatedTitle,
        body: truncatedMessage,
        workspaceId: config.workspaceId,
      });

      if (config.workspaceId != null && config.timelineService != null) {
        config.timelineService.record(config.workspaceId, {
          kind: "agent.notified",
          source: { system: "agent", key: `notify:${options.toolCallId}` },
          anchor: { toolCallId: options.toolCallId },
          status: "completed",
          data: {
            title: truncatedTitle,
            ...(truncatedMessage != null ? { digest: truncatedMessage } : {}),
          },
        });
      }

      // If Electron notification succeeded, we're done
      if (result.success) {
        return {
          success: true,
          title: truncatedTitle,
          message: truncatedMessage,
          ui_only: {
            notify: {
              notifiedVia: "electron",
              workspaceId: config.workspaceId,
            },
          },
        };
      }

      // Electron unavailable - signal frontend to handle browser notification
      // This is not an error; the notification will be delivered via Web Notifications API
      return {
        success: true,
        title: truncatedTitle,
        message: truncatedMessage,
        ui_only: {
          notify: {
            notifiedVia: "browser",
            workspaceId: config.workspaceId,
          },
        },
      };
    },
  });
};
