import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { WorkspaceLifecycleToolCall } from "@/browser/features/Tools/WorkspaceLifecycleToolCall";

// Isolated previews of the workspace-lifecycle tool-call card — one cell per story in
// WorkspaceLifecycleToolCall.stories.tsx, named to match the story exports so compare pairs
// them, rendered with the same inline args/result/status. Hand-authored (not generated)
// because the stories import meta.tsx → the whole app graph, which is over the bundle cap
// (see .design-sync/NOTES.md "UI primitives / previews").

// Mirrors the stories' decorator chain (theme + tooltip provider, dark background, max-w-2xl).
// `width` reproduces a story-level narrow wrapper (BlockedNeedsAction renders at 375px).
const Shell = (props: { width?: string; children: React.ReactNode }) => (
  <MuxPreviewShell>
    <div className="bg-background p-6">
      <div className="w-full max-w-2xl">
        {props.width ? <div style={{ width: props.width }}>{props.children}</div> : props.children}
      </div>
    </div>
  </MuxPreviewShell>
);

export const ArchiveMultiple = () => (
  <Shell>
    <WorkspaceLifecycleToolCall
      args={{
        action: "archive",
        targets: [
          { workspaceId: "24e33167af" },
          { workspaceId: "4a92f76fbf" },
          { workspaceId: "0b71c40e21" },
        ],
      }}
      status="completed"
      defaultExpanded
      result={{
        results: [
          { status: "archived", action: "archive", workspaceId: "24e33167af" },
          { status: "archived", action: "archive", workspaceId: "4a92f76fbf" },
          { status: "archived", action: "archive", workspaceId: "0b71c40e21" },
        ],
      }}
    />
  </Shell>
);

export const RemoveSingle = () => (
  <Shell>
    <WorkspaceLifecycleToolCall
      args={{ action: "remove", targets: [{ taskId: "wst_9f0c1d77aa" }] }}
      status="completed"
      defaultExpanded
      result={{
        results: [
          {
            status: "removed",
            action: "remove",
            taskId: "wst_9f0c1d77aa",
            workspaceId: "9f0c1d77aa",
          },
        ],
      }}
    />
  </Shell>
);

export const DeleteWorktreeBatch = () => (
  <Shell>
    <WorkspaceLifecycleToolCall
      args={{
        action: "delete_worktree",
        targets: [{ workspaceId: "9f0c1d77aa" }, { workspaceId: "771be0c3d2" }],
      }}
      status="completed"
      defaultExpanded
      result={{
        results: [
          { status: "deleted_worktree", action: "delete_worktree", workspaceId: "9f0c1d77aa" },
          { status: "deleted_worktree", action: "delete_worktree", workspaceId: "771be0c3d2" },
        ],
      }}
    />
  </Shell>
);

export const PartialNotFound = () => (
  <Shell>
    <WorkspaceLifecycleToolCall
      args={{
        action: "archive",
        targets: [
          { workspaceId: "9f0c1d77aa" },
          { workspaceId: "771be0c3d2" },
          { workspaceId: "deadbeef00" },
        ],
      }}
      status="completed"
      defaultExpanded
      result={{
        results: [
          { status: "archived", action: "archive", workspaceId: "9f0c1d77aa" },
          { status: "already_archived", action: "archive", workspaceId: "771be0c3d2" },
          {
            status: "not_found",
            action: "archive",
            workspaceId: "deadbeef00",
            note: "Owned workspace metadata is already absent.",
          },
        ],
      }}
    />
  </Shell>
);

export const BlockedNeedsAction = () => (
  <Shell width="375px">
    <WorkspaceLifecycleToolCall
      args={{
        action: "archive",
        targets: [
          { workspaceId: "feature-billing-webhooks-experiment-very-long-id-001" },
          { workspaceId: "4a92f76fbf" },
        ],
      }}
      status="completed"
      defaultExpanded
      result={{
        results: [
          {
            status: "requires_confirmation",
            action: "archive",
            workspaceId: "feature-billing-webhooks-experiment-very-long-id-001",
            paths: [
              "packages/server/src/very/deeply/nested/path/to/an/untracked/file/that/is/quite/long/scratch.local.ts",
              ".env.local",
            ],
          },
          {
            status: "active",
            action: "archive",
            workspaceId: "4a92f76fbf",
            activeTaskIds: ["wst_4a92f76fbf01"],
          },
        ],
      }}
    />
  </Shell>
);

export const Executing = () => (
  <Shell>
    <WorkspaceLifecycleToolCall
      args={{
        action: "remove",
        targets: [{ workspaceId: "24e33167af" }, { workspaceId: "4a92f76fbf" }],
      }}
      status="executing"
      defaultExpanded
    />
  </Shell>
);

export const ErrorResult = () => (
  <Shell>
    <WorkspaceLifecycleToolCall
      args={{ action: "remove", targets: [{ workspaceId: "24e33167af" }] }}
      status="failed"
      defaultExpanded
      result={{
        success: false,
        error: "task_workspace_lifecycle requires an orchestrator workspace context.",
      }}
    />
  </Shell>
);

export const InvalidScope = () => (
  <Shell>
    <WorkspaceLifecycleToolCall
      args={{ action: "remove", targets: [{ taskId: "wst_notmine00" }] }}
      status="completed"
      defaultExpanded
      result={{
        results: [{ status: "invalid_scope", action: "remove", taskId: "wst_notmine00" }],
      }}
    />
  </Shell>
);
