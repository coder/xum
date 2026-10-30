// Characterization tests for TaskService.promptTaskForRequiredCompletionTool before its split into
// steps. Each test calls the private method and checks exact values: its outcome, the probes it ran
// for the task in order, the disposals of its fence token, the send, and the task row. The probe
// list pins which checks each exit runs and in which order, so a moved check or call fails a test.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { AssertionError } from "node:assert";
import * as path from "node:path";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import { Err, Ok } from "@/common/types/result";
import { taskRecoveryPromptDedupeKey } from "@/constants/agentMessaging";
import type { TaskService } from "@/node/services/taskService";
import type { TurnAdmissionToken, WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import { makeWorkspaceHostFake } from "@/node/services/taskWorkspaceSeam.testUtils";
import {
  createAIServiceMocks,
  createTestConfig,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  flushTerminalAttentionDrains,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

const PARENT_ID = "parent";
const TASK_ID = "child";
const ATTEMPT = "att_00000000000000c1";
const OTHER_ATTEMPT = "att_00000000000000c2";
const MODEL = "openai:gpt-5.2";
/** MAX_TASK_RECOVERY_ATTEMPTS (module-private in taskService.ts). */
const RECOVERY_LIMIT = 5;
/** A workflow task whose run is not on disk, so its workflow owner is inactive. */
const GONE_RUN = { runId: "wfr_gone", stepId: "collect" };
const FAULT = new Error("injected probe fault");
const SEND_FAULT = new Error("injected send fault");

/** Spied TaskService methods, by the probe name each call records. */
const SPIED = {
  interruptTaskRecoveryForInactiveWorkflowOwner: "inactiveOwner",
  hasActiveTaskOwnedWork: "ownedWork",
  isPlanLikeTaskWorkspace: "planLike",
  shouldAllowLegacyInvalidWorkflowOutputSchema: "legacySchema",
  failAgentTaskTerminally: "fail",
  editWorkspaceEntry: "edit",
  admitTaskWorkspaceTurn: "admit",
} as const;
type Probe = (typeof SPIED)[keyof typeof SPIED] | "streaming" | "send";
/** The probes a prompt runs before its budget charge, in order. */
const CHECKS: Probe[] = ["inactiveOwner", "ownedWork", "streaming", "planLike"];

interface PromptOptions {
  reason?: "startup" | "stream_end" | "error";
  error?: { error: string; errorType?: string };
  fence?: { turnAdmission: TurnAdmissionToken; attemptId: string };
  expectedAttemptId: string | null;
}
interface Internals {
  promptTaskForRequiredCompletionTool(id: string, options: PromptOptions): Promise<boolean>;
  buildTaskCompletionRecoveryMessage(kind: string, structured: boolean, o: PromptOptions): string;
  attemptLedger: { admittedSendsByTaskId: Map<string, Set<{ token: TurnAdmissionToken }>> };
}
const internals = (taskService: TaskService) => taskService as unknown as Internals;

interface Script {
  streaming?: boolean;
  /** The probe that rejects with FAULT (for the prompted task only). */
  fault?: Probe;
  send?: "accepted" | "refused" | "throws";
  /** Latch a stop of the task, so binding a token to its attempt is refused. */
  stopLatched?: boolean;
  /** Runs inside the owned-work probe, before the probe itself. */
  duringOwnedWork?: () => Promise<void>;
}
type SendArgs = Parameters<WorkspaceHost["sendMessage"]>;
interface SentPrompt {
  message: string;
  options: SendArgs[2];
  internal: SendArgs[3];
  /** The row's recovery count when the send was called. */
  chargedAtSend: number | undefined;
}

/** A test double fence token on ATTEMPT that records its disposals. */
function fenceToken(stale: boolean) {
  const live = { stale };
  const disposals: string[] = [];
  const turnAdmission: TurnAdmissionToken = {
    admissionStale: () => live.stale,
    onEnqueued: () => undefined,
    onAdmitted: () => undefined,
    onDisposed: (kind) => {
      disposals.push(kind);
    },
  };
  return { live, disposals, fence: { turnAdmission, attemptId: ATTEMPT } };
}

describe("TaskService.promptTaskForRequiredCompletionTool before the split", () => {
  let rootDir: string;
  let config: Config;
  // Teardown runs every settle, so a test that fails early still awaits the work it started.
  let settles: Array<() => Promise<void>>;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    config = await createTestConfig(rootDir);
    settles = [];
  });
  afterEach(async () => {
    // allSettled: a failed drain must not hide the test's own failure.
    await Promise.allSettled(settles.splice(0).map((settle) => settle()));
    mock.restore();
    // A config read can queue a one-shot migration write: land it before removing the root.
    await Promise.allSettled([config.editConfig((cfg) => cfg)]);
    await removeTaskServiceTestRoot(rootDir);
  });

  const repo = () => path.join(rootDir, "repo");
  /** An awaiting_report exec task under PARENT_ID on ATTEMPT. */
  const task = (id: string, overrides: Omit<Partial<WorkspaceConfigEntry>, "id" | "path"> = {}) =>
    projectWorkspace(repo(), id, id, {
      parentWorkspaceId: PARENT_ID,
      agentId: "exec",
      agentType: "exec",
      taskStatus: "awaiting_report",
      taskModelString: MODEL,
      taskThinkingLevel: "high",
      taskAttemptId: ATTEMPT,
      ...overrides,
    });
  const rowState = (id: string) => {
    const row = findWorkspaceInConfig(config, id);
    if (row == null) return null;
    const { taskStatus, taskAttemptId, taskRecoveryAttempts, taskTerminalFailure } = row;
    return { taskStatus, taskAttemptId, taskRecoveryAttempts, taskTerminalFailure };
  };
  type RowState = NonNullable<ReturnType<typeof rowState>>;
  /** An untouched awaiting_report row's state, with `overrides`. */
  const state = (overrides: Partial<RowState> = {}): RowState => ({
    taskStatus: "awaiting_report",
    taskAttemptId: ATTEMPT,
    taskRecoveryAttempts: undefined,
    taskTerminalFailure: undefined,
    ...overrides,
  });

  /**
   * Saves PARENT_ID and `rows` and builds a TaskService. Spies record each probe the prompt runs
   * for the prompted id. Calls nested in a probe (e.g. the failure's own writes) are not recorded,
   * so a list shows only the prompt's own calls. The host's send never disposes the token it gets
   * (as a session that took it), so every recorded disposal comes from the prompt.
   */
  async function setup(rows: WorkspaceConfigEntry[], script: Script = {}) {
    await saveWorkspaces(
      config,
      repo(),
      [projectWorkspace(repo(), "parent", PARENT_ID), ...rows],
      testTaskSettings()
    );
    let promptedId = "";
    let depth = 0;
    const probes: Probe[] = [];
    const sends: SentPrompt[] = [];
    const own = (subject: unknown) => depth === 0 && subject === promptedId;
    const isStreaming = mock((id: string) => {
      if (own(id)) probes.push("streaming");
      return script.streaming === true;
    });
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const sendMessage = mock((...[id, message, options, internal]: SendArgs) => {
      if (!own(id)) return Promise.resolve(Ok(undefined));
      probes.push("send");
      const chargedAtSend = findWorkspaceInConfig(config, id)?.taskRecoveryAttempts;
      sends.push({ message, options, internal, chargedAtSend });
      if (script.send === "throws") return Promise.reject(SEND_FAULT);
      const refused = Err({ type: "unknown" as const, raw: "no" });
      return Promise.resolve(script.send === "refused" ? refused : Ok(undefined));
    });
    const workspaceService = makeWorkspaceHostFake({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
    const target = taskService as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const [method, probe] of Object.entries(SPIED)) {
      const original = target[method].bind(taskService);
      spyOn(target, method).mockImplementation((...args: unknown[]) => {
        const first = args[0] as string | { workspace: { id: string } };
        if (!own(typeof first === "string" ? first : first.workspace.id)) return original(...args);
        probes.push(probe);
        if (probe === script.fault) return Promise.reject(FAULT);
        depth += 1;
        const result =
          probe === "ownedWork" && script.duringOwnedWork != null
            ? script.duringOwnedWork().then(() => original(...args))
            : original(...args);
        if (result instanceof Promise) return result.finally(() => (depth -= 1));
        depth -= 1;
        return result;
      });
    }
    // The prompt starts queue drains (inactive owner, terminal failure) and terminal-attention
    // drains without awaiting them: await every drain until no new one appears.
    const drains = spyOn(taskService, "maybeStartQueuedTasks");
    const settle = async () => {
      let settled = -1;
      while (settled !== drains.mock.results.length) {
        settled = drains.mock.results.length;
        await Promise.allSettled(drains.mock.results.map((result) => result.value));
        await taskService.queueDrainSettled();
        await flushTerminalAttentionDrains(taskService);
      }
    };
    settles.push(settle);
    if (script.stopLatched === true) {
      const release = taskService.latchWorkspaceStopsInProgress([TASK_ID]);
      settles.push(() => Promise.resolve(release()));
    }
    return {
      taskService,
      sends,
      /** Runs the prompt for `id`, then settles the work it started. */
      async prompt(id: string, options: PromptOptions) {
        promptedId = id;
        const outcome = await internals(taskService)
          .promptTaskForRequiredCompletionTool(id, options)
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error })
          );
        const ran = probes.splice(0);
        await settle();
        return { ...outcome, probes: ran };
      },
    };
  }

  /**
   * One exit before the handoff. Defaults: the prompted id is TASK_ID, a live fence, outcome
   * false, disposals ["refused"] when fenced ([] otherwise), and an untouched row.
   */
  interface ExitCase {
    task?: Omit<Partial<WorkspaceConfigEntry>, "id" | "path">;
    /** Also save a running child of the task (active owned work). */
    busyChild?: true;
    id?: string;
    fence?: "live" | "stale" | "none";
    expectedAttemptId?: string;
    script?: Script;
    outcome?: { value: boolean } | { error: Error };
    probes: Probe[];
    disposals?: string[];
    row?: RowState | null;
  }
  const atLimit = { taskRecoveryAttempts: RECOVERY_LIMIT };
  const reAdmitted = { taskAttemptId: OTHER_ATTEMPT };
  const failedAt: Partial<RowState> = {
    taskStatus: "interrupted",
    taskTerminalFailure: { attemptId: ATTEMPT, errorType: "task_recovery_limit" },
  };
  const EXITS: Record<string, ExitCase> = {
    "an unknown task id": { id: "missing", probes: [], row: null },
    "a row without a parent": { task: { parentWorkspaceId: undefined }, probes: [] },
    "a task not awaiting_report, before its inactive owner is checked": {
      task: { taskStatus: "running", workflowTask: GONE_RUN },
      probes: [],
      row: state({ taskStatus: "running" }),
    },
    "an inactive workflow owner, before owned work and the stream": {
      task: { workflowTask: GONE_RUN },
      busyChild: true,
      script: { streaming: true },
      probes: ["inactiveOwner"],
      row: state({ taskStatus: "interrupted" }),
    },
    "active owned work, before the stream": {
      busyChild: true,
      script: { streaming: true },
      probes: ["inactiveOwner", "ownedWork"],
    },
    "a task already streaming": {
      script: { streaming: true },
      outcome: { value: true },
      probes: ["inactiveOwner", "ownedWork", "streaming"],
      disposals: ["no-work"],
    },
    "the limit with a stale fence: no failure": {
      task: atLimit,
      fence: "stale",
      probes: CHECKS,
      row: state(atLimit),
    },
    "the limit with a live fence: its attempt fails": {
      task: atLimit,
      probes: [...CHECKS, "fail"],
      row: state({ ...atLimit, ...failedAt }),
    },
    "the limit with a live fence on a re-admitted row: no failure": {
      task: { ...atLimit, ...reAdmitted },
      probes: [...CHECKS, "fail"],
      row: state({ ...atLimit, ...reAdmitted }),
    },
    "the limit decided for a re-admitted row's old attempt: no failure": {
      task: { ...atLimit, ...reAdmitted },
      fence: "none",
      expectedAttemptId: ATTEMPT,
      probes: [...CHECKS, "fail"],
      row: state({ ...atLimit, ...reAdmitted }),
    },
    "the limit with no decided attempt: the row fails": {
      task: atLimit,
      fence: "none",
      probes: [...CHECKS, "fail"],
      row: state({ ...atLimit, ...failedAt }),
    },
    "a fence on a re-admitted row: no charge": {
      task: reAdmitted,
      probes: [...CHECKS, "edit"],
      row: state(reAdmitted),
    },
    "a prompt decided for a re-admitted row's old attempt: no charge": {
      task: reAdmitted,
      fence: "none",
      expectedAttemptId: ATTEMPT,
      probes: [...CHECKS, "edit"],
      row: state(reAdmitted),
    },
    "a stale fence below the limit: charged, then refused": {
      fence: "stale",
      probes: [...CHECKS, "edit"],
      row: state({ taskRecoveryAttempts: 1 }),
    },
    "a prompt whose attempt is stopping: charged, then the binding refuses": {
      fence: "none",
      expectedAttemptId: ATTEMPT,
      script: { stopLatched: true },
      probes: [...CHECKS, "edit", "admit"],
      row: state({ taskRecoveryAttempts: 1 }),
    },
    "a throw in the budget charge": {
      script: { fault: "edit" },
      outcome: { error: FAULT },
      probes: [...CHECKS, "edit"],
    },
    "a throw in the recovery-limit failure": {
      task: atLimit,
      script: { fault: "fail" },
      outcome: { error: FAULT },
      probes: [...CHECKS, "fail"],
      row: state(atLimit),
    },
  };

  test.each(Object.entries(EXITS))("%s: no send, and exact fence disposals", async (_name, c) => {
    const id = c.id ?? TASK_ID;
    const busyChild = task("grandchild", { parentWorkspaceId: TASK_ID, taskStatus: "running" });
    const t = await setup([task(TASK_ID, c.task), ...(c.busyChild ? [busyChild] : [])], c.script);
    const token = c.fence === "none" ? undefined : fenceToken(c.fence === "stale");
    const result = await t.prompt(id, {
      reason: token == null ? "stream_end" : "startup",
      expectedAttemptId: c.expectedAttemptId ?? null,
      ...(token != null ? { fence: token.fence } : {}),
    });
    expect(result).toEqual({ ...(c.outcome ?? { value: false }), probes: c.probes });
    expect(token?.disposals ?? []).toEqual(c.disposals ?? (token == null ? [] : ["refused"]));
    expect(t.sends).toEqual([]);
    expect(rowState(id)).toStrictEqual(c.row === undefined ? state() : c.row);
  });

  test("the recovery-limit failure names the task's completion tool and its prior error", async () => {
    const PLAN_ID = "plan-child";
    const t = await setup([
      task(TASK_ID, atLimit),
      task(PLAN_ID, { ...atLimit, agentId: "plan", agentType: "plan" }),
    ]);
    const prior = { error: "injected model failure", errorType: "empty_output" };
    const failed: { value: boolean; probes: Probe[] } = {
      value: false,
      probes: [...CHECKS, "fail"],
    };
    const options = { reason: "error", error: prior, expectedAttemptId: null } as const;
    expect(await t.prompt(TASK_ID, options)).toEqual(failed);
    expect(await t.prompt(PLAN_ID, { expectedAttemptId: null })).toEqual(failed);
    const message = (id: string) => findWorkspaceInConfig(config, id)?.taskLaunchError ?? "";
    // An exec task owes a final response, a plan task propose_plan. Only the exec prompt had a
    // prior error, and its message carries that error's type and text.
    const facts = (id: string) => [
      message(id).includes("propose_plan"),
      message(id).includes(prior.errorType),
      message(id).includes(prior.error),
    ];
    expect([facts(TASK_ID), facts(PLAN_ID)]).toEqual([
      [false, true, true],
      [true, false, false],
    ]);
  });

  /**
   * One prompt that reaches the send. Defaults: an exec task, no fence and no decided attempt,
   * an accepted send (outcome true), and the probes of a prompt with no binding.
   */
  interface SendCase {
    agentId?: "exec" | "plan";
    fence?: true;
    expectedAttemptId?: string;
    send?: Script["send"];
    outcome?: { value: boolean } | { error: Error };
    probes?: Probe[];
  }
  const SENDS: Record<string, SendCase> = {
    "a fenced send that is accepted": { fence: true },
    "a fenced send that is refused": { fence: true, send: "refused", outcome: { value: false } },
    "a fenced send that throws": { fence: true, send: "throws", outcome: { error: SEND_FAULT } },
    "an unfenced exec prompt with no decided attempt": {},
    "an unfenced plan prompt with no decided attempt": { agentId: "plan" },
    "an unfenced prompt decided for an attempt, bound to it before the send": {
      expectedAttemptId: ATTEMPT,
      probes: [...CHECKS, "edit", "admit", "send"],
    },
  };

  test.each(Object.entries(SENDS))("%s: exact send, and no disposal", async (_name, c) => {
    const agentId = c.agentId ?? "exec";
    const t = await setup([task(TASK_ID, { agentId, agentType: agentId })], { send: c.send });
    const token = c.fence ? fenceToken(false) : undefined;
    const options: PromptOptions =
      token != null
        ? { reason: "startup", fence: token.fence, expectedAttemptId: null }
        : {
            reason: "error",
            error: { error: "failed", errorType: "unknown" },
            expectedAttemptId: c.expectedAttemptId ?? null,
          };
    expect(await t.prompt(TASK_ID, options)).toEqual({
      ...(c.outcome ?? { value: true }),
      probes: c.probes ?? [...CHECKS, "edit", "send"],
    });
    // The prompt never disposes a token it handed off, whatever the send did.
    expect(token?.disposals ?? []).toEqual([]);
    expect(t.sends).toHaveLength(1);
    const [sent] = t.sends;
    // The budget is charged before the send.
    expect(sent.chargedAtSend).toBe(1);
    const kind = agentId === "plan" ? "propose_plan" : "final_response";
    const internal = internals(t.taskService);
    expect(sent.message).toBe(internal.buildTaskCompletionRecoveryMessage(kind, false, options));
    expect(sent.options).toStrictEqual({
      model: MODEL,
      agentId,
      thinkingLevel: "high",
      reasoningMode: undefined,
      serviceTier: undefined,
      ...(agentId === "plan"
        ? { toolPolicy: [{ regex_match: "^propose_plan$", action: "require" }] }
        : {}),
      queueDispatchMode: "turn-end",
    });
    // A bound prompt's token is the one obligation the binding minted for the task.
    const minted = [...(internal.attemptLedger.admittedSendsByTaskId.get(TASK_ID) ?? [])];
    expect(minted).toHaveLength(c.expectedAttemptId != null ? 1 : 0);
    const sentToken = token?.fence.turnAdmission ?? minted[0]?.token;
    const { admissionStale, ...sentInternal } = sent.internal ?? {};
    expect(sentInternal).toStrictEqual({
      acceptanceOrigin: "automatic",
      synthetic: true,
      agentInitiated: true,
      taskTurnKind: "required_report",
      queueDedupeKey: taskRecoveryPromptDedupeKey(TASK_ID, "completion"),
      removableQueueDedupeKey: true,
      startStreamInBackground: token != null,
      ...(sentToken != null ? { turnAdmission: sentToken } : {}),
    });
    // The staleness probe asks the token when the host calls it, not a value from the send.
    if (token != null) token.live.stale = true;
    expect(admissionStale?.()).toBe(sentToken == null ? undefined : token != null);
    expect(rowState(TASK_ID)).toStrictEqual(state({ taskRecoveryAttempts: 1 }));
  });

  test.each([
    ["raises the count to the limit and changes the model", false, RECOVERY_LIMIT + 1],
    ["removes the row", true, undefined],
  ] as const)(
    "another backend %s during the probes: the prompt still sends",
    async (_write, removeRow, chargedAtSend) => {
      // The limit check and the send options read the row the prompt read first. The budget charge
      // reads the row at the charge, and charges nothing when the row is gone.
      const t = await setup([task(TASK_ID)], {
        duringOwnedWork: async () => {
          const otherBackend = await createTestConfig(rootDir);
          // Lands a queued migration write of this Config before the root is removed.
          settles.push(() => otherBackend.editConfig((cfg) => cfg));
          await otherBackend.editConfig((cfg) => {
            for (const project of cfg.projects.values()) {
              const kept = project.workspaces.filter((w) => !removeRow || w.id !== TASK_ID);
              project.workspaces = kept;
              for (const row of kept.filter((w) => w.id === TASK_ID)) {
                row.taskRecoveryAttempts = RECOVERY_LIMIT;
                row.taskModelString = "openai:gpt-4o-mini";
              }
            }
            return cfg;
          });
        },
      });
      expect(await t.prompt(TASK_ID, { expectedAttemptId: null })).toEqual({
        value: true,
        probes: [...CHECKS, "edit", "send"],
      });
      const sent = t.sends.map((send) => [send.chargedAtSend, send.options.model]);
      expect(sent).toStrictEqual([[chargedAtSend, MODEL]]);
    }
  );

  test("an empty workspace id is a programming error", async () => {
    const t = await setup([task(TASK_ID)]);
    expect(await t.prompt("", { expectedAttemptId: null })).toEqual({
      error: expect.any(AssertionError),
      probes: [],
    });
  });
});
