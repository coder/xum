import { describe, expect, test, beforeEach, mock, spyOn } from "bun:test";
import type { SendMessageOptions } from "@/common/orpc/types";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import {
  parseRuntimeString,
  prepareCompactionMessage,
  handlePlanShowCommand,
  handlePlanOpenCommand,
  handleCompactCommand,
  WORKFLOW_FREEFORM_ARGS_ERROR_MESSAGE,
  processSlashCommand,
} from "./chatCommands";
import { parseCommand } from "./slashCommands/parser";
import type { CommandHandlerContext, SlashCommandContext } from "./chatCommands";
import type { ReviewNoteData } from "@/common/types/review";
import { useWorkspaceStoreRaw, workspaceStore } from "@/browser/stores/WorkspaceStore";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { HEARTBEAT_DEFAULT_INTERVAL_MS } from "@/constants/heartbeat";

// Simple mock for localStorage to satisfy resolveCompactionModel and experiment gating.
// Note: command helpers read from window.localStorage, so we set both globalThis.localStorage
// and window.localStorage for test isolation.
beforeEach(() => {
  // Ensure `window` exists for browser-environment functions like isExperimentEnabled.
  if (typeof globalThis.window === "undefined") {
    (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
  }

  const storageData = new Map<string, string>();
  const storage = {
    getItem: (key: string) => storageData.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageData.set(key, value);
    },
    removeItem: (key: string) => {
      storageData.delete(key);
    },
    clear: () => {
      storageData.clear();
    },
    key: (index: number) => Array.from(storageData.keys())[index] ?? null,
    get length() {
      return storageData.size;
    },
  } as unknown as Storage;

  globalThis.localStorage = storage;

  if (typeof window !== "undefined") {
    try {
      Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
    } catch {
      // Some test DOM environments expose localStorage as a readonly getter.
      (window as unknown as { localStorage?: Storage }).localStorage = storage;
    }
  }
});

describe("parseRuntimeString", () => {
  test.each([undefined, "worktree", "WORKTREE", " worktree "])(
    "returns undefined for default/worktree runtime %#",
    (runtime) => {
      expect(parseRuntimeString(runtime)).toBeUndefined();
    }
  );

  test.each(["local", "LOCAL", " local "])("returns local config for %p", (runtime) => {
    // "local" now returns project-dir runtime config (no srcBaseDir)
    expect(parseRuntimeString(runtime)).toEqual({ type: "local" });
  });

  test.each([
    ["ssh user@host", { type: "ssh", host: "user@host", srcBaseDir: "~/mux" }],
    [
      "ssh User@Host.Example.Com",
      { type: "ssh", host: "User@Host.Example.Com", srcBaseDir: "~/mux" },
    ],
    ["  ssh   user@host  ", { type: "ssh", host: "user@host", srcBaseDir: "~/mux" }],
    ["ssh hostname", { type: "ssh", host: "hostname", srcBaseDir: "~/mux" }],
    ["ssh dev.example.com", { type: "ssh", host: "dev.example.com", srcBaseDir: "~/mux" }],
    ["ssh root@hostname", { type: "ssh", host: "root@hostname", srcBaseDir: "~/mux" }],
    ["docker ubuntu:22.04", { type: "docker", image: "ubuntu:22.04" }],
    ["docker ghcr.io/myorg/dev:latest", { type: "docker", image: "ghcr.io/myorg/dev:latest" }],
    [
      "devcontainer .devcontainer/devcontainer.json",
      { type: "devcontainer", configPath: ".devcontainer/devcontainer.json" },
    ],
  ] as const)("parses %p", (runtime, expected) => {
    expect(parseRuntimeString(runtime)).toEqual(expected);
  });

  test.each([
    ["ssh", "SSH runtime requires host"],
    ["ssh ", "SSH runtime requires host"],
    ["devcontainer", "Dev container runtime requires a config path"],
    ["docker", "Docker runtime requires image"],
    ["docker ", "Docker runtime requires image"],
    [
      "remote",
      "Unknown runtime type: 'remote'. Use 'ssh <host>', 'docker <image>', 'devcontainer <config>', 'worktree', or 'local'",
    ],
    [
      "kubernetes",
      "Unknown runtime type: 'kubernetes'. Use 'ssh <host>', 'docker <image>', 'devcontainer <config>', 'worktree', or 'local'",
    ],
  ])("throws for invalid runtime %p", (runtime, message) => {
    expect(() => parseRuntimeString(runtime)).toThrow(message);
  });
});

function ensureWindowDispatchEvent(): void {
  Object.defineProperty(window, "dispatchEvent", { value: mock(() => true), configurable: true });
}

function createSlashCommandContext(
  overrides: Partial<SlashCommandContext> & Pick<SlashCommandContext, "api">
): SlashCommandContext {
  return {
    workspaceId: "test-ws",
    variant: "workspace",
    projectPath: "/tmp/project",
    setPreferredModel: mock(() => undefined),
    setVimEnabled: mock((cb: (prev: boolean) => boolean) => cb(false)),
    resetInputHeight: mock(() => undefined),
    onTruncateHistory: mock(() => Promise.resolve(undefined)),
    sendMessageOptions: {
      model: "anthropic:claude-sonnet-4-6",
      thinkingLevel: "off",
      toolPolicy: [],
      agentId: "exec",
    },
    setInput: mock(() => undefined),
    setToast: mock(() => undefined),
    setAttachments: mock(() => undefined),
    setSendingState: mock(() => undefined),
    ...overrides,
  };
}

function createGoalCommandContext(api: SlashCommandContext["api"]): SlashCommandContext {
  return createSlashCommandContext({
    api,
    workspaceId: "goal-ws",
    onMessageSent: mock(() => undefined),
    onCheckReviews: mock(() => undefined),
    attachedReviewIds: [],
    openSettings: mock(() => undefined),
  });
}

