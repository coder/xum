import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import {
  TaskHandleStore,
  type WorkspaceTurnTaskHandleRecord,
} from "@/node/services/taskHandleStore";
import {
  createWorkspaceTurnManagerHarness,
  finalizeWorkspaceTurnStreamEndForTest,
  startWorkspaceTurnForTest,
} from "@/node/services/workspaceTurnManager.testHarness";
import type { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import { Ok, type Result } from "@/common/types/result";
import { WORKSPACE_TURN_TASK_TAGS } from "@/constants/workspaceTags";
import { createMuxMessage } from "@/common/types/message";
import type { StreamEndEvent } from "@/common/types/stream";
import {
  createTaskServiceHarness,
  flushTerminalAttentionDrains,
  removeWorkspaceFromTestConfig,
} from "@/node/services/taskService.shared.testHarness";
import {
  createAIServiceMocks,
  createTestConfig,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  streamEnd,
  testTaskSettings,
  workspaceTurnManagerInternals,
  workspaceTurnRecord,
  workspaceTurnStreamEndEvent,
} from "@/node/services/taskService.testHarness";

/**
 * #5569: `getActiveWorkspaceTurnMuxMetadataForWorkspace` must find a target's active turn even
 * when this backend never registered it: another backend created, settled or revived it, or this
 * process restarted. Settle wakes and report rows correlate through this lookup, so a miss runs
 * them uncorrelated. Each backend is a real WorkspaceTurnManager on its own Config instance for
 * the same root.
 */
describe("active workspace-turn lookup without a live registration (#5569)", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-turn-lookup-"));
  });
  afterEach(async () => {
    mock.restore();
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  const lookup = (manager: WorkspaceTurnManager, workspaceId: string) =>
    manager.getActiveWorkspaceTurnMuxMetadataForWorkspace(workspaceId);

  /** Global scans of every owner's handle directory, on the manager's own store instance. */
  const globalScans = (manager: WorkspaceTurnManager) =>
    spyOn(workspaceTurnManagerInternals(manager).taskHandleStore, "scanAllWorkspaceTurns");

  const freshBackend = async () =>
    createWorkspaceTurnManagerHarness(await createTestConfig(rootDir)).taskService;

  const reviveOf = (manager: WorkspaceTurnManager) =>
    (
      manager as unknown as {
        reviveRetryingWorkspaceTurn: (
          record: WorkspaceTurnTaskHandleRecord
        ) => Promise<WorkspaceTurnTaskHandleRecord | null>;
      }
    ).reviveRetryingWorkspaceTurn.bind(manager);

  /** Writes config rows and handle records directly, as another backend left them on disk. */
  async function seedOnDisk(
    rows: (projectPath: string) => WorkspaceConfigEntry[],
    records: WorkspaceTurnTaskHandleRecord[]
  ): Promise<Config> {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    await saveWorkspaces(config, projectPath, rows(projectPath), testTaskSettings());
    const store = new TaskHandleStore(config);
    for (const record of records) await store.upsertWorkspaceTurn(record);
    return config;
  }

  test("T1: finds a delegated root's turn that another backend created after a lookup here", async () => {
    const backendA = await freshBackend();
    const scans = globalScans(backendA);
    expect(await lookup(backendA, "childworkspace")).toBeUndefined();
    // No config row yet, so no creator claim: the global scan answers.
    expect(scans).toHaveBeenCalledTimes(1);

    // Backend B creates the delegated root through its real createWorkspaceTurn.
    const { parentId } = await startWorkspaceTurnForTest(rootDir);

    expect(await lookup(backendA, "childworkspace")).toMatchObject({
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
    });
    // The confirmed creator's directory answers alone (#5569).
    expect(scans).toHaveBeenCalledTimes(1);
  });

  test("T2: finds the follow-up turn of a root without a creator tag or mark", async () => {
    const backendA = createWorkspaceTurnManagerHarness(
      await seedOnDisk(
        (projectPath) => [
          projectWorkspace(projectPath, "owner", "owner"),
          projectWorkspace(projectPath, "untagged", "untagged"),
        ],
        [
          workspaceTurnRecord("owner", "untagged", "wst_create", "completed", {
            createdWorkspace: true,
          }),
          workspaceTurnRecord("owner", "untagged", "wst_follow", "running", {
            createdAt: "2026-06-19T00:00:05.000Z",
          }),
        ]
      )
    ).taskService;

    expect(await lookup(backendA, "untagged")).toMatchObject({
      taskHandleId: "wst_follow",
      ownerWorkspaceId: "owner",
    });
  });

  test("T3: finds a nested agent task's turn owned by its grandparent", async () => {
    const backendA = createWorkspaceTurnManagerHarness(
      await seedOnDisk(
        (projectPath) => [
          projectWorkspace(projectPath, "root", "root"),
          projectWorkspace(projectPath, "mid", "mid", { parentWorkspaceId: "root" }),
          projectWorkspace(projectPath, "leaf", "leaf", { parentWorkspaceId: "mid" }),
        ],
        [workspaceTurnRecord("root", "leaf", "wst_grand", "running")]
      )
    ).taskService;
    const scans = globalScans(backendA);

    expect(await lookup(backendA, "leaf")).toMatchObject({
      taskHandleId: "wst_grand",
      ownerWorkspaceId: "root",
    });
    // The config ancestors' directories answer alone (#5569).
    expect(scans).not.toHaveBeenCalled();
  });

  test("T4: follows another backend's settle, revive and follow-up of a root's turn", async () => {
    const backendA = await freshBackend();
    const {
      config,
      parentId,
      taskService: backendB,
    } = await startWorkspaceTurnForTest(rootDir, {
      stableIds: ["handle", "turn", "secondhandle", "secondturn"],
    });
    const settleOnB = (messageId: string) =>
      finalizeWorkspaceTurnStreamEndForTest(
        backendB,
        workspaceTurnStreamEndEvent(parentId, messageId, "done")
      );
    const handle = { taskHandleId: "wst_handle", ownerWorkspaceId: parentId };
    const scans = globalScans(backendA);

    expect(await lookup(backendA, "childworkspace")).toMatchObject(handle);

    await settleOnB("msg_first");
    expect(await lookup(backendA, "childworkspace")).toBeUndefined();

    const settled = await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle");
    expect(await reviveOf(backendB)(settled!)).toMatchObject({ status: "running" });
    expect(await lookup(backendA, "childworkspace")).toMatchObject(handle);

    // A new turn on the same target must replace the earlier answer, not repeat it.
    await settleOnB("msg_second");
    expect(await lookup(backendA, "childworkspace")).toBeUndefined();
    const followUp = await backendB.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up",
      title: "Follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUp.success).toBe(true);
    expect(await lookup(backendA, "childworkspace")).toMatchObject({
      taskHandleId: "wst_secondhandle",
      ownerWorkspaceId: parentId,
    });
    // Every lookup ran after B created the claimed root, so the creator's directory answered all.
    expect(scans).not.toHaveBeenCalled();
  });

  test("T5: picks the newest running record across an agent task's ancestors", async () => {
    const backendA = createWorkspaceTurnManagerHarness(
      await seedOnDisk(
        (projectPath) => [
          projectWorkspace(projectPath, "root", "root"),
          projectWorkspace(projectPath, "mid", "mid", { parentWorkspaceId: "root" }),
          projectWorkspace(projectPath, "leaf", "leaf", { parentWorkspaceId: "mid" }),
        ],
        [
          workspaceTurnRecord("mid", "leaf", "wst_newer", "running", {
            createdAt: "2026-06-19T00:00:09.000Z",
          }),
          workspaceTurnRecord("root", "leaf", "wst_older", "running", {
            createdAt: "2026-06-19T00:00:01.000Z",
          }),
        ]
      )
    ).taskService;
    const scans = globalScans(backendA);

    expect(await lookup(backendA, "leaf")).toMatchObject({
      taskHandleId: "wst_newer",
      ownerWorkspaceId: "mid",
    });
    expect(scans).not.toHaveBeenCalled();
  });

  test("T6: a restarted backend finds surviving turns of a root and of an agent task", async () => {
    const { config, parentId, projectPath } = await startWorkspaceTurnForTest(rootDir);
    await config.editConfig((cfg) => {
      cfg.projects.get(projectPath)!.workspaces.push(
        projectWorkspace(projectPath, "agent-child", "agentchild", {
          parentWorkspaceId: parentId,
        })
      );
      return cfg;
    });
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "agentchild", "wst_agent", "running")
    );

    const restarted = await freshBackend();
    const scans = globalScans(restarted);

    expect(await lookup(restarted, "childworkspace")).toMatchObject({
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
    });
    expect(scans).not.toHaveBeenCalled();
    expect(await lookup(restarted, "agentchild")).toMatchObject({
      taskHandleId: "wst_agent",
      ownerWorkspaceId: parentId,
    });
    // The agent task's config ancestors answer too (#5569).
    expect(scans).not.toHaveBeenCalled();
  });

  // T7 pins the owner rule the narrowed lookup relies on (#5569). Case (a), a
  // root follow-up by an owner without the root's creating record, is pinned by
  // workspaceTurnManager.createWorkspaceTurn.test.ts ("other-parent" and "independently created
  // root" cases).
  test("T7b: the reawaken path refuses an agent task for an owner that is not its ancestor", async () => {
    const config = await seedOnDisk(
      (projectPath) => [
        projectWorkspace(projectPath, "parent", "parent"),
        projectWorkspace(projectPath, "stranger", "stranger"),
        projectWorkspace(projectPath, "child", "child", {
          parentWorkspaceId: "parent",
          agentType: "explore",
          taskStatus: "reported",
          runtimeConfig: { type: "local" },
        }),
      ],
      []
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, { workspaceService });

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: "stranger",
      prompt: "Continue",
      title: "Reawaken",
      allowAgentWorkspace: true,
      workspace: { mode: "existing", workspaceId: "child" },
    });

    expect(result.success ? "admitted" : result.error).toContain("invalid_scope");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  /** A claimed root whose real creator `owner` holds its creating record and a running follow-up. */
  const createdAndRunning = (owner: string, target: string) => [
    workspaceTurnRecord(owner, target, `wst_create_${target}`, "completed", {
      createdWorkspace: true,
    }),
    workspaceTurnRecord(owner, target, `wst_follow_${target}`, "running", {
      createdAt: "2026-06-19T00:00:05.000Z",
    }),
  ];
  const claimTag = (ownerWorkspaceId: string) => ({
    tags: { [WORKSPACE_TURN_TASK_TAGS.ownerWorkspaceId]: ownerWorkspaceId },
  });

  test("T8a: a tag naming an owner without the creating record falls back to the global scan", async () => {
    const backendA = createWorkspaceTurnManagerHarness(
      await seedOnDisk(
        (projectPath) => [
          projectWorkspace(projectPath, "owner", "owner"),
          projectWorkspace(projectPath, "stranger", "stranger"),
          projectWorkspace(projectPath, "target", "target", claimTag("stranger")),
        ],
        [
          ...createdAndRunning("owner", "target"),
          workspaceTurnRecord("stranger", "elsewhere", "wst_elsewhere", "running"),
        ]
      )
    ).taskService;
    const scans = globalScans(backendA);

    expect(await lookup(backendA, "target")).toMatchObject({
      taskHandleId: "wst_follow_target",
      ownerWorkspaceId: "owner",
    });
    expect(scans).toHaveBeenCalledTimes(1);
  });

  test("T8b: a creation still in flight is answered by the global scan until its record lands", async () => {
    const config = await seedOnDisk(
      (projectPath) => [
        projectWorkspace(projectPath, "owner", "owner"),
        projectWorkspace(projectPath, "target", "target", {
          delegatedCreation: { handleId: "wst_create", ownerWorkspaceId: "owner" },
        }),
      ],
      []
    );
    const backendA = createWorkspaceTurnManagerHarness(config).taskService;
    const scans = globalScans(backendA);

    expect(await lookup(backendA, "target")).toBeUndefined();
    expect(scans).toHaveBeenCalledTimes(1);

    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord("owner", "target", "wst_create", "running", { createdWorkspace: true })
    );
    expect(await lookup(backendA, "target")).toMatchObject({
      taskHandleId: "wst_create",
      ownerWorkspaceId: "owner",
    });
    expect(scans).toHaveBeenCalledTimes(1);
  });

  test("T8c: a claim that is not one path segment is never listed", async () => {
    // The last claim is a hand-edited non-string tag: config loading keeps tag values as written.
    const claims = ["../x", ".", "..", "own\0er", " ", 42 as unknown as string];
    const targets = claims.map((_, index) => `target${index}`);
    const backendA = createWorkspaceTurnManagerHarness(
      await seedOnDisk(
        (projectPath) => [
          projectWorkspace(projectPath, "owner", "owner"),
          ...targets.map((target, index) =>
            projectWorkspace(projectPath, target, target, claimTag(claims[index]))
          ),
        ],
        targets.flatMap((target) => createdAndRunning("owner", target))
      )
    ).taskService;
    const listings = spyOn(
      workspaceTurnManagerInternals(backendA).taskHandleStore,
      "listWorkspaceTurns"
    );

    for (const target of targets) {
      expect(await lookup(backendA, target)).toMatchObject({
        taskHandleId: `wst_follow_${target}`,
        ownerWorkspaceId: "owner",
      });
    }
    const listedOwners = listings.mock.calls.map(([ownerWorkspaceId]) => ownerWorkspaceId);
    expect(listedOwners).toContain("owner");
    for (const claim of claims) expect(listedOwners).not.toContain(claim);
  });

  test("T8d: an unreadable creator directory falls back to the global scan", async () => {
    const backendA = createWorkspaceTurnManagerHarness(
      await seedOnDisk(
        (projectPath) => [
          projectWorkspace(projectPath, "owner", "owner"),
          projectWorkspace(projectPath, "target", "target", claimTag("owner")),
        ],
        createdAndRunning("owner", "target")
      )
    ).taskService;
    const store = workspaceTurnManagerInternals(backendA).taskHandleStore;
    const scans = globalScans(backendA);
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    spyOn(store, "listWorkspaceTurns").mockImplementationOnce(() => Promise.reject(denied));

    expect(await lookup(backendA, "target")).toMatchObject({
      taskHandleId: "wst_follow_target",
      ownerWorkspaceId: "owner",
    });
    expect(scans).toHaveBeenCalledTimes(1);
  });

  test("T8e: a workspace ID on two config rows falls back to the global scan", async () => {
    // Corrupted config: the first row is a confirmed claimed root, a second row with the same ID is
    // an agent task whose parent holds a newer running record. Trusting the first row would hide it.
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const otherProjectPath = path.join(rootDir, "repo2");
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "owner", "owner"),
        projectWorkspace(projectPath, "parent", "parent"),
        projectWorkspace(projectPath, "target", "target", claimTag("owner")),
      ],
      {
        taskSettings: testTaskSettings(),
        extraProjects: [
          [
            otherProjectPath,
            {
              trusted: true,
              workspaces: [
                projectWorkspace(otherProjectPath, "target", "target", {
                  parentWorkspaceId: "parent",
                }),
              ],
            },
          ],
        ],
      }
    );
    const store = new TaskHandleStore(config);
    for (const record of [
      ...createdAndRunning("owner", "target"),
      workspaceTurnRecord("parent", "target", "wst_agent_target", "running", {
        createdAt: "2026-06-19T00:00:09.000Z",
      }),
    ]) {
      await store.upsertWorkspaceTurn(record);
    }
    const backendA = createWorkspaceTurnManagerHarness(config).taskService;
    const scans = globalScans(backendA);

    expect(await lookup(backendA, "target")).toMatchObject({
      taskHandleId: "wst_agent_target",
      ownerWorkspaceId: "parent",
    });
    expect(scans).toHaveBeenCalledTimes(1);
  });

  /** Seeds `rows` and `records`, then expects the global scan to answer `target` with `expected`. */
  async function expectGlobalScanAnswer(
    rows: (projectPath: string) => WorkspaceConfigEntry[],
    records: WorkspaceTurnTaskHandleRecord[],
    target: string,
    expected: { taskHandleId: string; ownerWorkspaceId: string }
  ) {
    const backendA = createWorkspaceTurnManagerHarness(await seedOnDisk(rows, records)).taskService;
    const scans = globalScans(backendA);
    expect(await lookup(backendA, target)).toMatchObject(expected);
    expect(scans).toHaveBeenCalledTimes(1);
  }
  /** A chain `${prefix}0` (the target) up to the root `${prefix}${levels}`. */
  const chain = (projectPath: string, prefix: string, levels: number) =>
    Array.from({ length: levels + 1 }, (_, level) =>
      projectWorkspace(projectPath, `${prefix}${level}`, `${prefix}${level}`, {
        ...(level < levels ? { parentWorkspaceId: `${prefix}${level + 1}` } : {}),
      })
    );

  test("T11a: an ancestor ID on two config rows falls back to the global scan", async () => {
    // The first "mid" row is a root. The second has parent "grand", which holds the running record.
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const otherProjectPath = path.join(rootDir, "repo2");
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "leaf", "leaf", { parentWorkspaceId: "mid" }),
        projectWorkspace(projectPath, "mid", "mid"),
        projectWorkspace(projectPath, "grand", "grand"),
      ],
      {
        taskSettings: testTaskSettings(),
        extraProjects: [
          [
            otherProjectPath,
            {
              trusted: true,
              workspaces: [
                projectWorkspace(otherProjectPath, "mid", "mid", { parentWorkspaceId: "grand" }),
              ],
            },
          ],
        ],
      }
    );
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord("grand", "leaf", "wst_grand", "running")
    );
    const backendA = createWorkspaceTurnManagerHarness(config).taskService;
    const scans = globalScans(backendA);

    expect(await lookup(backendA, "leaf")).toMatchObject({
      taskHandleId: "wst_grand",
      ownerWorkspaceId: "grand",
    });
    expect(scans).toHaveBeenCalledTimes(1);
  });

  test("T11b: a missing ancestor row falls back to the global scan", async () => {
    await expectGlobalScanAnswer(
      (projectPath) => [
        projectWorkspace(projectPath, "leaf", "leaf", { parentWorkspaceId: "gone" }),
        projectWorkspace(projectPath, "above", "above"),
      ],
      [workspaceTurnRecord("above", "leaf", "wst_above", "running")],
      "leaf",
      { taskHandleId: "wst_above", ownerWorkspaceId: "above" }
    );
  });

  test("T11c: more than 64 ancestor levels, or a cycle, fall back to the global scan", async () => {
    await expectGlobalScanAnswer(
      (projectPath) => chain(projectPath, "deep", 65),
      [workspaceTurnRecord("deep65", "deep0", "wst_deep", "running")],
      "deep0",
      { taskHandleId: "wst_deep", ownerWorkspaceId: "deep65" }
    );

    // 64 levels still resolve from the ancestors' directories.
    const backendA = createWorkspaceTurnManagerHarness(
      await seedOnDisk(
        (projectPath) => chain(projectPath, "edge", 64),
        [workspaceTurnRecord("edge64", "edge0", "wst_edge", "running")]
      )
    ).taskService;
    const scans = globalScans(backendA);
    expect(await lookup(backendA, "edge0")).toMatchObject({ taskHandleId: "wst_edge" });
    expect(scans).not.toHaveBeenCalled();

    // Last: without the level limit this walk never ends. "ring1" is an ancestor of "ring0"
    // through the cycle, so the owner rule admits its record.
    await expectGlobalScanAnswer(
      (projectPath) => [
        projectWorkspace(projectPath, "ring0", "ring0", { parentWorkspaceId: "ring1" }),
        projectWorkspace(projectPath, "ring1", "ring1", { parentWorkspaceId: "ring0" }),
      ],
      [workspaceTurnRecord("ring1", "ring0", "wst_ring", "running")],
      "ring0",
      { taskHandleId: "wst_ring", ownerWorkspaceId: "ring1" }
    );
  });

  test("T12: an unreadable ancestor directory falls back to the global scan", async () => {
    const backendA = createWorkspaceTurnManagerHarness(
      await seedOnDisk(
        (projectPath) => [
          projectWorkspace(projectPath, "root", "root"),
          projectWorkspace(projectPath, "mid", "mid", { parentWorkspaceId: "root" }),
          projectWorkspace(projectPath, "leaf", "leaf", { parentWorkspaceId: "mid" }),
        ],
        [workspaceTurnRecord("mid", "leaf", "wst_mid", "running")]
      )
    ).taskService;
    const store = workspaceTurnManagerInternals(backendA).taskHandleStore;
    const scans = globalScans(backendA);
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const listings = spyOn(store, "listWorkspaceTurns").mockImplementationOnce(() =>
      Promise.reject(denied)
    );

    expect(await lookup(backendA, "leaf")).toMatchObject({
      taskHandleId: "wst_mid",
      ownerWorkspaceId: "mid",
    });
    expect(listings.mock.calls[0]?.[0]).toBe("mid");
    expect(scans).toHaveBeenCalledTimes(1);
  });

  test("T9: matches the global scan on generated stores that obey the owner rule", async () => {
    // Deterministic LCG so a failure reproduces exactly.
    let seed = 5569;
    const next = (bound: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };
    const statuses: Array<WorkspaceTurnTaskHandleRecord["status"]> = [
      "queued",
      "starting",
      "running",
      "completed",
      "interrupted",
      "error",
    ];
    // Few distinct timestamps, so createdAt ties occur within one owner and across owners.
    const at = (second: number) => `2026-06-19T00:00:0${second}.000Z`;
    let handleSeq = 0;
    const handle = () => `wst_g${handleSeq++}`;
    const randomTurn = (owner: string, target: string) =>
      workspaceTurnRecord(owner, target, handle(), statuses[next(statuses.length)], {
        createdAt: at(next(4)),
      });

    const owners = ["own0", "own1", "own2", "own3"];
    const rows: Array<{ dir: string; id: string; options?: Partial<WorkspaceConfigEntry> }> =
      owners.map((id) => ({ dir: id, id }));
    const records: WorkspaceTurnTaskHandleRecord[] = [];
    const zeroByte: Array<{ owner: string; handleId: string }> = [];
    const confirmed = new Set<string>();

    // Fixed cases first: each fails one mutation of the creator branch for certain.
    rows.push({ dir: "fq", id: "fixedqueued", options: claimTag("own0") });
    records.push(
      workspaceTurnRecord("own0", "fixedqueued", handle(), "completed", { createdWorkspace: true }),
      workspaceTurnRecord("own0", "fixedqueued", handle(), "running", { createdAt: at(1) }),
      workspaceTurnRecord("own0", "fixedqueued", handle(), "queued", { createdAt: at(2) })
    );
    confirmed.add("fixedqueued");
    rows.push({ dir: "fn", id: "fixednewest", options: claimTag("own1") });
    records.push(
      workspaceTurnRecord("own1", "fixednewest", handle(), "running", { createdWorkspace: true }),
      workspaceTurnRecord("own1", "fixednewest", handle(), "starting", { createdAt: at(3) })
    );
    confirmed.add("fixednewest");
    rows.push({ dir: "fw", id: "fixedwrong", options: claimTag("own3") });
    records.push(
      workspaceTurnRecord("own2", "fixedwrong", handle(), "completed", { createdWorkspace: true }),
      workspaceTurnRecord("own2", "fixedwrong", handle(), "running", { createdAt: at(1) })
    );
    // Fixed agent cases: the grandparent holds the newest record, then a cross-owner tie.
    for (const prefix of ["fixedgrand", "fixedtie"]) {
      rows.push(
        { dir: prefix, id: prefix },
        { dir: `${prefix}a`, id: `${prefix}a`, options: { parentWorkspaceId: prefix } },
        { dir: `${prefix}b`, id: `${prefix}b`, options: { parentWorkspaceId: `${prefix}a` } }
      );
    }
    records.push(
      workspaceTurnRecord("fixedgranda", "fixedgrandb", handle(), "running", { createdAt: at(1) }),
      workspaceTurnRecord("fixedgrand", "fixedgrandb", handle(), "running", { createdAt: at(3) }),
      workspaceTurnRecord("fixedtiea", "fixedtieb", handle(), "running", { createdAt: at(2) }),
      workspaceTurnRecord("fixedtie", "fixedtieb", handle(), "starting", { createdAt: at(2) })
    );

    const kinds = [
      "claimedTag",
      "claimedMark",
      "wrongClaim",
      "markInFlight",
      "zeroByteCreate",
      "untagged",
      "userRoot",
      "agentChain",
    ] as const;
    for (let index = 0; index < 32; index++) {
      const kind = kinds[index % kinds.length];
      const target = `case${index}`;
      const creator = owners[next(owners.length)];
      const other = owners[(owners.indexOf(creator) + 1 + next(owners.length - 1)) % owners.length];
      const createHandle = handle();
      const creating = workspaceTurnRecord(creator, target, createHandle, statuses[next(6)], {
        createdWorkspace: true,
        createdAt: at(next(4)),
      });
      const followUps = Array.from({ length: next(4) }, () => randomTurn(creator, target));
      if (kind === "agentChain") {
        // An agent chain under a user-created root, with records from several ancestors.
        rows.push({ dir: target, id: target });
        const chain = [target];
        for (let depth = 1; depth <= 1 + next(5); depth++) {
          const agent = `${target}a${depth}`;
          rows.push({ dir: agent, id: agent, options: { parentWorkspaceId: chain.at(-1) } });
          for (let n = next(4); n > 0; n--)
            records.push(randomTurn(chain[next(chain.length)], agent));
          chain.push(agent);
        }
        continue;
      }
      if (kind === "userRoot") {
        rows.push({ dir: target, id: target });
        continue;
      }
      if (kind === "markInFlight") {
        rows.push({
          dir: target,
          id: target,
          options: { delegatedCreation: { handleId: createHandle, ownerWorkspaceId: creator } },
        });
        continue;
      }
      const options: Partial<WorkspaceConfigEntry> =
        kind === "claimedMark"
          ? {
              delegatedCreation: { handleId: createHandle, ownerWorkspaceId: creator },
              // The mark outranks a tag that names someone else.
              ...(next(2) === 0 ? claimTag(other) : {}),
            }
          : kind === "wrongClaim"
            ? claimTag(other)
            : kind === "untagged"
              ? {}
              : claimTag(creator);
      rows.push({ dir: target, id: target, options });
      records.push(...followUps);
      if (kind === "zeroByteCreate") zeroByte.push({ owner: creator, handleId: createHandle });
      else records.push(creating);
      if (kind === "claimedTag" || kind === "claimedMark") confirmed.add(target);
    }

    const config = await seedOnDisk(
      (projectPath) =>
        rows.map((row) => projectWorkspace(projectPath, row.dir, row.id, row.options)),
      records
    );
    for (const { owner, handleId } of zeroByte) {
      const dir = path.join(config.sessionsDir, owner, "task-handles");
      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(path.join(dir, `${handleId}.json`), "");
    }
    const oracleStore = new TaskHandleStore(config);
    const backendA = createWorkspaceTurnManagerHarness(config).taskService;
    const scans = globalScans(backendA);

    expect(rows.length).toBeGreaterThanOrEqual(40);
    const agentTasks = new Set(
      rows.filter((row) => row.options?.parentWorkspaceId).map((r) => r.id)
    );
    for (const { id } of rows) {
      const active = await oracleStore.listAllWorkspaceTurns({ statuses: ["starting", "running"] });
      const expected = active.toReversed().find((record) => record.workspaceId === id);
      // An agent task falls back only when another owner ties its newest record's createdAt.
      const tiedAcrossOwners = active.some(
        (record) =>
          record.workspaceId === id &&
          record.ownerWorkspaceId !== expected?.ownerWorkspaceId &&
          record.createdAt === expected?.createdAt
      );
      const scansBefore = scans.mock.calls.length;
      const actual = await lookup(backendA, id);
      expect({ id, handle: actual?.taskHandleId, owner: actual?.ownerWorkspaceId }).toEqual({
        id,
        handle: expected?.handleId,
        owner: expected?.ownerWorkspaceId,
      });
      expect({ id, scans: scans.mock.calls.length - scansBefore }).toEqual({
        id,
        scans: confirmed.has(id) || (agentTasks.has(id) && !tiedAcrossOwners) ? 0 : 1,
      });
    }
  });

  /**
   * Drives one sub-agent settle of "child" under "parent" through the real TaskService stack.
   * Report delivery, terminal-attention drains and the queue drain all look the parent's turn up.
   * Returns how many lookups, global scans and handle-file reads the settle ran.
   */
  async function settleChildUnderParent(config: Config, mode: "fg" | "bg" | "busy") {
    // busy: the parent streams a cuttable turn until `release`, then goes idle.
    const busy = { streaming: mode === "busy", turn: Symbol("parent-turn") };
    let release = () => undefined as void;
    const idle = new Promise<void>((resolve) => (release = resolve));
    const { aiService } = createAIServiceMocks(config, {
      isStreaming: mock((id: string) => busy.streaming && id === "parent"),
    });
    const { workspaceService, resumeStream, sendMessage } = createWorkspaceServiceMocks({
      remove: mock(async (workspaceId: string): Promise<Result<void>> => {
        await removeWorkspaceFromTestConfig(config, workspaceId);
        return Ok(undefined);
      }),
      getActiveTurnGeneration: mock((id: string) =>
        busy.streaming && id === "parent" ? busy.turn : undefined
      ),
      waitForIdleAndNoQueuedMessages: mock((id: string) =>
        busy.streaming && id === "parent" ? idle : Promise.resolve()
      ),
    });
    const { taskService, partialService, historyService, workspaceTurnManager } =
      createTaskServiceHarness(config, { aiService, workspaceService });

    if (mode === "fg") {
      // fg: the parent waits on the task tool, so the report finalizes the parent's partial.
      const parentPartial = createMuxMessage(
        "assistant-parent-partial",
        "assistant",
        "Waiting on subagent",
        { timestamp: Date.now() },
        [
          {
            type: "dynamic-tool",
            toolCallId: "task-call-1",
            toolName: "task",
            input: { subagent_type: "explore", prompt: "do the thing", title: "Test task" },
            state: "input-available",
          },
        ]
      );
      expect((await partialService.writePartial("parent", parentPartial)).success).toBe(true);
    }
    const prompt = createMuxMessage("user-child-prompt", "user", "do the thing", {
      timestamp: Date.now(),
    });
    expect((await historyService.appendToHistory("child", prompt)).success).toBe(true);
    const placeholder = createMuxMessage("assistant-child-partial", "assistant", "", {
      timestamp: Date.now(),
    });
    expect((await historyService.appendToHistory("child", placeholder)).success).toBe(true);
    const parts: StreamEndEvent["parts"] = [
      {
        type: "dynamic-tool",
        toolCallId: "agent-report-call-1",
        toolName: "agent_report",
        input: { reportMarkdown: "Hello from child", title: "Result" },
        state: "output-available",
        output: { success: true },
      },
      { type: "text", text: "Hello from child" },
    ];
    const childPartial = createMuxMessage(
      "assistant-child-partial",
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: placeholder.metadata?.historySequence },
      parts
    );
    expect((await partialService.writePartial("child", childPartial)).success).toBe(true);
    expect((await partialService.commitPartial("child")).success).toBe(true);

    const scans = spyOn(TaskHandleStore.prototype, "scanAllWorkspaceTurns");
    const reads = spyOn(
      TaskHandleStore.prototype as unknown as { readWorkspaceTurnFile: () => unknown },
      "readWorkspaceTurnFile"
    );
    const lookups = spyOn(
      workspaceTurnManager as unknown as {
        getActiveWorkspaceTurnRecordForWorkspace: () => unknown;
      },
      "getActiveWorkspaceTurnRecordForWorkspace"
    );
    const wakes = () => resumeStream.mock.calls.length + sendMessage.mock.calls.length;

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: "child",
      messageId: "assistant-child-partial",
      metadata: { model: "test-model", finishReason: "stop" },
      parts,
    });
    if (mode === "busy") {
      // The cut wake runs while the parent still streams; the after-idle drain waits on
      // `idle`, so drains cannot be flushed until the parent's turn ends.
      for (let spin = 0; spin < 10_000 && wakes() === 0; spin++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(wakes()).toBe(1);
      busy.streaming = false;
      release();
      await streamEnd(taskService, {
        type: "stream-end",
        workspaceId: "parent",
        messageId: "assistant-parent-turn",
        metadata: { model: "test-model", finishReason: "stop" },
        parts: [],
      });
    }
    await flushTerminalAttentionDrains(taskService);
    await taskService.queueDrainSettled();

    // The settle really happened: the child reported and the parent woke (busy: cut + idle).
    expect(findWorkspaceInConfig(config, "child")?.taskStatus).toBe("reported");
    expect(wakes()).toBe(mode === "busy" ? 2 : 1);
    expect(lookups.mock.calls.length).toBeGreaterThan(0);
    return {
      lookups: lookups.mock.calls.length,
      scans: scans.mock.calls.length,
      reads: reads.mock.calls.length,
    };
  }

  // T10: the whole sub-agent settle under a claimed root parent stays inside the creator's
  // directory: report delivery, terminal-attention drains and the queue drain all look the
  // parent's turn up, and none of them may fall back to the global scan.
  test.each(["fg", "bg", "busy"] as const)(
    "T10: a sub-agent settle under a claimed root parent runs no global scan (%s)",
    async (mode) => {
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");
      const creatorFiles = 20;
      const otherOwners = ["other0", "other1", "other2"];
      await saveWorkspaces(
        config,
        projectPath,
        [
          projectWorkspace(projectPath, "creator", "creator"),
          ...otherOwners.map((owner) => projectWorkspace(projectPath, owner, owner)),
          projectWorkspace(projectPath, "parent", "parent", {
            tags: {
              [WORKSPACE_TURN_TASK_TAGS.handle]: "wst_create",
              [WORKSPACE_TURN_TASK_TAGS.ownerWorkspaceId]: "creator",
              [WORKSPACE_TURN_TASK_TAGS.turn]: "turn",
            },
          }),
          projectWorkspace(projectPath, "child", "child", {
            parentWorkspaceId: "parent",
            agentType: "explore",
            taskStatus: "running",
          }),
        ],
        testTaskSettings()
      );
      const store = new TaskHandleStore(config);
      await store.upsertWorkspaceTurn(
        workspaceTurnRecord("creator", "parent", "wst_create", "completed", {
          createdWorkspace: true,
        })
      );
      for (let index = 1; index < creatorFiles; index++) {
        await store.upsertWorkspaceTurn(
          workspaceTurnRecord("creator", `done${index}`, `wst_c${index}`, "completed")
        );
      }
      for (const owner of otherOwners) {
        for (let index = 0; index < 40; index++) {
          await store.upsertWorkspaceTurn(
            workspaceTurnRecord(owner, `${owner}t${index}`, `wst_${owner}_${index}`, "completed")
          );
        }
      }

      const settle = await settleChildUnderParent(config, mode);
      expect(settle.scans).toBe(0);
      expect(settle.reads).toBeLessThanOrEqual(settle.lookups * creatorFiles + 30);
    }
  );

  // T13: the same settle under an agent-task parent reads only the parent's config ancestors.
  test.each(["fg", "bg", "busy"] as const)(
    "T13: a sub-agent settle under an agent-task parent runs no global scan (%s)",
    async (mode) => {
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");
      const rootFiles = 20;
      const otherOwners = ["other0", "other1", "other2"];
      await saveWorkspaces(
        config,
        projectPath,
        [
          projectWorkspace(projectPath, "root", "root"),
          ...otherOwners.map((owner) => projectWorkspace(projectPath, owner, owner)),
          projectWorkspace(projectPath, "parent", "parent", {
            parentWorkspaceId: "root",
            agentType: "explore",
            taskStatus: "running",
          }),
          projectWorkspace(projectPath, "child", "child", {
            parentWorkspaceId: "parent",
            agentType: "explore",
            taskStatus: "running",
          }),
        ],
        testTaskSettings()
      );
      const store = new TaskHandleStore(config);
      for (let index = 0; index < rootFiles; index++) {
        await store.upsertWorkspaceTurn(
          workspaceTurnRecord("root", `done${index}`, `wst_r${index}`, "completed")
        );
      }
      for (const owner of otherOwners) {
        for (let index = 0; index < 40; index++) {
          await store.upsertWorkspaceTurn(
            workspaceTurnRecord(owner, `${owner}t${index}`, `wst_${owner}_${index}`, "completed")
          );
        }
      }

      const settle = await settleChildUnderParent(config, mode);
      expect(settle.scans).toBe(0);
      expect(settle.reads).toBeLessThanOrEqual(settle.lookups * rootFiles + 30);
    }
  );
});
