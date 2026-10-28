import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as path from "node:path";
import { Err, Ok, type Result } from "@/common/types/result";
import type { Config, Workspace } from "@/node/config";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import {
  createTestConfig,
  createWorkspaceServiceMocks,
  projectWorkspace,
  saveWorkspacesWithCheckouts as saveWorkspaces,
  testTaskSettings,
  workspaceTurnManagerInternals,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  registerLiveWorkspaceTurnHandle,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

// Paths of TaskService.sendTreeMessage (the peer route) that no other test reached: the
// re-checks under the target's admission lock, the retry fences of a message that waited for a
// delegated turn, and the admission probe the host re-runs inside sendMessage.

type SendArgs = Parameters<WorkspaceHost["sendMessage"]>;
type SendResult = Awaited<ReturnType<TaskServiceInternals["sendTreeMessage"]>>;

interface TaskServiceInternals {
  sendTreeMessage(spec: unknown): Promise<Result<unknown, { code: string }>>;
  flushParkedPeerSends(targetId: string): Promise<void>;
  workspaceEventLocks: { withLock<T>(key: string, fn: () => Promise<T>): Promise<T> };
  interruptedParentWorkspaceIds: Set<string>;
}

describe("TaskService.sendTreeMessage uncovered paths", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    await removeTaskServiceTestRoot(rootDir);
  });

  // Two tag-linked root chats: alpha sends, beta receives.
  async function setUp() {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const tagged = { messagingTag: "research", messagingTagGeneration: "gen-1" };
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "alpha", "alpha", tagged),
        projectWorkspace(projectPath, "beta", "beta", tagged),
      ],
      testTaskSettings()
    );
    // While set, the next send runs this instead of the default accept.
    let intercept: ((args: SendArgs) => Promise<Result<void>>) | undefined;
    const sendMessage = mock(async (...args: SendArgs): Promise<Result<void>> => {
      const next = intercept;
      intercept = undefined;
      if (next != null) return next(args);
      await args[3]?.onAccepted?.();
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    // The first load of the saved test config schedules a background migration persist. Run it
    // now and wait for it (a no-op edit queues behind it), so no config write outlives a test.
    config.loadConfigOrDefault();
    await config.editConfig((cfg) => cfg);
    const internals = taskService as unknown as TaskServiceInternals;
    const interceptNextSend = (fn: (args: SendArgs) => Promise<Result<void>>) => {
      intercept = fn;
    };
    return { config, projectPath, taskService, internals, sendMessage, interceptNextSend };
  }

  type Setup = Awaited<ReturnType<typeof setUp>>;

  async function editWorkspace(config: Config, id: string, updates: Partial<Workspace>) {
    await config.editConfig((cfg) => {
      const entry = findWorkspaceEntry(cfg, id);
      if (entry == null) throw new Error(`Missing test workspace: ${id}`);
      Object.assign(entry.workspace, updates);
      return cfg;
    });
  }

  // The host re-runs the admission probe inside sendMessage; `interfere` changes state first.
  // A refused probe makes the host fail the send, so the result carries the probe's refusal.
  async function sendWithProbeInterference(s: Setup, interfere: () => Promise<void> | void) {
    s.interceptNextSend(async ([, , , internal]) => {
      await interfere();
      expect(internal?.admissionStale?.()).toBe(true);
      return Err("admission refused");
    });
    const result = await s.taskService.sendAgentTreeMessage("alpha", "beta", "Status?");
    expect(s.sendMessage).toHaveBeenCalledTimes(1);
    return result;
  }

  // Park a message from alpha behind another workspace's delegated turn on beta, run
  // `beforeRetry`, release the turn, and return the retry's result once the drain finished.
  async function retryAfterDelegatedTurn(s: Setup, beforeRetry: () => Promise<void>) {
    await registerLiveWorkspaceTurnHandle(s.taskService, "beta", "wst_owner", "owner");
    // Spied before the park, so the flush the park schedules is awaited below too.
    const flushes = spyOn(s.internals, "flushParkedPeerSends");
    expect(await s.taskService.sendAgentTreeMessage("alpha", "beta", "first")).toMatchObject(
      Ok({ delivery: "queued", awaitsDelegatedTurn: true })
    );
    expect(s.sendMessage).not.toHaveBeenCalled();
    await beforeRetry();
    // The drain calls sendTreeMessage on the instance; the wrapper is an object so the
    // retry's promise is handed over without being awaited here.
    const original = s.internals.sendTreeMessage.bind(s.taskService);
    const retries = spyOn(s.internals, "sendTreeMessage");
    const retryStarted = new Promise<{ result: Promise<SendResult> }>((resolve) => {
      retries.mockImplementationOnce((spec) => {
        const result = original(spec);
        resolve({ result });
        return result;
      });
    });
    const registrations = workspaceTurnManagerInternals(
      s.taskService
    ).activeWorkspaceTurnHandleByWorkspaceId;
    registrations.delete("beta");
    s.taskService.onWorkspaceTurnRegistrationReleased("beta");
    const retry = await (await retryStarted).result;
    // Every drain this test started has finished before the result is checked.
    await Promise.all(flushes.mock.results.map((result) => result.value as Promise<void>));
    expect(retries).toHaveBeenCalledTimes(1);
    flushes.mockRestore();
    retries.mockRestore();
    registrations.delete("beta");
    return retry;
  }

  test("a relation change while the send waits for the target's lock refuses it as invalid_scope", async () => {
    const s = await setUp();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const holder = s.internals.workspaceEventLocks.withLock("beta", () => held);
    // Routed as tag-linked roots, then beta becomes alpha's finished sub-agent before the lock
    // is free. A later gate would refuse that target as not_active; the lock-time re-check
    // refuses first, before any target state is read.
    const pending = s.taskService.sendAgentTreeMessage("alpha", "beta", "Status?");
    await editWorkspace(s.config, "beta", { parentWorkspaceId: "alpha", taskStatus: "reported" });
    release();
    await holder;
    expect(await pending).toEqual(Err({ code: "invalid_scope" }));
    expect(s.sendMessage).not.toHaveBeenCalled();
  });

  test("a retry after a delegated turn is refused as invalid_scope when a tag was re-issued", async () => {
    const s = await setUp();
    // Same tag string, new generation: a clear/re-tag cycle is a new link.
    const retry = await retryAfterDelegatedTurn(s, () =>
      editWorkspace(s.config, "beta", { messagingTagGeneration: "gen-2" })
    );
    expect(retry).toEqual(Err({ code: "invalid_scope" }));
    expect(s.sendMessage).not.toHaveBeenCalled();
  });

  test("an interrupted target chain seen only by the host's admission probe refuses the send", async () => {
    const s = await setUp();
    // Every production interrupt also bumps the stop epoch, which the probe checks first, so
    // only the suppression entry is set here to reach the level check behind it.
    const result = await sendWithProbeInterference(s, () => {
      s.internals.interruptedParentWorkspaceIds.add("beta");
    });
    expect(result).toMatchObject(Err({ code: "refused" }));
    // The same refusal a send gets when the target is already interrupted at entry.
    expect(await s.taskService.sendAgentTreeMessage("alpha", "beta", "again")).toEqual(result);
  });

  test("a target removed before the host's admission probe refuses the send as not_found", async () => {
    const s = await setUp();
    const result = await sendWithProbeInterference(s, () =>
      s.config.editConfig((cfg) => {
        const project = cfg.projects.get(s.projectPath);
        if (project == null) throw new Error("Missing test project");
        project.workspaces = project.workspaces.filter((workspace) => workspace.id !== "beta");
        return cfg;
      })
    );
    expect(result).toEqual(Err({ code: "not_found" }));
  });

  test("a retry whose send fails after a new delegated turn refuses with the wait, not send_failed", async () => {
    const s = await setUp();
    const retry = await retryAfterDelegatedTurn(s, () => {
      // Another workspace's delegated turn starts while the retry is inside sendMessage. A retry
      // never waits twice, so the probe refuses it and the host fails the send.
      s.interceptNextSend(async ([, , , internal]) => {
        await registerLiveWorkspaceTurnHandle(s.taskService, "beta", "wst_next", "owner-2");
        expect(internal?.admissionStale?.()).toBe(true);
        return Err("admission refused");
      });
      return Promise.resolve();
    });
    expect(s.sendMessage).toHaveBeenCalledTimes(1);
    // The wait's refusal (code refused), not the generic transport failure (send_failed).
    expect(retry).toMatchObject(Err({ code: "refused" }));
  });
});
