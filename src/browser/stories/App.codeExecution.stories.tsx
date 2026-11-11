import { expect, userEvent, within } from "storybook/test";
import { getAutoExpandPrefsKey } from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { PhoneSubagentReportDecorator } from "./helpers/subagentReportStory";
import { collapseLeftSidebar, collapseRightSidebar } from "./helpers/uiState";
import { createAssistantMessage } from "./mocks/messages";
import { createWorkspace, STABLE_TIMESTAMP } from "./mocks/workspaces";

const WORKSPACE_ID = "ws-code-execution-spacing";
const REVIEWER_ID = "code-execution-reviewer";

function setupNestedToolsStory() {
  collapseLeftSidebar();
  collapseRightSidebar();
  updatePersistedState(getAutoExpandPrefsKey(WORKSPACE_ID), {});
  return setupSimpleChatStory({
    workspaceId: WORKSPACE_ID,
    workspaceName: "nested-tool-spacing",
    projectName: "mux",
    messages: [
      createAssistantMessage("nested-tools", "", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP,
        toolCalls: [
          {
            type: "dynamic-tool",
            toolCallId: "code-execution",
            toolName: "code_execution",
            state: "output-available",
            input: { code: "mux.file_read({ path: 'src/config.ts' });" },
            output: { success: true, toolCalls: [], consoleOutput: [] },
            nestedCalls: [
              {
                toolCallId: "nested-report",
                toolName: "agent_report",
                state: "output-available",
                input: {
                  title: "Layout review",
                  reportMarkdown: "The tool cards should stay inside the code execution border.",
                },
                output: { success: true },
              },
              {
                toolCallId: "nested-read",
                toolName: "file_read",
                state: "output-available",
                input: { path: "src/config.ts" },
                output: {
                  success: true,
                  lines_read: 1,
                  file_size: 24,
                  content: "1\tconst debug = false;",
                },
              },
              {
                toolCallId: "nested-message",
                toolName: "task_send_message",
                state: "output-available",
                input: {
                  task_id: REVIEWER_ID,
                  message:
                    "Check both collapsed and expanded cards at phone widths.\n\nInspect src/browser/features/Tools/Shared/NestedToolsContainer.tsx for spacing shared by all nested tools.",
                },
                output: { status: "reactivated", taskId: REVIEWER_ID },
              },
            ],
          },
        ],
      }),
    ],
    additionalWorkspaces: [
      createWorkspace({
        id: REVIEWER_ID,
        name: "reviewer",
        title: "Reviewer",
        projectName: "mux",
        parentWorkspaceId: WORKSPACE_ID,
        taskStatus: "running",
      }),
    ],
  });
}

export default {
  ...appMeta,
  title: "App/CodeExecution",
};

export const NestedTools: AppStory = {
  render: () => <AppWithMocks setup={setupNestedToolsStory} />,
  globals: { viewport: { value: "desktop", isRotated: false } },
  // Geometry regression only: ConsecutiveRuns carries the code execution Pixel snapshots, which
  // keeps the repo under its snapshot budget.
  parameters: { pixel: PIXEL_DISABLED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole("button", { name: "Message to Reviewer" });
    const frame = canvas.getByRole("group", { name: "Code Execution" });
    const header = frame.firstElementChild!;
    const tools = within(frame).getByTestId("nested-tool-calls");
    await expect(tools.children).toHaveLength(3);

    const checkSpacing = async () => {
      const bounds = frame.getBoundingClientRect();
      let previousBottom = header.getBoundingClientRect().bottom;
      // Assert rendered geometry, not utility classes: every tool (including an
      // unbordered file read) stays inside the card, below the header, without overlap.
      for (const card of tools.children) {
        const rect = card.getBoundingClientRect();
        await expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
        await expect(rect.right).toBeLessThanOrEqual(bounds.right);
        await expect(rect.top).toBeGreaterThanOrEqual(previousBottom);
        await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
        previousBottom = rect.bottom;
      }
      await expect(bounds.bottom).toBeGreaterThanOrEqual(previousBottom);
      await expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth);
    };

    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await checkSpacing();
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    await checkSpacing();
  },
};

