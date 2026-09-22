import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "fs/promises";
import { execSync } from "node:child_process";
import * as os from "os";
import * as path from "path";

import type { Config } from "@/node/config";
import { type Workspace as WorkspaceConfigEntry } from "@/node/config";
import { SecretsStore } from "@/node/config";
import { HistoryService } from "@/node/services/historyService";
import { prepareDedicatedTaskCheckout } from "@/node/services/taskCheckoutPreparation.testHarness";
import { TaskService } from "@/node/services/taskService";
import {
  createAIServiceMocks,
  createMockInitStateManager,
  createTestConfig,
  createTestProject,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  initGitRepo,
  saveWorkspaces,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import type { TaskTurnAdmission, WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";

/**
 * Checkout-preparation authority at the task admissions (consumer slice): every admission that
 * can start or feed a task execution binds a captured, physically validated preparation
 * authority and re-checks it strictly against the fresh registry at its synchronous fence.
 * Roots are exempt; off-host task rows are excluded; host-local task rows without a usable
 * authority (legacy rows written before the protocol, ancestry that no longer reaches a root)
 * are refused before any attempt rotates or any send binds — inspectable, never executable.
 */
const rootId = "root-prep";
const ATTEMPT_ID = /^att_[0-9a-f]{16}$/;

interface Internals {
  ownedAttemptByTaskId: Map<string, { attemptId?: string }>;
  currentAttemptIdByTaskId: Map<string, string>;
  startReservedAgentTask: (plan: unknown) => Promise<void>;
  evaluateAttemptLineage: (
    taskId: string,
    entry: WorkspaceConfigEntry
  ) => Promise<{ proven: boolean; reason: string }>;
}
const internals = (service: TaskService) => service as unknown as Internals;

describe("TaskService checkout-preparation authority at the admissions", () => {
  let rootDir: string;
  let projectPath: string;
  let config: Config;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-prep-admission-"));
    config = await createTestConfig(rootDir);
    projectPath = await createTestProject(rootDir, "repo", { initGit: false });
  });
  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  /**
   * A project-dir root (its checkout IS the project directory) with task rows beneath it. Shared
   * rows (isolation none) point at the parent's checkout; a "dedicated" row is a REAL prepared
   * worktree (claimed, bound, proof on the row — what the materializer publishes); a "legacy"
   * dedicated row is a worktree task row written before preparation existed (no proof field); an
   * off-host row is excluded.
   */
  async function setupTree(
    rows: Array<{
      id: string;
      kind: "shared" | "dedicated" | "legacy" | "offhost";
      parentId?: string;
      overrides?: Partial<WorkspaceConfigEntry>;
    }>
  ): Promise<void> {
    const entries: WorkspaceConfigEntry[] = [
      {
        id: rootId,
        name: "root",
        path: projectPath,
        runtimeConfig: { type: "local" },
      },
    ];
    if (rows.some((row) => row.kind === "dedicated")) initGitRepo(projectPath);
    for (const row of rows) {
      const base = {
        id: row.id,
        name: row.id,
        parentWorkspaceId: row.parentId ?? rootId,
        agentType: "explore",
        agentId: "explore",
        taskStatus: "running" as const,
        taskModelString: "openai:gpt-5.2",
        taskAttemptId: "att_00000000000000a1",
      };
      if (row.kind === "shared") {
        entries.push({
          ...base,
          path: projectPath,
          runtimeConfig: { type: "local" },
          taskIsolation: "none",
          ...row.overrides,
        });
      } else if (row.kind === "dedicated") {
        const checkout = path.join(config.srcDir, "repo", row.id);
        await fsPromises.mkdir(path.dirname(checkout), { recursive: true });
        const runtimeConfig = { type: "worktree", srcBaseDir: config.srcDir } as const;
        entries.push({
          ...base,
          path: checkout,
          runtimeConfig,
          taskCheckoutPreparation: await prepareDedicatedTaskCheckout({
            projectPath,
            checkout,
            branch: row.id,
            runtimeConfig,
          }),
          ...row.overrides,
        });
      } else if (row.kind === "legacy") {
        const legacyPath = path.join(rootDir, `${row.id}-checkout`);
        await fsPromises.mkdir(legacyPath, { recursive: true });
        entries.push({
          ...base,
          path: legacyPath,
          runtimeConfig: { type: "worktree", srcBaseDir: rootDir },
          ...row.overrides,
        });
      } else {
        entries.push({
          ...base,
          path: `/srv/${row.id}`,
          runtimeConfig: { type: "ssh", host: "example", srcBaseDir: "/srv" },
          ...row.overrides,
        });
      }
    }
    await saveWorkspaces(config, projectPath, entries, testTaskSettings(4, 3));
  }

  function createHarness(overrides?: { workspaceService?: WorkspaceHost }) {
    const historyService = new HistoryService(config);
    const aiService = createAIServiceMocks(config).aiService;
    const workspaceService =
      overrides?.workspaceService ?? createWorkspaceServiceMocks().workspaceService;
    const initStateManager = createMockInitStateManager();
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const taskService = new TaskService(
      config,
      historyService,
      aiService,
      workspaceService,
      initStateManager,
      undefined,
      undefined,
      new SecretsStore(config.rootDir),
      terminalAttentionStore
    );
    const workspaceTurnManager = new WorkspaceTurnManager(
      config,
      historyService,
      aiService,
      workspaceService,
      initStateManager,
      taskService,
      terminalAttentionStore,
      aiService as unknown as ConstructorParameters<typeof WorkspaceTurnManager>[7]
    );
    taskService.setWorkspaceTurnManager(workspaceTurnManager);
    return { taskService, workspaceService };
  }

  const entryOf = (id: string) => findWorkspaceInConfig(config, id);

  async function editEntry(id: string, edit: (ws: WorkspaceConfigEntry) => void): Promise<void> {
    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const ws = project.workspaces.find((w) => w.id === id);
        if (ws) edit(ws);
      }
      return cfg;
    });
  }

  function expectRefused(admission: TaskTurnAdmission): string {
    expect(admission.kind).toBe("refused");
    if (admission.kind !== "refused") throw new Error("not refused");
    return admission.message;
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  describe("preflight + fence", () => {
    test("a root is exempt: its preflight succeeds without a proof and the fence stays not-a-task", async () => {
      await setupTree([]);
      const { taskService } = createHarness();
      const preflight = await taskService.preflightTaskWorkspacePreparation(rootId);
      expect(preflight.success).toBe(true);
      expect(
        taskService.admitTaskWorkspaceTurn(rootId, {
          acceptanceOrigin: "manual",
          preparation: preflight.success ? preflight.data : undefined,
        })
      ).toEqual({ kind: "not-a-task" });
      expect(taskService.admitTaskWorkspaceTurn(rootId, { acceptanceOrigin: "manual" })).toEqual({
        kind: "not-a-task",
      });
    });

    test("a legacy host-local task row (no proof) is refused: preflight fails and the fence refuses even the pre-identity bypass", async () => {
      await setupTree([
        { id: "legacy-with-id", kind: "legacy" },
        { id: "legacy-pre-identity", kind: "legacy", overrides: { taskAttemptId: undefined } },
      ]);
      const { taskService } = createHarness();
      const preflight = await taskService.preflightTaskWorkspacePreparation("legacy-with-id");
      expect(preflight.success).toBe(false);
      // No captured authority at all: refused, never admitted.
      expectRefused(
        taskService.admitTaskWorkspaceTurn("legacy-with-id", { acceptanceOrigin: "manual" })
      );
      // The pre-identity entry used to fall through as "not-a-task" (no obligation); a
      // host-local task row without a usable authority must refuse instead — the bypass would
      // otherwise let a send start a turn in an unprepared checkout.
      expectRefused(
        taskService.admitTaskWorkspaceTurn("legacy-pre-identity", { acceptanceOrigin: "manual" })
      );
      // The row is inspectable and untouched: no rotation, no launch error, no ownership.
      expect(entryOf("legacy-with-id")?.taskAttemptId).toBe("att_00000000000000a1");
      expect(internals(taskService).ownedAttemptByTaskId.has("legacy-with-id")).toBe(false);
    });

    test("an off-host task row is excluded: no proof is required and the fence admits as before", async () => {
      await setupTree([{ id: "remote-child", kind: "offhost" }]);
      const { taskService } = createHarness();
      const preflight = await taskService.preflightTaskWorkspacePreparation("remote-child");
      expect(preflight.success).toBe(true);
      const admission = taskService.admitTaskWorkspaceTurn("remote-child", {
        acceptanceOrigin: "manual",
        preparation: preflight.success ? preflight.data : undefined,
      });
      expect(admission.kind).toBe("admitted");
      if (admission.kind === "admitted") admission.token.onDisposed("no-work");
    });

    test("a shared child derives its authority from live same-path ancestry and the fence binds it", async () => {
      await setupTree([{ id: "shared-child", kind: "shared" }]);
      const { taskService } = createHarness();
      const preflight = await taskService.preflightTaskWorkspacePreparation("shared-child");
      expect(preflight.success).toBe(true);
      if (!preflight.success) return;
      const admission = taskService.admitTaskWorkspaceTurn("shared-child", {
        acceptanceOrigin: "manual",
        preparation: preflight.data,
      });
      expect(admission.kind).toBe("admitted");
      if (admission.kind !== "admitted") return;
      expect(admission.token.admissionStale()).toBe(false);
      admission.token.onDisposed("no-work");
      // A captured authority is mandatory for a host-local task row: the fence cannot derive one
      // from the registry alone (the physical validation is the async preflight's).
      expectRefused(
        taskService.admitTaskWorkspaceTurn("shared-child", { acceptanceOrigin: "manual" })
      );
    });

    test("a shared child whose path differs from its anchor, or whose ancestry no longer reaches a root, is refused", async () => {
      await setupTree([
        { id: "shared-mid", kind: "shared" },
        { id: "shared-leaf", kind: "shared", parentId: "shared-mid" },
        { id: "shared-detached", kind: "shared" },
      ]);
      const detachedPath = path.join(rootDir, "elsewhere");
      await fsPromises.mkdir(detachedPath, { recursive: true });
      await editEntry("shared-detached", (ws) => {
        ws.path = detachedPath;
      });
      const { taskService } = createHarness();
      expect((await taskService.preflightTaskWorkspacePreparation("shared-detached")).success).toBe(
        false
      );
      // Two hops of same-path ancestry reach the root: ready.
      const leaf = await taskService.preflightTaskWorkspacePreparation("shared-leaf");
      expect(leaf.success).toBe(true);
      if (!leaf.success) return;
      // Every intermediate identity matters: archiving the middle hop refuses the leaf's fresh
      // preflight AND the fence for an authority captured before it.
      await editEntry("shared-mid", (ws) => {
        ws.archivedAt = new Date().toISOString();
      });
      expect((await taskService.preflightTaskWorkspacePreparation("shared-leaf")).success).toBe(
        false
      );
      expectRefused(
        taskService.admitTaskWorkspaceTurn("shared-leaf", {
          acceptanceOrigin: "manual",
          preparation: leaf.data,
        })
      );
      // A missing intermediate row refuses too (the chain must be complete).
      await editEntry("shared-mid", (ws) => {
        delete ws.archivedAt;
      });
      const restored = await taskService.preflightTaskWorkspacePreparation("shared-leaf");
      expect(restored.success).toBe(true);
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          project.workspaces = project.workspaces.filter((w) => w.id !== "shared-mid");
        }
        return cfg;
      });
      expect((await taskService.preflightTaskWorkspacePreparation("shared-leaf")).success).toBe(
        false
      );
    });

    test("a dedicated child with a real prepared checkout is admitted under its proof authority; a proof edit stales the fence, a same-path replacement refuses the next preflight", async () => {
      await setupTree([{ id: "ded-child", kind: "dedicated" }]);
      const { taskService } = createHarness();
      const preflight = await taskService.preflightTaskWorkspacePreparation("ded-child");
      expect(preflight.success).toBe(true);
      if (!preflight.success) return;
      expect(preflight.data).toMatchObject({
        kind: "authority",
        authority: { kind: "dedicated", workspaceId: "ded-child", anchorWorkspaceId: "ded-child" },
      });
      const admission = taskService.admitTaskWorkspaceTurn("ded-child", {
        acceptanceOrigin: "manual",
        preparation: preflight.data,
      });
      expect(admission.kind).toBe("admitted");
      if (admission.kind !== "admitted") return;
      expect(admission.token.admissionStale()).toBe(false);
      // Nothing captured is never an allow for a dedicated row either.
      expectRefused(
        taskService.admitTaskWorkspaceTurn("ded-child", { acceptanceOrigin: "manual" })
      );

      // The proof is immutable: a row whose proof field changed under the pending send (any
      // writer, any field) no longer derives the captured signature → stale + refused.
      const checkout = entryOf("ded-child")!.path;
      await editEntry("ded-child", (ws) => {
        ws.taskCheckoutPreparation = {
          ...(ws.taskCheckoutPreparation as Record<string, unknown>),
          authorizationRevision: "rev_ffffffffffffffff",
        };
      });
      expect(admission.token.admissionStale()).toBe(true);
      admission.token.onDisposed("refused");
      expect(
        expectRefused(
          taskService.admitTaskWorkspaceTurn("ded-child", {
            acceptanceOrigin: "manual",
            preparation: preflight.data,
          })
        )
      ).toMatch(/PREP_STALE/);
      // The edited row still validates physically (same directory) — a fresh preflight is what
      // every stream-starting path runs, and it captures the new signature.
      const fresh = await taskService.preflightTaskWorkspacePreparation("ded-child");
      expect(fresh.success).toBe(true);

      // A same-path replacement of the checkout (an older build re-materializing it) leaves the
      // row byte-identical, so only the physical preflight can catch it — and it refuses.
      execSync(`git worktree remove --force "${checkout}"`, { cwd: projectPath, stdio: "ignore" });
      execSync(`git worktree add -q -b ded-child-again "${checkout}" main`, {
        cwd: projectPath,
        stdio: "ignore",
      });
      const replaced = await taskService.preflightTaskWorkspacePreparation("ded-child");
      expect(replaced.success).toBe(false);
      if (replaced.success) return;
      expect(replaced.error).toMatch(/PREP_MISMATCH/);
      // The row is inspectable and untouched: no rotation, no launch error, no ownership.
      expect(entryOf("ded-child")).toMatchObject({
        taskStatus: "running",
        taskAttemptId: "att_00000000000000a1",
      });
      expect(internals(taskService).ownedAttemptByTaskId.has("ded-child")).toBe(false);
    });

    test("a pending token goes stale when the fresh registry no longer supports its authority", async () => {
      await setupTree([{ id: "shared-token", kind: "shared" }]);
      const { taskService } = createHarness();
      const preflight = await taskService.preflightTaskWorkspacePreparation("shared-token");
      expect(preflight.success).toBe(true);
      if (!preflight.success) return;
      const admission = taskService.admitTaskWorkspaceTurn("shared-token", {
        acceptanceOrigin: "manual",
        preparation: preflight.data,
      });
      expect(admission.kind).toBe("admitted");
      if (admission.kind !== "admitted") return;
      expect(admission.token.admissionStale()).toBe(false);
      // The anchor root is archived underneath the pending send: its authority is gone.
      await editEntry(rootId, (ws) => {
        ws.archivedAt = new Date().toISOString();
      });
      expect(admission.token.admissionStale()).toBe(true);
      admission.token.onDisposed("refused");
      // A send decided under the old authority is refused at the fence too (strict fresh read).
      expectRefused(
        taskService.admitTaskWorkspaceTurn("shared-token", {
          acceptanceOrigin: "manual",
          preparation: preflight.data,
        })
      );
    });
  });

  describe("rescue, reactivation, startup and queue admissions", () => {
    test("the manual rescue refuses a legacy row without rotating it; a shared row rotates under its authority", async () => {
      await setupTree([
        { id: "legacy-int", kind: "legacy", overrides: { taskStatus: "interrupted" } },
        { id: "shared-int", kind: "shared", overrides: { taskStatus: "interrupted" } },
      ]);
      const { taskService } = createHarness();
      expect(await taskService.markInterruptedTaskRunning("legacy-int")).toBe(false);
      expect(entryOf("legacy-int")).toMatchObject({
        taskStatus: "interrupted",
        taskAttemptId: "att_00000000000000a1",
      });
      expect(internals(taskService).ownedAttemptByTaskId.has("legacy-int")).toBe(false);

      expect(await taskService.markInterruptedTaskRunning("shared-int")).toBe(true);
      const rotated = entryOf("shared-int");
      expect(rotated?.taskStatus).toBe("running");
      expect(rotated?.taskAttemptId).toMatch(ATTEMPT_ID);
      expect(rotated?.taskAttemptId).not.toBe("att_00000000000000a1");
    });

    test("a dedicated interrupted child rotates at the manual rescue and a dedicated running child is re-driven at startup, both under their proof authority", async () => {
      await setupTree([
        { id: "ded-int", kind: "dedicated", overrides: { taskStatus: "interrupted" } },
        { id: "ded-run", kind: "dedicated" },
      ]);
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createHarness({ workspaceService });
      const proofBefore = entryOf("ded-int")?.taskCheckoutPreparation;
      expect(proofBefore).toBeDefined();
      expect(await taskService.markInterruptedTaskRunning("ded-int")).toBe(true);
      const rotated = entryOf("ded-int");
      expect(rotated?.taskStatus).toBe("running");
      expect(rotated?.taskAttemptId).toMatch(ATTEMPT_ID);
      expect(rotated?.taskAttemptId).not.toBe("att_00000000000000a1");
      // The rescue rotated the attempt, not the proof (immutable: admissions never rebind it).
      expect(rotated?.taskCheckoutPreparation).toEqual(proofBefore);

      await taskService.recoverInterruptedTasks();
      await settle();
      const redriven = entryOf("ded-run");
      expect(redriven?.taskAttemptId).toMatch(ATTEMPT_ID);
      expect(redriven?.taskAttemptId).not.toBe("att_00000000000000a1");
      expect(sendMessage.mock.calls.filter((call) => call[0] === "ded-run")).toHaveLength(1);
    });

    test("the rescue re-checks the authority at its CAS: an ancestry change landing after the preflight refuses the rotation", async () => {
      await setupTree([
        { id: "shared-race", kind: "shared", overrides: { taskStatus: "interrupted" } },
      ]);
      const { taskService } = createHarness();
      const svc = internals(taskService);
      // The lineage evaluation is the last await before the CAS; a cooperating writer archives
      // the anchor root inside that gap.
      const lineage = svc.evaluateAttemptLineage.bind(taskService);
      spyOn(svc, "evaluateAttemptLineage").mockImplementation(async (taskId, entry) => {
        await editEntry(rootId, (ws) => {
          ws.archivedAt = new Date().toISOString();
        });
        return lineage(taskId, entry);
      });
      expect(await taskService.markInterruptedTaskRunning("shared-race")).toBe(false);
      expect(entryOf("shared-race")).toMatchObject({
        taskStatus: "interrupted",
        taskAttemptId: "att_00000000000000a1",
      });
      expect(svc.ownedAttemptByTaskId.has("shared-race")).toBe(false);
    });

    test("a reactivation of a legacy reported child is refused before its attempt rotates", async () => {
      await setupTree([
        { id: "legacy-rep", kind: "legacy", overrides: { taskStatus: "reported" } },
      ]);
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createHarness({ workspaceService });
      const result = await taskService.sendMessageToDescendantAgentTask(
        rootId,
        "legacy-rep",
        "again",
        "tool-end"
      );
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("send_failed");
      expect(entryOf("legacy-rep")?.taskAttemptId).toBe("att_00000000000000a1");
      expect(internals(taskService).ownedAttemptByTaskId.has("legacy-rep")).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    test("the startup re-drive refuses a legacy running row: no rotation, no send", async () => {
      await setupTree([
        { id: "legacy-run", kind: "legacy" },
        { id: "shared-run", kind: "shared" },
      ]);
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createHarness({ workspaceService });
      await taskService.recoverInterruptedTasks();
      await settle();
      expect(entryOf("legacy-run")?.taskAttemptId).toBe("att_00000000000000a1");
      expect(sendMessage.mock.calls.filter((call) => call[0] === "legacy-run")).toHaveLength(0);
      // The shared row is re-driven under its ancestry authority exactly as before.
      const shared = entryOf("shared-run");
      expect(shared?.taskAttemptId).toMatch(ATTEMPT_ID);
      expect(shared?.taskAttemptId).not.toBe("att_00000000000000a1");
      expect(sendMessage.mock.calls.filter((call) => call[0] === "shared-run")).toHaveLength(1);
    });

    test("the queue drain fails a legacy queued row inspectably instead of launching it", async () => {
      await setupTree([
        {
          id: "legacy-queued",
          kind: "legacy",
          overrides: { taskStatus: "queued", taskPrompt: "work", taskAttemptId: undefined },
        },
      ]);
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createHarness({ workspaceService });
      const svc = internals(taskService);
      const launch = spyOn(svc, "startReservedAgentTask").mockImplementation(() =>
        Promise.resolve()
      );
      await taskService.maybeStartQueuedTasks();
      const deadline = Date.now() + 2_000;
      while (entryOf("legacy-queued")?.taskStatus === "queued") {
        if (Date.now() > deadline) throw new Error("drain left the legacy row queued");
        await settle();
      }
      expect(entryOf("legacy-queued")?.taskStatus).toBe("interrupted");
      expect(entryOf("legacy-queued")?.taskLaunchError).toBeString();
      expect(launch).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });
});