describe("processSlashCommand - workflow", () => {
  test("rejects workflow execution when dynamic workflows are disabled", async () => {
    const start = mock(() =>
      Promise.resolve({ runId: "wfr_123", status: "running", result: null })
    );
    const context = createSlashCommandContext({
      api: {
        workflows: { start },
      } as unknown as SlashCommandContext["api"],
      dynamicWorkflowsEnabled: false,
    });

    const result = await processSlashCommand(
      {
        type: "workflow-run",
        scriptPath: "skill://deep-research/workflow.js",
        argsText: '{"input":"mux"}',
      },
      context
    );

    expect(result).toEqual({ clearInput: false, toastShown: true });
    expect(start).not.toHaveBeenCalled();
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", message: "Dynamic workflows are disabled" })
    );
  });

  test("rejects freeform workflow slash arguments", async () => {
    const start = mock(() =>
      Promise.resolve({ runId: "wfr_123", status: "running", result: null })
    );
    const context = createSlashCommandContext({
      api: {
        workflows: { start },
      } as unknown as SlashCommandContext["api"],
      dynamicWorkflowsEnabled: true,
    });

    const result = await processSlashCommand(
      { type: "workflow-run", scriptPath: "skill://deep-research/workflow.js", argsText: "mux" },
      context
    );

    expect(result).toEqual({ clearInput: false, toastShown: true });
    expect(start).not.toHaveBeenCalled();
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", message: WORKFLOW_FREEFORM_ARGS_ERROR_MESSAGE })
    );
  });

  test.each([
    ['"hello"', "hello"],
    ["123", 123],
  ] as const)(
    "passes JSON scalar workflow slash arguments from %p",
    async (argsText, expectedArgs) => {
      const start = mock(() =>
        Promise.resolve({
          runId: "wfr_123",
          status: "running",
          result: null,
          invocationMessagePersisted: true,
        })
      );
      const context = createSlashCommandContext({
        api: {
          workflows: { start },
        } as unknown as SlashCommandContext["api"],
        rawInput: `/workflow ./echo.js ${argsText}`,
        dynamicWorkflowsEnabled: true,
      });

      const result = await processSlashCommand(
        { type: "workflow-run", scriptPath: "./echo.js", argsText },
        context
      );

      expect(result).toEqual({ clearInput: true, toastShown: true });
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expectedArgs,
          rawCommand: `/workflow ./echo.js ${argsText}`,
        })
      );
    }
  );

  test("sends completed workflow slash output to the main agent as hidden context", async () => {
    const workflowResult = {
      reportMarkdown: "# Research\n\nFindings",
      structuredOutput: { confidence: "high" },
    };
    const start = mock(() =>
      Promise.resolve({
        runId: "wfr_123",
        status: "completed",
        result: workflowResult,
      })
    );
    const getRun = mock(() =>
      Promise.resolve({
        id: "wfr_123",
        workspaceId: "test-ws",
        workflow: {
          name: "skill://deep-research/workflow.js",
          description: "Deep research",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return null; }",
        sourceHash: "sha256:test",
        args: { input: "mux" },
        status: "completed",
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:01.000Z",
        events: [
          {
            sequence: 1,
            type: "result",
            at: "2026-05-29T00:00:01.000Z",
            result: workflowResult,
          },
        ],
        steps: [],
      })
    );
    interface SentWorkflowMessage {
      message: string;
      options: { muxMetadata?: { type?: string; rawCommand?: string; commandPrefix?: string } };
    }
    const sentMessages: SentWorkflowMessage[] = [];
    const sendMessage = mock((input: SentWorkflowMessage) => {
      sentMessages.push(input);
      return Promise.resolve({ success: true });
    });
    const onMessageSent = mock(() => undefined);
    const context = createSlashCommandContext({
      api: {
        workflows: { start, getRun },
        workspace: { sendMessage },
      } as unknown as SlashCommandContext["api"],
      rawInput: '/deep-research {"input":"mux"}',
      dynamicWorkflowsEnabled: true,
      onMessageSent,
    });

    const result = await processSlashCommand(
      {
        type: "workflow-run",
        scriptPath: "skill://deep-research/workflow.js",
        argsText: '{"input":"mux"}',
      },
      context
    );

    expect(result).toEqual({ clearInput: true, toastShown: true });
    expect(start).toHaveBeenCalledWith({
      workspaceId: "test-ws",
      scriptPath: "skill://deep-research/workflow.js",
      runInBackground: true,
      args: { input: "mux" },
      rawCommand: '/deep-research {"input":"mux"}',
      continuationOptions: context.sendMessageOptions,
    });
    expect(getRun).toHaveBeenCalledWith({ workspaceId: "test-ws", runId: "wfr_123" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendInput = sentMessages[0];
    expect(sendInput).toBeDefined();
    expect(sendInput.message).toContain('/deep-research {"input":"mux"}');
    expect(sendInput.message).toContain("<mux_workflow_result>");
    expect(sendInput.message).toContain("Findings");
    expect(sendInput.message).toContain("confidence");
    expect(sendInput.options.muxMetadata?.type).toBe("workflow-result");
    expect(sendInput.options.muxMetadata?.rawCommand).toBe('/deep-research {"input":"mux"}');
    expect(sendInput.options.muxMetadata?.commandPrefix).toBe("/deep-research");
    expect(context.setSendingState).toHaveBeenNthCalledWith(1, true);
    expect(context.setSendingState).toHaveBeenNthCalledWith(2, false);
    expect(context.setSendingState).toHaveBeenNthCalledWith(3, true);
    expect(context.setSendingState).toHaveBeenNthCalledWith(4, false);
    expect(onMessageSent).toHaveBeenCalledWith("tool-end");
  });

  test("leaves slash workflow continuation to backend when invocation is persisted", async () => {
    const start = mock(() =>
      Promise.resolve({
        runId: "wfr_123",
        status: "running",
        result: null,
        invocationMessagePersisted: true,
      })
    );
    const getRun = mock(() => Promise.resolve(null));
    const sendMessage = mock(() => Promise.resolve({ success: true }));
    const context = createSlashCommandContext({
      api: {
        workflows: { start, getRun },
        workspace: { sendMessage },
      } as unknown as SlashCommandContext["api"],
      rawInput: '/deep-research {"input":"mux"}',
      dynamicWorkflowsEnabled: true,
    });

    const result = await processSlashCommand(
      {
        type: "workflow-run",
        scriptPath: "skill://deep-research/workflow.js",
        argsText: '{"input":"mux"}',
      },
      context
    );

    expect(result).toEqual({ clearInput: true, toastShown: true });
    expect(start).toHaveBeenCalledWith({
      workspaceId: "test-ws",
      scriptPath: "skill://deep-research/workflow.js",
      runInBackground: true,
      args: { input: "mux" },
      rawCommand: '/deep-research {"input":"mux"}',
      continuationOptions: context.sendMessageOptions,
    });
    expect(getRun).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        message: "Workflow skill://deep-research/workflow.js started",
      })
    );
    expect(context.setSendingState).toHaveBeenNthCalledWith(1, true);
    expect(context.setSendingState).toHaveBeenNthCalledWith(2, false);
  });

  test("does not send terminal workflow results for superseded slash commands", async () => {
    const workflowResult = { reportMarkdown: "done" };
    const start = mock(() =>
      Promise.resolve({
        runId: "wfr_completed",
        status: "completed",
        result: workflowResult,
      })
    );
    const getRun = mock(() =>
      Promise.resolve({
        id: "wfr_completed",
        workspaceId: "test-ws",
        workflow: {
          name: "skill://deep-research/workflow.js",
          description: "Deep research",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return null; }",
        sourceHash: "sha256:test",
        args: { input: "mux" },
        status: "completed",
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:01.000Z",
        events: [
          { sequence: 1, type: "result", at: "2026-05-29T00:00:01.000Z", result: workflowResult },
        ],
        steps: [],
      })
    );
    const sendMessage = mock(() => Promise.resolve({ success: true }));
    const context = createSlashCommandContext({
      api: {
        workflows: { start, getRun },
        workspace: { sendMessage },
      } as unknown as SlashCommandContext["api"],
      rawInput: '/deep-research {"input":"mux"}',
      dynamicWorkflowsEnabled: true,
      asyncCommandToken: 1,
      isAsyncCommandCurrent: mock(() => false),
    });

    const result = await processSlashCommand(
      {
        type: "workflow-run",
        scriptPath: "skill://deep-research/workflow.js",
        argsText: '{"input":"mux"}',
      },
      context
    );

    expect(result).toEqual({ clearInput: true, toastShown: false });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(context.setToast).not.toHaveBeenCalled();
  });

  test("does not restore a superseded workflow slash command", async () => {
    const start = mock(() =>
      Promise.resolve({
        runId: "wfr_running",
        status: "running",
        result: null,
      })
    );
    const getRun = mock(() =>
      Promise.resolve({
        id: "wfr_running",
        workspaceId: "test-ws",
        workflow: {
          name: "skill://deep-research/workflow.js",
          description: "Deep research",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return null; }",
        sourceHash: "sha256:test",
        args: { input: "mux" },
        status: "running",
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:01.000Z",
        events: [],
        steps: [],
      })
    );
    const sendMessage = mock(() => Promise.resolve({ success: true }));
    const context = createSlashCommandContext({
      api: {
        workflows: { start, getRun },
        workspace: { sendMessage },
      } as unknown as SlashCommandContext["api"],
      rawInput: '/deep-research {"input":"mux"}',
      dynamicWorkflowsEnabled: true,
      asyncCommandToken: 1,
      isAsyncCommandCurrent: mock(() => false),
    });

    const result = await processSlashCommand(
      {
        type: "workflow-run",
        scriptPath: "skill://deep-research/workflow.js",
        argsText: '{"input":"mux"}',
      },
      context
    );

    expect(result).toEqual({ clearInput: true, toastShown: false });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(context.setToast).not.toHaveBeenCalled();
  });

  test("does not restore failed workflow slash commands over newer drafts", async () => {
    const start = mock(() =>
      Promise.resolve({
        runId: "wfr_failed_send",
        status: "completed",
        result: { reportMarkdown: "done" },
      })
    );
    const getRun = mock(() =>
      Promise.resolve({
        id: "wfr_failed_send",
        workspaceId: "test-ws",
        workflow: {
          name: "skill://deep-research/workflow.js",
          description: "Deep research",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return null; }",
        sourceHash: "sha256:test",
        args: { input: "mux" },
        status: "completed",
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:01.000Z",
        events: [],
        steps: [],
      })
    );
    const sendMessage = mock(() => Promise.resolve({ success: false }));
    const context = createSlashCommandContext({
      api: {
        workflows: { start, getRun },
        workspace: { sendMessage },
      } as unknown as SlashCommandContext["api"],
      rawInput: '/deep-research {"input":"mux"}',
      dynamicWorkflowsEnabled: true,
      getInput: mock(() => "newer draft"),
    });

    const result = await processSlashCommand(
      {
        type: "workflow-run",
        scriptPath: "skill://deep-research/workflow.js",
        argsText: '{"input":"mux"}',
      },
      context
    );

    expect(result).toEqual({ clearInput: true, toastShown: true });
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "Failed to send workflow result to the agent",
      })
    );
  });

  test("does not continue the agent after an interrupted workflow slash run", async () => {
    const start = mock(() =>
      Promise.resolve({
        runId: "wfr_interrupted",
        status: "interrupted",
        result: null,
      })
    );
    const getRun = mock(() =>
      Promise.resolve({
        id: "wfr_interrupted",
        workspaceId: "test-ws",
        workflow: {
          name: "skill://deep-research/workflow.js",
          description: "Deep research",
          scope: "built-in",
          executable: true,
        },
        source: "export default function workflow() { return null; }",
        sourceHash: "sha256:test",
        args: { input: "mux" },
        status: "interrupted",
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:01.000Z",
        events: [],
        steps: [],
      })
    );
    const sendMessage = mock(() => Promise.resolve({ success: true }));
    const onMessageSent = mock(() => undefined);
    const context = createSlashCommandContext({
      api: {
        workflows: { start, getRun },
        workspace: { sendMessage },
      } as unknown as SlashCommandContext["api"],
      rawInput: '/deep-research {"input":"mux"}',
      dynamicWorkflowsEnabled: true,
      onMessageSent,
    });

    const result = await processSlashCommand(
      {
        type: "workflow-run",
        scriptPath: "skill://deep-research/workflow.js",
        argsText: '{"input":"mux"}',
      },
      context
    );

    expect(result).toEqual({ clearInput: true, toastShown: true });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(onMessageSent).not.toHaveBeenCalled();
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        message: "Workflow skill://deep-research/workflow.js interrupted",
      })
    );
  });
});

