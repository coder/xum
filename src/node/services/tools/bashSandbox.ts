import type { BashSandboxApprovalEvent } from "@/common/types/stream";
import type { BashToolResult } from "@/common/types/tools";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { sandboxApprovalManager } from "@/node/services/agentSandbox/sandboxApprovalManager";
import { clockOf } from "@/node/utils/hostClock";
import { emitChatEventBestEffort } from "./toolUtils";

export const SANDBOX_APPROVAL_DENIED =
  "The user did not approve running this command outside the sandbox. Do not retry it outside the sandbox; find a way that works inside it, or ask the user.";

/** Whether the macOS agent sandbox applies to the commands of this tool configuration. */
export function agentSandboxApplies(config: ToolConfiguration): boolean {
  try {
    return config.runtime.agentSandboxPolicy?.({ cwd: config.cwd }) != null;
  } catch {
    // The sandbox applies but has no safe policy for this cwd, so commands fail closed there.
    return true;
  }
}

/**
 * Asks the user whether one bash call may run outside the sandbox. "not-asked" when the call
 * did not ask (no reason) or no sandbox applies, so the field changes nothing. A call with no
 * user to ask (`xum run`, ACP) is denied at once, and Stop denies a pending one. One answer is
 * for one call: nothing is remembered.
 */
export async function requestSandboxApproval(
  config: ToolConfiguration,
  toolCallId: string,
  reason: string | null | undefined,
  abortSignal: AbortSignal | undefined
): Promise<"not-asked" | "approved" | "denied"> {
  if (reason == null || !agentSandboxApplies(config)) return "not-asked";
  const workspaceId = config.workspaceId;
  if (config.noInteractiveUser === true || workspaceId === undefined) return "denied";
  const emit = (pending: boolean) =>
    emitChatEventBestEffort(
      config,
      {
        type: "bash-sandbox-approval",
        workspaceId,
        toolCallId,
        reason,
        pending,
        timestamp: clockOf(config).nowMs(),
      } satisfies BashSandboxApprovalEvent,
      "bash"
    );
  const answer = sandboxApprovalManager.request(workspaceId, toolCallId, abortSignal);
  emit(true);
  try {
    return await answer;
  } finally {
    emit(false);
  }
}

/**
 * Adds what the sandbox blocked to a foreground bash result, with a note that tells the model
 * what it may do about it.
 */
export function withSandboxDenials(result: BashToolResult, denials: string[]): BashToolResult {
  if (denials.length === 0 || !("exitCode" in result) || "backgroundProcessId" in result) {
    return result;
  }
  const note =
    `The sandbox blocked: ${denials.join("; ")}. Only the workspace, temp folders and tool caches are writable, ` +
    "and only listed hosts are reachable. If the command must run outside the sandbox, call bash again with the same script and outside_sandbox_reason; the user must approve it.";
  return {
    ...result,
    sandboxDenials: denials,
    note: result.note ? `${result.note}\n\n${note}` : note,
  };
}
