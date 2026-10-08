import type { RuntimeMode } from "@/common/types/runtime";
import { RUNTIME_MODE, runtimeModeSupportsSharedTaskWorkspace } from "@/common/types/runtime";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { mergeAdditionalSystemInstructions } from "@/common/utils/additionalSystemInstructions";
import { getRuntimeType } from "@/node/runtime/initHook";

/**
 * `/side` chats mirror Codex's side conversations: an ephemeral fork of the current chat that
 * inherits its history, runs in the same checkout, and is discarded when the user returns to the
 * main chat. They are for asking questions without derailing the main chat, so the hidden
 * instructions below keep the model in an "understand, don't change" posture: the main chat may
 * still be working in the same checkout, and side-chat writes would interfere with it.
 */
export const SIDE_CHAT_SYSTEM_INSTRUCTIONS = [
  "You are in a side chat: a temporary conversation forked from the user's main chat so they can ask questions without disturbing it. The main chat may keep working while you answer, and this side chat is discarded when the user closes it.",
  "The conversation history before this side chat was inherited from the main chat. Treat it as reference-only context: do not continue, resume, or finish the main chat's in-progress work here.",
  "Side chats are for interactive dialogue aimed at understanding: answer questions, explain code and decisions, discuss options, and read files or run read-only commands when that helps you answer.",
  "Do not write, edit, create, move, or delete files, and do not perform other operations that change state or could interfere with the main chat, which may still be working in the same checkout. This includes git operations that change the repository, installing dependencies, starting or stopping processes, editing plans, goals, or todos, and spawning sub-agents or workflows.",
  "If the user asks for such a change, describe what you would do and suggest making the change from the main chat instead.",
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