describe("processSlashCommand - clear", () => {
  function createClearContext(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
    return createSlashCommandContext({
      api: null,
      onDetachAllReviews: mock(() => undefined),
      onResetContext: mock(() => Promise.resolve("reset" as const)),
      ...overrides,
    });
  }

  test("hard clear truncates history", async () => {
    const context = createClearContext();

    const result = await processSlashCommand({ type: "clear", mode: "hard" }, context);

    expect(result).toEqual({ clearInput: true, toastShown: true });
    expect(context.onTruncateHistory).toHaveBeenCalledWith(1.0);
    expect(context.setAttachments).toHaveBeenCalledWith([]);
    expect(context.onDetachAllReviews).toHaveBeenCalled();
    expect(context.onResetContext).not.toHaveBeenCalled();
  });

  test("soft clear resets context without truncating history", async () => {
    const context = createClearContext();

    const result = await processSlashCommand({ type: "clear", mode: "soft" }, context);

    expect(result).toEqual({ clearInput: true, toastShown: true });
    expect(context.onResetContext).toHaveBeenCalled();
    expect(context.setAttachments).toHaveBeenCalledWith([]);
    expect(context.onDetachAllReviews).toHaveBeenCalled();
    expect(context.onTruncateHistory).not.toHaveBeenCalled();
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Context reset; history preserved", type: "success" })
    );
  });

  test("soft clear preserves attachments when reset is a no-op", async () => {
    const context = createClearContext({
      onResetContext: mock(() => Promise.resolve("noop" as const)),
    });

    const result = await processSlashCommand({ type: "clear", mode: "soft" }, context);

    expect(result).toEqual({ clearInput: true, toastShown: true });
    expect(context.setAttachments).not.toHaveBeenCalled();
    expect(context.onDetachAllReviews).not.toHaveBeenCalled();
  });

  test("soft clear reports errors without clearing composer state", async () => {
    const context = createClearContext({
      onResetContext: mock(() => Promise.reject(new Error("reset failed"))),
    });
    const consoleErrorSpy = spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const result = await processSlashCommand({ type: "clear", mode: "soft" }, context);

      expect(result).toEqual({ clearInput: false, toastShown: true });
      expect(context.setInput).not.toHaveBeenCalled();
      expect(context.setAttachments).not.toHaveBeenCalled();
      expect(context.onDetachAllReviews).not.toHaveBeenCalled();
      expect(context.setToast).toHaveBeenCalledWith(
        expect.objectContaining({ message: "reset failed", type: "error" })
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  test("soft clear reports no-op resets", async () => {
    const context = createClearContext({
      onResetContext: mock(() => Promise.resolve("noop" as const)),
    });

    const result = await processSlashCommand({ type: "clear", mode: "soft" }, context);

    expect(result).toEqual({ clearInput: true, toastShown: true });
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: "No context to reset", type: "success" })
    );
  });
});

describe("processSlashCommand - model-set", () => {
  const createModelSetContext = (api: SlashCommandContext["api"]): SlashCommandContext =>
    createSlashCommandContext({
      api,
      onMessageSent: mock(() => undefined),
      onCheckReviews: mock(() => undefined),
      attachedReviewIds: [],
      openSettings: mock(() => undefined),
    });

  test("reports backend verification failure for custom providers when config loading fails", async () => {
    const getConfig = mock(() => Promise.reject(new Error("backend offline")));
    const context = createModelSetContext({
      providers: {
        getConfig,
      },
    } as unknown as SlashCommandContext["api"]);
    const consoleErrorSpy = spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const result = await processSlashCommand(
        { type: "model-set", modelString: "local-vllm:qwen3-coder" },
        context
      );

      expect(result).toEqual({ clearInput: false, toastShown: true });
      expect(context.setToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          message: 'Could not verify provider "local-vllm": backend unreachable. Please retry.',
        })
      );
      expect(context.setToast).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Unknown provider "local-vllm"' })
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  test("refuses switching budgeted active goals to an unpriced model", async () => {
    ensureWindowDispatchEvent();
    const setPreferredModel = mock(() => undefined);
    const context = createModelSetContext({
      providers: {
        getConfig: mock(() => Promise.resolve({})),
        setModels: mock(() => Promise.resolve(undefined)),
      },
      workspace: {
        getGoal: mock(() =>
          Promise.resolve({
            goal: {
              goalId: "11111111-1111-4111-8111-111111111111",
              status: "active",
              budgetCents: 500,
            },
          })
        ),
      },
    } as unknown as SlashCommandContext["api"]);
    context.setPreferredModel = setPreferredModel;

    const result = await processSlashCommand(
      { type: "model-set", modelString: "openai:not-priced-model" },
      context
    );

    expect(result).toEqual({ clearInput: false, toastShown: true });
    expect(setPreferredModel).not.toHaveBeenCalled();
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "Target model has no pricing data. Pick a priced model before switching.",
      })
    );
  });

  test("allows switching unbudgeted active goals to an unpriced model", async () => {
    const setPreferredModel = mock(() => undefined);
    const context = createModelSetContext({
      providers: {
        getConfig: mock(() => Promise.resolve({})),
        setModels: mock(() => Promise.resolve(undefined)),
      },
      workspace: {
        getGoal: mock(() =>
          Promise.resolve({
            goal: {
              goalId: "11111111-1111-4111-8111-111111111111",
              status: "active",
              budgetCents: null,
            },
          })
        ),
      },
    } as unknown as SlashCommandContext["api"]);
    context.setPreferredModel = setPreferredModel;

    const result = await processSlashCommand(
      { type: "model-set", modelString: "openai:not-priced-model" },
      context
    );

    expect(result).toEqual({ clearInput: true, toastShown: true });
    expect(setPreferredModel).toHaveBeenCalledWith("openai:not-priced-model");
  });
});

