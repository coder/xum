import { useCallback, useRef, useState } from "react";

import { AUTO_EXPAND_PREFS_MAX_CHARS, getAutoExpandPrefsKey } from "@/common/constants/storage";
import { withRecordEntry } from "@/browser/utils/boundedPersistedValue";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";

import { useOptionalMessageListContext } from "./MessageListContext";
import { useToolName } from "./ToolNameContext";

/** Transcript block types that share a per-workspace sticky auto-expand preference. */
export type ExpandableBlockKind = "thinking" | "tools";

/**
 * Per-workspace record of the user's last expand/collapse intent.
 * Persisted under getAutoExpandPrefsKey(workspaceId). A missing entry falls back
 * to each block's own default.
 *
 * Thinking blocks share one preference, but tool blocks are keyed by tool name so
 * each tool (bash, file_read, task, …) remembers its own intent independently.
 */
export interface AutoExpandPrefs {
  thinking?: boolean;
  tools?: Record<string, boolean>;
}

/** Read the stored preference for a block, resolving tools by their tool name. */
function readStoredPref(
  prefs: AutoExpandPrefs,
  kind: ExpandableBlockKind,
  toolName: string | undefined
): boolean | undefined {
  if (kind === "thinking") return prefs.thinking;
  const tools = prefs.tools;
  // Back-compat: a prior build persisted `tools` as a single boolean shared by all
  // tools. Honor that legacy value as the per-tool fallback so an upgrading user's
  // choice isn't silently dropped (the next toggle migrates the key to the record).
  if (typeof tools === "boolean") return tools;
  return toolName == null ? undefined : tools?.[toolName];
}

/** Apply a toggle to the stored preferences, keying tools by their tool name. */
function applyStoredPref(
  prev: AutoExpandPrefs,
  kind: ExpandableBlockKind,
  toolName: string | undefined,
  next: boolean
): AutoExpandPrefs {
  if (kind === "thinking") return { ...prev, thinking: next };
  if (toolName == null) return prev;
  // One entry per tool ever toggled (MCP tool names are long): keep the newest ones inside the
  // key budget, leaving room for the thinking flag and the object wrapper.
  const toolsMaxChars = AUTO_EXPAND_PREFS_MAX_CHARS - '{"thinking":false,"tools":}'.length;
  return { ...prev, tools: withRecordEntry(prev.tools ?? {}, toolName, next, toolsMaxChars) };
}

export interface UseStickyExpandOptions {
  /**
   * Live "must open" signal layered above the stored preference/fallback (e.g. a
   * blocking AskUserQuestion prompt while executing, or a tool whose error/failure
   * only becomes known after mount — task errors, failed `task_await` sub-tasks).
   *
   * It is latched monotonically: the row opens on the rising edge but the signal
   * going false again never collapses a present block (no height tear). A user
   * toggle still wins over it, so the row remains collapsible.
   */
  forceExpanded?: boolean;
}

interface StickyExpandState {
  expanded: boolean;
  setExpanded: (next: boolean) => void;
  toggleExpanded: () => void;
}

/**
 * Sticky expand/collapse state for transcript blocks (thinking + tools).
 *
 * UX contract — legible stickiness with no layout flashes. Effective state is
 * `userChoice ?? (forceLatched || (storedPref ?? fallbackExpanded))`:
 *  - The stored preference and `fallbackExpanded` are snapshotted ONCE at mount
 *    (via readPersistedState, NOT usePersistedState — no subscription), so a later
 *    preference change from another block can never retroactively expand/collapse
 *    this already-mounted block. Only blocks that mount afterwards inherit it.
 *  - `forceExpanded` is a live "must open" signal, latched monotonically: it opens
 *    the row on its rising edge (e.g. a task error arriving after mount) but never
 *    forces a collapse, so a present block is never torn closed.
 *  - A user toggle wins over everything and is the only thing that writes the
 *    preference, so FUTURE blocks of this kind inherit the choice. Tool blocks key
 *    the preference by tool name, so each tool remembers its own intent rather than
 *    sharing one global "tools" bucket.
 *
 * workspaceId comes from MessageListContext (which wraps the whole transcript) and
 * the tool name from ToolNameContext (provided per tool row), so no prop-drilling is
 * needed; outside those contexts (e.g. isolated tests) the hook degrades to
 * local-only state with no persistence.
 */
export function useStickyExpand(
  kind: ExpandableBlockKind,
  fallbackExpanded: boolean,
  options?: UseStickyExpandOptions
): StickyExpandState {
  const forceExpanded = options?.forceExpanded ?? false;
  const workspaceId = useOptionalMessageListContext()?.workspaceId;
  // Tool blocks key their preference by tool name (each tool remembers its own
  // intent); resolved from ToolNameContext so no prop-drilling is needed. Undefined
  // for thinking blocks and outside a tool row.
  const toolName = useToolName();

  // Snapshot the stored preference + fallback ONCE at mount. Freezing them is what
  // guarantees the present-block invariant: neither another block's preference write
  // nor a convenience fallback that later flips (e.g. FileEdit's `!isFailed`) can
  // mutate this row's baseline.
  const [seed] = useState<{ pref: boolean | undefined; fallback: boolean }>(() => ({
    pref:
      workspaceId == null
        ? undefined
        : readStoredPref(
            readPersistedState<AutoExpandPrefs>(getAutoExpandPrefsKey(workspaceId), {}),
            kind,
            toolName
          ),
    fallback: fallbackExpanded,
  }));

  // The user's explicit toggle wins over everything and is the only thing we persist.
  const [userChoice, setUserChoice] = useState<boolean | null>(null);

  // Latch forceExpanded monotonically so a signal that turns on after mount (a task
  // error / failed sub-task) still opens the row, while a signal turning back off
  // never collapses a present block.
  const [forceLatched, setForceLatched] = useState<boolean>(forceExpanded);
  if (forceExpanded && !forceLatched) {
    setForceLatched(true);
  }

  const expanded = userChoice ?? (forceLatched || (seed.pref ?? seed.fallback));

  // Keep the latest expanded value available to setExpanded without making the
  // callback identity depend on it.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // setExpanded/toggleExpanded MUST keep a stable identity across renders. Consumers
  // pass setExpanded into effect dependency arrays — e.g. WorkflowRunToolCall lists it
  // in a useLayoutEffect and a useEffect — and the previous useToolExpansion returned
  // React's stable useState setter, so those effects only re-ran on real changes. The
  // bun test runtime does NOT apply the React Compiler, so without an explicit stable
  // identity these closures change every render and re-fire those consumer effects on
  // every commit; the synchronous useLayoutEffect variant then spins act() forever
  // (observed as a hung unit test). This is a correctness requirement, not perf memo.
  const setExpanded = useCallback(
    (next: boolean): void => {
      setUserChoice(next);
      // Persist only with a concrete target: a workspace, and—for tools—a tool name
      // to key on. Future blocks of the same kind/tool then inherit the choice.
      if (workspaceId != null && (kind !== "tools" || toolName != null)) {
        updatePersistedState<AutoExpandPrefs>(
          getAutoExpandPrefsKey(workspaceId),
          (prev) => applyStoredPref(prev, kind, toolName, next),
          {}
        );
      }
    },
    [workspaceId, kind, toolName]
  );

  // expandedRef keeps toggleExpanded reading the latest value without taking a
  // dependency on `expanded`, so its identity stays stable too.
  const toggleExpanded = useCallback(() => setExpanded(!expandedRef.current), [setExpanded]);

  return {
    expanded,
    setExpanded,
    toggleExpanded,
  };
}
