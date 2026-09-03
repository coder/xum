import type { Meta, StoryObj } from "@storybook/react-vite";
import { waitFor } from "@storybook/test";
import type { ReactNode } from "react";
import { BackgroundBashProvider } from "@/browser/contexts/BackgroundBashContext";
import { BashBackgroundListToolCall } from "@/browser/features/Tools/BashBackgroundListToolCall";
import { BashBackgroundTerminateToolCall } from "@/browser/features/Tools/BashBackgroundTerminateToolCall";
import { BashOutputToolCall } from "@/browser/features/Tools/BashOutputToolCall";
import { BashToolCall } from "@/browser/features/Tools/BashToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { NOW } from "@/browser/stories/storyTime";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/Bash",
  component: BashToolCall,
} satisfies Meta<typeof BashToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

const STORYBOOK_WORKSPACE_ID = "storybook-bash";

function ToolStoryShell(props: { children: ReactNode }) {
  return (
    <BackgroundBashProvider workspaceId={STORYBOOK_WORKSPACE_ID}>
      <div className="bg-background p-6">
        <div className="w-full max-w-2xl space-y-4">{props.children}</div>
      </div>
    </BackgroundBashProvider>
  );
}

/** foreground bash output with passing and failing commands */
export const WithTerminal: Story = {
  render: () => (
    <ToolStoryShell>
      <BashToolCall
        workspaceId={STORYBOOK_WORKSPACE_ID}
        toolCallId="terminal-pass"
        args={{
          script: "bun test src/api/users.test.ts",
          run_in_background: false,
          timeout_secs: 30,
          display_name: "Unit tests",
        }}
        result={{
          success: true,
          output: [
            "PASS src/api/users.test.ts",
            "  ✓ should return user when authenticated (24ms)",
            "  ✓ should return 401 when token is missing (18ms)",
            "",
            "Test Suites: 1 passed, 1 total",
            "Tests:       2 passed, 2 total",
          ].join("\n"),
          exitCode: 0,
          wall_duration_ms: 1640,
        }}
        status="completed"
      />

      <BashToolCall
        workspaceId={STORYBOOK_WORKSPACE_ID}
        toolCallId="terminal-fail"
        args={{
          script: "bun test --testNamePattern='edge case'",
          run_in_background: false,
          timeout_secs: 30,
          display_name: "Focused test",
        }}
        result={{
          success: false,
          output: [
            "FAIL src/api/users.test.ts",
            "  ✕ should handle edge case (45ms)",
            "",
            "Error: Expected 200 but got 500",
          ].join("\n"),
          error: "Command exited with code 1",
          exitCode: 1,
          wall_duration_ms: 960,
        }}
        status="completed"
      />
    </ToolStoryShell>
  ),
};

/** collapsed bash header showing intent on top and command on the second line */
export const IntentCollapsedSummary: Story = {
  render: () => (
    <ToolStoryShell>
      <BashToolCall
        workspaceId={STORYBOOK_WORKSPACE_ID}
        toolCallId="intent-summary"
        args={{
          script: "sleep 30 && tail -30 /tmp/develop.log",
          model_intent:
            "Waiting for the dev instance to start using sleep 30 && tail -30 /tmp/develop.log for 30.1s",
          run_in_background: false,
          timeout_secs: 120,
          display_name: "Dev server readiness",
        }}
        result={{
          success: true,
          output: "VITE ready on the sandbox frontend. Backend health check passed.",
          exitCode: 0,
          wall_duration_ms: 30_100,
        }}
        status="completed"
      />
    </ToolStoryShell>
  ),
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      const textContent = canvasElement.textContent ?? "";
      if (!textContent.includes("Waiting for the dev instance to start")) {
        throw new Error("Intent summary text should be visible");
      }
      if (!textContent.includes("sleep 30 && tail -30 /tmp/develop.log")) {
        throw new Error("Raw command should stay visible alongside intent");
      }
      if (!textContent.includes("for 30.1s")) {
        throw new Error("Completed duration should be visible outside the intent text");
      }
      if (textContent.includes("timeout: 120s")) {
        throw new Error("Completed intent summaries should not repeat the timeout chip");
      }
    });
  },
};

export const IntentExecutingSummary: Story = {
  render: () => (
    <ToolStoryShell>
      <BashToolCall
        workspaceId={STORYBOOK_WORKSPACE_ID}
        toolCallId="intent-executing-summary"
        args={{
          script: "sleep 30 && tail -30 /tmp/develop.log",
          model_intent: "Waiting for the dev instance to start",
          run_in_background: false,
          timeout_secs: 120,
          display_name: "Dev server readiness",
        }}
        status="executing"
        startedAt={NOW - 1_000}
      />
    </ToolStoryShell>
  ),
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      const textContent = canvasElement.textContent ?? "";
      if (!textContent.includes("Waiting for the dev instance to start")) {
        throw new Error("Intent summary text should be visible while executing");
      }
      if (!textContent.includes("timeout: 120s")) {
        throw new Error("Executing intent summaries should keep timeout metadata visible");
      }
      if (textContent.includes("for 30.1s")) {
        throw new Error("Executing intent summaries should not show completed duration metadata");
      }
    });
  },
};

