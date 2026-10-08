import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import * as nativeFs from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { Config } from "@/node/config";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { isMultiProject } from "@/common/utils/multiProject";
import {
  createMockAIService,
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";
import { createTaskServiceStack, createWorkspaceServiceMocks } from "./taskService.testHarness";

// Callers 1-3 of #5727 F1b read one row: WorkspaceService.getInfo, the AI-settings emit and
// TaskService.emitWorkspaceMetadata. Each case writes a fixture, reads through one caller and
// compares the row with an oracle run on a copy of the root taken at the caller's read: `full` is
// `getAllWorkspaceMetadata().find(id)`, `byId` is `getWorkspaceMetadataById(id)`. `expected` pins
// the field that tells the full and by-id builds apart (O1, O2, P1, T1) or the shared answer.

type Row = FrontendWorkspaceMetadata | null;
type Expected = Partial<FrontendWorkspaceMetadata> | null;
type CallerName =
  | "getInfo"
  | "AI-settings emit"
  | "TaskService.emitWorkspaceMetadata"
  | "updateTags";

/** Why a case does not count at a caller: the edit returns this error before the emit. */
interface Unreachable {
  refused: string;
}

interface Case {
  name: string;
  /** config.json projects; ids resolve under the per-test root. */
  projects: () => Array<[string, { workspaces: Array<Record<string, unknown>> }]>;
  /** Files under sessions/ as JSON; DIR makes a directory at that path. */
  sessions?: Record<string, unknown>;
  /** K1 and P1 depend on probes: no checkout directories. Others get one per row. */
  noCheckouts?: true;
  id: string;
  expected: Expected;
  expectedAt?: Partial<Record<CallerName, Expected>>;
  oracle?: "full" | "byId";
  /** Read by the same caller at T1, before the asserted reads at T2. */
  warmup?: string;
  calls?: number;
  unreachableAt?: Partial<Record<CallerName, Unreachable>>;
}

const DIR = Symbol("directory");
const T0 = "2025-06-01T00:00:00.000Z";
const T1 = "2026-03-01T00:00:00.000Z";
const T2 = "2026-03-02T00:00:00.000Z";
const L = "repo-feat"; // config.generateLegacyId(repo(), ws("feat"))

let root: string;
const repo = () => path.join(root, "p", "repo");
const ws = (name: string) => path.join(root, "s", "repo", name);
const row = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  name: id,
  path: ws(id),
  createdAt: "2026-01-01T00:00:00.000Z",
  runtimeConfig: { type: "local" },
  ...fields,
});
const inRepo =
  (...workspaces: Array<Record<string, unknown>>) =>
  () =>
    [[repo(), { workspaces }]] as Array<[string, { workspaces: Array<Record<string, unknown>> }]>;
const worktree = () => ({ type: "worktree", srcBaseDir: path.join(root, "s") });
/** An id-less row, then a persisted row with the id the first one resolves to. */
const idlessFirst = (laterId: string) => () =>
  inRepo({ path: ws("feat") }, row(laterId, { name: "other", path: ws("other") }))();

const cases: Case[] = [
  {
    name: "O1",
    projects: idlessFirst("X1"),
    sessions: { [`${L}/metadata.json`]: { id: "X1", name: "feat", createdAt: T0 } },
    id: "X1",
    expected: { name: "feat", createdAt: T0 },
  },
  { name: "O1l", projects: idlessFirst(L), id: L, expected: { name: "feat" } },
  {
    // EISDIR: the lenient build falls back to L and records no migration, so it lasts.
    name: "O1d",
    projects: idlessFirst(L),
    sessions: { [`${L}/metadata.json`]: DIR },
    id: L,
    expected: { name: "feat" },
    calls: 2,
  },
  {
    name: "O2",
    projects: () => inRepo({ path: ws("a") }, { path: ws("b") })(),
    sessions: {
      "repo-a/metadata.json": { id: "A1" },
      "a/metadata.json": { id: "X" },
      "repo-b/metadata.json": { id: "X" },
    },
    id: "X",
    expected: { name: "b" },
  },
  {
    // A project stored at "/". Since #5918 it loads as "/" (an old "" key too), so both builds
    // keep it and agree on its row (F1b amendment: O3 is an agree case, like D1).
    name: "O3",
    projects: () => [
      ["/", { workspaces: [row("X", { name: "slash", path: ws("slash") })] }],
      [repo(), { workspaces: [row("X", { name: "later", path: ws("later") })] }],
    ],
    id: "X",
    expected: { name: "slash" },
  },
  {
    // 32 stalled checkouts hold the probe concurrency past the build's shared 2 s deadline, so X
    // (missing, last) answers its last-known state: present.
    name: "P1",
    projects: () =>
      inRepo(
        ...Array.from({ length: 32 }, (_, i) => row(`stall-${i}`, { runtimeConfig: worktree() })),
        row("X", { runtimeConfig: worktree() })
      )(),
    noCheckouts: true,
    id: "X",
    expected: { transcriptOnly: undefined },
    oracle: "full",
  },
  {
    // The full build behind the X read at T1 assigns and saves Y's createdAt.
    name: "T1",
    projects: () => inRepo(row("X"), row("Y", { createdAt: undefined }))(),
    warmup: "X",
    id: "Y",
    expected: { createdAt: T1 },
    oracle: "full",
  },
  {
    name: "D1",
    projects: () =>
      inRepo(
        row("X", { title: "first", path: ws("one") }),
        row("X", { title: "second", path: ws("two") })
      )(),
    id: "X",
    expected: { title: "first" },
    expectedAt: { updateTags: { title: "second" } },
  },
  {
    name: "K1",
    projects: () => inRepo(row("X", { runtimeConfig: worktree() }))(),
    noCheckouts: true,
    id: "X",
    expected: { transcriptOnly: true },
  },
  {
    name: "U1",
    projects: inRepo(),
    id: "missing",
    expected: null,
    unreachableAt: { "AI-settings emit": { refused: "Workspace not found" } },
  },
  {
    // Hidden from getInfo while the multi-project experiment is off; the emits still carry it.
    name: "H1",
    projects: () => [
      [
        "_multi",
        {
          workspaces: [
            row("X", {
              projects: [
                { projectPath: repo(), projectName: "repo" },
                { projectPath: path.join(root, "p", "other"), projectName: "other" },
              ],
            }),
          ],
        },
      ],
    ],
    id: "X",
    expected: { id: "X" },
    expectedAt: { getInfo: null },
  },
];

