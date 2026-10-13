import React, { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { List } from "lucide-react";
import { TodoList } from "../TodoList/TodoList";
import { ChatInputDecoration } from "../ChatPane/ChatInputDecoration";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { getPinnedTodoExpandedKey } from "@/common/constants/storage";

interface PinnedTodoListProps {
  workspaceId: string;
}

/**
 * Pinned TODO list displayed in the composer-adjacent decoration stack beneath
 * the stream barrier. Incomplete plans persist across streams until the agent
 * updates them, while fully completed plans clear when the final stream ends
 * for this workspace. The pinned panel expansion state persists separately in
 * localStorage.
 *
 * Relies on natural reference stability from MapStore + Aggregator architecture:
 * - Aggregator.getCurrentTodos() returns direct reference (not a copy)
 * - Reference only changes when todos are actually modified
 * - MapStore caches WorkspaceState per version, avoiding unnecessary recomputation
 */
export const PinnedTodoList: React.FC<PinnedTodoListProps> = ({ workspaceId }) => {
  const [expanded, setExpanded] = usePersistedState(getPinnedTodoExpandedKey(workspaceId), true);

  const workspaceStore = useWorkspaceStoreRaw();
  const subscribeToWorkspace = (callback: () => void) =>
    workspaceStore.subscribeKey(workspaceId, callback);
  const todos = useSyncExternalStore(
    subscribeToWorkspace,
    () => workspaceStore.getWorkspaceState(workspaceId).todos
  );

  // The panel scrolls once the list outgrows its max height (MAX_TODOS allows lists taller than
  // it), and completed items always come first, so a long list would open with the current item
  // below the fold. Bring the first unfinished item into view, with one finished row above it for
  // context. This syncs with a DOM scroll position, so it needs an effect; it reruns only when the
  // panel opens or the current item moves, so it never fights the user's own scrolling. It sets
  // the panel's own scrollTop instead of calling scrollIntoView, which would also scroll the chat.
  const contentRef = useRef<HTMLDivElement>(null);
  const currentIndex = todos.findIndex((todo) => todo.status !== "completed");
  useLayoutEffect(() => {
    const container = contentRef.current;
    if (!expanded || container === null || currentIndex < 0) {
      return;
    }
    const rows = container.querySelectorAll<HTMLElement>("[data-todo-row]");
    const target = rows[Math.max(0, currentIndex - 1)];
    if (target === undefined) {
      return;
    }
    container.scrollTop +=
      target.getBoundingClientRect().top - container.getBoundingClientRect().top;
  }, [expanded, currentIndex]);

  // No todos have been written yet in this session
  if (todos.length === 0) {
    return null;
  }

  const inProgressCount = todos.filter((todo) => todo.status === "in_progress").length;
  const pendingCount = todos.filter((todo) => todo.status === "pending").length;
  const completedCount = todos.length - inProgressCount - pendingCount;
  const summaryParts: string[] = [];
  if (inProgressCount > 0) {
    summaryParts.push(`${inProgressCount} in progress`);
  }
  if (pendingCount > 0) {
    summaryParts.push(`${pendingCount} pending`);
  }
  if (summaryParts.length === 0) {
    summaryParts.push(`${completedCount} completed`);
  }

  return (
    <ChatInputDecoration
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      contentClassName="max-h-[300px] overflow-y-auto"
      contentRef={contentRef}
      dataComponent="PinnedTodoList"
      summary={
        <>
          <List className="text-muted group-hover:text-secondary size-3.5 transition-colors" />
          <span className="text-muted group-hover:text-secondary transition-colors">
            <span className="font-medium">TODO</span>
            {summaryParts.length > 0 && <> · {summaryParts.join(" · ")}</>}
          </span>
        </>
      }
      renderExpanded={() => <TodoList todos={todos} />}
    />
  );
};
