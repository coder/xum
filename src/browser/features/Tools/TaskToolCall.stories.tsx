import type { Meta, StoryObj } from "@storybook/react-vite";
import { waitFor, within } from "@storybook/test";
import type { ReactNode } from "react";
import { TaskApplyGitPatchToolCall } from "@/browser/features/Tools/TaskApplyGitPatchToolCall";
import {
  TaskListToolCall,
  TaskRemoveToolCall,
  TaskRetitleToolCall,
  TaskStopToolCall,
  TaskToolCall,
} from "@/browser/features/Tools/TaskToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/Task",
  component: TaskToolCall,
} satisfies Meta<typeof TaskToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

function ToolStoryShell(props: { children: ReactNode }) {
  return (
    <div className="bg-background p-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">{props.children}</div>
    </div>
  );
}

/** task cards in queued/running workflow states */
export const TaskWorkflowStates: Story = {
  render: () => (
    <ToolStoryShell>
      <TaskToolCall
        args={{
          subagent_type: "explore",
          prompt: "Analyze the frontend React components in src/browser/",
          title: "Frontend Reviewer",
          run_in_background: true,
        }}
        result={{
          status: "running",
          taskId: "task-fe-001",
          modelString: "anthropic:claude-opus-5",
          thinkingLevel: "high",
          note: "Use task_await to monitor progress.",
        }}
        status="completed"
      />

      <TaskToolCall
        args={{
          subagent_type: "exec",
          prompt: "Run linting on src/node/ and summarize the findings.",
          title: "Backend Auditor",
          run_in_background: true,
        }}
        result={{
          status: "queued",
          taskId: "task-be-002",
          note: "Task is queued and will start shortly.",
        }}
        status="completed"
      />
    </ToolStoryShell>
  ),
};

/** simplified persistent-child lifecycle operations */
export const TaskLifecycleOperations: Story = {
  render: () => (
    <ToolStoryShell>
      <TaskRetitleToolCall
        args={{ task_id: "lifecycle-auditor", title: "Simplicity Auditor" }}
        result={{
          status: "retitled",
          taskId: "lifecycle-auditor",
          title: "Simplicity Auditor",
        }}
        status="completed"
      />
      <TaskStopToolCall
        args={{ task_ids: ["react-expert", "api-expert"] }}
        result={{
          results: [
            { status: "stopped", taskId: "react-expert", stoppedTaskIds: ["react-expert"] },
            { status: "already_inactive", taskId: "api-expert" },
          ],
        }}
        status="completed"
      />
      <TaskRemoveToolCall
        args={{ task_ids: ["obsolete-reviewer"] }}
        result={{
          results: [
            {
              status: "removed",
              taskId: "obsolete-reviewer",
              workspaceId: "obsolete-reviewer",
            },
          ],
        }}
        status="completed"
      />
    </ToolStoryShell>
  ),
};

/** completed task showing markdown report content */
export const TaskWithReport: Story = {
  render: () => (
    <ToolStoryShell>
      <TaskToolCall
        args={{
          subagent_type: "explore",
          prompt:
            "Find all test files in this project. Look for *.test.ts, *.spec.ts, and tests directories.",
          title: "Exploring test file structure",
          run_in_background: true,
        }}
        result={{
          status: "completed",
          taskId: "task-abc123",
          title: "Test File Analysis",
          modelString: "openai:gpt-5.6-sol",
          thinkingLevel: "xhigh",
          reportMarkdown: `# Test File Analysis

Found **47 test files** across the project.

## Key Patterns
- Unit tests are co-located with implementation files.
- Integration tests live under \`tests/integration/\`.
- Most suites run through \`bun test\`.`,
        }}
        status="completed"
      />
    </ToolStoryShell>
  ),
};

/** best-of-n task group rendered as one grouped task card */
export const BestOfTaskGroup: Story = {
  render: () => (
    <ToolStoryShell>
      <TaskToolCall
        args={{
          subagent_type: "explore",
          prompt: "Compare three implementation strategies for sidebar grouping.",
          title: "Compare implementation strategies",
          run_in_background: false,
          n: 3,
        }}
        result={{
          status: "completed",
          taskIds: ["task-best-of-1", "task-best-of-2", "task-best-of-3"],
          reports: [
            {
              taskId: "task-best-of-1",
              title: "Option 1",
              agentId: "explore",
              agentType: "explore",
              modelString: "anthropic:claude-sonnet-5",
              thinkingLevel: "medium",
              reportMarkdown: "Use **shared helper utilities** for tree coalescing.",
            },
            {
              taskId: "task-best-of-2",
              title: "Option 2",
              agentId: "explore",
              agentType: "explore",
              reportMarkdown: "Prefer a **synthetic group row** with expandable candidates.",
            },
            {
              taskId: "task-best-of-3",
              title: "Option 3",
              agentId: "explore",
              agentType: "explore",
              reportMarkdown: "Keep grouping logic **local to ProjectSidebar**.",
            },
          ],
        }}
        status="completed"
      />
    </ToolStoryShell>
  ),
};