interface MetadataEvent {
  workspaceId: string;
  metadata: Row;
}

interface Context {
  harness: WorkspaceServiceHarness;
  taskService: ReturnType<typeof createTaskServiceStack>["taskService"];
  /** TaskService emits through its WorkspaceHost; this double records those emits. */
  hostEmit: ReturnType<typeof mock<(event: string, payload: MetadataEvent) => boolean>>;
  /** WorkspaceService's own `metadata` events. */
  emitted: MetadataEvent[];
  /** One oracle per read, started on a copy of the root taken at that read. */
  oracles: Array<Promise<Row>>;
  snapshot(id: string): void;
}

interface Caller {
  name: CallerName;
  /** The row the caller returns or emits, or the error of a refused edit. */
  read(ctx: Context, id: string, call: number): Promise<{ row: Row } | { refused: string }>;
  /** getInfo hides multi-project rows (experiment off). */
  view?: (row: Row) => Row;
  pick?: "first" | "last";
}

/** Runs a config edit, snapshots the root right after its write, and returns its one emit. */
async function editAndEmit(
  ctx: Context,
  id: string,
  edit: () => Promise<{ success: true } | { success: false; error: string }>
) {
  const config = ctx.harness.config;
  const editConfig = config.editConfig.bind(config);
  const spy = spyOn(config, "editConfig").mockImplementationOnce(async (...args) => {
    const result = await editConfig(...args);
    ctx.snapshot(id);
    return result;
  });
  const before = ctx.emitted.length;
  try {
    const result = await edit();
    if (!result.success) return { refused: result.error };
  } finally {
    spy.mockRestore();
  }
  expect(ctx.emitted.slice(before).map((event) => event.workspaceId)).toEqual([id]);
  return { row: ctx.emitted.at(-1)!.metadata };
}

const callers: Caller[] = [
  {
    name: "getInfo",
    read: async (ctx, id) => {
      ctx.snapshot(id);
      return { row: await ctx.harness.service.getInfo(id) };
    },
    view: (row) => (row && isMultiProject(row) ? null : row),
  },
  {
    // The thinking level alternates, so every call edits and emits.
    name: "AI-settings emit",
    read: (ctx, id, call) =>
      editAndEmit(ctx, id, () =>
        ctx.harness.service.updateAgentAISettings(id, "exec", {
          model: "anthropic:claude-opus-5-5",
          thinkingLevel: call % 2 === 0 ? "low" : "high",
        })
      ),
  },
  {
    name: "TaskService.emitWorkspaceMetadata",
    read: async (ctx, id) => {
      ctx.snapshot(id);
      await ctx.taskService.emitWorkspaceMetadata(id);
      expect(ctx.hostEmit.mock.calls.at(-1)?.[0]).toBe("metadata");
      const event = ctx.hostEmit.mock.calls.at(-1)![1];
      expect(event.workspaceId).toBe(id);
      return { row: event.metadata };
    },
  },
];

/** emitCurrentWorkspaceMetadata builds a Map, so the last row with the id wins (D1 only). */
const updateTags: Caller = {
  name: "updateTags",
  pick: "last",
  read: (ctx, id) => editAndEmit(ctx, id, () => ctx.harness.service.updateTags(id, { k: "v" })),
};

