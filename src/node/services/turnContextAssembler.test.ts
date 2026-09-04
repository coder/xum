import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { sliceMessagesFromLatestCompactionBoundary } from "@/common/utils/messages/compactionBoundary";
import { createMuxMessage } from "@/common/types/message";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectsConfig } from "@/common/types/project";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import { getPlanFilePath } from "@/common/utils/planStorage";
import { buildWorkflowRunCardMessage } from "@/common/utils/workflowRunMessages";
import { jsonSchema, tool } from "ai";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";

import {
  assemblePromptPayload,
  buildPlanInstructions,
  buildStreamSystemContext,
  prepareProviderRequestMessages,
} from "./turnContextAssembler";

class TestRuntime extends LocalRuntime {
  constructor(
    projectPath: string,
    private readonly xumHomePath: string
  ) {
    super(projectPath);
  }

  override getXumHome(): string {
    return this.xumHomePath;
  }
}

function createWorkspaceMetadata(args: {
  id: string;
  name: string;
  projectName: string;
  projectPath: string;
  parentWorkspaceId?: string;
}): WorkspaceMetadata {
  return {
    id: args.id,
    name: args.name,
    projectName: args.projectName,
    projectPath: args.projectPath,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    parentWorkspaceId: args.parentWorkspaceId,
  };
}

function createProjectsConfig(args: {
  projectPath: string;
  workspaces: Array<{
    id: string;
    name: string;
    parentWorkspaceId?: string;
  }>;
}): ProjectsConfig {
  return {
    projects: new Map([
      [
        args.projectPath,
        {
          trusted: true,
          workspaces: args.workspaces.map((workspace) => ({
            path: path.join(args.projectPath, workspace.name),
            id: workspace.id,
            name: workspace.name,
            createdAt: "2026-01-01T00:00:00.000Z",
            runtimeConfig: DEFAULT_RUNTIME_CONFIG,
            parentWorkspaceId: workspace.parentWorkspaceId,
          })),
        },
      ],
    ]),
  };
}

async function buildSystemContextForTest(args: {
  runtime: TestRuntime;
  metadata: WorkspaceMetadata;
  workspacePath: string;
  cfg: ProjectsConfig;
  isSubagentWorkspace: boolean;
  effectiveAdditionalInstructions?: string;
  planFilePath?: string;
  memoryToolAvailable?: boolean;
}) {
  return buildStreamSystemContext({
    runtime: args.runtime,
    metadata: args.metadata,
    workspacePath: args.workspacePath,
    workspaceId: args.metadata.id,
    agentDefinition: { id: "exec", scope: "built-in" },
    effectiveMode: "exec",
    agentDiscoveryRuntime: args.runtime,
    agentDiscoveryPath: args.workspacePath,
    isSubagentWorkspace: args.isSubagentWorkspace,
    effectiveAdditionalInstructions: args.effectiveAdditionalInstructions,
    planFilePath: args.planFilePath,
    modelString: "openai:gpt-5.2",
    cfg: args.cfg,
    providersConfig: null,
    mcpServers: {},
    memoryToolAvailable: args.memoryToolAvailable,
  });
}

describe("prepareProviderRequestMessages", () => {
  test("slices at reset boundaries before filtering empty assistant messages", () => {
    const oldMessage = createMuxMessage("old-user", "user", "old context", {
      historySequence: 1,
    });
    const resetBoundary = createMuxMessage("reset-boundary", "assistant", "", {
      historySequence: 2,
      contextBoundaryKind: CONTEXT_BOUNDARY_KINDS.RESET,
    });
    const newMessage = createMuxMessage("new-user", "user", "new context", {
      historySequence: 3,
    });

    const result = prepareProviderRequestMessages(
      [oldMessage, resetBoundary, newMessage],
      "openai",
      "off"
    );

    expect(result.activeContextMessages.map((message) => message.id)).toEqual(["new-user"]);
    expect(result.providerRequestMessages.map((message) => message.id)).toEqual(["new-user"]);
  });

  test("filters workflow display rows while keeping provider-visible workflow results", () => {
    const trigger = createMuxMessage("workflow-command", "user", "/shallow-review mux", {
      historySequence: 1,
      muxMetadata: {
        type: "workflow-trigger-display",
        rawCommand: "/shallow-review mux",
        commandPrefix: "/shallow-review",
        runId: "wfr_1",
      },
    });
    const card = buildWorkflowRunCardMessage(
      { name: "shallow-review", args: { input: "mux" } },
      { runId: "wfr_1", status: "running", result: null },
      2
    );
    card.metadata = {
      historySequence: 2,
      synthetic: true,
      uiVisible: true,
      muxMetadata: { type: "workflow-run-card-display", runId: "wfr_1" },
    };
    const result = createMuxMessage(
      "workflow-result",
      "user",
      "/shallow-review mux\n\n<mux_workflow_result>{}</mux_workflow_result>",
      {
        historySequence: 3,
        muxMetadata: {
          type: "workflow-result",
          rawCommand: "/shallow-review mux",
          commandPrefix: "/shallow-review",
          runId: "wfr_1",
        },
      }
    );
    const nextUser = createMuxMessage("next-user", "user", "continue normal work", {
      historySequence: 4,
    });

    const prepared = prepareProviderRequestMessages(
      [trigger, card, result, nextUser],
      "openai",
      "off"
    );

    expect(prepared.activeContextMessages.map((message) => message.id)).toEqual([
      "workflow-result",
      "next-user",
    ]);
    expect(prepared.providerRequestMessages.map((message) => message.id)).toEqual([
      "workflow-result",
      "next-user",
    ]);
  });

  test("excludes the stamped keep-recent tail from RLM compaction summarization requests", () => {
    const head = createMuxMessage("head-user", "user", "old context", { historySequence: 1 });
    const headReply = createMuxMessage("head-assistant", "assistant", "old reply", {
      historySequence: 2,
    });
    const tail = createMuxMessage("tail-user", "user", "recent context", { historySequence: 3 });
    const tailReply = createMuxMessage("tail-assistant", "assistant", "recent reply", {
      historySequence: 4,
    });
    const stampedRequest = createMuxMessage("compact-req", "user", "/compact", {
      historySequence: 5,
      muxMetadata: {
        type: "compaction-request",
        rawCommand: "/compact",
        parsed: {},
        keepRecentTail: { startHistorySequence: 3 },
      },
    });

    const prepared = prepareProviderRequestMessages(
      [head, headReply, tail, tailReply, stampedRequest],
      "openai",
      "off"
    );

    expect(prepared.providerRequestMessages.map((message) => message.id)).toEqual([
      "head-user",
      "head-assistant",
      "compact-req",
    ]);
  });

  test("keeps whole-epoch summarization for unstamped compaction requests (RLM off)", () => {
    const head = createMuxMessage("head-user", "user", "old context", { historySequence: 1 });
    const tail = createMuxMessage("tail-user", "user", "recent context", { historySequence: 2 });
    const request = createMuxMessage("compact-req", "user", "/compact", {
      historySequence: 3,
      muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
    });

    const prepared = prepareProviderRequestMessages([head, tail, request], "openai", "off");

    expect(prepared.providerRequestMessages.map((message) => message.id)).toEqual([
      "head-user",
      "tail-user",
      "compact-req",
    ]);
  });
});

