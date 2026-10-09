import { randomUUID } from "node:crypto";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { isModelHiddenMessage } from "@/common/utils/messages/modelHiddenMessages";
import type { HistoryService } from "./historyService";
import type { CapabilityGrants } from "@/common/types/capabilityGrants";
import type { RuntimeMode } from "@/common/types/runtime";
import { RUNTIME_MODE, runtimeModeSupportsSharedTaskWorkspace } from "@/common/types/runtime";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { mergeAdditionalSystemInstructions } from "@/common/utils/additionalSystemInstructions";
import { getRuntimeType } from "@/node/runtime/initHook";

/** Copied context is not a turn to finish, nor a tool invocation owned by this workspace. */
function inertSideChatMessage(message: MuxMessage): MuxMessage {
  const hasPendingTools = message.parts.some(
    (part) => part.type === "dynamic-tool" && part.state === "input-available"
  );
  const original = message.metadata;
  const hasPendingFollowUp =
    original?.muxMetadata?.type === "compaction-summary" &&
    original.muxMetadata.pendingFollowUp != null;
  if (
    !hasPendingTools &&
    !hasPendingFollowUp &&
    original?.partial == null &&
    original?.streamFinalized == null &&
    original?.error == null &&
    original?.errorType == null &&
    original?.retrySendOptions == null
  ) {
    return message;
  }
  const metadata = { ...original };
  delete metadata.partial;
  delete metadata.streamFinalized;
  delete metadata.error;
  delete metadata.errorType;
  delete metadata.retrySendOptions;
  if (metadata.muxMetadata?.type === "compaction-summary") {
    metadata.muxMetadata = { ...metadata.muxMetadata };
    delete metadata.muxMetadata.pendingFollowUp;
  }
  return {
    ...message,
    metadata,
    parts: message.parts.map((part) =>
      part.type === "dynamic-tool" && part.state === "input-available"
        ? {
            type: "text" as const,
            text: `[Main-chat ${part.toolName} call was unfinished when this context was copied; it is not running in this side chat.]`,
            timestamp: part.timestamp,
          }
        : part
    ),
  };
}

/**
 * Finish only the *copy* as reference context before registering a side chat. Forks deliberately
 * keep resumable partials; side chats must not inherit that behavior. Direct updates also clear
 * flags/refresh text when the part count is unchanged (commitPartial intentionally skips those).
 */
export async function materializeSideChatHistorySnapshot(params: {
  historyService: HistoryService;
  targetWorkspaceId: string;
  partialSnapshot: MuxMessage | null;
}): Promise<void> {
  const history = await params.historyService.getHistoryFromLatestBoundary(
    params.targetWorkspaceId
  );
  if (!history.success) throw new Error(history.error);
  const messages: MuxMessage[] = [];
  for (const copied of history.data) {
    const partial = params.partialSnapshot;
    // A completed row may have landed after the partial was captured. Never replace it with
    // the older partial, or resurrect an orphan whose own id/sequence is absent from the copy.
    const snapshot =
      partial != null &&
      copied.id === partial.id &&
      copied.metadata?.historySequence === partial.metadata?.historySequence &&
      (copied.metadata?.partial === true || copied.parts.length === 0) &&
      partial.parts.length >= copied.parts.length
        ? partial
        : copied;
    const inert = inertSideChatMessage(snapshot);
    if (inert !== copied) {
      const updated = await params.historyService.updateHistory(params.targetWorkspaceId, inert);
      if (!updated.success) throw new Error(updated.error);
    }
    messages.push(inert);
  }

  // Empty placeholders and hidden snapshots are not visible replies. If the inherited display
  // tail is a user turn, close that context without answering it or showing a retry barrier.
  const visibleTail = messages.findLast(
    (message) =>
      message.role !== "system" &&
      !isModelHiddenMessage(message) &&
      (message.metadata?.synthetic !== true || message.metadata.uiVisible === true) &&
      message.parts.some((part) =>
        part.type === "text" || part.type === "reasoning" ? part.text.trim().length > 0 : true
      )
  );
  if (visibleTail?.role === "user") {
    const appended = await params.historyService.appendToHistory(
      params.targetWorkspaceId,
      createMuxMessage(
        randomUUID(),
        "assistant",
        "Main-chat context copied for reference. Ask a side question; the main chat continues separately.",
        { synthetic: true, uiVisible: true }
      )
    );
    if (!appended.success) throw new Error(appended.error);
  }
}

