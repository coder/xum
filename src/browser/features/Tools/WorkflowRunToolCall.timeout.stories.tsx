import type { Meta, StoryObj } from "@storybook/react-vite";

import { WorkflowRunToolCall } from "@/browser/features/Tools/WorkflowRunToolCall";
import { PIXEL_DISABLED, lightweightMeta } from "@/browser/stories/meta.js";
import type { WorkflowRunRecord } from "@/common/types/workflow";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/WorkflowRun/Timeouts",
  component: WorkflowRunToolCall,
  parameters: {
    pixel: PIXEL_DISABLED,
  },
} satisfies Meta<typeof WorkflowRunToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

const timeoutRecoveredRun: WorkflowRunRecord = {
  id: "wfr_story_timeout_recovered",
  workspaceId: "workspace-1",
  workflow: {
    name: "timeout-demo",
    description: "Timeout demo",
    scope: "project",
    sourcePath: "./workflows/timeout-demo.js",
    requestedScriptPath: "./workflows/timeout-demo.js",
    canonicalScriptPath: "./workflows/timeout-demo.js",
    sourceKind: "workspace-file",
    sourceHash: "sha256:timeout-story",
    executable: true,
  },
  source: "export default function workflow() { return null; }",
  sourceHash: "sha256:timeout-story",
  args: { topic: "workflow timeout finalization" },
  status: "completed",
  createdAt: "2026-05-29T00:00:00.000Z",
  updatedAt: "2026-05-29T00:00:05.000Z",
  events: [
    { sequence: 1, type: "status", at: "2026-05-29T00:00:00.000Z", status: "running" },
    {
      sequence: 2,
      type: "task",
      at: "2026-05-29T00:00:01.000Z",
      stepId: "slow-investigation",
      taskId: "task_timeout",
      status: "started",
      title: "Slow investigation",
    },
    {
      sequence: 3,
      type: "timeout",
      at: "2026-05-29T00:00:03.000Z",
      stepId: "slow-investigation",
      taskId: "task_timeout",
      phase: "soft",
      details: { softMs: 2000, graceMs: 2000 },
    },
    {
      sequence: 4,
      type: "task",
      at: "2026-05-29T00:00:03.000Z",
      stepId: "slow-investigation",
      taskId: "task_timeout",
      status: "finalizing",
      title: "Slow investigation",
    },
    {
      sequence: 5,
      type: "timeout",
      at: "2026-05-29T00:00:03.100Z",
      stepId: "slow-investigation",
      taskId: "task_timeout",
      phase: "finalization_prompt_sent",
    },
    {
      sequence: 6,
      type: "timeout",
      at: "2026-05-29T00:00:04.000Z",
      stepId: "slow-investigation",
      taskId: "task_timeout",
      phase: "recovered",
      details: { graceMs: 2000 },
    },
    {
      sequence: 7,
      type: "task",
      at: "2026-05-29T00:00:04.000Z",
      stepId: "slow-investigation",
      taskId: "task_timeout",
      status: "completed",
      title: "Slow investigation",
    },
    { sequence: 8, type: "status", at: "2026-05-29T00:00:05.000Z", status: "completed" },
  ],
  steps: [],
};

export const TimeoutRecovered: Story = {
  args: {
    args: {
      script_path: "./workflows/timeout-demo.js",
      args: { topic: "workflow timeout finalization" },
      run_in_background: false,
    },
    status: "completed",
    result: {
      status: "completed",
      runId: "wfr_story_timeout_recovered",
      result: { reportMarkdown: "Recovered during timeout finalization." },
      run: timeoutRecoveredRun,
    },
  },
};

export const TimeoutFinalizing: Story = {
  args: {
    ...TimeoutRecovered.args,
    result: {
      status: "running",
      runId: "wfr_story_timeout_finalizing",
      result: null,
      run: {
        ...timeoutRecoveredRun,
        id: "wfr_story_timeout_finalizing",
        status: "running",
        updatedAt: "2026-05-29T00:00:03.100Z",
        events: timeoutRecoveredRun.events.slice(0, 5),
      },
    },
  },
};

