import assert from "node:assert/strict";
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { Ok } from "@/common/types/result";
import { shellQuote } from "@/common/utils/shell";
import type {
  ProviderModelFactory,
  ResolveAndCreateModelResult,
} from "@/node/services/providerModelFactory";
import {
  cleanupTestEnvironment,
  createTestEnvironment,
  setupProviders,
} from "../../../tests/ipc/setup";
import {
  HAIKU_MODEL,
  cleanupTempGitRepo,
  createTempGitRepo,
  createWorkspace,
  generateBranchName,
  resolveOrpcClient,
  sendMessage,
} from "../../../tests/ipc/helpers";
import { WorktreeRuntime } from "@/node/runtime/WorktreeRuntime";
import { InitStateManager } from "@/node/services/initStateManager";
import { UNSANITIZED_TASK_CHECKOUT_CODE } from "@/node/services/unsanitizedTaskCheckout";

// Runs under `bun test` with the real ServiceContainer (TaskService, WorkspaceService,
// AIService, MCPServerManager) and a real stdio MCP process; only the language model is
// substituted (as in mcpIdentity.assembly.test.ts).
const RECORDING_SERVER = path.resolve(
  import.meta.dir,
  "../../../tests/fixtures/mcp/recording-server.ts"
);
const ATTEMPT = "att_00000000000000d4";
const RUN = { runId: "wfr_mcp_order", stepId: "summarize", inputHash: "hash-mcp" };

interface RecordedEvent {
  event: string;
  cwd: string;
  at: number;
}

async function readRecord(file: string): Promise<RecordedEvent[]> {
  // Absent until the stub process first starts.
  const raw = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecordedEvent);
}