/** long custom model IDs must wrap inside a narrow card instead of overflowing */
export const TaskNarrowLongModelId: Story = {
  render: () => (
    <div data-testid="narrow-task-card" className="bg-background w-[320px] p-2">
      <TaskToolCall
        args={{
          subagent_type: "explore",
          prompt: "Analyze the frontend React components in src/browser/",
          title: "Frontend Reviewer",
          run_in_background: true,
        }}
        result={{
          status: "running",
          taskId: "task-fe-001",
          // Deliberately hyphen-free: only an unbroken token exercises the wrap fix.
          modelString:
            "openrouter:acmelabs/somextremelylongcustommodelidentifierwithoutanybreakopportunitieswhatsoeverv2instruct",
          thinkingLevel: "high",
          note: "Use task_await to monitor progress.",
        }}
        status="completed"
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByText("task").click();
    await waitFor(() => {
      if (!canvasElement.querySelector("[data-task-ai-settings]")) {
        throw new Error("task AI settings did not render after expanding");
      }
    });
    const container = canvasElement.querySelector('[data-testid="narrow-task-card"]');
    if (!(container instanceof HTMLElement)) {
      throw new Error("narrow task card container not found");
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    const containerRight = container.getBoundingClientRect().right;
    const settings = container.querySelector("[data-task-ai-settings]");
    const settingsRight = settings?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY;
    // Right-edge containment, not scrollWidth: ancestors clip overflow, which would
    // hide a too-wide settings row from scrollWidth-based checks.
    if (settingsRight > containerRight + 1) {
      throw new Error(
        `task AI settings overflowed the ${container.clientWidth}px card by ` +
          `${Math.round(settingsRight - containerRight)}px`
      );
    }
  },
};

/**
 * task_list scope:"instance": the instance-wide address book — root workspaces across projects
 * with a busy/idle snapshot, the caller's own row, a long project path, and a truncated page.
 */
const INSTANCE_LIST_ARGS = { scope: "instance" as const, limit: 3 };
const INSTANCE_LIST_RESULT = {
  tasks: [
    {
      taskId: "ws-coordinator-7f3a",
      status: "workspace" as const,
      workspaceName: "coordinator",
      title: "Coordinate the migration",
      relationship: "self" as const,
      projectPath: "/home/alice/projects/mux",
      activity: "busy" as const,
      depth: 0,
    },
    {
      taskId: "ws-release-cut-19c2",
      status: "workspace" as const,
      workspaceName: "release-cut",
      title: "Cut release/2026.09",
      relationship: "unrelated" as const,
      projectPath:
        "/home/alice/projects/platform/services/billing/reconciliation-pipeline-with-an-extremely-long-directory-name",
      activity: "busy" as const,
      depth: 0,
    },
    {
      taskId: "ws-docs-sweep-42b0",
      status: "workspace" as const,
      workspaceName: "docs-sweep",
      relationship: "unrelated" as const,
      projectPath: "C:\\Users\\alice\\projects\\api-docs\\",
      activity: "idle" as const,
      depth: 0,
    },
  ],
  note: "Rows are root workspaces in this Xum instance and an availability snapshot. More rows match; pass `nextOffset` as `offset` to continue.",
  nextOffset: 3,
};

async function expandInstanceList(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  canvas.getByText("task_list").click();
  await waitFor(() => {
    // Instance rows are the only ones carrying an activity snapshot.
    if (canvas.queryByText("idle") == null || canvas.queryAllByText("busy").length !== 2) {
      throw new Error("instance rows did not render their activity snapshot");
    }
  });
}

export const TaskListInstanceScope: Story = {
  render: () => (
    <ToolStoryShell>
      <TaskListToolCall
        args={INSTANCE_LIST_ARGS}
        result={INSTANCE_LIST_RESULT}
        status="completed"
      />
    </ToolStoryShell>
  ),
  play: async ({ canvasElement }) => {
    await expandInstanceList(canvasElement);
    const canvas = within(canvasElement);
    // Project context shows as the basename only; the full path would drown the row.
    if (canvas.queryByText("mux") == null || canvas.queryByText("api-docs") == null) {
      throw new Error("instance rows did not render their project basenames");
    }
    if (canvas.queryByText(/reconciliation-pipeline-with-an-extremely-long/) == null) {
      throw new Error("long project basename was dropped instead of truncated");
    }
    if (canvas.queryByText("self") == null || canvas.queryAllByText("unrelated").length !== 2) {
      throw new Error("instance rows did not render their relationships");
    }
  },
};

const INSTANCE_LIST_PHONE_WIDTH = 390;

/**
 * Phone-width contract for instance rows: the wrapping badge row (id, status, title, relationship,
 * project, activity) must stay inside a 390px card. Pinned to the Pixel phone viewport; the
 * fixed-width frame keeps the contract active in the desktop-sized test-runner too, and the play
 * checks the rendered frame width before asserting containment.
 */
export const TaskListInstanceScopePhone390: Story = {
  globals: { viewport: { value: "taskListPhone", isRotated: false } },
  parameters: {
    viewport: {
      options: {
        taskListPhone: {
          name: "Phone 390",
          styles: { width: `${INSTANCE_LIST_PHONE_WIDTH}px`, height: "844px" },
          type: "mobile",
        },
      },
    },
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
  render: () => (
    <div
      data-testid="instance-list-phone-frame"
      className="bg-background p-2"
      style={{ width: INSTANCE_LIST_PHONE_WIDTH, maxWidth: "100%" }}
    >
      <TaskListToolCall
        args={INSTANCE_LIST_ARGS}
        result={INSTANCE_LIST_RESULT}
        status="completed"
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expandInstanceList(canvasElement);
    const frame = canvasElement.querySelector<HTMLElement>(
      '[data-testid="instance-list-phone-frame"]'
    );
    if (!frame) throw new Error("phone frame did not render");
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    const frameRect = frame.getBoundingClientRect();
    if (frameRect.width !== INSTANCE_LIST_PHONE_WIDTH) {
      throw new Error(
        `phone frame is ${frameRect.width}px wide; expected ${INSTANCE_LIST_PHONE_WIDTH}px — the story would assert the wrong layout`
      );
    }
    // Right-edge containment of every rendered element rather than scrollWidth: ancestors clip
    // overflow, which would hide a too-wide badge or truncated span from scrollWidth checks.
    for (const element of frame.querySelectorAll<HTMLElement>("*")) {
      const right = element.getBoundingClientRect().right;
      if (right > frameRect.right + 1) {
        throw new Error(
          `instance list content overflowed the ${INSTANCE_LIST_PHONE_WIDTH}px frame by ${Math.round(right - frameRect.right)}px`
        );
      }
    }
  },
};

/** task_apply_git_patch states: executing, dry-run, success, and failure */
export const TaskApplyGitPatchStates: Story = {
  render: () => (
    <ToolStoryShell>
      <TaskApplyGitPatchToolCall
        args={{ task_id: "task-fe-001", dry_run: true, three_way: true }}
        status="executing"
      />

      <TaskApplyGitPatchToolCall
        args={{ task_id: "task-fe-001", dry_run: true, three_way: true }}
        result={{
          success: true,
          taskId: "task-fe-001",
          appliedCommits: [
            { subject: "feat: add Apply Patch tool UI" },
            { subject: "fix: render applied commit list" },
          ],
          dryRun: true,
          note: "Dry run succeeded; no commits were applied.",
        }}
        status="completed"
      />

      <TaskApplyGitPatchToolCall
        args={{ task_id: "task-fe-001", three_way: true }}
        result={{
          success: true,
          taskId: "task-fe-001",
          appliedCommits: [
            {
              sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6",
              subject: "feat: add Apply Patch tool UI",
            },
            {
              sha: "d7a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9",
              subject: "fix: render applied commit list",
            },
          ],
          headCommitSha: "d7a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9",
        }}
        status="completed"
      />

      <TaskApplyGitPatchToolCall
        args={{ task_id: "task-fe-001", three_way: true }}
        result={{
          success: false,
          taskId: "task-fe-001",
          error: "fatal: Dirty index: cannot apply patches (dirty: src/App.tsx)",
          note: "git am failed before entering conflict-recovery state. Review the error output above and fix the patch/input before retrying.",
        }}
        status="completed"
      />
    </ToolStoryShell>
  ),
};
