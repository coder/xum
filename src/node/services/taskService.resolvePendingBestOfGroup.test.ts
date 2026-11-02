// Characterization tests for TaskService.resolvePendingBestOfGroupForParent: the step of the deferred
// best-of delivery that picks the child group a parent's pending `task` call waits on. The method is
// private and its only caller (deliverDeferredBestOfReportsForParent) hides the result, so the tests
// call it through a cast, as taskService.handoffAndCleanup.test.ts does for the sibling delivery.
// Each case asserts the picked group (or null) and the config reads the method made, with one row or
// input field that alone decides the outcome, so dropping or negating one condition fails a case.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMuxMessage, type MuxMessage, type MuxMetadata } from "@/common/types/message";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import {
  createTestConfig,
  projectWorkspace,
  saveWorkspaces,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

const PARENT_ID = "parent";
const OTHER_PARENT_ID = "other-parent";
const TITLE = "Best of 2";
/** The pending partial's metadata.timestamp: when the parent's turn started. */
const STARTED_AT = Date.parse("2026-01-01T00:00:00.000Z");
const BEFORE = new Date(STARTED_AT - 60_000).toISOString();
const AT = new Date(STARTED_AT).toISOString();
const AFTER = new Date(STARTED_AT + 60_000).toISOString();

type Input = Record<string, unknown>;
const CURRENT_INPUT: Input = { subagent_type: "explore", prompt: "compare", title: TITLE, n: 2 };
/** The removed `variants` form, which the recovery parser still accepts: its labels set the count. */
const LEGACY_REQUEST: Input = { n: undefined, variants: ["a", "b"] };
/** Only a legacy workspace task names no agent (a current one cannot ask for n > 1). */
const NO_AGENT_REQUEST: Input = { ...LEGACY_REQUEST, kind: "workspace", subagent_type: undefined };

/** A child row. Unset fields take ROW_DEFAULTS; an explicit undefined leaves the field out. */
interface Row {
  group: string;
  total?: number;
  /** Stored as a removed `variants` row: config hides it from the runtime rows. */
  legacy?: boolean;
  parent?: string;
  agentType?: string;
  agentId?: string;
  title?: string;
  /** A number stands for a hand-edited row: config loads it as stored. */
  createdAt?: string | number;
}
const ROW_DEFAULTS = {
  total: 2,
  parent: PARENT_ID,
  agentType: "explore",
  title: TITLE,
  createdAt: AFTER,
};
const inG = (fields: Omit<Row, "group"> = {}): Row => ({ group: "g", ...fields });
const inH = (fields: Omit<Row, "group"> = {}): Row => ({ group: "h", ...fields });

/** `picked` is the expected group id or null. Unless a case says otherwise, the partial holds one
 * pending task call with CURRENT_INPUT plus `input`, stamped STARTED_AT (`timestamp: undefined`: none;
 * a string stands for a corrupt partial, which readPartial returns as stored). */
interface Case {
  name: string;
  rows: Row[];
  picked: string | null;
  input?: Input;
  timestamp?: number | string;
}

function taskCall(
  input: unknown,
  toolCallId: string,
  toolName = "task"
): MuxMessage["parts"][number] {
  return { type: "dynamic-tool", toolCallId, toolName, input, state: "input-available" };
}

interface Internals {
  resolvePendingBestOfGroupForParent: (
    parentWorkspaceId: string
  ) => Promise<{ groupId: string; total: number } | null>;
}