describe("processSlashCommand - workspace command gating", () => {
  test("shows goal parse errors during workspace creation", async () => {
    const context = createGoalCommandContext(null);
    context.variant = "creation";

    const result = await processSlashCommand(
      { type: "command-unknown-flag", command: "goal", flag: "--bogus" },
      context
    );

    expect(result).toEqual({ clearInput: false, toastShown: true });
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Unknown flag for /goal: --bogus" })
    );
  });
});

describe("processSlashCommand - goal optimistic concurrency", () => {
  test("retries once after a goal conflict and reapplies the slash command intent", async () => {
    ensureWindowDispatchEvent();
    const getGoal = mock()
      .mockResolvedValueOnce({
        goal: {
          goalId: "11111111-1111-4111-8111-111111111111",
          objective: "old objective",
        },
      })
      .mockResolvedValueOnce({
        goal: {
          goalId: "22222222-2222-4222-8222-222222222222",
          objective: "fresh objective",
        },
      });
    const setGoal = mock()
      .mockResolvedValueOnce({
        success: false,
        error: {
          type: "goal_conflict",
          expectedGoalId: "11111111-1111-4111-8111-111111111111",
          actualGoalId: "22222222-2222-4222-8222-222222222222",
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          goalId: "33333333-3333-4333-8333-333333333333",
          objective: "new objective",
        },
      });
    const context = createGoalCommandContext({
      workspace: { getGoal, setGoal, clearGoal: mock() },
    } as unknown as SlashCommandContext["api"]);

    const result = await processSlashCommand(
      { type: "goal-set", objective: "new objective" },
      context
    );

    expect(result).toEqual({ clearInput: true, toastShown: false });
    expect(getGoal).toHaveBeenCalledTimes(2);
    expect(setGoal).toHaveBeenNthCalledWith(1, {
      workspaceId: "goal-ws",
      objective: "new objective",
      budgetCents: 200,
      turnCap: null,
      expectedGoalId: "11111111-1111-4111-8111-111111111111",
    });
    expect(setGoal).toHaveBeenNthCalledWith(2, {
      workspaceId: "goal-ws",
      objective: "new objective",
      budgetCents: 200,
      turnCap: null,
      expectedGoalId: "22222222-2222-4222-8222-222222222222",
    });
    expect(context.setToast).not.toHaveBeenCalled();
  });

  test("surfaces a toast and stops after two consecutive goal conflicts", async () => {
    ensureWindowDispatchEvent();
    const getGoal = mock()
      .mockResolvedValueOnce({
        goal: {
          goalId: "11111111-1111-4111-8111-111111111111",
          objective: "old objective",
        },
      })
      .mockResolvedValueOnce({
        goal: {
          goalId: "22222222-2222-4222-8222-222222222222",
          objective: "fresh objective",
        },
      });
    const setGoal = mock()
      .mockResolvedValueOnce({
        success: false,
        error: {
          type: "goal_conflict",
          expectedGoalId: "11111111-1111-4111-8111-111111111111",
          actualGoalId: "22222222-2222-4222-8222-222222222222",
        },
      })
      .mockResolvedValueOnce({
        success: false,
        error: {
          type: "goal_conflict",
          expectedGoalId: "22222222-2222-4222-8222-222222222222",
          actualGoalId: "33333333-3333-4333-8333-333333333333",
        },
      });
    const context = createGoalCommandContext({
      workspace: { getGoal, setGoal, clearGoal: mock() },
    } as unknown as SlashCommandContext["api"]);

    const result = await processSlashCommand(
      { type: "goal-set", objective: "new objective" },
      context
    );

    expect(result).toEqual({ clearInput: false, toastShown: true });
    expect(getGoal).toHaveBeenCalledTimes(2);
    expect(setGoal).toHaveBeenCalledTimes(2);
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "Goal changed in another window. Please try again.",
      })
    );
  });
});

describe("processSlashCommand - goal lifecycle commands", () => {
  test("surfaces invalid transition messages for lifecycle commands", async () => {
    ensureWindowDispatchEvent();
    const context = createGoalCommandContext({
      workspace: {
        getGoal: mock(() => Promise.resolve({ goal: null })),
        setGoal: mock(() =>
          Promise.resolve({
            success: false,
            error: { type: "invalid_transition", message: "Cannot pause a missing goal." },
          })
        ),
        clearGoal: mock(),
      },
    } as unknown as SlashCommandContext["api"]);

    const result = await processSlashCommand({ type: "goal-pause" }, context);

    expect(result).toEqual({ clearInput: false, toastShown: true });
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", message: "Cannot pause a missing goal." })
    );
  });

  test("dispatches pause, resume, and complete goal commands", async () => {
    ensureWindowDispatchEvent();
    const setGoal = mock(() =>
      Promise.resolve({
        success: true,
        data: { goalId: "33333333-3333-4333-8333-333333333333", objective: "goal" },
      })
    );
    const context = createGoalCommandContext({
      providers: { getConfig: mock(() => Promise.resolve({})) },
      workspace: {
        getGoal: mock(() => Promise.resolve({ goal: { status: "paused", budgetCents: null } })),
        setGoal,
        clearGoal: mock(),
      },
    } as unknown as SlashCommandContext["api"]);

    await processSlashCommand({ type: "goal-pause" }, context);
    await processSlashCommand({ type: "goal-resume" }, context);
    await processSlashCommand({ type: "goal-complete", summary: "Done." }, context);

    expect(setGoal).toHaveBeenNthCalledWith(1, {
      workspaceId: "goal-ws",
      expectedGoalId: null,
      status: "paused",
    });
    expect(setGoal).toHaveBeenNthCalledWith(2, {
      workspaceId: "goal-ws",
      status: "active",
      expectedGoalId: null,
    });
    expect(setGoal).toHaveBeenNthCalledWith(3, {
      workspaceId: "goal-ws",
      status: "complete",
      completionSummary: "Done.",
      expectedGoalId: null,
    });
  });

  test("refuses to resume a budgeted goal on an unpriced current model", async () => {
    ensureWindowDispatchEvent();
    const setGoal = mock(() => Promise.resolve({ success: true, data: {} }));
    const context = createGoalCommandContext({
      providers: { getConfig: mock(() => Promise.resolve({})) },
      workspace: {
        getGoal: mock(() =>
          Promise.resolve({
            goal: {
              goalId: "11111111-1111-4111-8111-111111111111",
              status: "paused",
              budgetCents: 500,
            },
          })
        ),
        setGoal,
        clearGoal: mock(),
      },
    } as unknown as SlashCommandContext["api"]);
    context.sendMessageOptions.model = "custom:unpriced-model";

    const result = await processSlashCommand({ type: "goal-resume" }, context);

    expect(result).toEqual({ clearInput: false, toastShown: true });
    expect(setGoal).not.toHaveBeenCalled();
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message:
          "Current model has no pricing data. Pick a priced model, use -b 0 with a turn cap, or change goal budget defaults in Settings.",
      })
    );
  });
});

