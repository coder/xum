/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await, local/no-sync-fs-methods */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createRouterClient, ORPCError } from "@orpc/server";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Context, Effect } from "effect";
import { Config } from "@/node/config";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  EXPERIMENT_OVERRIDES_FILE_NAME,
  ExperimentsService,
} from "@/node/services/experimentsService";
import type { TelemetryService } from "@/node/services/telemetryService";
import { Err, Ok, type Result } from "@/common/types/result";
import { draftTooLargeMessage, isDraftTooLargeError } from "@/common/utils/drafts";
import type { AutoModelRoutingDecision } from "@/common/types/autoModelRouting";
import { AutoModelRouterTag } from "@/node/services/di/tags";
import type { AutoModelRouter, AutoModelRouterFailure } from "@/node/services/autoModelRouter";

import type { ORPCContext } from "./context";
import { inFlightProcedureCount } from "./inFlightProcedures";
import { WorkspaceMutationInProgressError } from "@/node/services/workspaceUseLeases";
import { router } from "./router";

describe("config.previewAutoModelRouting", () => {
  const PREVIEW_TIERS = {
    tiers: [
      { id: "easy", label: "Easy", description: "Trivial" },
      { id: "hard", label: "Hard", description: "Complex", model: "openai:gpt-5.5" },
    ],
  };
  const EVALUATOR_USAGE = { inputTokens: 40, outputTokens: 3, totalTokens: 43 };

  function createPreviewClient(outcome: Result<AutoModelRoutingDecision, AutoModelRouterFailure>) {
    const classifyEffect = mock((_input: unknown) => Effect.succeed(outcome));
    const recordHeadlessUsage = mock((..._args: unknown[]) => Promise.resolve(undefined));
    const context = {
      config: {
        loadConfigOrDefault: () => ({}),
        // Only ws-live is registered; a stale persisted selection resolves to nothing.
        findWorkspace: (workspaceId: string) =>
          workspaceId === "ws-live" ? { workspacePath: "/repo/ws", projectPath: "/repo" } : null,
      },
      initStateManager: { waitForInit: mock(async () => undefined) },
      sessionUsageService: { recordHeadlessUsage },
      "effect/context": Context.make(AutoModelRouterTag, {
        classifyEffect,
      } as unknown as AutoModelRouter),
    } as unknown as ORPCContext;
    return {
      client: createRouterClient(router(), { context }),
      classifyEffect,
      recordHeadlessUsage,
    };
  }

  test("bills the evaluator's usage to the named workspace like the send path", async () => {
    const { client, recordHeadlessUsage } = createPreviewClient(
      Ok({
        tierId: "hard",
        confidence: 0.8,
        evaluationModel: "typesafe:jev-latest",
        usage: EVALUATOR_USAGE,
        providerMetadata: { typesafe: { requestId: "req-1" } },
      })
    );
    const result = await client.config.previewAutoModelRouting({
      prompt: "Refactor the scheduler",
      workspaceId: "ws-live",
      config: PREVIEW_TIERS,
    });
    expect(result).toEqual(
      Ok({
        tierId: "hard",
        tierLabel: "Hard",
        confidence: 0.8,
        evaluationModel: "typesafe:jev-latest",
        model: "openai:gpt-5.5",
      })
    );
    expect(recordHeadlessUsage).toHaveBeenCalledTimes(1);
    expect(recordHeadlessUsage.mock.calls[0]).toEqual([
      "ws-live",
      "typesafe:jev-latest",
      EVALUATOR_USAGE,
      { typesafe: { requestId: "req-1" } },
      { analyticsSource: "auto_model_routing_preview" },
    ]);
  });

  test("a verdict naming a tier the panel no longer has still bills its usage", async () => {
    const { client, recordHeadlessUsage } = createPreviewClient(
      Ok({
        tierId: "extreme",
        evaluationModel: "typesafe:jev-latest",
        usage: EVALUATOR_USAGE,
      })
    );
    const result = await client.config.previewAutoModelRouting({
      prompt: "Refactor the scheduler",
      workspaceId: "ws-live",
      config: PREVIEW_TIERS,
    });
    expect(result.success).toBe(true);
    expect(recordHeadlessUsage).toHaveBeenCalledTimes(1);
  });

  test("bills a rejected verdict the provider already billed (#4774)", async () => {
    const { client, recordHeadlessUsage } = createPreviewClient(
      Err({ reason: "Evaluation failed (AI_InvalidResponseDataError)", usage: EVALUATOR_USAGE })
    );
    const result = await client.config.previewAutoModelRouting({
      prompt: "Refactor the scheduler",
      workspaceId: "ws-live",
      config: PREVIEW_TIERS,
    });
    expect(result).toEqual(Err("Evaluation failed (AI_InvalidResponseDataError)"));
    expect(recordHeadlessUsage.mock.calls).toEqual([
      [
        "ws-live",
        "typesafe:jev-latest",
        EVALUATOR_USAGE,
        undefined,
        { analyticsSource: "auto_model_routing_preview" },
      ],
    ]);
  });

  test("refuses a workspace it does not know before calling the evaluator", async () => {
    const { client, classifyEffect, recordHeadlessUsage } = createPreviewClient(
      Ok({
        tierId: "hard",
        evaluationModel: "typesafe:jev-latest",
        usage: EVALUATOR_USAGE,
      })
    );
    const result = await client.config.previewAutoModelRouting({
      prompt: "Refactor the scheduler",
      workspaceId: "ws-removed",
      config: PREVIEW_TIERS,
    });
    expect(result.success).toBe(false);
    expect(classifyEffect).not.toHaveBeenCalled();
    expect(recordHeadlessUsage).not.toHaveBeenCalled();
  });
});