/** A text-only answer: the child's turn ends normally without calling any tool. */
function answeringModel(): MockLanguageModelV3 {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  return new MockLanguageModelV3({
    doStream: () =>
      Promise.resolve({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "a" },
            { type: "text-delta", id: "a", delta: "done" },
            { type: "text-end", id: "a" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
  });
}

type TestEnvironment = Awaited<ReturnType<typeof createTestEnvironment>>;

/**
 * Parent workspace with the recording MCP server enabled (project config + trust), a model
 * that answers in text, the workflow step's retired child, and pass-through spies that ledger
 * every MCP entry point by workspace. `launchReplacement` claims the retired child and
 * launches its replacement through createMany's claim, returning the replacement's id.
 */
async function setUpReplacement(env: TestEnvironment, repoPath: string, recordFile: string) {
  await setupProviders(env, { anthropic: { apiKey: "mock-model-key" } });
  // Project MCP config, consented by project trust (createWorkspace trusts the project):
  // the server is enabled for every workspace of the project, the replacement included.
  await fs.mkdir(path.join(repoPath, ".xum"), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, ".xum", "mcp.jsonc"),
    JSON.stringify({
      servers: {
        recorder: [process.execPath, RECORDING_SERVER, recordFile].map(shellQuote).join(" "),
      },
    })
  );
  const parent = await createWorkspace(env, repoPath, generateBranchName("mcp-order"));
  if (!parent.success) throw new Error(parent.error);
  const parentId = parent.metadata.id;
  // The parent's checkout materializes (and is sanitized) after create returns.
  await env.services.initStateManager.waitForInit(parentId);

  const factory = (
    env.services.aiService as unknown as { providerModelFactory: ProviderModelFactory }
  ).providerModelFactory;
  spyOn(factory, "resolveAndCreateModel").mockImplementation(() =>
    Promise.resolve(
      Ok({
        model: answeringModel(),
        effectiveModelString: HAIKU_MODEL,
        canonicalModelString: HAIKU_MODEL,
        canonicalProviderName: "anthropic",
        canonicalModelId: HAIKU_MODEL.slice(HAIKU_MODEL.indexOf(":") + 1),
        wireProviderName: "anthropic",
        routedThroughGateway: false,
      } satisfies ResolveAndCreateModelResult)
    )
  );

  // The workflow step's previous child: ended without a report (interrupted, no receipt
  // needed in the owning process), so the runner may claim and replace it.
  await env.config.editConfig((cfg) => {
    const project = cfg.projects.get(repoPath);
    assert(project, "parent project must be registered");
    project.workspaces.push({
      id: "retiredmcp",
      name: "retired-mcp",
      path: path.join(env.config.srcDir, "retired-mcp"),
      createdAt: new Date().toISOString(),
      parentWorkspaceId: parentId,
      agentType: "explore",
      agentId: "explore",
      runtimeConfig: parent.metadata.runtimeConfig,
      taskStatus: "interrupted",
      taskAttemptId: ATTEMPT,
      workflowTask: { runId: RUN.runId, stepId: RUN.stepId },
    });
    return cfg;
  });

  // In-process order ledger. Every MCP entry point is a pass-through spy on the real
  // manager, so a start that the stub process has not yet recorded is still caught.
  const ledger: Array<{ step: string; workspaceId: string }> = [];
  const mcp = env.services.mcpServerManager;
  for (const method of ["getToolsForWorkspace", "getPromptsForWorkspace"] as const) {
    const real = mcp[method].bind(mcp) as (...args: unknown[]) => Promise<unknown>;
    spyOn(mcp, method).mockImplementation(((...args: unknown[]) => {
      ledger.push({
        step: method,
        workspaceId: (args[0] as { workspaceId: string }).workspaceId,
      });
      return real(...args);
    }) as never);
  }

  const launchReplacement = async (): Promise<string> => {
    const taskService = env.services.taskService;
    const claim = await taskService.claimRetiredAttempt("retiredmcp", ATTEMPT, RUN);
    assert(claim.success, `claim must succeed: ${claim.success ? "" : claim.error}`);
    const created = await taskService.createMany(
      [
        {
          parentWorkspaceId: parentId,
          kind: "agent",
          agentId: "explore",
          prompt: "Summarize durable workflows",
          title: "Replacement",
          workflowTask: { runId: RUN.runId, stepId: RUN.stepId },
        },
      ],
      { retires: [{ taskId: "retiredmcp", attemptId: ATTEMPT, nonce: claim.data.nonce }] }
    );
    assert(created.success, `createMany must succeed: ${created.success ? "" : created.error}`);
    const replacementId = created.data[0]?.taskId;
    assert(replacementId, "createMany must return the replacement's task id");
    return replacementId;
  };
  return { parentId, ledger, launchReplacement };
}

/**
 * Pass-through spies on init state: `parked` resolves once a request for `target.workspaceId`
 * waits on init, and `completed` lists every workspace whose init was completed (endInit), the
 * point that releases such waiters.
 */
function observeInit(env: TestEnvironment) {
  const initStateManager = env.services.initStateManager;
  const realWaitForInit = initStateManager.waitForInit.bind(initStateManager);
  const realEndInit = initStateManager.endInit.bind(initStateManager);
  const parked = Promise.withResolvers<void>();
  const target: { workspaceId?: string } = {};
  const completed: string[] = [];
  spyOn(initStateManager, "waitForInit").mockImplementation((workspaceId, signal) => {
    if (workspaceId === target.workspaceId) parked.resolve();
    return realWaitForInit(workspaceId, signal);
  });
  spyOn(initStateManager, "endInit").mockImplementation((workspaceId, exitCode) => {
    completed.push(workspaceId);
    return realEndInit(workspaceId, exitCode);
  });
  return { target, parked: parked.promise, completed };
}

/**
 * Gate 4 of G2 end to end (#4576): a workflow replacement's launch must not start MCP servers or
 * run prompt discovery before its checkout's plugin overrides are sanitized. Two discovery
 * routes reach a new child: the launch's own first send (turn assembly lists MCP tools and
 * prompts) and a client's prompt-catalog request (`workspace.mcp.prompts.list`), which a
 * renderer can issue as soon as the published row appears.
 */
describe("workflow replacement launch: MCP after sanitize", () => {
  test("no MCP process, tool list or prompt discovery reaches the replacement until its sanitize returns", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();
    const recordFile = path.join(env.tempDir, "mcp-record.jsonl");
    try {
      const { parentId, ledger, launchReplacement } = await setUpReplacement(
        env,
        repoPath,
        recordFile
      );

      // Hold the replacement's sanitize (the real call runs once released).
      const workspaceService = env.services.workspaceService;
      const realSanitize =
        workspaceService.sanitizeMaterializedTaskWorkspace.bind(workspaceService);
      const sanitizeEntered = Promise.withResolvers<{ taskId: string; checkout: string }>();
      const releaseSanitize = Promise.withResolvers<void>();
      let sanitizedAt = Number.POSITIVE_INFINITY;
      let recordAtSanitize: RecordedEvent[] | undefined;
      spyOn(workspaceService, "sanitizeMaterializedTaskWorkspace").mockImplementation(
        async (...args) => {
          if (args[0] === parentId) return realSanitize(...args);
          sanitizeEntered.resolve({ taskId: args[0], checkout: args[1] });
          await releaseSanitize.promise;
          const result = await realSanitize(...args);
          sanitizedAt = Date.now();
          recordAtSanitize = await readRecord(recordFile);
          ledger.push({ step: "sanitized", workspaceId: args[0] });
          return result;
        }
      );
      // Witness that a client's prompt-catalog request has parked on the launch's init state.
      const initWaits = observeInit(env);
      const initStateManager = env.services.initStateManager;

      const replacementId = await launchReplacement();

      const held = await sanitizeEntered.promise;
      expect(held.taskId).toBe(replacementId);
      // Sanitize is held: the launch has neither started a server nor listed anything.
      expect(ledger.filter((entry) => entry.workspaceId === replacementId)).toEqual([]);
      expect(await readRecord(recordFile)).toEqual([]);
      // The row is published and its checkout materialized: a renderer may ask for the new
      // workspace's prompt catalog now. The request must wait for sanitize, not race it.
      initWaits.target.workspaceId = replacementId;
      const probe = resolveOrpcClient(env).workspace.mcp.prompts.list({
        workspaceId: replacementId,
      });
      await initWaits.parked;
      // Parked, not passed through: the launch's init is still running, and it completes only
      // after sanitize (waitForInit returns at once for a completed or absent init).
      expect(initStateManager.getInitState(replacementId)?.status).toBe("running");
      expect(initWaits.completed).not.toContain(replacementId);

      releaseSanitize.resolve();

      // Positive control: discovery genuinely reaches this child's stub once sanitized.
      const prompts = await probe;
      expect(prompts.map((p) => `${p.serverName}/${p.promptName}`)).toContain("recorder/recorded");
      const checkout = await fs.realpath(held.checkout);
      // The launch's own first send assembles the turn: it lists this child's MCP tools.
      const deadline = Date.now() + 30_000;
      const sendListedTools = () =>
        ledger.some((e) => e.workspaceId === replacementId && e.step === "getToolsForWorkspace");
      while (!sendListedTools()) {
        assert(Date.now() < deadline, "the replacement's first send never listed MCP tools");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const childEvents = (await readRecord(recordFile)).filter((e) => e.cwd === checkout);
      // Let the child's turn finish before teardown: it reports, and a completed task's row
      // may then be auto-deleted.
      const status = () =>
        env.config
          .loadConfigOrDefault()
          .projects.get(repoPath)
          ?.workspaces.find((w) => w.id === replacementId)?.taskStatus;
      while (status() !== "reported" && status() !== undefined) {
        assert(
          Date.now() < deadline,
          `the replacement never reported (status ${String(status())})`
        );
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      // Nothing ran before sanitize returned, in-process or in the stub process...
      expect(recordAtSanitize).toEqual([]);
      const replacementSteps = ledger
        .filter((entry) => entry.workspaceId === replacementId)
        .map((entry) => entry.step);
      expect(replacementSteps[0]).toBe("sanitized");
      // ...and afterwards both routes reached it: the probe's catalog and the send's tool list.
      expect(replacementSteps).toContain("getPromptsForWorkspace");
      expect(replacementSteps).toContain("getToolsForWorkspace");
      expect(childEvents[0]?.event).toBe("start");
      const childMethods = childEvents.map((e) => e.event);
      expect(childMethods).toContain("tools/list");
      expect(childMethods).toContain("prompts/list");
      for (const event of childEvents) expect(event.at).toBeGreaterThanOrEqual(sanitizedAt);
    } finally {
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 120_000);

  test("a failed sanitize releases no parked discovery into the checkout before its reclaim", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();
    const recordFile = path.join(env.tempDir, "mcp-record.jsonl");
    try {
      const { parentId, ledger, launchReplacement } = await setUpReplacement(
        env,
        repoPath,
        recordFile
      );
      // The replacement's sanitize fails; the launch must then unpublish the row and delete
      // the checkout. The first config edit after the failure (the reclaim's unpublish) is held.
      const reclaimHeld = Promise.withResolvers<void>();
      const releaseReclaim = Promise.withResolvers<void>();
      let holdNextEdit = false;
      const realEditConfig = env.config.editConfig.bind(env.config);
      spyOn(env.config, "editConfig").mockImplementation((async (...args: unknown[]) => {
        if (holdNextEdit) {
          holdNextEdit = false;
          reclaimHeld.resolve();
          await releaseReclaim.promise;
        }
        return (realEditConfig as (...a: unknown[]) => Promise<unknown>)(...args);
      }) as never);
      let checkout: string | undefined;
      spyOn(env.services.workspaceService, "sanitizeMaterializedTaskWorkspace").mockImplementation(
        async (id: string, workspacePath: string) => {
          if (id === parentId) return undefined;
          checkout = await fs.realpath(workspacePath);
          holdNextEdit = true;
          return "fixture: sanitize failed";
        }
      );
      const initWaits = observeInit(env);

      const replacementId = await launchReplacement();
      await reclaimHeld.promise;
      assert(checkout, "the replacement's sanitize must have run");
      // The unsanitized row is still published; a renderer asks for its prompt catalog.
      initWaits.target.workspaceId = replacementId;
      const probe = resolveOrpcClient(env)
        .workspace.mcp.prompts.list({ workspaceId: replacementId })
        .then(
          (prompts) => ({ prompts }),
          (error: unknown) => ({ error })
        );
      await initWaits.parked;
      // Parked: init completes only after the reclaim attempt (completing it is what releases
      // the request), so nothing reaches the manager or starts a server while it is held.
      expect(initWaits.completed).not.toContain(replacementId);
      expect(ledger.filter((entry) => entry.workspaceId === replacementId)).toEqual([]);
      expect(await readRecord(recordFile)).toEqual([]);

      releaseReclaim.resolve();
      const outcome = await probe;
      // The reclaim removed the row, checkout and session dir before the request resumed: it
      // finds no workspace and fails, and no server ever ran in the reclaimed checkout.
      expect("error" in outcome).toBe(true);
      expect(ledger.filter((entry) => entry.workspaceId === replacementId)).toEqual([]);
      expect((await readRecord(recordFile)).filter((e) => e.cwd === checkout)).toEqual([]);
      expect(
        env.config
          .loadConfigOrDefault()
          .projects.get(repoPath)
          ?.workspaces.some((w) => w.id === replacementId)
      ).toBe(false);
      expect(await fs.stat(checkout).catch(() => null)).toBeNull();
      // Dropping (not completing) the reclaimed task's init writes no init-status.json back.
      expect(
        await fs.stat(path.join(env.config.sessionsDir, replacementId)).catch(() => null)
      ).toBeNull();
    } finally {
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 120_000);
});

/** The typed refusal a quarantined checkout returns through the prompt-catalog RPC. */
function expectTypedPromptRefusal(outcome: object) {
  expect("error" in outcome ? outcome.error : undefined).toMatchObject({
    code: "PRECONDITION_FAILED",
    data: { code: UNSANITIZED_TASK_CHECKOUT_CODE },
  });
}

/**
 * The retained row carries the persisted marker, so a restarted backend (a fresh InitStateManager
 * over the same config, without this process's in-memory record) still refuses it (#4674).
 */
function expectRefusedAfterRestart(env: TestEnvironment, taskId: string, parentId: string) {
  const row = [...env.config.loadConfigOrDefault().projects.values()]
    .flatMap((project) => project.workspaces)
    .find((w) => w.id === taskId);
  expect(row?.taskCheckoutUnsanitized).toBe(true);
  const restarted = new InitStateManager(env.config);
  expect(restarted.getUnsanitizedCheckoutError(taskId)?.code).toBe(UNSANITIZED_TASK_CHECKOUT_CODE);
  expect(restarted.getUnsanitizedCheckoutError(parentId)).toBeUndefined();
}

const listPrompts = (env: TestEnvironment, workspaceId: string) =>
  resolveOrpcClient(env)
    .workspace.mcp.prompts.list({ workspaceId })
    .then(
      (prompts) => ({ prompts }),
      (error: unknown) => ({ error })
    );

/**
 * #4674: a launch whose sanitize failed and whose reclaim could not remove the row or the
 * checkout leaves an unsanitized checkout behind. MCP discovery and sends for it must refuse
 * with a typed error; no MCP process may start in it.
 */
describe("unsanitized task checkout whose reclaim failed", () => {
  test("a failed unpublish keeps prompt discovery and sends refused and starts nothing in the checkout", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();
    const recordFile = path.join(env.tempDir, "mcp-record.jsonl");
    try {
      const { parentId, launchReplacement } = await setUpReplacement(env, repoPath, recordFile);
      // The reclaim's unpublish (the first config edit after the failed sanitize) is held,
      // then fails: the row and the unsanitized checkout both stay.
      const reclaimHeld = Promise.withResolvers<void>();
      const failReclaim = Promise.withResolvers<void>();
      let failNextEdit = false;
      const realEditConfig = env.config.editConfig.bind(env.config);
      spyOn(env.config, "editConfig").mockImplementation((async (...args: unknown[]) => {
        if (failNextEdit) {
          failNextEdit = false;
          reclaimHeld.resolve();
          await failReclaim.promise;
          throw new Error("fixture: unpublish failed");
        }
        return (realEditConfig as (...a: unknown[]) => Promise<unknown>)(...args);
      }) as never);
      let checkout: string | undefined;
      spyOn(env.services.workspaceService, "sanitizeMaterializedTaskWorkspace").mockImplementation(
        async (id: string, workspacePath: string) => {
          if (id === parentId) return undefined;
          checkout = await fs.realpath(workspacePath);
          failNextEdit = true;
          return "fixture: sanitize failed";
        }
      );
      // The persisted marker is written by the failed launch's markTaskLaunchFailed, which the
      // launch schedules without awaiting it. The refusals below come from the in-memory record
      // and can finish first, so the persisted assertions wait for this record (#4927).
      const taskService = env.services.taskService as unknown as {
        markTaskLaunchFailed: (taskId: string, ...rest: unknown[]) => Promise<void>;
      };
      const markTaskLaunchFailed = taskService.markTaskLaunchFailed.bind(taskService);
      const launchFailureRecorded = Promise.withResolvers<string>();
      spyOn(taskService, "markTaskLaunchFailed").mockImplementation(async (taskId, ...rest) => {
        try {
          return await markTaskLaunchFailed(taskId, ...rest);
        } finally {
          launchFailureRecorded.resolve(taskId);
        }
      });
      const initWaits = observeInit(env);

      const replacementId = await launchReplacement();
      await reclaimHeld.promise;
      assert(checkout, "the replacement's sanitize must have run");
      initWaits.target.workspaceId = replacementId;
      const parked = listPrompts(env, replacementId);
      await initWaits.parked;
      expect(initWaits.completed).not.toContain(replacementId);
      failReclaim.resolve();

      // The parked request is released by the failed launch and refuses with the typed error.
      expectTypedPromptRefusal(await parked);
      expectTypedPromptRefusal(await listPrompts(env, replacementId));
      const sent = await sendMessage(env, replacementId, "continue", { model: HAIKU_MODEL });
      expect(sent).toMatchObject({
        success: false,
        error: { type: UNSANITIZED_TASK_CHECKOUT_CODE },
      });
      // Positive control: the sentinel records the (sanitized) parent's discovery in this run.
      expect("prompts" in (await listPrompts(env, parentId))).toBe(true);
      const events = await readRecord(recordFile);
      expect(events.some((e) => e.cwd !== checkout)).toBe(true);
      expect(events.filter((e) => e.cwd === checkout)).toEqual([]);
      expect(await launchFailureRecorded.promise).toBe(replacementId);
      // The scenario: the row is still published and the unsanitized checkout still exists.
      expect(
        env.config
          .loadConfigOrDefault()
          .projects.get(repoPath)
          ?.workspaces.some((w) => w.id === replacementId)
      ).toBe(true);
      expect(await fs.stat(checkout).catch(() => null)).not.toBeNull();
      expectRefusedAfterRestart(env, replacementId, parentId);
      // Inspection and removal stay available.
      expect(
        (await resolveOrpcClient(env).workspace.getInfo({ workspaceId: replacementId }))?.id
      ).toBe(replacementId);
      const removed = await env.services.workspaceService.remove(replacementId, true);
      expect(removed.success).toBe(true);
      expect(await fs.stat(checkout).catch(() => null)).toBeNull();
    } finally {
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 120_000);

  test("a failed checkout delete refuses the parked request and reports the checkout retained", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();
    const recordFile = path.join(env.tempDir, "mcp-record.jsonl");
    let deleteSpy: { mockRestore: () => void } | undefined;
    try {
      const { parentId, launchReplacement } = await setUpReplacement(env, repoPath, recordFile);
      const reclaimHeld = Promise.withResolvers<void>();
      const releaseReclaim = Promise.withResolvers<void>();
      let holdNextEdit = false;
      const realEditConfig = env.config.editConfig.bind(env.config);
      spyOn(env.config, "editConfig").mockImplementation((async (...args: unknown[]) => {
        if (holdNextEdit) {
          holdNextEdit = false;
          reclaimHeld.resolve();
          await releaseReclaim.promise;
        }
        return (realEditConfig as (...a: unknown[]) => Promise<unknown>)(...args);
      }) as never);
      let checkout: string | undefined;
      spyOn(env.services.workspaceService, "sanitizeMaterializedTaskWorkspace").mockImplementation(
        async (id: string, workspacePath: string) => {
          if (id === parentId) return undefined;
          checkout = await fs.realpath(workspacePath);
          holdNextEdit = true;
          return "fixture: sanitize failed";
        }
      );
      // The row is unpublished, but the checkout cannot be deleted. (A prototype spy:
      // restored in finally so later tests delete checkouts for real.)
      deleteSpy = spyOn(WorktreeRuntime.prototype, "deleteWorkspace").mockResolvedValue({
        success: false,
        error: "fixture: delete failed",
      });
      const taskService = env.services.taskService as unknown as {
        reclaimUnsanitizedTaskCheckout: (...args: unknown[]) => Promise<unknown>;
      };
      const reclaim = taskService.reclaimUnsanitizedTaskCheckout.bind(taskService);
      const reclaimResults: unknown[] = [];
      spyOn(taskService, "reclaimUnsanitizedTaskCheckout").mockImplementation(async (...args) => {
        const result = await reclaim(...args);
        reclaimResults.push(result);
        return result;
      });
      const initWaits = observeInit(env);

      const replacementId = await launchReplacement();
      await reclaimHeld.promise;
      assert(checkout, "the replacement's sanitize must have run");
      initWaits.target.workspaceId = replacementId;
      const parked = listPrompts(env, replacementId);
      await initWaits.parked;
      releaseReclaim.resolve();

      expectTypedPromptRefusal(await parked);
      expect(reclaimResults).toEqual([{ rowUnpublished: true, checkoutRemoved: false }]);
      expect((await readRecord(recordFile)).filter((e) => e.cwd === checkout)).toEqual([]);
      expect(await fs.stat(checkout).catch(() => null)).not.toBeNull();
      expect(
        await fs.stat(path.join(env.config.sessionsDir, replacementId)).catch(() => null)
      ).toBeNull();
    } finally {
      deleteSpy?.mockRestore();
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 120_000);

  test("a direct create whose sanitize fails leaves a retained row that refuses sends and discovery", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();
    const recordFile = path.join(env.tempDir, "mcp-record.jsonl");
    try {
      const { parentId } = await setUpReplacement(env, repoPath, recordFile);
      let checkout: string | undefined;
      spyOn(env.services.workspaceService, "sanitizeMaterializedTaskWorkspace").mockImplementation(
        async (id: string, workspacePath: string) => {
          if (id === parentId) return undefined;
          checkout = await fs.realpath(workspacePath);
          return "fixture: sanitize failed";
        }
      );
      const created = await env.services.taskService.create({
        parentWorkspaceId: parentId,
        kind: "agent",
        agentId: "explore",
        prompt: "Summarize durable workflows",
        title: "Direct",
      });
      expect(created.success).toBe(false);
      assert(checkout, "the direct task's sanitize must have run");
      const taskRow = env.config
        .loadConfigOrDefault()
        .projects.get(repoPath)
        ?.workspaces.find((w) => w.parentWorkspaceId === parentId && w.id !== "retiredmcp");
      assert(taskRow?.id, "the direct create retains its interrupted row");
      expectRefusedAfterRestart(env, taskRow.id, parentId);

      const sent = await sendMessage(env, taskRow.id, "continue", { model: HAIKU_MODEL });
      expect(sent).toMatchObject({
        success: false,
        error: { type: UNSANITIZED_TASK_CHECKOUT_CODE },
      });
      expectTypedPromptRefusal(await listPrompts(env, taskRow.id));
      expect((await readRecord(recordFile)).filter((e) => e.cwd === checkout)).toEqual([]);
    } finally {
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 120_000);
});

/**
 * #4742: a direct `TaskService.create` persists its row as `running` before it sanitizes the
 * checkout. A send admitted in that window expands its slash-invoked MCP prompt (the prompt
 * snapshot) before the turn's init wait. That expansion must not start the prompt's server in
 * the checkout before sanitize returns. It cannot today: `MCPServerManager.getPrompt` only
 * serves a workspace whose options an earlier tool or prompt listing recorded, both listings
 * wait for init, and the launch completes init only after sanitize. This pins that chain for
 * the direct path: a listing that served before sanitize, or a cold-starting getPrompt, fails it.
 */
describe("direct create: MCP prompt snapshot before sanitize", () => {
  test("a send racing the direct create starts no MCP server before the checkout is sanitized", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();
    const recordFile = path.join(env.tempDir, "mcp-record.jsonl");
    try {
      const { parentId } = await setUpReplacement(env, repoPath, recordFile);
      const workspaceService = env.services.workspaceService;
      const realSanitize =
        workspaceService.sanitizeMaterializedTaskWorkspace.bind(workspaceService);
      const sanitizeEntered = Promise.withResolvers<{ taskId: string; checkout: string }>();
      const releaseSanitize = Promise.withResolvers<void>();
      let sanitizedAt = Number.POSITIVE_INFINITY;
      spyOn(workspaceService, "sanitizeMaterializedTaskWorkspace").mockImplementation(
        async (...args) => {
          if (args[0] === parentId) return realSanitize(...args);
          sanitizeEntered.resolve({ taskId: args[0], checkout: await fs.realpath(args[1]) });
          await releaseSanitize.promise;
          const result = await realSanitize(...args);
          sanitizedAt = Date.now();
          return result;
        }
      );
      const getPrompt = spyOn(env.services.mcpServerManager, "getPrompt");
      const initWaits = observeInit(env);

      const created = env.services.taskService.create({
        parentWorkspaceId: parentId,
        kind: "agent",
        agentId: "explore",
        prompt: "Summarize durable workflows",
        title: "Direct",
      });
      const held = await sanitizeEntered.promise;
      const row = () =>
        env.config
          .loadConfigOrDefault()
          .projects.get(repoPath)
          ?.workspaces.find((w) => w.id === held.taskId);
      // The window: the row is persisted as running while its sanitize is held.
      expect(row()?.taskStatus).toBe("running");

      // A renderer's prompt catalog request parks on the launch's init until sanitize is done;
      // a listing that served now would record options that let the send below start MCP.
      initWaits.target.workspaceId = held.taskId;
      const catalog = listPrompts(env, held.taskId);
      await initWaits.parked;
      expect(initWaits.completed).not.toContain(held.taskId);
      const racing = await sendMessage(env, held.taskId, "/mcp__recorder__recorded", {
        model: HAIKU_MODEL,
        muxMetadata: {
          type: "normal",
          rawCommand: "/mcp__recorder__recorded",
          commandPrefix: "/mcp__recorder__recorded",
          mcpPromptRefs: [
            {
              serverName: "recorder",
              promptName: "recorded",
              commandKey: "mcp__recorder__recorded",
              source: "slash",
            },
          ],
        },
      });
      // The send reached the prompt snapshot, and its expansion started nothing.
      expect(getPrompt.mock.calls.some((call) => call[0] === held.taskId)).toBe(true);
      expect(racing.success).toBe(false);
      expect((await readRecord(recordFile)).filter((e) => e.cwd === held.checkout)).toEqual([]);

      releaseSanitize.resolve();
      expect((await created).success).toBe(true);
      expect("prompts" in (await catalog)).toBe(true);
      // Positive control: the launch's own turn starts the server in the checkout, after sanitize.
      const deadline = Date.now() + 30_000;
      let childEvents: RecordedEvent[] = [];
      while (!childEvents.some((e) => e.event === "tools/list")) {
        assert(Date.now() < deadline, "the launch never listed the checkout's MCP tools");
        await new Promise((resolve) => setTimeout(resolve, 25));
        childEvents = (await readRecord(recordFile)).filter((e) => e.cwd === held.checkout);
      }
      for (const event of childEvents) expect(event.at).toBeGreaterThanOrEqual(sanitizedAt);
      // Let the child's turn finish before teardown: it reports, and a completed task's row
      // may then be auto-deleted.
      while (row() !== undefined && row()?.taskStatus !== "reported") {
        assert(Date.now() < deadline, `the task never reported (${String(row()?.taskStatus)})`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 120_000);
});
