import assert from "node:assert/strict";

export type SandboxApprovalAnswer = "approved" | "denied";

interface PendingSandboxApproval {
  resolve: (answer: SandboxApprovalAnswer) => void;
}

/**
 * The bash calls that wait for the user to let one blocked command run outside the sandbox.
 * Only the user answers, through workspace.answerSandboxApproval; no agent tool reaches it. An
 * answer covers one call, and nothing is remembered: the next call asks again, and a restart
 * drops every pending request (its tool call is gone too).
 */
export class SandboxApprovalManager {
  private pendingByWorkspace = new Map<string, Map<string, PendingSandboxApproval>>();

  /** Waits for the user's answer to `toolCallId`. An abort (Stop) denies it. */
  request(
    workspaceId: string,
    toolCallId: string,
    abortSignal?: AbortSignal
  ): Promise<SandboxApprovalAnswer> {
    assert(workspaceId.length > 0, "workspaceId must be non-empty");
    assert(toolCallId.length > 0, "toolCallId must be non-empty");
    if (abortSignal?.aborted) return Promise.resolve("denied");
    let workspaceMap = this.pendingByWorkspace.get(workspaceId);
    if (!workspaceMap) {
      workspaceMap = new Map();
      this.pendingByWorkspace.set(workspaceId, workspaceMap);
    }
    assert(!workspaceMap.has(toolCallId), `sandbox approval already pending for ${toolCallId}`);
    const pending = workspaceMap;
    return new Promise<SandboxApprovalAnswer>((resolve) => {
      const onAbort = () => resolve("denied");
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      pending.set(toolCallId, {
        resolve: (answer) => {
          abortSignal?.removeEventListener("abort", onAbort);
          resolve(answer);
        },
      });
    }).finally(() => {
      pending.delete(toolCallId);
      if (pending.size === 0 && this.pendingByWorkspace.get(workspaceId) === pending) {
        this.pendingByWorkspace.delete(workspaceId);
      }
    });
  }

  /** Answers a pending request; false when none is pending (already answered, or gone). */
  answer(workspaceId: string, toolCallId: string, approved: boolean): boolean {
    const entry = this.pendingByWorkspace.get(workspaceId)?.get(toolCallId);
    if (!entry) return false;
    entry.resolve(approved ? "approved" : "denied");
    return true;
  }
}

export const sandboxApprovalManager = new SandboxApprovalManager();
