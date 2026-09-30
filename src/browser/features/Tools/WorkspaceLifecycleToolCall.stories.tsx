import type { Meta, StoryObj } from "@storybook/react-vite";
import { WorkspaceLifecycleToolCall } from "@/browser/features/Tools/WorkspaceLifecycleToolCall";
import { PIXEL_DISABLED, lightweightMeta, StoryUiShell } from "@/browser/stories/meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/WorkspaceLifecycle",
  component: WorkspaceLifecycleToolCall,
  parameters: {
    ...lightweightMeta.parameters,
    // Excluded because the repo-wide Pixel snapshot budget is at its ceiling.
    pixel: PIXEL_DISABLED,
  },
  decorators: [
    (Story) => (
      <StoryUiShell>
        <div className="bg-background p-6">
          <div className="w-full max-w-2xl">
            <Story />
          </div>
        </div>
      </StoryUiShell>
    ),
  ],
} satisfies Meta<typeof WorkspaceLifecycleToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

/** archive · several owned workspaces all archived (uniform → solid "N archived" pill). */
export const ArchiveMultiple: Story = {
  args: {
    args: {
      action: "archive",
      targets: [
        { workspaceId: "24e33167af" },
        { workspaceId: "4a92f76fbf" },
        { workspaceId: "0b71c40e21" },
      ],
    },
    status: "completed",
    defaultExpanded: true,
    result: {
      results: [
        {
          status: "archived",
          action: "archive",
          workspaceId: "24e33167af",
          displayName: "Fix streaming resume",
        },
        {
          status: "archived",
          action: "archive",
          workspaceId: "4a92f76fbf",
          displayName: "Review settings polish",
        },
        {
          status: "archived",
          action: "archive",
          workspaceId: "0b71c40e21",
          displayName: "Investigate sidebar jitter",
        },
      ],
    },
  },
};

/** remove · single workspace removed permanently (danger tone). */
export const RemoveSingle: Story = {
  args: {
    args: { action: "remove", targets: [{ taskId: "wst_9f0c1d77aa" }] },
    status: "completed",
    defaultExpanded: true,
    result: {
      results: [
        {
          status: "removed",
          action: "remove",
          taskId: "wst_9f0c1d77aa",
          workspaceId: "9f0c1d77aa",
        },
      ],
    },
  },
};

/** delete_worktree · batch reclaim of disk for already-archived workspaces. */
export const DeleteWorktreeBatch: Story = {
  args: {
    args: {
      action: "delete_worktree",
      targets: [{ workspaceId: "9f0c1d77aa" }, { workspaceId: "771be0c3d2" }],
    },
    status: "completed",
    defaultExpanded: true,
    result: {
      results: [
        { status: "deleted_worktree", action: "delete_worktree", workspaceId: "9f0c1d77aa" },
        { status: "deleted_worktree", action: "delete_worktree", workspaceId: "771be0c3d2" },
      ],
    },
  },
};

/** Mixed · one archived, one already archived (no-op), one not found (mixed → dot-chips). */
export const PartialNotFound: Story = {
  args: {
    args: {
      action: "archive",
      targets: [
        { workspaceId: "9f0c1d77aa" },
        { workspaceId: "771be0c3d2" },
        { workspaceId: "deadbeef00" },
      ],
    },
    status: "completed",
    defaultExpanded: true,
    result: {
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
    },
  },
};

/**
 * Blocked · requires_confirmation (untracked files would be lost) + an active turn. Pinned
 * to a fixed ~375px container (the Storybook test-runner renders at desktop width and
 * ignores viewport / Pixel matrix variants, so the narrow case must be forced with a wrapper) and
 * a play that fails if a long workspace id / file path overflows instead of truncating.
 */
export const BlockedNeedsAction: Story = {
  args: {
    args: {
      action: "archive",
      targets: [
        { workspaceId: "feature-billing-webhooks-experiment-very-long-id-001" },
        { workspaceId: "4a92f76fbf" },
        { workspaceId: "c81d3e02b7" },
      ],
    },
    status: "completed",
    defaultExpanded: true,
    result: {
      results: [
        // Historical (pre-#3950) row: archives now refuse instead, as in the last row.
        {
          status: "requires_confirmation",
          action: "archive",
          workspaceId: "feature-billing-webhooks-experiment-very-long-id-001",
          displayName: "Billing webhooks experiment",
          paths: [
            "packages/server/src/very/deeply/nested/path/to/an/untracked/file/that/is/quite/long/scratch.local.ts",
            ".env.local",
          ],
        },
        {
          status: "active",
          action: "archive",
          workspaceId: "4a92f76fbf",
          displayName: "Running cleanup follow-up",
          activeTaskIds: ["wst_4a92f76fbf01"],
        },
        {
          status: "error",
          action: "archive",
          workspaceId: "c81d3e02b7",
          displayName: "Notes spike",
          paths: ["docs/drafts/really-long-directory-name-for-overflow-checks/notes.md"],
          error:
            "Archiving would permanently delete the untracked files listed in paths, because the snapshot archive behavior cannot preserve them. Ask the user to archive this workspace manually.",
        },
      ],
    },
  },
  decorators: [
    (Story) => (
      <div data-testid="wl-card-container" className="w-[375px]">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    if (!canvasElement.textContent?.includes("Confirm files")) {
      throw new Error("WorkspaceLifecycle requires_confirmation row did not render");
    }
    const container = canvasElement.querySelector('[data-testid="wl-card-container"]');
    if (!(container instanceof HTMLElement)) {
      throw new Error("WorkspaceLifecycle story container not found");
    }
    // Let layout settle before measuring.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    if (container.scrollWidth > container.clientWidth + 1) {
      throw new Error(
        `WorkspaceLifecycle card overflowed its ${container.clientWidth}px container by ` +
          `${container.scrollWidth - container.clientWidth}px`
      );
    }
  },
};

/** Mid-flight, before the result arrives — falls back to the requested targets. */
export const Executing: Story = {
  args: {
    args: {
      action: "remove",
      targets: [{ workspaceId: "24e33167af" }, { workspaceId: "4a92f76fbf" }],
    },
    status: "executing",
    defaultExpanded: true,
  },
};

/**
 * Error · a thrown execute() surfaces as { success: false, error } (e.g. the tool ran
 * outside an orchestrator context). Exercises the shared ErrorBox.
 */
export const ErrorResult: Story = {
  args: {
    args: { action: "remove", targets: [{ workspaceId: "24e33167af" }] },
    status: "failed",
    defaultExpanded: true,
    result: {
      success: false,
      error: "task_workspace_lifecycle requires an orchestrator workspace context.",
    },
  },
};

/** Per-row failure · target is not a workspace this orchestrator owns. */
export const InvalidScope: Story = {
  args: {
    args: { action: "remove", targets: [{ taskId: "wst_notmine00" }] },
    status: "completed",
    defaultExpanded: true,
    result: {
      results: [{ status: "invalid_scope", action: "remove", taskId: "wst_notmine00" }],
    },
  },
};