/** A hard ceiling, independent of agent/caller policy: side chats may inspect, never act. */
export const SIDE_CHAT_TOOL_GRANTS: CapabilityGrants = {
  version: 1,
  bridgeTools: {
    allow: [
      "file_read",
      "agent_skill_list",
      "agent_skill_read",
      "agent_skill_read_file",
      "todo_read",
      "get_goal",
      "review_pane_get",
      "models_list",
      "session_history",
      "ask_user_question",
    ],
  },
  vars: false,
  hostEvents: false,
};

export function sideChatCapabilityGrants(
  metadata: Pick<WorkspaceMetadata, "sideChatParentWorkspaceId">
): CapabilityGrants | undefined {
  return metadata.sideChatParentWorkspaceId != null ? SIDE_CHAT_TOOL_GRANTS : undefined;
}

/**
 * `/side` chats mirror Codex's side conversations: an ephemeral fork of the current chat that
 * inherits its history and shares its checkout until closed. The request builder enforces a
 * local-read-only tool ceiling because model actions could interfere with the main chat's work.
 * These instructions explain how to use inherited context without continuing that work.
 */
export const SIDE_CHAT_SYSTEM_INSTRUCTIONS = [
  "You are in a side chat: a temporary conversation forked from the user's main chat so they can ask questions without disturbing it. The main chat may keep working while you answer, and this side chat is discarded when the user closes it.",
  "The conversation history before this side chat was inherited from the main chat. Treat it as reference-only context: do not continue, resume, or finish the main chat's in-progress work here.",
  "Side chats are for understanding: answer questions, explain code and decisions, and discuss options using the inherited transcript, user-provided context, and the available local read tools. You cannot run shell commands, browse the network, change files or state, or delegate work here. Say when the available context is insufficient instead of guessing.",
  "Do not continue the main chat's work or claim to have changed the checkout. If the user asks for a change or an operation outside your local read tools, explain what is needed and suggest requesting it in the main chat instead.",
].join("\n\n");

/** Appends the side-chat guardrails to a turn's additional instructions; other chats pass through. */
export function withSideChatInstructions(
  metadata: Pick<WorkspaceMetadata, "sideChatParentWorkspaceId">,
  additionalSystemInstructions: string | undefined
): string | undefined {
  if (metadata.sideChatParentWorkspaceId == null) {
    return additionalSystemInstructions;
  }
  return mergeAdditionalSystemInstructions(
    additionalSystemInstructions ?? "",
    SIDE_CHAT_SYSTEM_INSTRUCTIONS
  );
}

/**
 * Runtimes whose checkout a side chat can share by pointing its persisted path at the parent's.
 * Local (project-dir) workspaces already share the project directory. Docker and devcontainer are
 * excluded because their container identity derives from the workspace name.
 */
function runtimeModeSupportsSideChat(mode: RuntimeMode): boolean {
  return mode === RUNTIME_MODE.LOCAL || runtimeModeSupportsSharedTaskWorkspace(mode);
}

/** Why `/side` cannot start from this workspace, or null when it can. */
export function getSideChatCreationRefusal(
  parent: Pick<
    WorkspaceMetadata,
    "sideChatParentWorkspaceId" | "kind" | "projects" | "runtimeConfig"
  >
): string | null {
  if (parent.sideChatParentWorkspaceId != null) {
    // Codex rejects /side inside a side conversation too: one level keeps "return" unambiguous.
    return "Side chats cannot be nested. Press Esc to return to the main chat first.";
  }
  if (parent.kind === "scratch") {
    return "Side chats are not supported in scratch chats yet.";
  }
  if ((parent.projects?.length ?? 0) > 1) {
    return "Side chats are not supported in multi-project workspaces yet.";
  }
  const mode = getRuntimeType(parent.runtimeConfig);
  if (!runtimeModeSupportsSideChat(mode)) {
    return `Side chats are not supported for ${mode} workspaces yet.`;
  }
  return null;
}
