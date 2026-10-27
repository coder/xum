import React, { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { List } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { TodoList } from "../TodoList/TodoList";
import { ChatInputDecoration } from "../ChatPane/ChatInputDecoration";
import { useChatActivityPanel } from "../ChatPane/chatActivityPanels";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import type { TodoItem } from "@/common/types/tools";

interface PinnedTodoListProps {
  workspaceId: string;
}

/**
 * The panel scrolls once the list outgrows its max height (MAX_TODOS allows lists taller than
 * it), and completed items always come first, so a long list would open with the current item
 * below the fold. Bring the first unfinished item into view, with one finished row above it for
 * context. This syncs with a DOM scroll position, so it needs an effect; it reruns only when the
 * panel opens or the current item moves, so it never fights the user's own scrolling. It sets
 * the panel's own scrollTop instead of calling scrollIntoView, which would also scroll the chat.
 */
function useScrollToCurrentTodo(expanded: boolean, todos: readonly TodoItem[]) {
  const contentRef = useRef<HTMLDivElement>(null);
  const currentIndex = todos.findIndex((todo) => todo.status !== "completed");
  useLayoutEffect(() => {
    const container = contentRef.current;
    if (!expanded || container === null || currentIndex < 0) {
      return;
    }
    const target =
      container.querySelectorAll<HTMLElement>("[data-todo-row]")[Math.max(0, currentIndex - 1)];
    if (target === undefined) {
      return;
    }
    container.scrollTop +=
      target.getBoundingClientRect().top - container.getBoundingClientRect().top;
  }, [expanded, currentIndex]);
  return contentRef;
}

/**
 * The list's counts ("1 in progress · 2 pending", or "5 completed" once nothing is left) and the
 * step the chip names: the one in progress, else the next pending one.
 */
function summarizeTodos(todos: readonly TodoItem[]) {
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
  const currentTodo =
    todos.find((todo) => todo.status === "in_progress") ??
    todos.find((todo) => todo.status === "pending");
  return { completedCount, summaryParts, currentTodo };
}

/** Progress ring for the chip: the completed share of the list, drawn as an arc. */
function TodoProgressRing(props: { completed: number; total: number }) {
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg aria-hidden="true" viewBox="0 0 14 14" className="size-3.5 shrink-0 -rotate-90">
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        strokeWidth="2"
        stroke="var(--color-border-medium)"
      />
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        strokeWidth="2"
        stroke="var(--color-success)"
        strokeDasharray={`${(circumference * props.completed) / props.total} ${circumference}`}
      />
    </svg>
  );
}

/**
 * Pinned TODO list: a chip in the composer's live line that names the current step, with the
 * full list in its panel. Incomplete plans persist across streams until the agent updates them,
 * while fully completed plans clear when the final stream ends for this workspace.
 *
 * Relies on natural reference stability from MapStore + Aggregator architecture:
 * - Aggregator.getCurrentTodos() returns direct reference (not a copy)
 * - Reference only changes when todos are actually modified
 * - MapStore caches WorkspaceState per version, avoiding unnecessary recomputation
 */
export const PinnedTodoList: React.FC<PinnedTodoListProps> = ({ workspaceId }) => {
  // Closed until asked for: the panel covers the transcript, unlike the old inline list that
  // stayed open across turns.
  const [expanded, setExpanded] = useChatActivityPanel("todo");

  const workspaceStore = useWorkspaceStoreRaw();
  const subscribeToWorkspace = (callback: () => void) =>
    workspaceStore.subscribeKey(workspaceId, callback);
  const todos = useSyncExternalStore(
    subscribeToWorkspace,
    () => workspaceStore.getWorkspaceState(workspaceId).todos
  );

  const contentRef = useScrollToCurrentTodo(expanded, todos);

  // No todos have been written yet in this session
  if (todos.length === 0) {
    return null;
  }

  const { completedCount, summaryParts, currentTodo } = summarizeTodos(todos);
  const progress = `${completedCount}/${todos.length}`;

  return (
    <ChatInputDecoration
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      contentClassName="max-h-[300px] overflow-y-auto"
      contentRef={contentRef}
      dataComponent="PinnedTodoList"
      activityId="todo"
      chipLabel={`TODO, ${completedCount} of ${todos.length} done${currentTodo ? `: ${currentTodo.content}` : ""}`}
      // The only chip with text worth reading: it takes the line's free width, and it is the one
      // that yields width on phones, down to its ring and the start of the step.
      chipVariant="plain"
      chipClassName="min-w-14"
      panelTitle="TODO"
      panelMeta={[`${progress} done`, ...(currentTodo ? summaryParts : [])].join(" · ")}
      tab={
        <>
          <TodoProgressRing completed={completedCount} total={todos.length} />
          <span>TODO</span>
          <span className="counter-nums text-muted">{progress}</span>
        </>
      }
      chip={
        <>
          <TodoProgressRing completed={completedCount} total={todos.length} />
          {/* The ring carries progress on phones, where the current step needs the width. */}
          <span className={cn("counter-nums text-muted", currentTodo && "hidden @md:inline")}>
            {progress}
          </span>
          {currentTodo && <span className="min-w-0 truncate">{currentTodo.content}</span>}
        </>
      }
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