describe("processSlashCommand - goal budgets", () => {
  test("applies configured defaults when budget and turn cap are omitted", async () => {
    ensureWindowDispatchEvent();
    const setGoal = mock().mockResolvedValueOnce({
      success: true,
      data: { goalId: "33333333-3333-4333-8333-333333333333", objective: "new objective" },
    });
    const context = createGoalCommandContext({
      config: {
        getConfig: mock(() =>
          Promise.resolve({
            goalDefaults: {
              defaultBudgetCents: 350,
              defaultTurnCap: 25,
              alwaysRequireExplicitBudget: true,
            },
          })
        ),
      },
      workspace: {
        getGoal: mock(() => Promise.resolve({ goal: null })),
        setGoal,
        clearGoal: mock(),
      },
    } as unknown as SlashCommandContext["api"]);

    await processSlashCommand({ type: "goal-set", objective: "new objective" }, context);

    expect(setGoal).toHaveBeenCalledWith({
      workspaceId: "goal-ws",
      objective: "new objective",
      expectedGoalId: null,
      budgetCents: 350,
      turnCap: 25,
    });
  });

  test("passes parsed multiline goal objectives through to setGoal", async () => {
    ensureWindowDispatchEvent();
    const objective = "Implement PRD\n\nRead first:\n- CONTEXT.md\n- PRD.md";
    const setGoal = mock().mockResolvedValueOnce({
      success: true,
      data: { goalId: "33333333-3333-4333-8333-333333333333", objective },
    });
    const context = createGoalCommandContext({
      config: { getConfig: mock(() => Promise.resolve({})) },
      workspace: {
        getGoal: mock(() => Promise.resolve({ goal: null })),
        setGoal,
        clearGoal: mock(),
      },
    } as unknown as SlashCommandContext["api"]);

    const parsed = parseCommand("/goal Implement PRD\n\nRead first:\n- CONTEXT.md\n- PRD.md");
    if (parsed?.type !== "goal-set") {
      throw new Error("expected multiline /goal to parse as goal-set");
    }

    const result = await processSlashCommand(parsed, context);

    expect(result).toEqual({ clearInput: true, toastShown: false });
    expect(setGoal).toHaveBeenCalledWith({
      workspaceId: "goal-ws",
      objective,
      expectedGoalId: null,
      budgetCents: 200,
      turnCap: null,
    });
    expect(context.setToast).not.toHaveBeenCalled();
    expect(window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mux:openGoalTab" })
    );
  });

  test("passes explicit no-budget and turn cap through to setGoal", async () => {
    ensureWindowDispatchEvent();
    const setGoal = mock().mockResolvedValueOnce({
      success: true,
      data: { goalId: "33333333-3333-4333-8333-333333333333", objective: "new objective" },
    });
    const context = createGoalCommandContext({
      config: { getConfig: mock(() => Promise.resolve({})) },
      workspace: {
        getGoal: mock(() => Promise.resolve({ goal: null })),
        setGoal,
        clearGoal: mock(),
      },
    } as unknown as SlashCommandContext["api"]);

    await processSlashCommand(
      { type: "goal-set", objective: "new objective", budgetCents: null, turnCap: 10 },
      context
    );

    expect(setGoal).toHaveBeenCalledWith({
      workspaceId: "goal-ws",
      objective: "new objective",
      expectedGoalId: null,
      budgetCents: null,
      turnCap: 10,
    });
  });

  test("updates an existing goal budget without applying defaults", async () => {
    ensureWindowDispatchEvent();
    const currentGoal = {
      goalId: "11111111-1111-4111-8111-111111111111",
      objective: "existing objective",
    };
    const setGoal = mock().mockResolvedValueOnce({
      success: true,
      data: { ...currentGoal, budgetCents: 500 },
    });
    const context = createGoalCommandContext({
      config: {
        getConfig: mock(() =>
          Promise.resolve({
            goalDefaults: {
              defaultBudgetCents: 350,
              defaultTurnCap: 25,
              alwaysRequireExplicitBudget: true,
            },
          })
        ),
      },
      workspace: {
        getGoal: mock(() => Promise.resolve({ goal: currentGoal })),
        setGoal,
        clearGoal: mock(),
      },
    } as unknown as SlashCommandContext["api"]);

    await processSlashCommand({ type: "goal-budget", budgetCents: 500 }, context);

    expect(setGoal).toHaveBeenCalledWith({
      workspaceId: "goal-ws",
      budgetCents: 500,
      expectedGoalId: currentGoal.goalId,
    });
  });

  test("passes no-budget budget updates through on unpriced current model", async () => {
    ensureWindowDispatchEvent();
    const currentGoal = {
      goalId: "11111111-1111-4111-8111-111111111111",
      objective: "existing objective",
    };
    const setGoal = mock().mockResolvedValueOnce({
      success: true,
      data: { ...currentGoal, budgetCents: null },
    });
    const context = createGoalCommandContext({
      config: { getConfig: mock(() => Promise.resolve({})) },
      workspace: {
        getGoal: mock(() => Promise.resolve({ goal: currentGoal })),
        setGoal,
        clearGoal: mock(),
      },
    } as unknown as SlashCommandContext["api"]);
    context.sendMessageOptions.model = "custom-provider:no-price-model";

    await processSlashCommand({ type: "goal-budget", budgetCents: null }, context);

    expect(setGoal).toHaveBeenCalledWith({
      workspaceId: "goal-ws",
      budgetCents: null,
      expectedGoalId: currentGoal.goalId,
    });
  });

  test("passes zero-dollar budget updates through on unpriced current model", async () => {
    ensureWindowDispatchEvent();
    const currentGoal = {
      goalId: "11111111-1111-4111-8111-111111111111",
      objective: "existing objective",
    };
    const setGoal = mock().mockResolvedValueOnce({
      success: true,
      data: { ...currentGoal, budgetCents: null },
    });
    const context = createGoalCommandContext({
      config: { getConfig: mock(() => Promise.resolve({})) },
      workspace: {
        getGoal: mock(() => Promise.resolve({ goal: currentGoal })),
        setGoal,
        clearGoal: mock(),
      },
    } as unknown as SlashCommandContext["api"]);
    context.sendMessageOptions.model = "custom-provider:no-price-model";

    await processSlashCommand({ type: "goal-budget", budgetCents: 0 }, context);

    expect(setGoal).toHaveBeenCalledWith({
      workspaceId: "goal-ws",
      budgetCents: 0,
      expectedGoalId: currentGoal.goalId,
    });
  });

  test("refuses budgeted goals on an unpriced current model", async () => {
    ensureWindowDispatchEvent();
    const setGoal = mock();
    const context = createGoalCommandContext({
      config: { getConfig: mock(() => Promise.resolve({})) },
      workspace: {
        getGoal: mock(() => Promise.resolve({ goal: null })),
        setGoal,
        clearGoal: mock(),
      },
    } as unknown as SlashCommandContext["api"]);
    context.sendMessageOptions.model = "custom-provider:no-price-model";

    const result = await processSlashCommand(
      { type: "goal-set", objective: "new objective", budgetCents: 500 },
      context
    );

    expect(result).toEqual({ clearInput: false, toastShown: true });
    expect(setGoal).not.toHaveBeenCalled();
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message:
          "Current model has no pricing data. Pick a priced model, use -b 0 with a turn cap, or change goal budget defaults in Settings.",
      })
    );
  });
});

