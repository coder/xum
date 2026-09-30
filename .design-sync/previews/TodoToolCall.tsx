import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { TodoToolCall } from "@/browser/features/Tools/TodoToolCall";
import type { TodoItem } from "@/common/types/tools";

// A tool-call card: rendered directly with inline mock tool args/result/status
// (mirrors the story). Tool cards only need theme + tooltip from the shell.
const TODOS: TodoItem[] = [
  { content: "Create British-themed layout (HTML) matching the reference", status: "completed" },
  {
    content: "Implement Great Britain pride styling with ornate typography",
    status: "in_progress",
  },
  { content: "Add small JS for interactions (nav, drawer, hover, focus)", status: "pending" },
  { content: "Run a local server and verify responsiveness across breakpoints", status: "pending" },
];

export const TodoWrite = () => (
  <MuxPreviewShell>
    <div className="bg-background flex items-start p-6">
      <div className="w-full max-w-2xl">
        <TodoToolCall
          args={{ todos: TODOS }}
          result={{ success: true, count: 4 }}
          status="completed"
        />
      </div>
    </div>
  </MuxPreviewShell>
);