describe("router drafts.update", () => {
  test("the size refusal reaches the client with its message, so it is not retried", async () => {
    const message = draftTooLargeMessage(41 * 1024 * 1024);
    const context = {
      draftService: { update: mock(() => Promise.reject(new Error(message))) },
    } as unknown as ORPCContext;
    const client = createRouterClient(router(), { context });

    let refused: unknown;
    await client.drafts
      .update({ scope: { kind: "workspace", workspaceId: "ws-1" }, text: "x" })
      .catch((error: unknown) => (refused = error));
    expect(refused).toBeInstanceOf(ORPCError);
    expect((refused as ORPCError<string, unknown>).code).toBe("BAD_REQUEST");
    expect(isDraftTooLargeError(refused)).toBe(true);
  });
});

describe("router terminal.create", () => {
  test("a structural mutation's refusal reaches the client with its message (#4476)", async () => {
    const message = "Workspace ws-1 is being renamed, removed or archived by pid 42";
    const context = {
      terminalService: {
        create: mock(() => Promise.reject(new WorkspaceMutationInProgressError(message))),
      },
    } as unknown as ORPCContext;
    const client = createRouterClient(router(), { context });

    let refused: unknown;
    await client.terminal
      .create({ workspaceId: "ws-1", cols: 80, rows: 24 })
      .catch((error: unknown) => (refused = error));
    expect(refused).toBeInstanceOf(ORPCError);
    expect((refused as ORPCError<string, unknown>).code).toBe("CONFLICT");
    expect((refused as Error).message).toBe(message);
  });
});