describe("processSlashCommand - heartbeat-set", () => {
  const HEARTBEAT_EXPERIMENT_KEY = getExperimentKey(EXPERIMENT_IDS.WORKSPACE_HEARTBEATS);

  function setHeartbeatExperiment(enabled: boolean) {
    globalThis.localStorage.setItem(HEARTBEAT_EXPERIMENT_KEY, JSON.stringify(enabled));
  }

  const createSlashCommandContext = (options?: {
    api?: SlashCommandContext["api"] | null;
    workspaceId?: string;
    variant?: SlashCommandContext["variant"];
  }): SlashCommandContext => {
    const setInput = mock(() => undefined);
    const setToast = mock(() => undefined);

    return {
      api: options?.api ?? null,
      workspaceId:
        options && Object.hasOwn(options, "workspaceId") ? options.workspaceId : "test-ws",
      variant: options?.variant ?? "workspace",
      projectPath: "/tmp/project",
      setPreferredModel: mock(() => undefined),
      setVimEnabled: mock((cb: (prev: boolean) => boolean) => cb(false)),
      resetInputHeight: mock(() => undefined),
      onTruncateHistory: mock(() => Promise.resolve(undefined)),
      onMessageSent: mock(() => undefined),
      onCheckReviews: mock(() => undefined),
      attachedReviewIds: [],
      openSettings: mock(() => undefined),
      sendMessageOptions: {
        model: "anthropic:claude-sonnet-4-6",
        thinkingLevel: "off",
        toolPolicy: [],
        agentId: "exec",
      },
      setInput,
      setToast,
      setAttachments: mock(() => undefined),
      setSendingState: mock(() => undefined),
    };
  };

  test("shows an error toast when the heartbeat experiment is disabled", async () => {
    const heartbeatSet = mock(() => Promise.resolve({ success: true, data: undefined }));
    const context = createSlashCommandContext({
      api: {
        workspace: {
          heartbeat: {
            set: heartbeatSet,
          },
        },
      } as unknown as SlashCommandContext["api"],
    });

    setHeartbeatExperiment(false);

    const result = await processSlashCommand({ type: "heartbeat-set", minutes: 30 }, context);

    expect(result).toEqual({ clearInput: false, toastShown: true });
    expect(heartbeatSet).not.toHaveBeenCalled();
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message:
          "Heartbeat configuration requires the Workspace Heartbeats experiment to be enabled",
      })
    );
  });

  test("shows an error toast when no workspace is selected", async () => {
    const heartbeatSet = mock(() => Promise.resolve({ success: true, data: undefined }));
    const context = createSlashCommandContext({
      api: {
        workspace: {
          heartbeat: {
            set: heartbeatSet,
          },
        },
      } as unknown as SlashCommandContext["api"],
      workspaceId: undefined,
    });

    setHeartbeatExperiment(true);

    const result = await processSlashCommand({ type: "heartbeat-set", minutes: 30 }, context);

    expect(result).toEqual({ clearInput: false, toastShown: true });
    expect(heartbeatSet).not.toHaveBeenCalled();
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "No workspace selected",
      })
    );
  });

  test("enables workspace heartbeats with the requested interval without clearing the saved message", async () => {
    const heartbeatGet = mock(() =>
      Promise.resolve({
        enabled: true as const,
        intervalMs: 45 * 60 * 1000,
        message: "Review the workspace status before taking action.",
      })
    );
    const heartbeatSet = mock(() => Promise.resolve({ success: true, data: undefined }));
    const context = createSlashCommandContext({
      api: {
        workspace: {
          heartbeat: {
            get: heartbeatGet,
            set: heartbeatSet,
          },
        },
      } as unknown as SlashCommandContext["api"],
      workspaceId: "test-ws",
    });

    setHeartbeatExperiment(true);

    const result = await processSlashCommand({ type: "heartbeat-set", minutes: 30 }, context);

    expect(result).toEqual({ clearInput: true, toastShown: true });
    expect(context.setInput).toHaveBeenCalledWith("");
    expect(heartbeatGet).toHaveBeenCalledWith({ workspaceId: "test-ws" });
    expect(heartbeatSet).toHaveBeenCalledWith({
      workspaceId: "test-ws",
      enabled: true,
      intervalMs: 30 * 60 * 1000,
      message: "Review the workspace status before taking action.",
    });
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        message: "Heartbeat set to every 30 minutes",
      })
    );
  });

  test("still updates the interval when reading current heartbeat settings fails", async () => {
    const heartbeatGet = mock(() => Promise.reject(new Error("Corrupted heartbeat settings")));
    const heartbeatSet = mock(() => Promise.resolve({ success: true, data: undefined }));
    const context = createSlashCommandContext({
      api: {
        workspace: {
          heartbeat: {
            get: heartbeatGet,
            set: heartbeatSet,
          },
        },
      } as unknown as SlashCommandContext["api"],
      workspaceId: "test-ws",
    });

    setHeartbeatExperiment(true);

    const result = await processSlashCommand({ type: "heartbeat-set", minutes: 30 }, context);

    expect(result).toEqual({ clearInput: true, toastShown: true });
    expect(heartbeatGet).toHaveBeenCalledWith({ workspaceId: "test-ws" });
    expect(heartbeatSet).toHaveBeenCalledWith({
      workspaceId: "test-ws",
      enabled: true,
      intervalMs: 30 * 60 * 1000,
    });
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        message: "Heartbeat set to every 30 minutes",
      })
    );
  });

  test("preserves the configured interval and message when disabling workspace heartbeats", async () => {
    const heartbeatGet = mock(() =>
      Promise.resolve({
        enabled: true as const,
        intervalMs: 45 * 60 * 1000,
        message: "Review the workspace status before taking action.",
      })
    );
    const heartbeatSet = mock(() => Promise.resolve({ success: true, data: undefined }));
    const context = createSlashCommandContext({
      api: {
        workspace: {
          heartbeat: {
            get: heartbeatGet,
            set: heartbeatSet,
          },
        },
      } as unknown as SlashCommandContext["api"],
      workspaceId: "test-ws",
    });

    setHeartbeatExperiment(true);

    const result = await processSlashCommand({ type: "heartbeat-set", minutes: null }, context);

    expect(result).toEqual({ clearInput: true, toastShown: true });
    expect(heartbeatGet).toHaveBeenCalledWith({ workspaceId: "test-ws" });
    expect(heartbeatSet).toHaveBeenCalledWith({
      workspaceId: "test-ws",
      enabled: false,
      intervalMs: 45 * 60 * 1000,
      message: "Review the workspace status before taking action.",
    });
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        message: "Heartbeat disabled",
      })
    );
  });

  test("uses the default interval when disabling heartbeats without saved settings", async () => {
    const heartbeatGet = mock(() => Promise.resolve(null));
    const heartbeatSet = mock(() => Promise.resolve({ success: true, data: undefined }));
    const context = createSlashCommandContext({
      api: {
        workspace: {
          heartbeat: {
            get: heartbeatGet,
            set: heartbeatSet,
          },
        },
      } as unknown as SlashCommandContext["api"],
      workspaceId: "test-ws",
    });

    setHeartbeatExperiment(true);

    const result = await processSlashCommand({ type: "heartbeat-set", minutes: null }, context);

    expect(result).toEqual({ clearInput: true, toastShown: true });
    expect(heartbeatGet).toHaveBeenCalledWith({ workspaceId: "test-ws" });
    expect(heartbeatSet).toHaveBeenCalledWith({
      workspaceId: "test-ws",
      enabled: false,
      intervalMs: HEARTBEAT_DEFAULT_INTERVAL_MS,
    });
  });

  test("surfaces backend heartbeat update failures", async () => {
    const heartbeatGet = mock(() =>
      Promise.resolve({
        enabled: true as const,
        intervalMs: 45 * 60 * 1000,
        message: "Review the workspace status before taking action.",
      })
    );
    const heartbeatSet = mock(() =>
      Promise.resolve({ success: false as const, error: "Heartbeat update failed" })
    );
    const context = createSlashCommandContext({
      api: {
        workspace: {
          heartbeat: {
            get: heartbeatGet,
            set: heartbeatSet,
          },
        },
      } as unknown as SlashCommandContext["api"],
      workspaceId: "test-ws",
    });

    setHeartbeatExperiment(true);

    const result = await processSlashCommand({ type: "heartbeat-set", minutes: 30 }, context);

    expect(result).toEqual({ clearInput: false, toastShown: true });
    expect(heartbeatSet).toHaveBeenCalledWith({
      workspaceId: "test-ws",
      enabled: true,
      intervalMs: 30 * 60 * 1000,
      message: "Review the workspace status before taking action.",
    });
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "Heartbeat update failed",
      })
    );
  });
});