describe("TaskService.resolvePendingBestOfGroupForParent", () => {
  let rootDir: string;
  let config: Config;
  let projectPath: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    config = await createTestConfig(rootDir);
    projectPath = path.join(rootDir, "repo");
  });
  afterEach(async () => {
    mock.restore();
    // allSettled: a test that failed early must still not leave a config write running.
    await Promise.allSettled([settleConfigWrites()]);
    await removeTaskServiceTestRoot(rootDir);
  });

  /**
   * The method starts no background work, but a config read of a file that still needs a load-time
   * migration queues a one-shot migration write. This read queues it, and the edit queued behind it
   * returns once it landed, so the method's own config read finds a migrated file and starts no write.
   */
  async function settleConfigWrites(): Promise<void> {
    config.loadConfigOrDefault();
    await config.editConfig((cfg) => cfg);
  }

  function childEntry(row: Row, index: number): WorkspaceConfigEntry {
    const {
      group,
      total,
      legacy: _legacy,
      parent,
      createdAt,
      ...fields
    } = {
      ...ROW_DEFAULTS,
      ...row,
    };
    const id = `child-${index}`;
    return projectWorkspace(projectPath, id, id, {
      ...fields,
      createdAt: createdAt as string | undefined,
      name: `agent_explore_${index}`,
      parentWorkspaceId: parent,
      taskStatus: "reported",
      bestOf: { groupId: group, index: 0, total },
    });
  }

  /** Rewrites the legacy rows as the removed `variants` groups, the way an old Xum stored them. */
  async function storeAsLegacyRows(rows: Row[]): Promise<void> {
    const configFile = path.join(config.rootDir, "config.json");
    const raw = JSON.parse(await fs.readFile(configFile, "utf-8")) as {
      projects: Array<[string, { workspaces: Array<Record<string, unknown>> }]>;
    };
    const legacyIds = new Set(rows.flatMap((row, index) => (row.legacy ? [`child-${index}`] : [])));
    for (const [, project] of raw.projects) {
      for (const workspace of project.workspaces) {
        if (typeof workspace.id === "string" && legacyIds.has(workspace.id)) {
          workspace.bestOf = {
            ...(workspace.bestOf as object),
            kind: "variants",
            label: workspace.id,
          };
        }
      }
    }
    await fs.writeFile(configFile, JSON.stringify(raw, null, 2));
  }

  /** The group the method picks (the fields its caller reads) and the config reads it made, in order. */
  async function resolve(
    rows: Row[],
    parts: MuxMessage["parts"] | null,
    timestamp?: number | string
  ) {
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", PARENT_ID),
        projectWorkspace(projectPath, "other-parent", OTHER_PARENT_ID),
        ...rows.map(childEntry),
      ],
      testTaskSettings()
    );
    const { historyService, taskService } = createTaskServiceHarness(config);
    if (parts !== null) {
      const metadata =
        timestamp === undefined ? undefined : ({ timestamp } as unknown as MuxMetadata);
      const partial = createMuxMessage("assistant-parent", "assistant", "", metadata, parts);
      expect((await historyService.writePartial(PARENT_ID, partial)).success).toBe(true);
    }
    await storeAsLegacyRows(rows);
    await settleConfigWrites();

    const reads: string[] = [];
    const loadConfig = config.loadConfigOrDefault.bind(config);
    spyOn(config, "loadConfigOrDefault").mockImplementation((options) => {
      reads.push("config");
      return loadConfig(options);
    });
    const listLegacyRows = config.listLegacyTaskVariantWorkspaces.bind(config);
    spyOn(config, "listLegacyTaskVariantWorkspaces").mockImplementation((parentWorkspaceId) => {
      reads.push("legacy");
      return listLegacyRows(parentWorkspaceId);
    });
    const internals = taskService as unknown as Internals;
    const picked = await internals.resolvePendingBestOfGroupForParent(PARENT_ID);
    return {
      picked: picked === null ? null : { groupId: picked.groupId, total: picked.total },
      reads,
    };
  }

  async function expectCase(testCase: Case, legacyRows: boolean): Promise<void> {
    const input = { ...CURRENT_INPUT, ...(legacyRows ? LEGACY_REQUEST : {}), ...testCase.input };
    const rows = legacyRows
      ? testCase.rows.map((row) => ({ ...row, legacy: true }))
      : testCase.rows;
    const timestamp = "timestamp" in testCase ? testCase.timestamp : STARTED_AT;
    expect(await resolve(rows, [taskCall(input, "pending")], timestamp)).toEqual({
      picked: testCase.picked === null ? null : { groupId: testCase.picked, total: 2 },
      reads: input.variants === undefined ? ["config"] : ["config", "legacy"],
    });
  }

  // A matching group "g" exists in each case, so a method that went on would pick it.
  test.each<{ name: string; parts: MuxMessage["parts"] | null }>([
    { name: "no partial", parts: null },
    {
      name: "two pending task calls",
      parts: [taskCall(CURRENT_INPUT, "a"), taskCall(CURRENT_INPUT, "b")],
    },
    {
      name: "an input the recovery parser rejects",
      parts: [taskCall({ ...CURRENT_INPUT, prompt: "" }, "a")],
    },
    { name: "a single task (n: 1)", parts: [taskCall({ ...CURRENT_INPUT, n: 1 }, "a")] },
  ])("$name: null before any config read", async ({ parts }) => {
    expect(await resolve([inG()], parts, STARTED_AT)).toEqual({ picked: null, reads: [] });
  });

  test("only the pending dynamic task call counts", async () => {
    const pending = taskCall(CURRENT_INPUT, "pending");
    const parts = [
      taskCall({}, "shell", "bash"),
      { ...pending, toolCallId: "done", state: "output-available", output: {} },
      // A corrupt text part with a task call's fields, which readPartial returns as stored.
      { ...pending, toolCallId: "not-dynamic", type: "text", text: "" },
      pending,
    ];
    expect(await resolve([inG()], parts as MuxMessage["parts"], STARTED_AT)).toEqual({
      picked: { groupId: "g", total: 2 },
      reads: ["config"],
    });
  });

  // The two row loops (config rows, legacy rows) test the same conditions, each its own way.
  const ROW_MATCH_CASES: Case[] = [
    { name: "a matching row's group", rows: [inG()], picked: "g" },
    {
      name: "a row with another total does not count",
      rows: [inG(), inH({ total: 3 })],
      picked: "g",
    },
    { name: "no row has the requested total", rows: [inH({ total: 3 })], picked: null },
    {
      name: "a row of another agent does not count",
      rows: [inG(), inH({ agentType: "exec" })],
      picked: "g",
    },
    { name: "a row without an agent counts", rows: [inH({ agentType: undefined })], picked: "h" },
    {
      name: "a request without an agent counts any agent",
      input: NO_AGENT_REQUEST,
      rows: [inG({ agentType: "exec" })],
      picked: "g",
    },
    {
      name: "a row with another title does not count",
      rows: [inG(), inH({ title: "Other" })],
      picked: "g",
    },
    {
      name: "a row with a blank title counts as untitled",
      rows: [inH({ title: "  " })],
      picked: "h",
    },
    {
      name: "a blank requested title counts any title",
      input: { title: "  " },
      rows: [inG({ title: "Other" })],
      picked: "g",
    },
    {
      name: "one row that predates the partial keeps its group out",
      rows: [inG({ createdAt: BEFORE }), inG()],
      picked: null,
    },
    {
      name: "a row without a start time adds none",
      rows: [inG({ createdAt: undefined }), inG()],
      picked: "g",
    },
    { name: "a non-string start time adds none", rows: [inG({ createdAt: 2027 })], picked: null },
  ];
  for (const legacyRows of [false, true]) {
    describe(legacyRows ? "legacy variants rows" : "config rows", () => {
      test.each(ROW_MATCH_CASES)("$name", async (testCase) => expectCase(testCase, legacyRows));
    });
  }

  test.each<Case>([
    {
      name: "another parent's row does not count",
      rows: [inG(), inH({ parent: OTHER_PARENT_ID })],
      picked: "g",
    },
    {
      name: "a current request ignores legacy rows",
      rows: [inG(), inH({ legacy: true })],
      picked: "g",
    },
    {
      name: "a config row's agentType wins over its agentId",
      rows: [inH({ agentId: "explore", agentType: "exec" })],
      picked: null,
    },
    {
      name: "a legacy row's agentId wins over its agentType",
      input: LEGACY_REQUEST,
      rows: [inH({ legacy: true, agentId: "explore", agentType: "exec" })],
      picked: "h",
    },
    // Selection.
    {
      name: "without a partial timestamp, a single group counts however old",
      timestamp: undefined,
      rows: [inG({ createdAt: BEFORE })],
      picked: "g",
    },
    {
      name: "a non-numeric partial timestamp counts as none",
      timestamp: "soon",
      rows: [inG({ createdAt: BEFORE })],
      picked: "g",
    },
    {
      name: "without a partial timestamp, two groups pick none",
      timestamp: undefined,
      rows: [inG(), inH()],
      picked: null,
    },
    {
      name: "a single group that predates the partial is not picked",
      rows: [inG({ createdAt: BEFORE })],
      picked: null,
    },
    {
      name: "a group without start times is not recent",
      rows: [inG({ createdAt: undefined })],
      picked: null,
    },
    {
      name: "a row created as the partial started counts",
      rows: [inG({ createdAt: AT })],
      picked: "g",
    },
    {
      name: "of two groups, the one that started after the partial",
      rows: [inG({ createdAt: BEFORE }), inH()],
      picked: "h",
    },
    {
      name: "two groups that started after the partial pick none",
      rows: [inG(), inH()],
      picked: null,
    },
  ])("$name", async (testCase) => expectCase(testCase, false));
});