export const TimeoutHard: Story = {
  args: {
    ...TimeoutRecovered.args,
    result: {
      status: "failed",
      runId: "wfr_story_timeout_hard",
      result: null,
      run: {
        ...timeoutRecoveredRun,
        id: "wfr_story_timeout_hard",
        status: "failed",
        updatedAt: "2026-05-29T00:00:06.000Z",
        events: [
          ...timeoutRecoveredRun.events.slice(0, 5),
          {
            sequence: 6,
            type: "timeout",
            at: "2026-05-29T00:00:05.000Z",
            stepId: "slow-investigation",
            taskId: "task_timeout",
            phase: "hard",
            details: {
              error:
                "Workflow agent step slow-investigation exceeded its soft timeout (2000ms) and did not produce a valid agent_report within the grace period (2000ms).",
            },
          },
          {
            sequence: 7,
            type: "task",
            at: "2026-05-29T00:00:05.000Z",
            stepId: "slow-investigation",
            taskId: "task_timeout",
            status: "timed_out",
            title: "Slow investigation",
          },
          {
            sequence: 8,
            type: "error",
            at: "2026-05-29T00:00:05.100Z",
            message:
              "Workflow agent step slow-investigation exceeded its soft timeout (2000ms) and did not produce a valid agent_report within the grace period (2000ms).",
          },
          { sequence: 9, type: "status", at: "2026-05-29T00:00:06.000Z", status: "failed" },
        ],
      },
    },
  },
};

export const TimeoutParallel: Story = {
  args: {
    ...TimeoutRecovered.args,
    result: {
      status: "completed",
      runId: "wfr_story_timeout_parallel",
      result: {
        reportMarkdown: "Parallel workflow completed after one lane recovered during grace.",
      },
      run: {
        ...timeoutRecoveredRun,
        id: "wfr_story_timeout_parallel",
        status: "completed",
        updatedAt: "2026-05-29T00:00:06.000Z",
        events: [
          { sequence: 1, type: "status", at: "2026-05-29T00:00:00.000Z", status: "running" },
          {
            sequence: 2,
            type: "task",
            at: "2026-05-29T00:00:01.000Z",
            stepId: "fast-lane",
            taskId: "task_fast",
            status: "completed",
            title: "Fast lane",
          },
          {
            sequence: 3,
            type: "task",
            at: "2026-05-29T00:00:01.000Z",
            stepId: "slow-lane",
            taskId: "task_slow",
            status: "started",
            title: "Slow lane",
          },
          {
            sequence: 4,
            type: "timeout",
            at: "2026-05-29T00:00:03.000Z",
            stepId: "slow-lane",
            taskId: "task_slow",
            phase: "soft",
            details: { softMs: 2000, graceMs: 2000 },
          },
          {
            sequence: 5,
            type: "task",
            at: "2026-05-29T00:00:03.000Z",
            stepId: "slow-lane",
            taskId: "task_slow",
            status: "finalizing",
            title: "Slow lane",
          },
          {
            sequence: 6,
            type: "timeout",
            at: "2026-05-29T00:00:03.100Z",
            stepId: "slow-lane",
            taskId: "task_slow",
            phase: "finalization_prompt_sent",
          },
          {
            sequence: 7,
            type: "timeout",
            at: "2026-05-29T00:00:04.000Z",
            stepId: "slow-lane",
            taskId: "task_slow",
            phase: "recovered",
            details: { graceMs: 2000 },
          },
          {
            sequence: 8,
            type: "task",
            at: "2026-05-29T00:00:04.000Z",
            stepId: "slow-lane",
            taskId: "task_slow",
            status: "completed",
            title: "Slow lane",
          },
          { sequence: 9, type: "status", at: "2026-05-29T00:00:06.000Z", status: "completed" },
        ],
      },
    },
  },
};