async function writeFixture(config: Config, c: Case) {
  // Start from a config this build saved, so loading the fixture schedules no migration write,
  // then replace the file atomically, as another process does.
  await config.editConfig((snapshot) => ({ ...snapshot, projects: new Map() }));
  const file = path.join(config.rootDir, "config.json");
  const saved = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
  const projects = c.projects();
  await fs.writeFile(`${file}.tmp`, JSON.stringify({ ...saved, projects }));
  await fs.rename(`${file}.tmp`, file);
  for (const [relative, content] of Object.entries(c.sessions ?? {})) {
    const target = path.join(config.sessionsDir, relative);
    await fs.mkdir(content === DIR ? target : path.dirname(target), { recursive: true });
    if (content !== DIR) await fs.writeFile(target, JSON.stringify(content));
  }
  if (c.noCheckouts) return;
  for (const [, project] of projects) {
    for (const workspace of project.workspaces) {
      await fs.mkdir(workspace.path as string, { recursive: true });
    }
  }
}

/** The built row without the services' enrichment fields. */
function built(metadata: Row): Row {
  if (!metadata) return null;
  const copy: Partial<FrontendWorkspaceMetadata> = { ...metadata };
  delete copy.isRemoving;
  delete copy.isInitializing;
  return copy as FrontendWorkspaceMetadata;
}

describe("single-row metadata reads at callers 1-3 (#5727 F1b)", () => {
  let ctx: Context;
  let current: { oracle: "full" | "byId"; pick: "first" | "last" };
  const realAccess = nativeFs.promises.access.bind(nativeFs.promises);

  beforeEach(async () => {
    setSystemTime(new Date(T0));
    // P1: probes of stall-* checkouts never settle; every other probe hits the disk.
    spyOn(nativeFs.promises, "access").mockImplementation((file, mode) =>
      path.basename(String(file)).startsWith("stall-")
        ? new Promise<void>(() => undefined)
        : realAccess(file, mode)
    );
    const harness = await createWorkspaceServiceHarness({
      aiService: createMockAIService({ isStreaming: mock(() => false) }),
    });
    root = harness.config.rootDir;
    const hostEmit = mock((_event: string, _payload: MetadataEvent) => true);
    const { taskService } = createTaskServiceStack(harness.config, {
      workspaceService: createWorkspaceServiceMocks({ emit: hostEmit }).workspaceService,
    });
    const emitted: MetadataEvent[] = [];
    harness.service.on("metadata", (event: MetadataEvent) => emitted.push(event));
    const oracles: Array<Promise<Row>> = [];
    const snapshot = (id: string) => {
      const copy = path.join(root, `oracle-${oracles.length}`);
      nativeFs.mkdirSync(copy);
      nativeFs.copyFileSync(path.join(root, "config.json"), path.join(copy, "config.json"));
      if (nativeFs.existsSync(harness.config.sessionsDir)) {
        nativeFs.cpSync(harness.config.sessionsDir, path.join(copy, "sessions"), {
          recursive: true,
        });
      }
      const config = new Config(copy);
      const { oracle, pick } = current;
      oracles.push(
        oracle === "byId"
          ? config.getWorkspaceMetadataById(id)
          : config.getAllWorkspaceMetadata().then((all) => {
              const rows = all.filter((metadata) => metadata.id === id);
              return (pick === "last" ? rows.at(-1) : rows[0]) ?? null;
            })
      );
    };
    ctx = { harness, taskService, hostEmit, emitted, oracles, snapshot };
  });

  afterEach(async () => {
    setSystemTime();
    mock.restore();
    await ctx.harness.cleanup();
  });

  async function run(c: Case, caller: Caller) {
    current = { oracle: c.oracle ?? "full", pick: caller.pick ?? "first" };
    await writeFixture(ctx.harness.config, c);
    // No snapshot holds a "" project key since #5918; the guard then rests on id-less rows.
    expect(ctx.harness.config.loadConfigOrDefault().projects.has("")).toBe(false);
    setSystemTime(new Date(T1));
    if (c.warmup) expect(await caller.read(ctx, c.warmup, 0)).toHaveProperty("row");
    setSystemTime(new Date(T2));
    const unreachable = c.unreachableAt?.[caller.name];
    const expectedAt = c.expectedAt ?? {};
    const expected = caller.name in expectedAt ? expectedAt[caller.name]! : c.expected;
    for (let call = 1; call <= (c.calls ?? 1); call++) {
      const read = await caller.read(ctx, c.id, call);
      if (unreachable) {
        expect(read).toEqual(unreachable);
        expect(ctx.emitted).toEqual([]);
        continue;
      }
      if (!("row" in read)) throw new Error(`${caller.name} refused: ${read.refused}`);
      const actual = built(read.row);
      expect(ctx.oracles).toHaveLength((c.warmup ? 1 : 0) + call);
      const oracle = await ctx.oracles.at(-1)!;
      expect(actual).toEqual(caller.view ? caller.view(oracle) : oracle);
      // Only the expected keys; an absent key reads as undefined (P1's transcriptOnly).
      const fields =
        actual &&
        Object.fromEntries(
          Object.keys(expected ?? {}).map((k) => [k, actual[k as keyof typeof actual]])
        );
      expect(fields).toEqual(expected);
    }
  }

  for (const c of cases) {
    for (const caller of c.name === "D1" ? [...callers, updateTags] : callers) {
      test(`${c.name} at ${caller.name}`, () => run(c, caller), { timeout: 15_000 });
    }
  }
});
