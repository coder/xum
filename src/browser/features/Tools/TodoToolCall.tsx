import React from "react";
import { EmojiIcon } from "@/browser/components/icons/EmojiIcon/EmojiIcon";
import { TodoList } from "@/browser/components/TodoList/TodoList";
import type { TodoWriteToolArgs, TodoWriteToolResult } from "@/common/types/tools";
import { deriveTodoStatus } from "@/common/utils/todoList";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  ToolIcon,
} from "./Shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./Shared/toolUtils";

interface TodoToolCallProps {
  args: TodoWriteToolArgs;
  result?: TodoWriteToolResult;
  status?: ToolStatus;
}

export const TodoToolCall: React.FC<TodoToolCallProps> = ({
  args,
  result: _result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useToolExpansion(false); // Collapsed by default
  const statusDisplay = getStatusDisplay(status);
  const todoStatusPreview = deriveTodoStatus(args.todos);
  const fallbackPreview =
    args.todos.length === 0
      ? "Cleared todo list"
      : `${args.todos.length} item${args.todos.length === 1 ? "" : "s"}`;

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded} />
        <ToolIcon toolName="todo_write" />
        <span className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1 italic">
          {todoStatusPreview ? (
            <>
              <EmojiIcon emoji={todoStatusPreview.emoji} className="h-3 w-3 shrink-0" />
              <span className="truncate">{todoStatusPreview.message}</span>
            </>
          ) : (
            <span className="truncate">{fallbackPreview}</span>
          )}
        </span>
        <StatusIndicator status={status}>{statusDisplay}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <TodoList todos={args.todos} />
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
