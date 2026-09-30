import React from "react";
import { Check, Circle, Loader2 } from "lucide-react";
import { cn } from "@/common/lib/utils";
import type { TodoItem } from "@/common/types/tools";

const statusBgColors: Record<TodoItem["status"], string> = {
  completed: "color-mix(in srgb, var(--color-success), transparent 92%)",
  in_progress: "color-mix(in srgb, var(--color-info), transparent 92%)",
  pending: "color-mix(in srgb, var(--color-muted), transparent 96%)",
};

const statusBorderColors: Record<TodoItem["status"], string> = {
  completed: "var(--color-success)",
  in_progress: "var(--color-info)",
  pending: "var(--color-dim)",
};

const statusTextColors: Record<TodoItem["status"], string> = {
  completed: "var(--color-muted)",
  in_progress: "var(--color-info)",
  pending: "var(--color-text)",
};

/**
 * Calculate opacity fade for items distant from the center (exponential decay).
 * @param distance - How far from the center (higher = more fade)
 * @param minOpacity - Minimum opacity floor
 * @returns Opacity value between minOpacity and 1.0
 */
function calculateFadeOpacity(distance: number, minOpacity: number): number {
  return Math.max(minOpacity, 1 - distance * 0.15);
}

function calculateTextOpacity(
  status: TodoItem["status"],
  completedIndex?: number,
  totalCompleted?: number,
  pendingIndex?: number,
  totalPending?: number
): number {
  if (status === "completed") {
    // Apply gradient fade for old completed items (distant past)
    if (
      completedIndex !== undefined &&
      totalCompleted !== undefined &&
      totalCompleted > 2 &&
      completedIndex < totalCompleted - 2
    ) {
      const distance = totalCompleted - completedIndex;
      return calculateFadeOpacity(distance, 0.35);
    }
    return 0.7;
  }
  if (status === "pending") {
    // Apply gradient fade for far future pending items (distant future)
    if (
      pendingIndex !== undefined &&
      totalPending !== undefined &&
      totalPending > 2 &&
      pendingIndex > 1
    ) {
      const distance = pendingIndex - 1;
      return calculateFadeOpacity(distance, 0.5);
    }
  }
  return 1;
}

interface TodoListProps {
  todos: TodoItem[];
  /**
   * Orientation of the list:
   *  - "vertical" (default): stacked rows — used by the pinned list and tool history.
   *  - "horizontal": a single horizontally-scrolling row of compact chips, used by the
   *    immersive review status bar to keep the plan to one row of vertical space.
   */
  layout?: "vertical" | "horizontal";
}

function getStatusIcon(status: TodoItem["status"]): React.ReactNode {
  switch (status) {
    case "completed":
      return <Check aria-hidden="true" className="h-3 w-3" />;
    case "in_progress":
      return (
        // Chromium composites transforms on this HTML wrapper; animating the SVG
        // itself keeps the renderer main thread busy even while mux is otherwise idle.
        <span className="inline-flex animate-spin">
          <Loader2 aria-hidden="true" className="h-3 w-3" />
        </span>
      );
    case "pending":
    default:
      return <Circle aria-hidden="true" className="h-3 w-3" />;
  }
}

/**
 * Shared TODO list component used by:
 * - TodoToolCall (in expanded tool history)
 * - PinnedTodoList (pinned at bottom of chat)
 */
export const TodoList: React.FC<TodoListProps> = ({ todos, layout = "vertical" }) => {
  const isHorizontal = layout === "horizontal";
  // Count completed and pending items for fade effects
  const completedCount = todos.filter((t) => t.status === "completed").length;
  const pendingCount = todos.filter((t) => t.status === "pending").length;
  let completedIndex = 0;
  let pendingIndex = 0;

  return (
    <div
      className={cn(
        "px-2 py-1.5",
        isHorizontal
          ? // Single row, horizontal scroll: stays one row tall no matter how many
            // todos so the immersive bar reserves minimal review height.
            "flex flex-row gap-1.5 overflow-x-auto"
          : "flex flex-col gap-[3px]"
      )}
    >
      {todos.map((todo, index) => {
        const currentCompletedIndex = todo.status === "completed" ? completedIndex++ : undefined;
        const currentPendingIndex = todo.status === "pending" ? pendingIndex++ : undefined;

        const textOpacity = calculateTextOpacity(
          todo.status,
          currentCompletedIndex,
          completedCount,
          currentPendingIndex,
          pendingCount
        );

        return (
          <div
            key={index}
            className={cn(
              "font-monospace flex gap-1.5 rounded border-l-2 px-2 py-1 text-[11px] leading-[1.35]",
              isHorizontal ? "max-w-[220px] shrink-0 items-center" : "items-start"
            )}
            style={{
              background: statusBgColors[todo.status],
              borderLeftColor: statusBorderColors[todo.status],
              color: "var(--color-text)",
            }}
          >
            <div className={cn("shrink-0 text-xs opacity-80", !isHorizontal && "mt-px")}>
              {getStatusIcon(todo.status)}
            </div>
            <div className="min-w-0 flex-1">
              <div
                title={todo.content}
                className={cn(
                  "truncate",
                  todo.status === "completed" && "line-through",
                  todo.status === "in_progress" &&
                    "font-medium after:content-['...'] after:inline after:overflow-hidden after:animate-[ellipsis_1.5s_steps(4,end)_infinite]"
                )}
                style={{
                  color: statusTextColors[todo.status],
                  opacity: textOpacity,
                }}
              >
                {todo.content}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
