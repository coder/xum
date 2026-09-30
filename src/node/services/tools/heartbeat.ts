import { tool } from "ai";
import type {
  ToolFactory,
  WorkspaceHeartbeatSettings,
  WorkspaceHeartbeatSettingsUpdate,
} from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { HeartbeatToolArgs, HeartbeatToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { HEARTBEAT_REMOVED_SUMMARY, summarizeHeartbeatSettings } from "@/constants/heartbeat";
import { requireWorkspaceId } from "./toolUtils";

function hasProvided<K extends keyof HeartbeatToolArgs>(
  args: HeartbeatToolArgs,
  key: K
): args is HeartbeatToolArgs & { [P in K]-?: NonNullable<HeartbeatToolArgs[P]> } {
  return Object.prototype.hasOwnProperty.call(args, key) && args[key] != null;
}

function summarize(
  result: Pick<HeartbeatToolResult & { success: true }, "action" | "settings">
): string {
  return result.action === "unset"
    ? HEARTBEAT_REMOVED_SUMMARY
    : summarizeHeartbeatSettings(result.settings);
}

// Build the shared success payload for every heartbeat action so the get/set/unset branches
// don't each re-assemble the same { action, configured, settings, summary } object. `configured`
// is derived from settings: null only for unset and an unconfigured get, non-null otherwise.
function buildSuccessResult(
  action: HeartbeatToolArgs["action"],
  settings: WorkspaceHeartbeatSettings | null
): Extract<HeartbeatToolResult, { success: true }> {
  return {
    success: true,
    action,
    configured: settings != null,
    settings,
    summary: summarize({ action, settings }),
  };
}

export const createHeartbeatTool: ToolFactory = (config) =>
  tool({
    description: TOOL_DEFINITIONS.heartbeat.description,
    inputSchema: TOOL_DEFINITIONS.heartbeat.schema,
    execute: async (args): Promise<HeartbeatToolResult> => {
      try {
        const workspaceId = requireWorkspaceId(config, "heartbeat");

        const heartbeatService = config.workspaceHeartbeatService;
        if (!heartbeatService) {
          return { success: false, error: "Heartbeat service is unavailable" };
        }

        if (args.action === "get") {
          const settings = heartbeatService.getHeartbeatSettings(workspaceId);
          return buildSuccessResult(args.action, settings);
        }

        if (args.action === "unset") {
          const unsetResult = await heartbeatService.unsetHeartbeatSettings(workspaceId);
          if (!unsetResult.success) {
            return { success: false, error: unsetResult.error };
          }
          return buildSuccessResult(args.action, null);
        }

        const settingsUpdate: WorkspaceHeartbeatSettingsUpdate = {};
        if (hasProvided(args, "enabled")) {
          settingsUpdate.enabled = args.enabled;
        }
        if (hasProvided(args, "intervalMs")) {
          settingsUpdate.intervalMs = args.intervalMs;
        }
        if (hasProvided(args, "contextMode")) {
          settingsUpdate.contextMode = args.contextMode;
        }
        if (hasProvided(args, "message")) {
          settingsUpdate.message = args.message;
        }
        // Strict-mode providers send explicit null for omitted fields, so the tool treats
        // null as "not provided" (preserve). Individual fields cannot be cleared here;
        // action='unset' clears everything.
        if (hasProvided(args, "trigger")) {
          settingsUpdate.trigger = args.trigger;
        }
        if (hasProvided(args, "whenBusy")) {
          settingsUpdate.whenBusy = args.whenBusy;
        }

        const setResult = await heartbeatService.setHeartbeatSettings(workspaceId, settingsUpdate);
        if (!setResult.success) {
          return { success: false, error: setResult.error };
        }

        const settings = setResult.data;
        return buildSuccessResult(args.action, settings);
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });
