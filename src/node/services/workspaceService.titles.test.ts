import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from "bun:test";
import type { WorkspaceService } from "./workspaceService";
import { NAME_GEN_PREFERRED_MODELS } from "@/common/constants/nameGeneration";
import { DEFAULT_MODEL } from "@/common/constants/knownModels";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import type { AgentSession } from "./agentSession";
import * as fsPromises from "fs/promises";
import path from "path";
import { Err, Ok, type Result } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { createMuxMessage } from "@/common/types/message";
import * as workspaceTitleGenerator from "./workspaceTitleGenerator";
import {
  createCompactionAdmissionMocks,
  createDeferred,
  createMockAIService,
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";
import { saveWorkspaces } from "./taskService.testHarness";

describe("WorkspaceService pending auto-title", () => {
  let workspaceService: WorkspaceService;
  let harness: WorkspaceServiceHarness;
  let historyService: HistoryService;
  let config: Config;
  let workspaceId: string;
  let projectPath: string;
  let workspacePath: string;
  let fakeSession: {
    isBusy: ReturnType<typeof mock>;
    hasQueuedMessages: ReturnType<typeof mock>;
    hasQueuedOrDispatchingEntry: ReturnType<typeof mock>;
    dropQueuedMessageWithOnlyDedupeKey: ReturnType<typeof mock>;
    queueMessage: ReturnType<typeof mock>;
    sendMessage: ReturnType<typeof mock>;
    resumeStream: ReturnType<typeof mock>;
  };

  beforeEach(async () => {
    workspaceId = "pending-auto-title-workspace";
    harness = await createWorkspaceServiceHarness({
      aiService: createMockAIService({ isStreaming: mock(() => false) }),
    });
    ({ config, historyService, service: workspaceService } = harness);
    // sendMessage fires its recency write without awaiting it; these tests assert titles,
    // not recency, so keep that write off disk instead of racing harness cleanup.
    spyOn(harness.extensionMetadata, "updateRecency").mockImplementation((_workspaceId, recency) =>
      Promise.resolve({
        recency: recency ?? Date.now(),
        streaming: false,
        lastModel: null,
        lastThinkingLevel: null,
      })
    );

    projectPath = path.join(harness.rootDir, "project");
    workspacePath = path.join(projectPath, "fork-branch");
    await fsPromises.mkdir(projectPath, { recursive: true });
    await config.addWorkspace(projectPath, {
      id: workspaceId,
      name: "fork-branch",
      title: "Parent title (1)",
      pendingAutoTitle: true,
      projectName: "project",
      projectPath,
      createdAt: new Date().toISOString(),
      runtimeConfig: { type: "local" },
      namedWorkspacePath: workspacePath,
    });

    const metadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "fork-branch",
      title: "Parent title (1)",
      pendingAutoTitle: true,
      projectName: "project",
      projectPath,
      createdAt: new Date().toISOString(),
      runtimeConfig: { type: "local" },
      namedWorkspacePath: workspacePath,
    };
    spyOn(harness.aiService, "getWorkspaceMetadata").mockResolvedValue(Ok(metadata));

    fakeSession = {
      ...createCompactionAdmissionMocks(),
      isBusy: mock(() => false),
      hasQueuedMessages: mock(() => false),
      hasQueuedOrDispatchingEntry: mock(() => false),
      dropQueuedMessageWithOnlyDedupeKey: mock(() => false),
      queueMessage: mock(() => "tool-end" as const),
      sendMessage: mock(() => Promise.resolve(Ok(undefined))),
      resumeStream: mock(() => Promise.resolve(Ok({ started: true }))),
    };

    spyOn(workspaceService, "getOrCreateSession").mockReturnValue(
      fakeSession as unknown as AgentSession
    );

    // Keep AI-settings persistence instant: it runs between the concurrent-send test's capture
    // barrier and the auto-title claim, and real disk I/O lets one send finish before the other
    // reaches the claim, so the two sends no longer overlap.
    (
      workspaceService as unknown as {
        maybePersistAISettingsFromOptions: (workspaceId: string, options: unknown) => Promise<void>;
      }
    ).maybePersistAISettingsFromOptions = mock(() => Promise.resolve());
  });

  /** Resolves once the service publishes `title` for this workspace (auto-title completion). */
  function waitForTitleEmission(title: string): Promise<void> {
    const emitted = createDeferred<void>();
    const listener = (event: {
      workspaceId: string;
      metadata: FrontendWorkspaceMetadata | null;
    }) => {
      if (event.workspaceId !== workspaceId || event.metadata?.title !== title) return;
      workspaceService.off("metadata", listener);
      emitted.resolve();
    };
    workspaceService.on("metadata", listener);
    return emitted.promise;
  }

  afterEach(async () => {
    await harness.cleanup();
  });

  test("sendMessage triggers fork auto-title after the first accepted continue message", async () => {
    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockResolvedValue(
      Ok({
        name: "auth-hardening-a1b2",
        title: "Harden auth flow",
        modelUsed: "openai:gpt-4o-mini",
      })
    );
    const titled = waitForTitleEmission("Harden auth flow");

    try {
      const result = await workspaceService.sendMessage(
        workspaceId,
        "Continue with auth hardening",
        { model: "openai:gpt-4o-mini", agentId: "exec" }
      );

      expect(result.success).toBe(true);
      // The auto-title runs detached from the send; its published title is the completion signal.
      await titled;
      expect(generateIdentitySpy).toHaveBeenCalledTimes(1);
      expect(generateIdentitySpy.mock.calls[0]?.[0]).toBe("Continue with auth hardening");
    } finally {
      generateIdentitySpy.mockRestore();
    }
  });

  test("concurrent sends only claim one pending auto-title generation", async () => {
    const releaseSend = createDeferred<Result<void, SendMessageError>>();
    fakeSession.sendMessage.mockImplementation(() => releaseSend.promise);
    const capturesEntered = createDeferred<void>();
    const releaseCaptures = createDeferred<void>();
    const capture = historyService.captureCompactionReplacement.bind(historyService);
    let captures = 0;
    spyOn(historyService, "captureCompactionReplacement").mockImplementation(async (...args) => {
      const result = await capture(...args);
      if (++captures === 2) capturesEntered.resolve();
      await releaseCaptures.promise;
      return result;
    });
    const autoTitleSpy = spyOn(
      workspaceService as unknown as {
        maybeRunPendingAutoTitleFromMessage: (
          workspaceId: string,
          message: string
        ) => Promise<void>;
      },
      "maybeRunPendingAutoTitleFromMessage"
    ).mockResolvedValue(undefined);

    try {
      const firstSend = workspaceService.sendMessage(workspaceId, "First continue message", {
        model: "openai:gpt-4o-mini",
        agentId: "exec",
      });
      const secondSend = workspaceService.sendMessage(workspaceId, "Second continue message", {
        model: "openai:gpt-4o-mini",
        agentId: "exec",
      });

      await capturesEntered.promise;
      releaseCaptures.resolve();
      releaseSend.resolve(Ok(undefined));
      const [firstResult, secondResult] = await Promise.all([firstSend, secondSend]);

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
      expect(autoTitleSpy).toHaveBeenCalledTimes(1);
      expect(autoTitleSpy).toHaveBeenCalledWith(workspaceId, "First continue message");
    } finally {
      autoTitleSpy.mockRestore();
    }
  });

  test("sendMessage only launches one pending auto-title generation at a time", async () => {
    const generationStarted = createDeferred<void>();
    const releaseGeneration = createDeferred<void>();
    const autoTitleSpy = spyOn(
      workspaceService as unknown as {
        maybeRunPendingAutoTitleFromMessage: (
          workspaceId: string,
          message: string
        ) => Promise<void>;
      },
      "maybeRunPendingAutoTitleFromMessage"
    ).mockImplementation(async () => {
      generationStarted.resolve();
      await releaseGeneration.promise;
    });

    try {
      const firstResult = await workspaceService.sendMessage(
        workspaceId,
        "First continue message",
        {
          model: "openai:gpt-4o-mini",
          agentId: "exec",
        }
      );
      expect(firstResult.success).toBe(true);
      await generationStarted.promise;

      const secondResult = await workspaceService.sendMessage(
        workspaceId,
        "Second continue message",
        {
          model: "openai:gpt-4o-mini",
          agentId: "exec",
        }
      );
      expect(secondResult.success).toBe(true);
      expect(autoTitleSpy).toHaveBeenCalledTimes(1);

      releaseGeneration.resolve();
      await Promise.resolve();
    } finally {
      autoTitleSpy.mockRestore();
    }
  });

  test("completing a pending auto-title replaces the fallback title and clears the state", async () => {
    // Fork auto-titles honor the configured naming agent (model + thinking) first.
    await config.editConfig((cfg) => ({
      ...cfg,
      agentAiDefaults: {
        name_workspace: { modelString: "google:gemini-3.8-flash", thinkingLevel: "medium" },
      },
    }));
    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockResolvedValue(
      Ok({
        name: "auth-hardening-a1b2",
        title: "Harden auth flow",
        modelUsed: "openai:gpt-4o-mini",
      })
    );

    try {
      await (
        workspaceService as unknown as {
          maybeRunPendingAutoTitleFromMessage: (
            workspaceId: string,
            message: string
          ) => Promise<void>;
        }
      ).maybeRunPendingAutoTitleFromMessage(workspaceId, "Continue with auth hardening");

      const metadata = (await config.getAllWorkspaceMetadata()).find(
        (entry) => entry.id === workspaceId
      );
      expect(metadata?.title).toBe("Harden auth flow");
      expect(metadata?.pendingAutoTitle).toBeUndefined();
      expect(generateIdentitySpy.mock.calls[0]?.[0]).toBe("Continue with auth hardening");
      expect(generateIdentitySpy.mock.calls[0]?.[1][0]).toEqual({
        model: "google:gemini-3.8-flash",
        thinkingLevel: "medium",
      });
    } finally {
      generateIdentitySpy.mockRestore();
    }
  });

  test("manual title edits cancel an in-flight auto-title before it can overwrite the title", async () => {
    const generationStarted = createDeferred<void>();
    const autoTitleResult =
      createDeferred<
        Awaited<ReturnType<typeof workspaceTitleGenerator.generateWorkspaceIdentity>>
      >();
    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockImplementation((_message, _candidates, _aiService) => {
      generationStarted.resolve();
      return autoTitleResult.promise;
    });

    try {
      const autoTitlePromise = (
        workspaceService as unknown as {
          maybeRunPendingAutoTitleFromMessage: (
            workspaceId: string,
            message: string
          ) => Promise<void>;
        }
      ).maybeRunPendingAutoTitleFromMessage(workspaceId, "Continue with auth hardening");

      await generationStarted.promise;

      const updateTitleResult = await workspaceService.updateTitle(workspaceId, "Manual title");
      expect(updateTitleResult.success).toBe(true);

      autoTitleResult.resolve(
        Ok({
          name: "auth-hardening-a1b2",
          title: "Harden auth flow",
          modelUsed: "openai:gpt-4o-mini",
        })
      );
      await autoTitlePromise;

      const metadata = (await config.getAllWorkspaceMetadata()).find(
        (entry) => entry.id === workspaceId
      );
      expect(metadata?.title).toBe("Manual title");
      expect(metadata?.pendingAutoTitle).toBeUndefined();
    } finally {
      generateIdentitySpy.mockRestore();
    }
  });
});

describe("WorkspaceService naming model candidates", () => {
  const NAMING_DEFAULTS = {
    name_workspace: { modelString: "google:gemini-3.8-flash", thinkingLevel: "medium" as const },
  };

  const harnesses: WorkspaceServiceHarness[] = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
  });

  async function createNamingService(options: {
    agentAiDefaults?: AgentAiDefaults;
    defaultModel?: string;
    minThinkingLevelByModel?: Record<string, ThinkingLevel>;
    metadata?: Partial<FrontendWorkspaceMetadata>;
  }): Promise<WorkspaceService> {
    const metadata = options.metadata
      ? Ok({
          id: "ws-naming",
          name: "ws-naming",
          projectName: "proj",
          projectPath: "/tmp/proj",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" as const },
          ...options.metadata,
        })
      : { success: false as const, error: "workspace metadata unavailable" };
    const harness = await createWorkspaceServiceHarness({
      aiService: createMockAIService({
        getWorkspaceMetadata: mock(() => Promise.resolve(metadata)),
      }),
    });
    harnesses.push(harness);
    await harness.config.editConfig((cfg) => ({
      ...cfg,
      agentAiDefaults: options.agentAiDefaults,
      defaultModel: options.defaultModel,
      minThinkingLevelByModel: options.minThinkingLevelByModel,
    }));
    return harness.service;
  }

  test("configured naming model + thinking leads, hardcoded small models follow", async () => {
    const service = await createNamingService({ agentAiDefaults: NAMING_DEFAULTS });

    const candidates = await service.getWorkspaceNamingCandidates("ws-naming");

    expect(candidates[0]).toEqual({ model: "google:gemini-3.8-flash", thinkingLevel: "medium" });
    expect(candidates.slice(1)).toEqual(NAME_GEN_PREFERRED_MODELS.map((model) => ({ model })));
  });

  test.each(["medium", "off"] as const)(
    "honors thinking-only naming settings with an inherited model (thinking=%s)",
    async (thinkingLevel) => {
      const service = await createNamingService({
        agentAiDefaults: { name_workspace: { thinkingLevel } },
      });

      const candidates = await service.getWorkspaceNamingCandidates(undefined);

      expect(candidates[0]).toEqual({ model: DEFAULT_MODEL, thinkingLevel });
    }
  );

  test("thinking-only naming settings inherit the workspace's active model, not the app default", async () => {
    const service = await createNamingService({
      agentAiDefaults: { name_workspace: { thinkingLevel: "medium" } },
      defaultModel: "openai:gpt-5.6-terra",
      metadata: {
        agentId: "ask",
        aiSettingsByAgent: {
          exec: { model: "openai:gpt-5.4", thinkingLevel: "off" },
          ask: { model: "openai:gpt-5.6-sol", thinkingLevel: "off" },
        },
      },
    });

    const candidates = await service.getWorkspaceNamingCandidates("ws-naming");

    expect(candidates.map((candidate) => candidate.model)).toEqual([
      "openai:gpt-5.6-sol",
      ...NAME_GEN_PREFERRED_MODELS,
      "openai:gpt-5.4",
    ]);
    expect(candidates[0]).toEqual({ model: "openai:gpt-5.6-sol", thinkingLevel: "medium" });
  });

  test("thinking-only naming settings inherit the caller's model for a workspace that does not exist yet", async () => {
    const service = await createNamingService({
      agentAiDefaults: { name_workspace: { thinkingLevel: "medium" } },
      defaultModel: "openai:gpt-5.6-terra",
    });

    const candidates = await service.getWorkspaceNamingCandidates(undefined, [
      "openai:gpt-5.6-sol",
    ]);

    expect(candidates).toEqual([
      { model: "openai:gpt-5.6-sol", thinkingLevel: "medium" },
      ...NAME_GEN_PREFERRED_MODELS.map((model) => ({ model })),
    ]);
  });

  test("thinking-only naming settings fall back to the configured default model", async () => {
    const service = await createNamingService({
      agentAiDefaults: { name_workspace: { thinkingLevel: "medium" } },
      defaultModel: "openai:gpt-5.6-terra",
    });

    const candidates = await service.getWorkspaceNamingCandidates(undefined);

    expect(candidates[0]).toEqual({ model: "openai:gpt-5.6-terra", thinkingLevel: "medium" });
  });

  test("an active model without naming settings does not displace the hardcoded small models", async () => {
    const service = await createNamingService({
      defaultModel: "openai:gpt-5.6-terra",
      metadata: {
        agentId: "exec",
        aiSettingsByAgent: { exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "high" } },
      },
    });

    const candidates = await service.getWorkspaceNamingCandidates("ws-naming");

    expect(candidates).toEqual([
      ...NAME_GEN_PREFERRED_MODELS.map((model) => ({ model })),
      { model: "openai:gpt-5.6-sol" },
    ]);
  });

  test("carries each candidate's per-model thinking floor override", async () => {
    const service = await createNamingService({
      agentAiDefaults: NAMING_DEFAULTS,
      minThinkingLevelByModel: {
        "google:gemini-3.8-flash": "high",
        [NAME_GEN_PREFERRED_MODELS[0]]: "low",
      },
    });

    const candidates = await service.getWorkspaceNamingCandidates("ws-naming");

    expect(candidates).toEqual([
      { model: "google:gemini-3.8-flash", thinkingLevel: "medium", minThinkingLevel: "high" },
      { model: NAME_GEN_PREFERRED_MODELS[0], minThinkingLevel: "low" },
      { model: NAME_GEN_PREFERRED_MODELS[1] },
    ]);
  });

  test("keeps legacy model fallback for workspaces without per-agent settings", async () => {
    const service = await createNamingService({
      metadata: { aiSettings: { model: "openai:gpt-5.6-sol", thinkingLevel: "off" } },
    });

    const candidates = await service.getWorkspaceNamingCandidates("ws-naming");

    expect(candidates.map((candidate) => candidate.model)).toEqual([
      ...NAME_GEN_PREFERRED_MODELS,
      "openai:gpt-5.6-sol",
    ]);
  });

  test("unset naming config keeps the hardcoded small models first, thinking off", async () => {
    const service = await createNamingService({});

    const candidates = await service.getWorkspaceNamingCandidates("ws-naming");

    expect(candidates).toEqual(NAME_GEN_PREFERRED_MODELS.map((model) => ({ model })));
    expect(candidates.every((candidate) => candidate.thinkingLevel === undefined)).toBe(true);
  });

  test("the active per-agent model leads workspace fallbacks without stale legacy models or duplicates", async () => {
    const service = await createNamingService({
      agentAiDefaults: NAMING_DEFAULTS,
      metadata: {
        agentId: "ask",
        aiSettings: { model: "openai:gpt-5.1-codex-mini", thinkingLevel: "off" },
        aiSettingsByAgent: {
          exec: { model: NAME_GEN_PREFERRED_MODELS[0], thinkingLevel: "off" },
          plan: { model: "openai:gpt-5.4", thinkingLevel: "off" },
          ask: { model: "openai:gpt-5.6-sol", thinkingLevel: "off" },
        },
      },
    });

    const candidates = await service.getWorkspaceNamingCandidates("ws-naming");

    expect(candidates.map((candidate) => candidate.model)).toEqual([
      "google:gemini-3.8-flash",
      ...NAME_GEN_PREFERRED_MODELS,
      "openai:gpt-5.6-sol",
      "openai:gpt-5.4",
    ]);
  });

  test("pre-creation naming (no workspace) puts caller fallbacks after the configured and built-in models", async () => {
    const service = await createNamingService({ agentAiDefaults: NAMING_DEFAULTS });

    const candidates = await service.getWorkspaceNamingCandidates(undefined, [
      "openai:gpt-5.6-sol",
      NAME_GEN_PREFERRED_MODELS[0],
    ]);

    expect(candidates).toEqual([
      { model: "google:gemini-3.8-flash", thinkingLevel: "medium" },
      ...NAME_GEN_PREFERRED_MODELS.map((model) => ({ model })),
      { model: "openai:gpt-5.6-sol" },
    ]);
  });

  test("small-model string candidates share the same precedence", async () => {
    const service = await createNamingService({ agentAiDefaults: NAMING_DEFAULTS });

    expect(await service.getWorkspaceTitleModelCandidates("ws-naming")).toEqual([
      "google:gemini-3.8-flash",
      ...NAME_GEN_PREFERRED_MODELS,
    ]);
  });
});

describe("WorkspaceService regenerateTitle", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let harness: WorkspaceServiceHarness;

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness({
      aiService: createMockAIService({ isStreaming: mock(() => false) }),
    });
    ({ historyService, service: workspaceService } = harness);
    await saveWorkspaces(
      harness.config,
      "/tmp/proj",
      [
        "ws-regenerate-title",
        "ws-regenerate-title-compacted",
        "ws-regenerate-title-first-plus-last-three",
      ].map((id) => ({ id, name: id, path: `/tmp/proj/${id}` })),
      {
        agentAiDefaults: {
          name_workspace: { modelString: "google:gemini-3.8-flash", thinkingLevel: "medium" },
        },
      }
    );
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("returns updateTitle error when persisting generated title fails", async () => {
    const workspaceId = "ws-regenerate-title";

    await historyService.appendToHistory(workspaceId, createMuxMessage("user-1", "user", "Fix CI"));

    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockResolvedValue(
      Ok({
        name: "ci-fix-a1b2",
        title: "Fix CI",
        modelUsed: "anthropic:claude-3-5-haiku-latest",
      })
    );
    const updateTitleSpy = spyOn(workspaceService, "updateTitle").mockResolvedValueOnce(
      Err("Failed to update workspace title: disk full")
    );

    try {
      const result = await workspaceService.regenerateTitle(workspaceId);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Failed to update workspace title: disk full");
      }
      expect(generateIdentitySpy).toHaveBeenCalledTimes(1);
      const call = generateIdentitySpy.mock.calls[0];
      // Regeneration honors the configured naming agent (model + thinking) first.
      expect(call?.[1][0]).toEqual({ model: "google:gemini-3.8-flash", thinkingLevel: "medium" });
      expect(call?.[3]).toBeUndefined();
      expect(call?.[4]).toBe("Fix CI");
      expect(updateTitleSpy).toHaveBeenCalledWith(workspaceId, "Fix CI");
    } finally {
      updateTitleSpy.mockRestore();
      generateIdentitySpy.mockRestore();
    }
  });
  test("falls back to full history when latest compaction epoch has no user message", async () => {
    const workspaceId = "ws-regenerate-title-compacted";

    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-before-boundary", "user", "Refactor sidebar loading")
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("summary-boundary", "assistant", "Compacted summary", {
        compacted: true,
        compactionBoundary: true,
        compactionEpoch: 1,
      })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-after-boundary", "assistant", "No new user messages yet")
    );

    const iterateSpy = spyOn(historyService, "iterateFullHistory");
    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockResolvedValue(
      Ok({
        name: "sidebar-refactor-a1b2",
        title: "Refactor sidebar loading",
        modelUsed: "anthropic:claude-3-5-haiku-latest",
      })
    );
    const updateTitleSpy = spyOn(workspaceService, "updateTitle").mockResolvedValueOnce(
      Ok(undefined)
    );

    try {
      const result = await workspaceService.regenerateTitle(workspaceId);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBe("Refactor sidebar loading");
      }
      expect(iterateSpy).toHaveBeenCalledTimes(1);
      expect(generateIdentitySpy).toHaveBeenCalledTimes(1);
      const call = generateIdentitySpy.mock.calls[0];
      expect(call?.[0]).toBe("Refactor sidebar loading");
      const context = call?.[3];
      expect(typeof context).toBe("string");
      if (typeof context === "string") {
        expect(context).toContain("Refactor sidebar loading");
        expect(context).toContain("Compacted summary");
        expect(context).toContain("No new user messages yet");
        expect(context).not.toContain("omitted for brevity");
      }
      expect(call?.[4]).toBe("Refactor sidebar loading");
      expect(updateTitleSpy).toHaveBeenCalledWith(workspaceId, "Refactor sidebar loading");
    } finally {
      updateTitleSpy.mockRestore();
      generateIdentitySpy.mockRestore();
      iterateSpy.mockRestore();
    }
  });
  test("uses first user turn + latest 3 turns and flags omitted context", async () => {
    const workspaceId = "ws-regenerate-title-first-plus-last-three";

    for (let turn = 1; turn <= 12; turn++) {
      const role: "user" | "assistant" = turn % 2 === 1 ? "user" : "assistant";
      const text = `${role === "user" ? "User" : "Assistant"} turn ${turn}`;
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage(`${role}-${turn}`, role, text)
      );
    }

    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockResolvedValue(
      Ok({
        name: "title-refresh-a1b2",
        title: "User turn 1",
        modelUsed: "anthropic:claude-3-5-haiku-latest",
      })
    );
    const updateTitleSpy = spyOn(workspaceService, "updateTitle").mockResolvedValueOnce(
      Ok(undefined)
    );

    try {
      const result = await workspaceService.regenerateTitle(workspaceId);

      expect(result.success).toBe(true);
      expect(generateIdentitySpy).toHaveBeenCalledTimes(1);
      const call = generateIdentitySpy.mock.calls[0];
      expect(call?.[0]).toBe("User turn 1");
      const context = call?.[3];
      expect(typeof context).toBe("string");
      expect(call?.[4]).toBe("User turn 11");
      expect(updateTitleSpy).toHaveBeenCalledWith(workspaceId, "User turn 1");
    } finally {
      updateTitleSpy.mockRestore();
      generateIdentitySpy.mockRestore();
    }
  });
});
