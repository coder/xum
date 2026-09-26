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
} from "../../../tests/ipc/helpers";

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
      const initStateManager = env.services.initStateManager;
      const realWaitForInit = initStateManager.waitForInit.bind(initStateManager);
      const probeParked = Promise.withResolvers<void>();
      const probeTarget: { workspaceId?: string } = {};
      spyOn(initStateManager, "waitForInit").mockImplementation((workspaceId, signal) => {
        if (workspaceId === probeTarget.workspaceId) probeParked.resolve();
        return realWaitForInit(workspaceId, signal);
      });

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

      const held = await sanitizeEntered.promise;
      expect(held.taskId).toBe(replacementId);
      // Sanitize is held: the launch has neither started a server nor listed anything.
      expect(ledger.filter((entry) => entry.workspaceId === replacementId)).toEqual([]);
      expect(await readRecord(recordFile)).toEqual([]);
      // The row is published and its checkout materialized: a renderer may ask for the new
      // workspace's prompt catalog now. The request must wait for sanitize, not race it.
      probeTarget.workspaceId = replacementId;
      const probe = resolveOrpcClient(env).workspace.mcp.prompts.list({
        workspaceId: replacementId,
      });
      await probeParked.promise;
      // Parked, not passed through: the launch's init is still running, and it completes only
      // after sanitize (waitForInit returns at once for a completed or absent init).
      expect(initStateManager.getInitState(replacementId)?.status).toBe("running");

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
});
