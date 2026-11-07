import type { BashSandboxApprovalEvent } from "@/common/types/stream";
import type { BashToolResult } from "@/common/types/tools";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import type { ExecOptions, ExecStream } from "@/node/runtime/Runtime";
import { sandboxApprovalManager } from "@/node/services/agentSandbox/sandboxApprovalManager";
import { clockOf } from "@/node/utils/hostClock";
import { emitChatEventBestEffort } from "./toolUtils";

export const SANDBOX_APPROVAL_DENIED =
  "The user did not approve running this command outside the sandbox. Do not retry it outside the sandbox; find a way that works inside it, or ask the user.";

/** Whether the macOS agent sandbox applies to the commands of this tool configuration. */
function agentSandboxApplies(config: ToolConfiguration): boolean {
  try {
    return config.runtime.agentSandboxPolicy?.({ cwd: config.cwd }) != null;
  } catch {
    // The sandbox applies but has no safe policy for this cwd, so commands fail closed there.
    return true;
  }
}

export type SandboxApproval = "not-asked" | "approved" | "denied";

/** The exec options of a bash call: an approved call runs outside the sandbox, with full access. */
export function sandboxExecOptions(approval: SandboxApproval): Pick<ExecOptions, "sandbox"> {
  return approval === "approved" ? { sandbox: "off" } : {};
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
): Promise<SandboxApproval> {
  if (reason == null || !agentSandboxApplies(config)) return "not-asked";
  const workspaceId = config.workspaceId;
  if (config.noInteractiveUser === true || workspaceId === undefined) return "denied";
  const event = (pending: boolean): BashSandboxApprovalEvent => ({
    type: "bash-sandbox-approval",
    workspaceId,
    toolCallId,
    reason,
    pending,
    timestamp: clockOf(config).nowMs(),
  });
  const pendingEvent = event(true);
  const answer = sandboxApprovalManager.request(workspaceId, toolCallId, abortSignal, pendingEvent);
  emitChatEventBestEffort(config, pendingEvent, "bash");
  try {
    return await answer;
  } finally {
    emitChatEventBestEffort(config, event(false), "bash");
  }
}

/**
 * Adds what the sandbox blocked to a foreground bash result, with a note that tells the model
 * what it may do about it. `failed`: the command exited non-zero, so the denials are worth the
 * wait for the sandbox log.
 */
export async function withSandboxDenials(
  result: BashToolResult,
  execStream: Pick<ExecStream, "sandboxDenials">,
  failed: boolean
): Promise<BashToolResult> {
  const denials = (await execStream.sandboxDenials?.(failed)) ?? [];
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