describe("prepareCompactionMessage", () => {
  const createBaseOptions = (): SendMessageOptions => ({
    model: "anthropic:claude-sonnet-4-6",
    thinkingLevel: "medium",
    toolPolicy: [],
    agentId: "exec",
  });

  function expectCompactionMetadata(
    metadata: ReturnType<typeof prepareCompactionMessage>["metadata"]
  ): asserts metadata is Extract<
    ReturnType<typeof prepareCompactionMessage>["metadata"],
    { type: "compaction-request" }
  > {
    expect(metadata.type).toBe("compaction-request");
    if (metadata.type !== "compaction-request") {
      throw new Error("Expected compaction metadata");
    }
  }

  test("builds followUpContent from input", () => {
    const sendMessageOptions = createBaseOptions();

    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      maxOutputTokens: 4096,
      followUpContent: { text: "Keep building" },
      model: "anthropic:claude-3-5-haiku",
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    // followUpContent includes model/agentId from sendMessageOptions (captured for follow-up)
    expect(metadata.parsed.followUpContent?.text).toBe("Keep building");
    expect(metadata.parsed.followUpContent?.model).toBe("anthropic:claude-sonnet-4-6");
    expect(metadata.parsed.followUpContent?.agentId).toBe("exec");
  });

  test("compaction recovery keeps the persisted follow-up's restrictions when retry options lack them", () => {
    // Retrying a failed compaction passes the already-persisted follow-up together with
    // storage-derived send options, which never carry a caller toolPolicy. The preserved
    // restrictions must survive that recomposition or the recovered follow-up resumes with
    // unrestricted caller tools.
    const recoveredFollowUp = {
      text: "Keep building",
      model: "openai:gpt-4o",
      agentId: "code",
      toolPolicy: [{ regex_match: "^bash$", action: "disable" as const }],
      disableWorkspaceAgents: true,
    };
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: recoveredFollowUp,
      sendMessageOptions: { model: "anthropic:claude-sonnet-4-6", agentId: "exec" },
    });

    expectCompactionMetadata(metadata);
    expect(metadata.parsed.followUpContent?.toolPolicy).toEqual(recoveredFollowUp.toolPolicy);
    expect(metadata.parsed.followUpContent?.disableWorkspaceAgents).toBe(true);
    // Existing model/agentId still win over the retry-time options.
    expect(metadata.parsed.followUpContent?.model).toBe("openai:gpt-4o");
    expect(metadata.parsed.followUpContent?.agentId).toBe("code");
  });

  test("does not create followUpContent when no text or images provided", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      maxOutputTokens: 4096,
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    expect(metadata.parsed.followUpContent).toBeUndefined();
  });

  test("captures model/agentId from sendMessageOptions for follow-up", () => {
    // Use different model/agentId than base options to verify they're captured
    const sendMessageOptions: SendMessageOptions = {
      model: "openai:gpt-4o",
      thinkingLevel: "medium",
      toolPolicy: [],
      agentId: "code",
    };

    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: { text: "Continue" },
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    // Follow-up should use the user's original model/agentId
    expect(metadata.parsed.followUpContent?.model).toBe("openai:gpt-4o");
    expect(metadata.parsed.followUpContent?.agentId).toBe("code");
  });

  test("uses agentId from sendMessageOptions in followUpContent", () => {
    const sendMessageOptions: SendMessageOptions = {
      model: "openai:gpt-4o",
      thinkingLevel: "medium",
      toolPolicy: [],
      agentId: "exec",
    };

    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: { text: "Continue" },
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    expect(metadata.parsed.followUpContent?.agentId).toBe("exec");
  });

  test("creates followUpContent when text is provided", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: { text: "Continue with this" },
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    expect(metadata.parsed.followUpContent).toBeDefined();
    expect(metadata.parsed.followUpContent?.text).toBe("Continue with this");
  });

  test("rawCommand includes multiline continue payload", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      maxOutputTokens: 2048,
      model: "anthropic:claude-3-5-haiku",
      followUpContent: { text: "Line 1\nLine 2" },
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    expect(metadata.rawCommand).toBe(
      "/compact -t 2048 -m anthropic:claude-3-5-haiku\nLine 1\nLine 2"
    );
  });

  test("omits default resume text from compaction prompt", () => {
    const sendMessageOptions = createBaseOptions();
    const { messageText, metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: { text: "Continue" },
      sendMessageOptions,
    });

    expect(messageText).not.toContain("The user wants to continue with: Continue");

    expectCompactionMetadata(metadata);

    // Still queued for auto-send after compaction
    expect(metadata.parsed.followUpContent?.text).toBe("Continue");
  });

  test("includes non-default continue text in compaction prompt", () => {
    const sendMessageOptions = createBaseOptions();
    const { messageText } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: { text: "fix tests" },
      sendMessageOptions,
    });

    expect(messageText).toContain("The user wants to continue with: fix tests");
  });

  test("creates followUpContent when images are provided without text", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: {
        text: "",
        fileParts: [{ url: "data:image/png;base64,abc", mediaType: "image/png" }],
      },
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    expect(metadata.parsed.followUpContent).toBeDefined();
    expect(metadata.parsed.followUpContent?.fileParts).toHaveLength(1);
  });

  test("creates followUpContent when reviews are provided without text", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: {
        text: "",
        reviews: [
          {
            filePath: "src/test.ts",
            lineRange: "10-15",
            selectedCode: "const x = 1;",
            userNote: "Please fix this",
          },
        ],
      },
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    expect(metadata.parsed.followUpContent).toBeDefined();
    expect(metadata.parsed.followUpContent?.reviews).toHaveLength(1);
    expect(metadata.parsed.followUpContent?.reviews?.[0].userNote).toBe("Please fix this");
  });

  test("creates followUpContent with reviews and text combined", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: {
        text: "Also check the tests",
        reviews: [
          {
            filePath: "src/test.ts",
            lineRange: "10-15",
            selectedCode: "const x = 1;",
            userNote: "Fix this bug",
          },
        ],
      },
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    expect(metadata.parsed.followUpContent).toBeDefined();
    expect(metadata.parsed.followUpContent?.text).toBe("Also check the tests");
    expect(metadata.parsed.followUpContent?.reviews).toHaveLength(1);
  });

  test("builds followUpContent from sourceContent with skill metadata", () => {
    const sendMessageOptions = createBaseOptions();

    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: {
        text: "/tests run all tests",
        muxMetadata: {
          type: "agent-skill",
          rawCommand: "/tests run all tests",
          skillName: "tests",
          scope: "project",
        },
      },
      sendMessageOptions,
    });

    expectCompactionMetadata(metadata);

    // Follow-up content should be built from sourceContent.
    expect(metadata.parsed.followUpContent).toBeDefined();
    expect(metadata.parsed.followUpContent?.text).toBe("/tests run all tests");

    // Skill metadata should be preserved in muxMetadata
    expect(metadata.parsed.followUpContent?.muxMetadata).toEqual({
      type: "agent-skill",
      rawCommand: "/tests run all tests",
      skillName: "tests",
      scope: "project",
    });
  });

  test("does not treat 'Continue' as default resume when reviews are present", () => {
    const sendMessageOptions = createBaseOptions();
    const { messageText, metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      followUpContent: {
        text: "Continue",
        reviews: [
          {
            filePath: "src/test.ts",
            lineRange: "10",
            selectedCode: "x = 1",
            userNote: "Check this",
          },
        ],
      },
      sendMessageOptions,
    });

    // When reviews are present, "Continue" should be included in compaction prompt
    // because there's actual work to continue with (the reviews)
    expect(messageText).toContain("The user wants to continue with: Continue");

    expectCompactionMetadata(metadata);

    expect(metadata.parsed.followUpContent?.reviews).toHaveLength(1);
  });
});

