import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  AGENT_INTERFACE_VIEW_KEY,
  AGENT_INTERFACE_VIEW_MAX_CHARS,
  AGENT_INTERFACE_VIEW_MAX_WORKSPACES,
} from "@/common/constants/storage";
import type { ArtifactEntry } from "@/common/orpc/schemas/artifacts";
import { isPlainObject } from "@/common/utils/isPlainObject";

/**
 * What eager code (App.tsx, the command palette's sources) reads of the Agent interface view,
 * apart from agentInterfaceView.ts and its artifact document parser, which stay out of the
 * first-load chunk (#7471). agentInterfaceView.ts writes the two maps below and notifies readers.
 */
export type AgentInterfaceView = "status" | "chat";

/**
 * The view a workspace shows. An explicit choice wins, the default is the status page, and a
 * missing status page always falls back to the transcript, so the pane is never blank.
 */
export function resolveAgentInterfaceView(input: {
  enabled: boolean;
  statusExists: boolean;
  stored: AgentInterfaceView | null;
}): AgentInterfaceView {
  if (!input.enabled || !input.statusExists) return "chat";
  return input.stored ?? "status";
}

/** Both flags: the sub-experiment does nothing while Artifacts is off. */
export function useAgentInterfaceEnabled(): boolean {
  const artifacts = useExperimentValue(EXPERIMENT_IDS.ARTIFACTS);
  const agentInterface = useExperimentValue(EXPERIMENT_IDS.ARTIFACTS_AGENT_INTERFACE);
  return artifacts && agentInterface;
}

// Explicit choices only, in one bounded most-recently-used map (like artifactSelection.ts), so a
// workspace without a choice keeps following the default.
type ChoiceMap = Record<string, AgentInterfaceView>;
export const EMPTY_CHOICES: ChoiceMap = {};

function isView(value: unknown): value is AgentInterfaceView {
  return value === "status" || value === "chat";
}

export function choiceFrom(map: unknown, workspaceId: string): AgentInterfaceView | null {
  if (!isPlainObject(map)) return null;
  const value = map[workspaceId];
  return isView(value) ? value : null;
}

function withChoice(map: unknown, workspaceId: string, view: AgentInterfaceView): ChoiceMap {
  const kept = isPlainObject(map)
    ? Object.entries(map).filter(
        (entry): entry is [string, AgentInterfaceView] =>
          entry[0] !== workspaceId && isView(entry[1])
      )
    : [];
  const entries = [...kept, [workspaceId, view] as [string, AgentInterfaceView]];
  const bounded = entries.slice(-AGENT_INTERFACE_VIEW_MAX_WORKSPACES);
  while (
    bounded.length > 1 &&
    JSON.stringify(Object.fromEntries(bounded)).length > AGENT_INTERFACE_VIEW_MAX_CHARS
  ) {
    bounded.shift();
  }
  return Object.fromEntries(bounded);
}

export function writeAgentInterfaceViewChoice(workspaceId: string, view: AgentInterfaceView) {
  updatePersistedState<unknown>(
    AGENT_INTERFACE_VIEW_KEY,
    (map: unknown) => withChoice(map, workspaceId, view),
    EMPTY_CHOICES
  );
}

// The status page's listing entry per workspace: absent until listed, null when there is none.
// A module store, so the main pane's single poll feeds the menu-bar toggle, the status view and
// the command palette without each listing the folder.
export const statusEntries = new Map<string, ArtifactEntry | null>();

/** A version of the page's file, as both a listing entry and a read result describe it. */
interface FileVersion {
  modifiedMs: number;
  size: number;
}

export function sameVersion(a: FileVersion | undefined, b: FileVersion | undefined): boolean {
  return a?.modifiedMs === b?.modifiedMs && a?.size === b?.size;
}

// The version of each workspace's status page that read as nothing to show (blank, a page that
// renders nothing, binary or too large). Until the file changes, the workspace counts as having no page, so the main pane
// falls back to the transcript instead of a blank or "cannot be previewed" pane.
export const unshowableStatusVersions = new Map<string, FileVersion>();

/**
 * Whether a listed status page can be shown: an empty file never can, and a version that read
 * as unshowable cannot until the file changes.
 */
export function isStatusPageEntryShowable(
  entry: ArtifactEntry | null | undefined,
  unshowable: FileVersion | undefined
): boolean {
  if (entry == null || entry.size === 0) return false;
  return unshowable == null || !sameVersion(entry, unshowable);
}

/** Whether the main pane's last listing found a status page for the workspace that can show. */
export function hasAgentInterfaceStatusPage(workspaceId: string): boolean {
  return isStatusPageEntryShowable(
    statusEntries.get(workspaceId),
    unshowableStatusVersions.get(workspaceId)
  );
}

/** Flip the workspace between its status page and the transcript; a no-op without a page. */
export function toggleAgentInterfaceView(workspaceId: string, onlyToChat = false) {
  if (!hasAgentInterfaceStatusPage(workspaceId)) return;
  const stored = choiceFrom(
    readPersistedState<unknown>(AGENT_INTERFACE_VIEW_KEY, EMPTY_CHOICES),
    workspaceId
  );
  const current = resolveAgentInterfaceView({ enabled: true, statusExists: true, stored });
  const next = toggledAgentInterfaceView(current, onlyToChat);
  if (next != null) writeAgentInterfaceViewChoice(workspaceId, next);
}

/** The view a switch leads to; null when it changes nothing (`onlyToChat` on the chat). */
export function toggledAgentInterfaceView(
  current: AgentInterfaceView,
  onlyToChat: boolean
): AgentInterfaceView | null {
  if (current === "status") return "chat";
  return onlyToChat ? null : "status";
}