export const NestedToolsPhone: AppStory = {
  ...NestedTools,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  // Keep the narrow-container regression active in the desktop-sized test-runner too.
  decorators: [PhoneSubagentReportDecorator],
  parameters: { pixel: PIXEL_DISABLED },
  play: async (context) => {
    await NestedTools.play?.(context);
    const frame = within(context.canvasElement).getByRole("group", { name: "Code Execution" });
    await expect(frame.getBoundingClientRect().width).toBeLessThan(390);
  },
};

const SEQUENCE_WORKSPACE_ID = "ws-code-execution-sequence";

function nestedRead(id: string, path: string) {
  return {
    toolCallId: id,
    toolName: "file_read",
    state: "output-available" as const,
    input: { path },
    output: { success: true, lines_read: 1, file_size: 24, content: "1\texport {};" },
  };
}

function codeExecutionCall(
  id: string,
  code: string,
  nestedCalls: Array<ReturnType<typeof nestedRead>>
) {
  return {
    type: "dynamic-tool" as const,
    toolCallId: id,
    toolName: "code_execution",
    state: "output-available" as const,
    input: { code },
    output: { success: true, result: "ok", toolCalls: [], consoleOutput: [] },
    nestedCalls,
  };
}

/** Back-to-back code executions, the way agents explore: several runs, then an answer. */
function setupSequenceStory() {
  collapseLeftSidebar();
  collapseRightSidebar();
  updatePersistedState(getAutoExpandPrefsKey(SEQUENCE_WORKSPACE_ID), {});
  return setupSimpleChatStory({
    workspaceId: SEQUENCE_WORKSPACE_ID,
    workspaceName: "code-execution-sequence",
    projectName: "mux",
    messages: [
      createAssistantMessage("sequence-tools", "", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP,
        toolCalls: [
          codeExecutionCall("run-1", "const files = xum.bash({ script: 'git ls-files' });", [
            nestedRead("run-1-read", "package.json"),
          ]),
          codeExecutionCall(
            "run-2",
            "// Count the stories per feature\nconst counts = new Map();\nreturn counts.size;",
            []
          ),
          codeExecutionCall(
            "run-3",
            "for (const p of paths) xum.file_read({ path: p });",
            Array.from({ length: 7 }, (_, index) =>
              nestedRead(`run-3-read-${index}`, `src/feature-${index}.ts`)
            )
          ),
        ],
      }),
      createAssistantMessage("sequence-answer", "The feature folders are consistent.", {
        historySequence: 2,
        timestamp: STABLE_TIMESTAMP + 1000,
      }),
    ],
  });
}

/**
 * A settled run of code executions folds into one summary row (normal density); expanding it
 * shows each execution as a one-line header over its calls, and a long run shows only its
 * latest calls until asked for the rest.
 */
export const ConsecutiveRuns: AppStory = {
  render: () => <AppWithMocks setup={setupSequenceStory} />,
  globals: { viewport: { value: "desktop", isRotated: false } },
  parameters: { pixel: { matrix: { viewports: ["laptop"] } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bundle = await canvas.findByRole("button", { name: /Ran 3 scripts/ });
    await expect(bundle).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.queryAllByRole("group", { name: "Code Execution" })).toHaveLength(0);

    await userEvent.click(bundle);
    const runs = await canvas.findAllByRole("group", { name: "Code Execution" });
    await expect(runs).toHaveLength(3);

    // A run without nested calls stays a single header line that previews its first statement.
    await expect(within(runs[1]).queryByTestId("nested-tool-calls")).toBeNull();
    await expect(runs[1]).toHaveTextContent("const counts = new Map();");

    const longRun = within(runs[2]);
    await expect(longRun.getByTestId("nested-tool-calls").children).toHaveLength(4);
    await userEvent.click(longRun.getByRole("button", { name: "Show 3 earlier calls" }));
    await expect(longRun.getByTestId("nested-tool-calls").children).toHaveLength(7);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
  },
};

export const ConsecutiveRunsPhone: AppStory = {
  ...ConsecutiveRuns,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  decorators: [PhoneSubagentReportDecorator],
  parameters: { pixel: { matrix: { viewports: ["phone"] } } },
  play: async (context) => {
    await ConsecutiveRuns.play?.(context);
    for (const run of within(context.canvasElement).getAllByRole("group", {
      name: "Code Execution",
    })) {
      await expect(run.scrollWidth).toBeLessThanOrEqual(run.clientWidth);
    }
  },
};