describe("handlePlanShowCommand", () => {
  const createMockContext = (
    getPlanContentResult:
      | { success: true; data: { content: string; path: string } }
      | { success: false; error: string }
  ): CommandHandlerContext => {
    const setInput = mock(() => undefined);
    const setToast = mock(() => undefined);

    return {
      workspaceId: "test-workspace-id",
      setInput,
      setToast,
      api: {
        workspace: {
          getPlanContent: mock(() => Promise.resolve(getPlanContentResult)),
        },
        general: {},
      } as unknown as CommandHandlerContext["api"],
      // Required fields for CommandHandlerContext
      sendMessageOptions: {
        model: "anthropic:claude-sonnet-4-6",
        thinkingLevel: "off",
        toolPolicy: [],
        agentId: "exec",
      },
      setAttachments: mock(() => undefined),
      setSendingState: mock(() => undefined),
    };
  };

  test("shows error toast when no plan exists", async () => {
    const context = createMockContext({ success: false, error: "No plan found" });

    const result = await handlePlanShowCommand(context);

    expect(result.clearInput).toBe(true);
    expect(result.toastShown).toBe(true);
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "No plan found for this workspace",
      })
    );
  });

  test("replaces the previous plan preview instead of stacking another tail row", async () => {
    const workspaceId = "test-workspace-id";
    const store = useWorkspaceStoreRaw();
    store.dispose();
    const metadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "test-workspace",
      title: "Test Workspace",
      projectName: "Project",
      projectPath: "/tmp/project",
      namedWorkspacePath: "/tmp/project/test-workspace",
      runtimeConfig: { type: "local" },
      createdAt: "2026-08-05T00:00:00.000Z",
    };
    workspaceStore.addWorkspace(metadata);

    try {
      await handlePlanShowCommand(
        createMockContext({
          success: true,
          data: { content: "# First plan", path: "/path/to/plan.md" },
        })
      );
      await handlePlanShowCommand(
        createMockContext({
          success: true,
          data: { content: "# Updated plan", path: "/path/to/plan.md" },
        })
      );

      const previews = store
        .getWorkspaceState(workspaceId)
        .messages.filter((message) => message.type === "plan-display");
      expect(previews).toHaveLength(1);
      expect(previews[0]).toMatchObject({ content: "# Updated plan" });
    } finally {
      store.dispose();
    }
  });

  test("clears input when plan is found", async () => {
    const context = createMockContext({
      success: true,
      data: { content: "# My Plan\n\nStep 1", path: "/path/to/plan.md" },
    });

    const result = await handlePlanShowCommand(context);

    expect(result.clearInput).toBe(true);
    expect(result.toastShown).toBe(false);
    expect(context.setInput).toHaveBeenCalledWith("");
    expect(context.api.workspace.getPlanContent).toHaveBeenCalledWith({
      workspaceId: "test-workspace-id",
    });
  });
});

describe("handlePlanOpenCommand", () => {
  const createMockContext = (
    getPlanContentResult:
      | { success: true; data: { content: string; path: string } }
      | { success: false; error: string },
    openInEditorResult?: { success: true; data: undefined } | { success: false; error: string }
  ): CommandHandlerContext => {
    const setInput = mock(() => undefined);
    const setToast = mock(() => undefined);

    return {
      workspaceId: "test-workspace-id",
      setInput,
      setToast,
      api: {
        workspace: {
          getPlanContent: mock(() => Promise.resolve(getPlanContentResult)),
          getInfo: mock(() => Promise.resolve(null)),
        },
        general: {
          openInEditor: mock(() =>
            Promise.resolve(openInEditorResult ?? { success: true, data: undefined })
          ),
        },
      } as unknown as CommandHandlerContext["api"],
      // Required fields for CommandHandlerContext
      sendMessageOptions: {
        model: "anthropic:claude-sonnet-4-6",
        thinkingLevel: "off",
        toolPolicy: [],
        agentId: "exec",
      },
      setAttachments: mock(() => undefined),
      setSendingState: mock(() => undefined),
    };
  };

  test("shows error toast when no plan exists", async () => {
    const context = createMockContext({ success: false, error: "No plan found" });

    const result = await handlePlanOpenCommand(context);

    expect(result.clearInput).toBe(true);
    expect(result.toastShown).toBe(true);
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "No plan found for this workspace",
      })
    );
    expect(context.api.workspace.getInfo).not.toHaveBeenCalled();
    // Should not attempt to open editor
    expect(context.api.general.openInEditor).not.toHaveBeenCalled();
  });

  test("opens plan in editor when plan exists", async () => {
    const context = createMockContext(
      { success: true, data: { content: "# My Plan", path: "/path/to/plan.md" } },
      { success: true, data: undefined }
    );

    const result = await handlePlanOpenCommand(context);

    expect(result.clearInput).toBe(true);
    expect(context.setInput).toHaveBeenCalledWith("");
    expect(context.api.workspace.getPlanContent).toHaveBeenCalledWith({
      workspaceId: "test-workspace-id",
    });
    expect(context.api.workspace.getInfo).toHaveBeenCalledWith({
      workspaceId: "test-workspace-id",
    });
    // Note: Built-in editors (VS Code/Cursor/Zed) now use deep links directly
    // via window.open(), not the backend API. The backend API is only used
    // for custom editors.
  });

  // Note: The "editor fails to open" test was removed because built-in editors
  // (VS Code/Cursor/Zed) now use deep links that open via window.open() and
  // always succeed from the app's perspective. Failures happen in the external
  // editor, not in our code path.
});

describe("handleCompactCommand", () => {
  const createMockContext = (
    sendMessageResult: { success: true } | { success: false; error?: string },
    options?: { reviews?: ReviewNoteData[] }
  ): CommandHandlerContext => {
    const setInput = mock(() => undefined);
    const setToast = mock(() => undefined);
    const setAttachments = mock(() => undefined);
    const setSendingState = mock(() => undefined);

    // Track the options passed to sendMessage
    const sendMessageMock = mock(() => Promise.resolve(sendMessageResult));

    return {
      workspaceId: "test-workspace-id",
      setInput,
      setToast,
      setAttachments,
      setSendingState,
      reviews: options?.reviews,
      api: {
        workspace: {
          sendMessage: sendMessageMock,
        },
      } as unknown as CommandHandlerContext["api"],
      sendMessageOptions: {
        model: "anthropic:claude-sonnet-4-6",
        thinkingLevel: "off",
        toolPolicy: [],
        agentId: "exec",
      },
    };
  };

  test("passes reviews to followUpContent when reviews are attached", async () => {
    const reviews: ReviewNoteData[] = [
      {
        filePath: "src/test.ts",
        lineRange: "10-15",
        selectedCode: "const x = 1;",
        userNote: "Please fix this bug",
      },
    ];

    const context = createMockContext({ success: true }, { reviews });

    await handleCompactCommand({ type: "compact" }, context);

    // Verify sendMessage was called with reviews in the metadata
    const sendMessageMock = context.api.workspace.sendMessage as ReturnType<typeof mock>;
    expect(sendMessageMock).toHaveBeenCalled();

    const callArgs = sendMessageMock.mock.calls[0][0] as {
      options?: { muxMetadata?: { parsed?: { followUpContent?: { reviews?: ReviewNoteData[] } } } };
    };
    const followUpContent = callArgs?.options?.muxMetadata?.parsed?.followUpContent;

    expect(followUpContent).toBeDefined();
    expect(followUpContent?.reviews).toHaveLength(1);
    expect(followUpContent?.reviews?.[0].userNote).toBe("Please fix this bug");
  });

  test("creates followUpContent with only reviews (no text)", async () => {
    const reviews: ReviewNoteData[] = [
      {
        filePath: "src/test.ts",
        lineRange: "10",
        selectedCode: "x = 1",
        userNote: "Check this",
      },
    ];

    const context = createMockContext({ success: true }, { reviews });

    // No followUpContent text, just reviews
    await handleCompactCommand({ type: "compact" }, context);

    const sendMessageMock = context.api.workspace.sendMessage as ReturnType<typeof mock>;
    expect(sendMessageMock).toHaveBeenCalled();

    const callArgs = sendMessageMock.mock.calls[0][0] as {
      options?: { muxMetadata?: { parsed?: { followUpContent?: { reviews?: ReviewNoteData[] } } } };
    };
    const followUpContent = callArgs?.options?.muxMetadata?.parsed?.followUpContent;

    // Should have followUpContent even without text, because reviews are present
    expect(followUpContent).toBeDefined();
    expect(followUpContent?.reviews).toHaveLength(1);
  });
});