/** when the model omits `model_intent`, the collapsed row falls back to the bare command */
export const NoIntentSummary: Story = {
  render: () => (
    <ToolStoryShell>
      <BashToolCall
        workspaceId={STORYBOOK_WORKSPACE_ID}
        toolCallId="command-summary"
        args={{
          script: "sleep 30 && tail -30 /tmp/develop.log",
          run_in_background: false,
          timeout_secs: 120,
          display_name: "Dev server readiness",
        }}
        result={{
          success: true,
          output: "VITE ready on the sandbox frontend. Backend health check passed.",
          exitCode: 0,
          wall_duration_ms: 30_100,
        }}
        status="completed"
      />
    </ToolStoryShell>
  ),
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      const textContent = canvasElement.textContent ?? "";
      if (!textContent.includes("sleep 30 && tail -30 /tmp/develop.log")) {
        throw new Error("Raw command should be visible when intent is absent");
      }
      if (!textContent.includes("timeout: 120s")) {
        throw new Error("Command-only mode should keep timeout metadata visible");
      }
      if (!textContent.includes("took 30s")) {
        throw new Error("Command-only mode should keep duration metadata visible");
      }
    });
  },
};

/** background bash lifecycle: spawn, poll output, list, and terminate */
export const BackgroundWorkflow: Story = {
  render: () => (
    <ToolStoryShell>
      <BashToolCall
        toolCallId="spawn-dev"
        args={{
          script: "bun run dev",
          run_in_background: true,
          timeout_secs: 60,
          display_name: "Dev Server",
        }}
        result={{
          success: true,
          output: "Background process started with ID: bash_1",
          exitCode: 0,
          wall_duration_ms: 58,
          taskId: "bash:bash_1",
          backgroundProcessId: "bash_1",
        }}
        status="completed"
      />

      <BashOutputToolCall
        args={{ process_id: "bash_1", timeout_secs: 5 }}
        result={{
          success: true,
          status: "running",
          output:
            "VITE v5.0.0 ready in 320 ms\n\n➜ Local: http://localhost:5173/\n➜ Network: use --host to expose",
          elapsed_ms: 1200,
        }}
        status="completed"
      />

      <BashBackgroundListToolCall
        args={{}}
        result={{
          success: true,
          processes: [
            {
              process_id: "bash_1",
              status: "running",
              script: "bun run dev",
              uptime_ms: 500000,
              display_name: "Dev Server",
            },
            {
              process_id: "bash_2",
              status: "exited",
              script: "bun run build",
              uptime_ms: 120000,
              exitCode: 0,
            },
          ],
        }}
        status="completed"
      />

      <BashBackgroundTerminateToolCall
        args={{ process_id: "bash_1" }}
        result={{
          success: true,
          message: "Process bash_1 terminated",
          display_name: "Dev Server",
        }}
        status="completed"
      />
    </ToolStoryShell>
  ),
};

/** grouped bash_output cards showing first/last markers for consecutive polls */
export const GroupedOutput: Story = {
  render: () => (
    <ToolStoryShell>
      <BashToolCall
        toolCallId="grouped-spawn"
        args={{
          script: "bun run dev",
          run_in_background: true,
          timeout_secs: 60,
          display_name: "Dev Server",
        }}
        result={{
          success: true,
          output: "Background process started with ID: bash_1",
          exitCode: 0,
          wall_duration_ms: 45,
          taskId: "bash:bash_1",
          backgroundProcessId: "bash_1",
        }}
        status="completed"
      />

      <BashOutputToolCall
        args={{ process_id: "bash_1", timeout_secs: 5 }}
        groupPosition="first"
        result={{
          success: true,
          status: "running",
          output: "Starting compilation...",
          elapsed_ms: 110,
        }}
        status="completed"
      />

      <BashOutputToolCall
        args={{ process_id: "bash_1", timeout_secs: 5 }}
        groupPosition="last"
        result={{
          success: true,
          status: "running",
          output: "VITE v5.0.0 ready in 320 ms\n\n➜ Local: http://localhost:5173/",
          elapsed_ms: 320,
        }}
        status="completed"
      />

      <BashOutputToolCall
        args={{ process_id: "bash_1", timeout_secs: 5 }}
        result={{
          success: true,
          status: "running",
          output: "Server healthy",
          elapsed_ms: 50,
        }}
        status="completed"
      />
    </ToolStoryShell>
  ),
};

/** overflow/truncation notice for a large completed bash output */
export const OverflowNotice: Story = {
  render: () => (
    <ToolStoryShell>
      <BashToolCall
        workspaceId={STORYBOOK_WORKSPACE_ID}
        toolCallId="overflow"
        args={{
          script: 'rg "ERROR" /var/log/app/*.log',
          run_in_background: false,
          timeout_secs: 5,
          display_name: "Log Scan",
        }}
        result={{
          success: true,
          output: "",
          note: [
            "[OUTPUT OVERFLOW - Total output exceeded display limit: 18432 bytes > 16384 bytes (at line 312)]",
            "",
            "Full output (1250 lines) saved to /home/user/.mux/tmp/bash-1a2b3c4d.txt",
            "",
            "Use selective filtering tools (e.g. grep) to extract relevant information and continue your task",
          ].join("\n"),
          exitCode: 0,
          wall_duration_ms: 4200,
          truncated: {
            reason: "Total output exceeded display limit: 18432 bytes > 16384 bytes (at line 312)",
            totalLines: 1250,
          },
        }}
        status="completed"
      />
    </ToolStoryShell>
  ),
};