describe("router agent skill routes", () => {
  test("subproject workspaces inherit parent skills with nearest precedence", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-skills-test-"));
    try {
      const checkoutRoot = path.join(tempDir, "checkout");
      const packagesRoot = path.join(checkoutRoot, "packages");
      const subProjectPath = path.join(packagesRoot, "app");
      const writeSkill = (root: string, name: string, description: string, body: string): void => {
        const skillDir = path.join(root, name);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`
        );
      };

      fs.mkdirSync(subProjectPath, { recursive: true });
      writeSkill(
        path.join(checkoutRoot, ".mux", "skills"),
        "parent-only",
        "from checkout",
        "parent body"
      );
      writeSkill(
        path.join(checkoutRoot, ".mux", "skills"),
        "shared",
        "from checkout",
        "checkout body"
      );
      writeSkill(
        path.join(packagesRoot, ".agents", "skills"),
        "shared",
        "from packages",
        "packages body"
      );

      const outsideRoot = path.join(tempDir, "outside-skills");
      writeSkill(outsideRoot, "escaped", "outside checkout", "outside body");
      fs.symlinkSync(
        path.join(outsideRoot, "escaped"),
        path.join(checkoutRoot, ".mux", "skills", "escaped"),
        "dir"
      );

      const context = {
        config: new Config(tempDir),
        initStateManager: { waitForInit: mock(async () => undefined) },
        aiService: {
          resolveXumToolScopeForWorkspace: mock(() => ({
            type: "project",
            xumHome: tempDir,
            projectRoot: subProjectPath,
            projectStorageAuthority: "host-local",
            checkoutRoot,
          })),
          getWorkspaceMetadata: mock(async () => ({
            success: true,
            data: {
              id: "workspace-1",
              name: "workspace-1",
              projectPath: checkoutRoot,
              namedWorkspacePath: checkoutRoot,
              subProjectPath,
              runtimeConfig: { type: "local", srcBaseDir: tempDir },
            },
          })),
        },
        experimentsService: {
          isExperimentEnabled: mock(() => false),
        },
      } as unknown as ORPCContext;
      const client = createRouterClient(router(), { context });

      const { skills } = await client.agentSkills.list({ workspaceId: "workspace-1" });
      expect(skills.find((skill) => skill.name === "parent-only")).toMatchObject({
        description: "from checkout",
        scope: "project",
      });
      expect(skills.find((skill) => skill.name === "shared")).toMatchObject({
        description: "from packages",
        scope: "project",
      });

      expect(skills.find((skill) => skill.name === "escaped")).toBeUndefined();
      await expect(
        client.agentSkills.get({ workspaceId: "workspace-1", skillName: "escaped" })
      ).rejects.toThrow("Agent skill not found");

      await expect(
        client.agentSkills.get({ workspaceId: "workspace-1", skillName: "parent-only" })
      ).resolves.toMatchObject({ body: "parent body\n" });
      await expect(
        client.agentSkills.get({ workspaceId: "workspace-1", skillName: "shared" })
      ).resolves.toMatchObject({ body: "packages body\n" });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("devcontainer workspaces read inherited skills from host-local storage", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-devcontainer-skills-"));
    try {
      const checkoutRoot = path.join(tempDir, "checkout");
      const subProjectPath = path.join(checkoutRoot, "packages", "app");
      const skillDir = path.join(checkoutRoot, ".mux", "skills", "parent-only");
      fs.mkdirSync(subProjectPath, { recursive: true });
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: parent-only\ndescription: Parent skill\n---\nHost parent body\n"
      );

      const context = {
        config: new Config(tempDir),
        initStateManager: { waitForInit: mock(async () => undefined) },
        aiService: {
          resolveXumToolScopeForWorkspace: mock(() => ({
            type: "project",
            xumHome: tempDir,
            projectRoot: subProjectPath,
            projectStorageAuthority: "host-local",
            checkoutRoot,
          })),
          getWorkspaceMetadata: mock(async () => ({
            success: true,
            data: {
              id: "workspace-1",
              name: "workspace-1",
              projectPath: checkoutRoot,
              namedWorkspacePath: checkoutRoot,
              subProjectPath,
              runtimeConfig: {
                type: "devcontainer",
                configPath: ".devcontainer/devcontainer.json",
              },
            },
          })),
        },
        experimentsService: {
          isExperimentEnabled: mock(() => false),
        },
      } as unknown as ORPCContext;
      const client = createRouterClient(router(), { context });

      await expect(
        client.agentSkills.list({ workspaceId: "workspace-1" }).then((result) => result.skills)
      ).resolves.toContainEqual(
        expect.objectContaining({
          name: "parent-only",
          description: "Parent skill",
          scope: "project",
        })
      );
      await expect(
        client.agentSkills.get({ workspaceId: "workspace-1", skillName: "parent-only" })
      ).resolves.toMatchObject({ body: "Host parent body\n" });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("project-path discovery inherits skills from a registered parent", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-project-skills-test-"));
    try {
      const parentProjectPath = path.join(tempDir, "checkout");
      const subProjectPath = path.join(parentProjectPath, "packages", "app");
      const skillDir = path.join(parentProjectPath, ".mux", "skills", "parent-only");
      fs.mkdirSync(subProjectPath, { recursive: true });
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: parent-only\ndescription: Parent skill\n---\nParent body\n"
      );

      const config = new Config(tempDir);
      await config.editConfig((current) => {
        current.projects.set(parentProjectPath, { workspaces: [] });
        current.projects.set(subProjectPath, {
          workspaces: [],
          parentProjectPath,
        });
        return current;
      });
      const context = {
        config,
        experimentsService: {
          isExperimentEnabled: mock(() => false),
        },
      } as unknown as ORPCContext;
      const client = createRouterClient(router(), { context });

      await expect(
        client.agentSkills.list({ projectPath: subProjectPath }).then((result) => result.skills)
      ).resolves.toContainEqual(
        expect.objectContaining({
          name: "parent-only",
          description: "Parent skill",
          scope: "project",
        })
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("router config transcript mutation", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-test-"));
    config = new Config(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createContext(): ORPCContext {
    const telemetryService = {
      setFeatureFlagVariant: () => undefined,
    } as unknown as TelemetryService;
    return {
      config,
      experimentsService: new ExperimentsService({ telemetryService, xumHome: tempDir }),
      perfFlightRecorder: {
        beginRpcCall: () => null,
        openRpcSubscription: () => null,
        setEnabled: () => undefined,
      },
      perfCaptures: { setEnabled: () => undefined },
    } as unknown as ORPCContext;
  }

  test("experiments.set signals onConfigChanged and the next getConfig carries the value", async () => {
    const client = createRouterClient(router(), { context: createContext() });
    const ptc = EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING;
    expect((await client.config.getConfig()).experiments[ptc]).toBe(false);

    const controller = new AbortController();
    const changes = await client.config.onConfigChanged(undefined, { signal: controller.signal });
    const changed = changes.next();
    await client.experiments.set({ experimentId: ptc, enabled: true });
    expect((await changed).done).toBe(false);
    controller.abort();

    expect((await client.config.getConfig()).experiments[ptc]).toBe(true);
  });

  test("getConfig adopts experiment writes another backend made on disk", async () => {
    const context = createContext();
    const recorderEnabled = spyOn(context.perfFlightRecorder, "setEnabled");
    const client = createRouterClient(router(), { context });
    const ptc = EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING;
    const perf = EXPERIMENT_IDS.PERF_FLIGHT_RECORDER;
    expect((await client.config.getConfig()).experiments[ptc]).toBe(false);

    fs.writeFileSync(
      path.join(tempDir, EXPERIMENT_OVERRIDES_FILE_NAME),
      JSON.stringify({ version: 1, experiments: {}, overrides: { [ptc]: true, [perf]: true } })
    );

    expect((await client.config.getConfig()).experiments[ptc]).toBe(true);
    expect(recorderEnabled).toHaveBeenLastCalledWith(true);
  });

  test("updateUserPreferences refuses an invalid value and keeps the stored one", async () => {
    const client = createRouterClient(router(), { context: createContext() });
    await client.config.updateUserPreferences({
      patches: [{ appearance: { transcriptDensity: "hyper" } }],
    });

    const outcome = await client.config
      .updateUserPreferences({ patches: [{ appearance: { transcriptDensity: "bogus" } }] })
      .then(
        () => "resolved",
        (error: ORPCError<string, unknown>) => error.code
      );

    expect(outcome).toBe("BAD_REQUEST");
    expect(new Config(tempDir).loadConfigOrDefault().userPreferences).toEqual({
      appearance: { transcriptDensity: "hyper" },
    });
  });

  test("terminal font family and size are patched and cleared independently", async () => {
    const clientA = createRouterClient(router(), { context: createContext() });
    const clientB = createRouterClient(router(), { context: createContext() });

    await clientA.config.updateUserPreferences({
      patches: [{ appearance: { terminalFontConfig: { fontSize: 16 } } }],
    });
    await clientB.config.updateUserPreferences({
      patches: [{ appearance: { terminalFontConfig: { fontFamily: "Menlo" } } }],
    });
    await clientB.config.updateUserPreferences({
      patches: [{ appearance: { terminalFontConfig: { fontFamily: null } } }],
    });

    expect(new Config(tempDir).loadConfigOrDefault().userPreferences).toEqual({
      appearance: { terminalFontConfig: { fontSize: 16 } },
    });
  });

  test("updateUserPreferences merges patches from separate clients and null deletes a key", async () => {
    const clientA = createRouterClient(router(), { context: createContext() });
    const clientB = createRouterClient(router(), { context: createContext() });

    await clientA.config.updateUserPreferences({
      patches: [{ appearance: { vimEnabled: true } }],
    });
    await clientB.config.updateUserPreferences({
      patches: [{ appearance: { theme: "dark" } }, { navigation: { launchBehavior: "new-chat" } }],
    });
    expect(new Config(tempDir).loadConfigOrDefault().userPreferences).toEqual({
      appearance: { vimEnabled: true, theme: "dark" },
      navigation: { launchBehavior: "new-chat" },
    });

    await clientA.config.updateUserPreferences({ patches: [{ appearance: { vimEnabled: null } }] });
    expect((await clientB.config.getConfig()).userPreferences).toEqual({
      appearance: { theme: "dark" },
      navigation: { launchBehavior: "new-chat" },
    });
  });

  test("persists the full-width chat transcript config flag", async () => {
    const client = createRouterClient(router(), { context: createContext() });

    expect((await client.config.getConfig()).chatTranscriptFullWidth).toBe(false);
    await client.config.updateChatTranscriptFullWidth({ enabled: true });
    expect((await client.config.getConfig()).chatTranscriptFullWidth).toBe(true);
    expect(config.loadConfigOrDefault().chatTranscriptFullWidth).toBe(true);

    await client.config.updateChatTranscriptFullWidth({ enabled: false });
    expect((await client.config.getConfig()).chatTranscriptFullWidth).toBe(false);
    expect(config.loadConfigOrDefault().chatTranscriptFullWidth).toBeUndefined();
  });

  test("persists the keep-screen-awake config flag", async () => {
    const client = createRouterClient(router(), { context: createContext() });

    expect((await client.config.getConfig()).keepScreenAwake).toBe(false);
    expect(config.getKeepScreenAwakeEnabled()).toBe(false);
    await client.config.updateKeepScreenAwake({ enabled: true });
    expect((await client.config.getConfig()).keepScreenAwake).toBe(true);
    expect(config.loadConfigOrDefault().keepScreenAwake).toBe(true);
    expect(config.getKeepScreenAwakeEnabled()).toBe(true);

    // Off state removes the key entirely (absent = off) instead of persisting `false`.
    await client.config.updateKeepScreenAwake({ enabled: false });
    expect((await client.config.getConfig()).keepScreenAwake).toBe(false);
    expect(config.loadConfigOrDefault().keepScreenAwake).toBeUndefined();
    expect(config.getKeepScreenAwakeEnabled()).toBe(false);
  });

  test("persists the tool-search opt-out and treats an absent key as enabled", async () => {
    const client = createRouterClient(router(), { context: createContext() });

    expect((await client.config.getConfig()).toolSearchEnabled).toBe(true);
    await client.config.updateToolSearchEnabled({ enabled: false });
    expect((await client.config.getConfig()).toolSearchEnabled).toBe(false);
    expect(new Config(config.rootDir).loadConfigOrDefault().toolSearchEnabled).toBe(false);

    await client.config.updateToolSearchEnabled({ enabled: true });
    expect((await client.config.getConfig()).toolSearchEnabled).toBe(true);
    expect(new Config(config.rootDir).loadConfigOrDefault().toolSearchEnabled).toBeUndefined();
  });

  test("refuses procedure calls once the server has begun shutting down", async () => {
    let shuttingDown = false;
    const context = {
      config,
      serverService: { isShuttingDown: () => shuttingDown },
    } as unknown as ORPCContext;
    const client = createRouterClient(router(), { context });
    expect(await client.general.ping("alive")).toBe("Pong: alive");

    shuttingDown = true;
    let error: unknown;
    try {
      await client.general.ping("late");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe("SERVICE_UNAVAILABLE");
  });

  test("an aborted config mutation stays in flight until its write settles", async () => {
    let started!: () => void;
    const writeStarted = new Promise<void>((resolve) => (started = resolve));
    let finish!: () => void;
    const write = new Promise<void>((resolve) => (finish = resolve));
    const context = {
      config: {
        markSplashScreenViewed: () => {
          started();
          return write;
        },
      },
    } as unknown as ORPCContext;
    const client = createRouterClient(router(), { context });
    const controller = new AbortController();
    const call = client.splashScreens
      .markSplashScreenViewed({ splashId: "late" }, { signal: controller.signal })
      .catch((error: unknown) => error);
    await writeStarted;
    expect(inFlightProcedureCount()).toBe(1);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inFlightProcedureCount()).toBe(1);
    finish();
    await call;
    expect(inFlightProcedureCount()).toBe(0);
  });
});