describe("assemblePromptPayload", () => {
  const createTools = () => ({
    first: tool({
      description: "first",
      inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
      execute: () => Promise.resolve({ ok: true }),
    }),
    terminal: tool({
      description: "terminal",
      inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
      execute: () => Promise.resolve({ ok: true }),
    }),
  });

  const assemble = (overrides: Partial<Parameters<typeof assemblePromptPayload>[0]> = {}) =>
    assemblePromptPayload({
      history: [createMuxMessage("user", "user", "hello")],
      systemMessage: "system",
      tools: createTools(),
      modelString: "google:gemini-2.5-pro",
      providerForMessages: "google",
      effectiveThinkingLevel: "off",
      effectiveAgentId: "exec",
      toolNamesForSentinel: ["first", "terminal"],
      workspaceId: "workspace",
      ...overrides,
    });

  for (const testCase of [
    {
      name: "folds Anthropic system and caches the terminal tool",
      modelString: "anthropic:claude-sonnet-4-5",
      providerForMessages: "anthropic",
      expectedSystem: "folded",
    },
    {
      name: "uses an explicit system breakpoint for eligible OpenAI requests",
      modelString: "openai:gpt-5.6-luna",
      providerForMessages: "openai",
      routeProvider: "openai",
      providersConfig: { openai: { apiKeySet: true, isEnabled: true, isConfigured: true } },
      expectedSystem: "structured",
    },
    {
      name: "keeps plain system instructions for providers without explicit caching",
      modelString: "google:gemini-2.5-pro",
      providerForMessages: "google",
      expectedSystem: "plain",
    },
  ] as const) {
    test(testCase.name, async () => {
      const payload = await assemble({ ...testCase, anthropicCacheTtl: "1h" });

      if (testCase.expectedSystem === "folded") {
        expect(payload.system).toBeUndefined();
        expect(payload.messages[0]?.role).toBe("system");
        expect(payload.tools?.terminal.providerOptions).toEqual({
          anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
        });
        expect(payload.tools?.first.providerOptions).toBeUndefined();
      } else if (testCase.expectedSystem === "structured") {
        expect(payload.system).toEqual({
          role: "system",
          content: "system",
          providerOptions: { openai: { promptCacheBreakpoint: { mode: "explicit" } } },
        });
      } else {
        expect(payload.system).toBe("system");
      }
    });
  }

  test("injects an interrupted sentinel only when a partial assistant remains terminal", async () => {
    const partial = createMuxMessage("partial", "assistant", "working", { partial: true });
    const withoutFollowingUser = await assemble({
      history: [createMuxMessage("user", "user", "hello"), partial],
    });
    const withFollowingUser = await assemble({
      history: [
        createMuxMessage("user", "user", "hello"),
        partial,
        createMuxMessage("follow-up", "user", "continue"),
      ],
    });

    expect(withoutFollowingUser.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(withFollowingUser.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(JSON.stringify(withoutFollowingUser.messages.at(-1))).not.toContain("continue");
    expect(JSON.stringify(withFollowingUser.messages.at(-1))).toContain("continue");
  });

  test("places plan transition context before the final user request", async () => {
    const payload = await assemble({
      history: [
        createMuxMessage("planned", "assistant", "plan ready", { agentId: "plan" }),
        createMuxMessage("execute", "user", "implement it"),
      ],
      planContentForTransition: "approved plan body",
      planFilePath: "/tmp/plan.md",
    });

    expect(payload.messages.map((message) => message.role)).toEqual(["assistant", "user"]);
    expect(JSON.stringify(payload.messages[1])).toContain("approved plan body");
  });
});

describe("buildPlanInstructions", () => {
  test("prepends runtime plan file guidance ahead of caller additional instructions", async () => {
    using tempRoot = new DisposableTempDir("turn-context-assembler");

    const projectPath = path.join(tempRoot.path, "project");
    const xumHome = path.join(tempRoot.path, "mux-home");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(xumHome, { recursive: true });

    const metadata: WorkspaceMetadata = {
      id: "ws-1",
      name: "workspace-1",
      projectName: "project-1",
      projectPath,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const runtime = new TestRuntime(projectPath, xumHome);
    const requestPayloadMessages = [createMuxMessage("u1", "user", "plan the fix")];
    const callerInstructions = "Caller-specific plan note";

    const expectedPlanFilePath = getPlanFilePath(metadata.name, metadata.projectName, xumHome);

    const result = await buildPlanInstructions({
      runtime,
      metadata,
      workspaceId: metadata.id,
      workspacePath: projectPath,
      effectiveMode: "plan",
      effectiveAgentId: "plan",
      agentIsPlanLike: true,
      agentDiscoveryRuntime: runtime,
      agentDiscoveryPath: projectPath,
      additionalSystemInstructions: callerInstructions,
      shouldDisableTaskToolsForDepth: false,
      taskDepth: 0,
      taskSettings: DEFAULT_TASK_SETTINGS,
      requestPayloadMessages,
    });

    expect(result.effectiveAdditionalInstructions).toContain(
      `Plan file path: ${expectedPlanFilePath}`
    );
    expect(result.effectiveAdditionalInstructions).toContain(callerInstructions);
    expect(result.effectiveAdditionalInstructions).toContain("propose_plan");
    expect(
      result.effectiveAdditionalInstructions?.indexOf(`Plan file path: ${expectedPlanFilePath}`)
    ).toBeLessThan(
      result.effectiveAdditionalInstructions?.indexOf(callerInstructions) ??
        Number.POSITIVE_INFINITY
    );
  });

  test("uses request payload history for Start Here detection", async () => {
    using tempRoot = new DisposableTempDir("turn-context-assembler");

    const projectPath = path.join(tempRoot.path, "project");
    const xumHome = path.join(tempRoot.path, "mux-home");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(xumHome, { recursive: true });

    const metadata: WorkspaceMetadata = {
      id: "ws-1",
      name: "workspace-1",
      projectName: "project-1",
      projectPath,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const runtime = new TestRuntime(projectPath, xumHome);

    const planFilePath = getPlanFilePath(metadata.name, metadata.projectName, xumHome);
    await fs.mkdir(path.dirname(planFilePath), { recursive: true });
    await fs.writeFile(planFilePath, "# Plan\n\n- Keep implementing", "utf-8");

    const startHereSummary = createMuxMessage(
      "start-here",
      "assistant",
      "# Start Here\n\n- Existing plan context\n\n*Plan file preserved at:* /tmp/plan.md",
      {
        compacted: "user",
        agentId: "plan",
      }
    );

    const compactionBoundary = createMuxMessage("boundary", "assistant", "Compacted summary", {
      compacted: "user",
      compactionBoundary: true,
      compactionEpoch: 1,
    });

    const latestUserMessage = createMuxMessage("u1", "user", "continue implementation");

    const fullHistory = [startHereSummary, compactionBoundary, latestUserMessage];
    const requestPayloadMessages = sliceMessagesFromLatestCompactionBoundary(fullHistory);

    expect(requestPayloadMessages.map((message) => message.id)).toEqual(["boundary", "u1"]);

    const fromSlicedPayload = await buildPlanInstructions({
      runtime,
      metadata,
      workspaceId: metadata.id,
      workspacePath: projectPath,
      effectiveMode: "exec",
      effectiveAgentId: "exec",
      agentIsPlanLike: false,
      agentDiscoveryRuntime: runtime,
      agentDiscoveryPath: projectPath,
      additionalSystemInstructions: undefined,
      shouldDisableTaskToolsForDepth: false,
      taskDepth: 0,
      taskSettings: DEFAULT_TASK_SETTINGS,
      requestPayloadMessages,
    });

    const fromFullHistory = await buildPlanInstructions({
      runtime,
      metadata,
      workspaceId: metadata.id,
      workspacePath: projectPath,
      effectiveMode: "exec",
      effectiveAgentId: "exec",
      agentIsPlanLike: false,
      agentDiscoveryRuntime: runtime,
      agentDiscoveryPath: projectPath,
      additionalSystemInstructions: undefined,
      shouldDisableTaskToolsForDepth: false,
      taskDepth: 0,
      taskSettings: DEFAULT_TASK_SETTINGS,
      requestPayloadMessages: fullHistory,
    });

    expect(fromSlicedPayload.effectiveAdditionalInstructions).toContain(
      `A plan file exists at: ${fromSlicedPayload.planFilePath}`
    );
    expect(fromFullHistory.effectiveAdditionalInstructions).toBeUndefined();
  });
});

class RestrictedTestRuntime extends TestRuntime {
  constructor(
    projectPath: string,
    xumHomePath: string,
    private readonly readableRoot: string
  ) {
    super(projectPath, xumHomePath);
  }

  override readFile(filePath: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
    const root = path.resolve(this.readableRoot);
    const target = path.resolve(filePath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`RestrictedTestRuntime cannot read outside ${root}: ${target}`);
    }
    return super.readFile(filePath, abortSignal);
  }
}

describe("buildStreamSystemContext", () => {
  test("includes proactive memory guidance only when the memory tool is available", async () => {
    using tempRoot = new DisposableTempDir("stream-system-context-memory-guidance");

    const projectPath = path.join(tempRoot.path, "project");
    const xumHome = path.join(tempRoot.path, "mux-home");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(xumHome, { recursive: true });

    const metadata = createWorkspaceMetadata({
      id: "memory-guidance-ws",
      name: "memory-guidance-workspace",
      projectName: "project",
      projectPath,
    });
    const cfg = createProjectsConfig({
      projectPath,
      workspaces: [{ id: metadata.id, name: metadata.name }],
    });
    const buildArgs = {
      runtime: new TestRuntime(projectPath, xumHome),
      metadata,
      workspacePath: projectPath,
      cfg,
      isSubagentWorkspace: false,
    };

    const withMemory = await buildSystemContextForTest({
      ...buildArgs,
      memoryToolAvailable: true,
    });
    expect(withMemory.systemMessage).toContain("<memory-tool-guidance>");

    // Guidance must stay in lockstep with tool availability: a prompt must
    // not steer the agent toward a tool the toolset does not have.
    const withoutMemory = await buildSystemContextForTest(buildArgs);
    expect(withoutMemory.systemMessage).not.toContain("<memory-tool-guidance>");
  });

  test("uses the resolved agent discovery runtime for parent-only subagent prompts", async () => {
    using tempRoot = new DisposableTempDir("stream-system-context-parent-runtime");

    const projectPath = path.join(tempRoot.path, "project");
    const parentPath = path.join(projectPath, "parent");
    const childPath = path.join(projectPath, "child");
    const xumHome = path.join(tempRoot.path, "mux-home");
    const customAgentId = "parent-only-reviewer";
    await fs.mkdir(path.join(parentPath, ".mux", "agents"), { recursive: true });
    await fs.mkdir(childPath, { recursive: true });
    await fs.mkdir(xumHome, { recursive: true });
    await fs.writeFile(
      path.join(parentPath, ".mux", "agents", `${customAgentId}.md`),
      [
        "---",
        "name: Parent Only Reviewer",
        "subagent:",
        "  runnable: true",
        "---",
        "Parent-only reviewer prompt body.",
        "",
      ].join("\n")
    );

    const metadata = createWorkspaceMetadata({
      id: "child-ws",
      name: "child-workspace",
      projectName: "project",
      projectPath,
      parentWorkspaceId: "parent-ws",
    });
    const cfg = createProjectsConfig({
      projectPath,
      workspaces: [
        { id: "parent-ws", name: "parent-workspace" },
        { id: metadata.id, name: metadata.name, parentWorkspaceId: metadata.parentWorkspaceId },
      ],
    });

    const result = await buildStreamSystemContext({
      runtime: new RestrictedTestRuntime(childPath, xumHome, childPath),
      metadata,
      workspacePath: childPath,
      workspaceId: metadata.id,
      agentDefinition: { id: customAgentId, scope: "project" },
      effectiveMode: "exec",
      agentDiscoveryRuntime: new RestrictedTestRuntime(parentPath, xumHome, parentPath),
      agentDiscoveryPath: parentPath,
      isSubagentWorkspace: true,
      effectiveAdditionalInstructions: undefined,
      modelString: "openai:gpt-5.2",
      cfg,
      providersConfig: null,
      mcpServers: {},
    });

    expect(result.agentSystemPromptSections.join("\n\n")).toContain(
      "Parent-only reviewer prompt body."
    );
  });

  const ancestorPlanCases: Array<{
    name: string;
    parentWorkspaceId?: string;
    otherWorkspaces: Array<{ id: string; name: string; parentWorkspaceId?: string }>;
    isSubagentWorkspace?: boolean;
    note?: string;
    activePlanFrom?: string;
    expectedAncestors: string[];
  }> = [
    {
      name: "includes the direct parent plan path ahead of caller instructions",
      parentWorkspaceId: "parent-ws",
      otherWorkspaces: [{ id: "parent-ws", name: "parent-workspace" }],
      note: "Caller-specific note",
      expectedAncestors: ["parent-workspace"],
    },
    {
      name: "lists nested ancestor plan paths in nearest-parent-first order",
      parentWorkspaceId: "child-ws",
      otherWorkspaces: [
        { id: "parent-ws", name: "parent-workspace" },
        { id: "child-ws", name: "child-workspace", parentWorkspaceId: "parent-ws" },
      ],
      expectedAncestors: ["child-workspace", "parent-workspace"],
    },
    {
      name: "omits ancestor plan paths for top-level workspaces",
      otherWorkspaces: [],
      isSubagentWorkspace: false,
      note: "Top-level note",
      expectedAncestors: [],
    },
    {
      name: "omits the ancestor section when the parent metadata is missing",
      parentWorkspaceId: "missing-parent-ws",
      otherWorkspaces: [],
      note: "Existing note",
      expectedAncestors: [],
    },
    {
      name: "dedupes ancestor plan paths that are already covered by the active plan file",
      parentWorkspaceId: "parent-ws",
      otherWorkspaces: [{ id: "parent-ws", name: "parent-workspace" }],
      activePlanFrom: "parent-workspace",
      expectedAncestors: [],
    },
    {
      name: "truncates cyclic ancestry without crashing",
      parentWorkspaceId: "parent-ws",
      otherWorkspaces: [
        { id: "parent-ws", name: "parent-workspace", parentWorkspaceId: "self-ws" },
      ],
      expectedAncestors: ["parent-workspace"],
    },
  ];

  for (const testCase of ancestorPlanCases) {
    test(testCase.name, async () => {
      using tempRoot = new DisposableTempDir("stream-system-context");

      const projectPath = path.join(tempRoot.path, "project");
      const xumHome = path.join(tempRoot.path, "mux-home");
      await fs.mkdir(projectPath, { recursive: true });
      await fs.mkdir(xumHome, { recursive: true });

      const metadata = createWorkspaceMetadata({
        id: "self-ws",
        name: "self-workspace",
        projectName: "project",
        projectPath,
        ...(testCase.parentWorkspaceId != null
          ? { parentWorkspaceId: testCase.parentWorkspaceId }
          : {}),
      });
      const cfg = createProjectsConfig({
        projectPath,
        workspaces: [
          ...testCase.otherWorkspaces,
          {
            id: metadata.id,
            name: metadata.name,
            ...(testCase.parentWorkspaceId != null
              ? { parentWorkspaceId: testCase.parentWorkspaceId }
              : {}),
          },
        ],
      });

      const activePlanPath =
        testCase.activePlanFrom != null
          ? getPlanFilePath(testCase.activePlanFrom, "project", xumHome)
          : undefined;
      const result = await buildSystemContextForTest({
        runtime: new TestRuntime(projectPath, xumHome),
        metadata,
        workspacePath: projectPath,
        cfg,
        isSubagentWorkspace: testCase.isSubagentWorkspace ?? true,
        ...(testCase.note != null ? { effectiveAdditionalInstructions: testCase.note } : {}),
        ...(activePlanPath != null ? { planFilePath: activePlanPath } : {}),
      });

      const expectedPaths = testCase.expectedAncestors.map((name) =>
        getPlanFilePath(name, "project", xumHome)
      );
      expect(result.ancestorPlanFilePaths).toEqual(expectedPaths);
      // The workspace's own plan must never list as its ancestor (covers cycles).
      expect(result.systemMessage).not.toContain(`- ${metadata.name}:`);
      if (expectedPaths.length === 0) {
        expect(result.systemMessage).not.toContain(
          "Ancestor plan file paths (nearest parent first):"
        );
        if (activePlanPath != null) {
          expect(result.systemMessage).not.toContain(activePlanPath);
        }
      } else {
        expect(result.systemMessage).toContain("Ancestor plan file paths (nearest parent first):");
        expect(result.systemMessage).toContain(
          "If useful for broader context, you may read these ancestor/parent plan files:"
        );
        const indices = testCase.expectedAncestors.map((name, i) => {
          const line = `- ${name}: ${expectedPaths[i]}`;
          expect(result.systemMessage).toContain(line);
          return result.systemMessage.indexOf(line);
        });
        expect([...indices].sort((a, b) => a - b)).toEqual(indices);
      }
      if (testCase.note != null) {
        expect(result.systemMessage).toContain(testCase.note);
        if (expectedPaths.length > 0) {
          expect(result.systemMessage.indexOf(expectedPaths[0])).toBeLessThan(
            result.systemMessage.indexOf(testCase.note)
          );
        }
      }
    });
  }
});
