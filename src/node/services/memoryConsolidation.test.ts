import { describe, expect, it, spyOn } from "bun:test";

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import type { Tool } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart, SharedV3ProviderMetadata } from "@ai-sdk/provider";

import {
  MEMORY_CONSOLIDATION_JOURNAL_MAX_ENTRIES,
  MEMORY_CONSOLIDATION_MAX_STEPS,
  MEMORY_CONSOLIDATION_OP_BUDGET,
  MEMORY_DREAM_EDIT_LIMIT_MAX,
  MEMORY_CONSOLIDATION_NOTE_MAX_CHARS,
  MEMORY_CONSOLIDATION_PATH_MAX_CHARS,
  MEMORY_MAX_FILE_BYTES,
  MEMORY_MAX_FILES_PER_SCOPE,
  MEMORY_MAX_OUTPUT_TOKENS_PER_STEP,
} from "@/common/constants/memory";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { Config } from "@/node/config";
import {
  createConsolidationMemoryTool,
  createMutationBudget,
  organizerEditBudget,
  runMemoryConsolidation,
  type MemoryConsolidationOp,
} from "./memoryConsolidation";
import { memoryLogicalKey, MemoryMetaService } from "./memoryMeta";
import { MemoryService, projectMemoryDirName, type MemoryScopeContext } from "./memoryService";
import { TestTempDir, mockToolCallOptions } from "./tools/testHelpers";
import { workspaceRemovalTombstonePath } from "./workspaceRemoval";
import { readRefinementEvents } from "./refinement/refinementTestHelpers";

/**
 * Behavior under test: the consolidation rails (scope restriction, pin
 * protection, op budget, dry-run interception, journal) enforced by the
 * guarded memory tool — in code, independent of the model and the agent
 * prompt.
 */

interface Fixture extends Disposable {
  xumHome: string;
  metaService: MemoryMetaService;
  memoryService: MemoryService;
  ctx: MemoryScopeContext;
  journal: MemoryConsolidationOp[];
  tool: Tool;
  getMutationCount: () => number;
  isBudgetExhausted: () => boolean;
  globalMemoryDir: string;
  projectMemoryDir: string;
}

async function createFixture(options?: {
  dryRun?: boolean;
  projectPath?: string;
  /** Guard options under test (scopes, secret check, description, budget). */
  guard?: Partial<Parameters<typeof createConsolidationMemoryTool>[0]>;
}): Promise<Fixture> {
  const tempDir = new TestTempDir("test-memory-consolidation");
  const xumHome = path.join(tempDir.path, "mux-home");
  const globalMemoryDir = path.join(xumHome, "memory", "global");
  const projectMemoryDir =
    options?.projectPath != null && options.projectPath !== ""
      ? path.join(xumHome, "memory", "project", projectMemoryDirName(options.projectPath))
      : "";
  await fsPromises.mkdir(globalMemoryDir, { recursive: true });

  const metaService = new MemoryMetaService(xumHome);
  const memoryService = new MemoryService(new Config(xumHome), metaService);
  const ctx: MemoryScopeContext = {
    runtime: null,
    checkoutCwd: "",
    workspaceId: "ws-consolidation",
    projectPath: options?.projectPath ?? "",
  };
  const journal: MemoryConsolidationOp[] = [];
  const { tool, getMutationCount, isBudgetExhausted } = createConsolidationMemoryTool({
    memoryService,
    metaService,
    ctx,
    dryRun: options?.dryRun ?? false,
    journal,
    ...options?.guard,
  });
  return {
    xumHome,
    metaService,
    memoryService,
    ctx,
    journal,
    globalMemoryDir,
    projectMemoryDir,
    tool,
    getMutationCount,
    isBudgetExhausted,
    [Symbol.dispose]() {
      tempDir[Symbol.dispose]();
    },
  };
}

function pathExists(target: string): Promise<boolean> {
  return fsPromises.access(target).then(
    () => true,
    () => false
  );
}

/** Files under `dir` (recursively) whose bytes contain `needle`; [] when `dir` does not exist. */
async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const names = await fsPromises.readdir(dir, { recursive: true }).catch(() => [] as string[]);
  const hits: string[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (!(await fsPromises.stat(file)).isFile()) continue;
    if ((await fsPromises.readFile(file, "utf-8")).includes(needle)) hits.push(name);
  }
  return hits;
}

type MemoryExecuteResult = { success: true; output: string } | { success: false; error: string };

async function execute(tool: Tool, input: Record<string, unknown>): Promise<MemoryExecuteResult> {
  const parsed = TOOL_DEFINITIONS.memory.schema.parse(input);
  return (await tool.execute!(parsed, mockToolCallOptions)) as MemoryExecuteResult;
}

describe("consolidation memory tool rails", () => {
  it("a mutation wedged before commit refuses once the pass is cancelled (r59)", async () => {
    // Tool executions receive no hard cancellation: a live run wedged in
    // pre-commit I/O is detached by the caller's bounded drain, and once
    // the wedge unblocked it used to commit durable memory AND append its
    // refinement journal row into the (by then deleted) session directory,
    // recreating it. The abort signal must make the mutation refuse INSIDE
    // the target lock instead.
    using fixture = await createFixture();
    // Seed the target directly on disk: going through the service would
    // journal the create and pre-create the session directory this test
    // asserts is never materialized.
    const targetPath = path.join(fixture.globalMemoryDir, "wedged.md");
    await fsPromises.writeFile(targetPath, "contents that must survive\n");

    const controller = new AbortController();
    const { tool } = createConsolidationMemoryTool({
      memoryService: fixture.memoryService,
      metaService: fixture.metaService,
      ctx: fixture.ctx,
      dryRun: false,
      journal: [],
      abortSignal: controller.signal,
    });
    // Wedge the guard's pin lookup (the delete path's pre-commit I/O).
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => (releaseGate = resolve));
    const entriesSpy = spyOn(fixture.metaService, "getEntries").mockImplementation(async () => {
      await gate;
      return new Map();
    });
    try {
      const pending = execute(tool, { command: "delete", path: "/memories/global/wedged.md" });
      // Teardown races in while the execution is wedged.
      controller.abort();
      releaseGate();
      const result = await pending;
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain("cancelled before commit");
    } finally {
      entriesSpy.mockRestore();
    }
    // Nothing durable landed: the target survived and no refinement journal
    // row recreated the workspace's session directory.
    expect(await fsPromises.readFile(targetPath, "utf-8")).toContain("must survive");
    const sessionDir = path.join(fixture.xumHome, "sessions", fixture.ctx.workspaceId);
    expect(
      await fsPromises.access(sessionDir).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  it("a durable removal tombstone refuses memory mutations at commit (r61)", async () => {
    // Cross-process teardown: with multiple backends over one Xum root, the
    // remover cannot abort a foreign backend's dream run — its mutations
    // must observe the durable tombstone at commit time and refuse, without
    // any abort signal, so they cannot recreate the deleted session dir.
    using fixture = await createFixture();
    const tombstonePath = workspaceRemovalTombstonePath(fixture.xumHome, fixture.ctx.workspaceId);
    await fsPromises.mkdir(path.dirname(tombstonePath), { recursive: true });
    await fsPromises.writeFile(
      tombstonePath,
      JSON.stringify({ workspaceId: fixture.ctx.workspaceId, removedAt: Date.now() })
    );

    const created = await fixture.memoryService.create(
      fixture.ctx,
      "/memories/global/after-removal.md",
      "must not land\n",
      "agent"
    );
    expect(created.success).toBe(false);
    if (!created.success) expect(created.error).toContain("was removed");
    expect(
      await fsPromises.access(path.join(fixture.globalMemoryDir, "after-removal.md")).then(
        () => true,
        () => false
      )
    ).toBe(false);

    // The Memory tab's save path (saveFile) refuses through the same check.
    const saved = await fixture.memoryService.saveFile(
      fixture.ctx,
      "/memories/workspace/harvest/inbox.md",
      "late inbox\n",
      null,
      "agent"
    );
    expect(saved.success).toBe(false);
    // No session directory materialized by either refusal.
    const sessionDir = path.join(fixture.xumHome, "sessions", fixture.ctx.workspaceId);
    expect(
      await fsPromises.access(sessionDir).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  it("a cancelled pass refuses new executions at entry (r59)", async () => {
    using fixture = await createFixture();
    const targetPath = path.join(fixture.globalMemoryDir, "entry.md");
    await fsPromises.writeFile(targetPath, "original\n");
    const controller = new AbortController();
    controller.abort();
    const { tool } = createConsolidationMemoryTool({
      memoryService: fixture.memoryService,
      metaService: fixture.metaService,
      ctx: fixture.ctx,
      dryRun: false,
      journal: [],
      abortSignal: controller.signal,
    });
    const result = await execute(tool, {
      command: "str_replace",
      path: "/memories/global/entry.md",
      old_str: "original",
      new_str: "clobbered",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("cancelled");
    expect(await fsPromises.readFile(targetPath, "utf-8")).toContain("original");
  });

  it("a read stalled in filesystem I/O returns once the pass is cancelled", async () => {
    // Only mutations re-check the signal inside MemoryService, and the provider loop waits for
    // the tool result: a read that never settles would hold the run past its timeout.
    using fixture = await createFixture();
    const controller = new AbortController();
    const { tool } = createConsolidationMemoryTool({
      memoryService: fixture.memoryService,
      metaService: fixture.metaService,
      ctx: fixture.ctx,
      dryRun: false,
      journal: [],
      abortSignal: controller.signal,
    });
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    spyOn(fixture.memoryService, "view").mockImplementation(() => {
      markReadStarted();
      return new Promise(() => undefined);
    });

    const pending = execute(tool, { command: "view", path: "/memories/" });
    await readStarted;
    controller.abort();

    const result = await pending;
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("cancelled");
  });

  it("applies in-scope mutations and journals them", async () => {
    using fixture = await createFixture();
    const result = await execute(fixture.tool, {
      command: "create",
      path: "/memories/global/lesson.md",
      file_text: "a durable lesson\n",
    });
    expect(result.success).toBe(true);
    expect(
      await fsPromises.readFile(path.join(fixture.globalMemoryDir, "lesson.md"), "utf-8")
    ).toContain("durable lesson");
    expect(fixture.journal).toEqual([
      { command: "create", path: "/memories/global/lesson.md", applied: true, note: undefined },
    ]);
  });

  it("applies project-scope mutations when the run has a single project identity", async () => {
    using fixture = await createFixture({ projectPath: "/projects/demo" });

    const result = await execute(fixture.tool, {
      command: "create",
      path: "/memories/project/lesson.md",
      file_text: "repo-specific lesson\n",
    });

    expect(result.success).toBe(true);
    expect(
      await fsPromises.readFile(path.join(fixture.projectMemoryDir, "lesson.md"), "utf-8")
    ).toBe("repo-specific lesson\n");
    expect(fixture.journal).toEqual([
      { command: "create", path: "/memories/project/lesson.md", applied: true, note: undefined },
    ]);
  });

  it("rejects project-scope mutations but allows reads to pass through", async () => {
    using fixture = await createFixture();
    const mutation = await execute(fixture.tool, {
      command: "delete",
      path: "/memories/project/note.md",
    });
    expect(mutation.success).toBe(false);
    if (!mutation.success) expect(mutation.error).toContain("single-project runs");
    expect(fixture.journal[0]?.applied).toBe(false);

    // Reads are unguarded by the tool, so out-of-scope privacy relies on the
    // ctx: project is structurally disabled, while global reads pass through.
    const projectRead = await execute(fixture.tool, {
      command: "view",
      path: "/memories/project/",
    });
    expect(projectRead.success).toBe(false);
    const read = await execute(fixture.tool, { command: "view", path: "/memories/global/" });
    expect(read.success).toBe(true);
  });

  it("keeps the default guard open to workspace, global and project writes, and checks no text", async () => {
    // The dream pass runs on the defaults: the analyzer's narrower scopes and secret check are opt-in.
    using fixture = await createFixture({ projectPath: "/projects/demo" });
    const writes = ["/memories/workspace/a.md", "/memories/global/b.md", "/memories/project/c.md"];
    for (const target of writes) {
      const result = await execute(fixture.tool, {
        command: "create",
        path: target,
        file_text: "password: kept-as-written\n",
      });
      expect(result.success).toBe(true);
    }
    expect(fixture.journal.map((op) => op.applied)).toEqual([true, true, true]);

    const session = await execute(fixture.tool, {
      command: "create",
      path: "/memories/session/checkpoint.md",
      file_text: "x\n",
    });
    expect(session.success).toBe(false);
    expect(fixture.journal.at(-1)?.applied).toBe(false);
  });

  describe("writable scopes", () => {
    it("rejects and journals a write outside them, without spending budget", async () => {
      using fixture = await createFixture({
        projectPath: "/projects/demo",
        guard: { writableScopes: ["workspace"] },
      });

      const global = await execute(fixture.tool, {
        command: "create",
        path: "/memories/global/x.md",
        file_text: "x\n",
      });
      const project = await execute(fixture.tool, {
        command: "create",
        path: "/memories/project/x.md",
        file_text: "x\n",
      });
      // A rename that starts inside a writable scope may not end outside it.
      const seeded = await execute(fixture.tool, {
        command: "create",
        path: "/memories/workspace/y.md",
        file_text: "y\n",
      });
      const moved = await execute(fixture.tool, {
        command: "rename",
        old_path: "/memories/workspace/y.md",
        new_path: "/memories/global/y.md",
      });

      expect(seeded.success).toBe(true);
      for (const result of [global, project, moved]) {
        expect(result.success).toBe(false);
        if (!result.success)
          expect(result.error).toContain("this run can modify /memories/workspace/....");
      }
      expect(fixture.journal.map((op) => op.applied)).toEqual([false, false, true, false]);
      // Only the accepted create consumed budget.
      expect(fixture.getMutationCount()).toBe(1);
      expect(await pathExists(path.join(fixture.globalMemoryDir, "x.md"))).toBe(false);
      expect(await pathExists(path.join(fixture.projectMemoryDir, "x.md"))).toBe(false);
    });

    it("keeps reads open to every scope", async () => {
      using fixture = await createFixture({
        projectPath: "/projects/demo",
        guard: { writableScopes: ["workspace"] },
      });
      await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "env.md"), "GLOBAL-FACT\n");

      const read = await execute(fixture.tool, {
        command: "view",
        path: "/memories/global/env.md",
      });

      expect(read.success).toBe(true);
      if (read.success) expect(read.output).toContain("GLOBAL-FACT");
    });

    it("keeps project memory unavailable without a single project even when listed", async () => {
      using fixture = await createFixture({
        guard: { writableScopes: ["workspace", "project"] },
      });

      const result = await execute(fixture.tool, {
        command: "create",
        path: "/memories/project/x.md",
        file_text: "x\n",
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain("single-project runs");
    });
  });

  describe("denied commands", () => {
    it("rejects and journals a denied command without spending budget, and still allows the others", async () => {
      using fixture = await createFixture({ guard: { deniedCommands: ["delete", "rename"] } });
      await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "keep.md"), "x\n");

      const deleted = await execute(fixture.tool, {
        command: "delete",
        path: "/memories/global/keep.md",
      });
      const renamed = await execute(fixture.tool, {
        command: "rename",
        old_path: "/memories/global/keep.md",
        new_path: "/memories/global/moved.md",
      });
      const edited = await execute(fixture.tool, {
        command: "str_replace",
        path: "/memories/global/keep.md",
        old_str: "x",
        new_str: "y",
      });

      expect(deleted.success).toBe(false);
      expect(renamed.success).toBe(false);
      expect(edited.success).toBe(true);
      expect(fixture.journal.map((op) => [op.command, op.applied])).toEqual([
        ["delete", false],
        ["rename", false],
        ["str_replace", true],
      ]);
      expect(fixture.journal[0]?.note).toContain("delete");
      expect(fixture.getMutationCount()).toBe(1);
      expect(
        await fsPromises.readFile(path.join(fixture.globalMemoryDir, "keep.md"), "utf-8")
      ).toBe("y\n");
    });
  });

  describe("denied command note", () => {
    it("names the commands the run can still use, not the ones it was denied", async () => {
      using fixture = await createFixture({
        guard: { deniedCommands: ["delete", "rename", "insert"] },
      });
      await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "keep.md"), "x\n");

      const result = await execute(fixture.tool, {
        command: "insert",
        path: "/memories/global/keep.md",
        insert_line: 0,
        insert_text: "y\n",
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      // Everything after "may not use insert;" is what the run is told it may do.
      const allowed = result.error.slice(result.error.indexOf(";"));
      expect(allowed).toContain("create");
      expect(allowed).toContain("str_replace");
      for (const denied of ["insert", "delete", "rename"]) expect(allowed).not.toContain(denied);
      expect(fixture.getMutationCount()).toBe(0);
      expect(
        await fsPromises.readFile(path.join(fixture.globalMemoryDir, "keep.md"), "utf-8")
      ).toBe("x\n");
    });
  });

  describe("journal bounds", () => {
    it("records at most the journal cap of refusals, says so in the last row, and still journals an accepted mutation", async () => {
      using fixture = await createFixture({ guard: { writableScopes: ["workspace"] } });

      // One step can issue many parallel calls, so the refusals arrive together.
      const refused = await Promise.all(
        Array.from({ length: MEMORY_CONSOLIDATION_JOURNAL_MAX_ENTRIES * 2 }, (_, index) =>
          execute(fixture.tool, {
            command: "create",
            path: `/memories/global/n${index}.md`,
            file_text: "x\n",
          })
        )
      );

      // The model still hears about every refusal; the journal keeps the first ones.
      expect(refused.every((result) => !result.success)).toBe(true);
      expect(fixture.journal).toHaveLength(MEMORY_CONSOLIDATION_JOURNAL_MAX_ENTRIES);
      expect(fixture.journal.at(-1)?.note).toContain("not recorded");
      expect(fixture.journal.at(-2)?.note).not.toContain("not recorded");
      expect(fixture.getMutationCount()).toBe(0);

      // A change the run makes must stay in the audit trail however many refusals came first.
      const accepted = await execute(fixture.tool, {
        command: "create",
        path: "/memories/workspace/ok.md",
        file_text: "ok\n",
      });
      expect(accepted.success).toBe(true);
      expect(fixture.journal).toHaveLength(MEMORY_CONSOLIDATION_JOURNAL_MAX_ENTRIES + 1);
      expect(fixture.journal.at(-1)).toMatchObject({
        applied: true,
        path: "/memories/workspace/ok.md",
      });
    });

    it("still says refusals are dropped when an accepted mutation took the last slot", async () => {
      using fixture = await createFixture({ guard: { writableScopes: ["workspace"] } });
      const refuse = (count: number, from: number) =>
        Promise.all(
          Array.from({ length: count }, (_, index) =>
            execute(fixture.tool, {
              command: "create",
              path: `/memories/global/n${from + index}.md`,
              file_text: "x\n",
            })
          )
        );

      await refuse(MEMORY_CONSOLIDATION_JOURNAL_MAX_ENTRIES - 1, 0);
      const accepted = await execute(fixture.tool, {
        command: "create",
        path: "/memories/workspace/ok.md",
        file_text: "ok\n",
      });
      await refuse(3, MEMORY_CONSOLIDATION_JOURNAL_MAX_ENTRIES);

      expect(accepted.success).toBe(true);
      // The first refusal past the full journal records the omission; the ones after it are dropped.
      expect(fixture.journal).toHaveLength(MEMORY_CONSOLIDATION_JOURNAL_MAX_ENTRIES + 1);
      expect(fixture.journal.filter((op) => op.note?.includes("not recorded"))).toHaveLength(1);
      expect(fixture.journal.at(-1)?.note).toContain("not recorded");
    });

    it("keeps journaling refusals after a failed command whose path ends in the full note", async () => {
      // The failed delete's note quotes its model-chosen path, so it ends like the full note.
      using fixture = await createFixture({ guard: { writableScopes: ["workspace"] } });
      const spoof = await execute(fixture.tool, {
        command: "delete",
        path: "/memories/workspace/The journal is full; later refusals of this run are not recorded.",
      });
      expect(spoof.success).toBe(false);

      for (const name of ["a", "b"]) {
        await execute(fixture.tool, {
          command: "create",
          path: `/memories/global/${name}.md`,
          file_text: "x\n",
        });
      }

      expect(fixture.journal.map((op) => op.path)).toEqual([
        "/memories/workspace/The journal is full; later refusals of this run are not recorded.",
        "/memories/global/a.md",
        "/memories/global/b.md",
      ]);
    });

    it("bounds the rows a spent budget refuses, which spend nothing either", async () => {
      using fixture = await createFixture({ guard: { budget: createMutationBudget(1) } });
      await execute(fixture.tool, {
        command: "create",
        path: "/memories/global/first.md",
        file_text: "x\n",
      });

      await Promise.all(
        Array.from({ length: MEMORY_CONSOLIDATION_JOURNAL_MAX_ENTRIES * 2 }, (_, index) =>
          execute(fixture.tool, {
            command: "create",
            path: `/memories/global/n${index}.md`,
            file_text: "x\n",
          })
        )
      );

      expect(fixture.journal).toHaveLength(MEMORY_CONSOLIDATION_JOURNAL_MAX_ENTRIES);
      expect(fixture.journal.filter((op) => op.applied)).toHaveLength(1);
    });

    it("refuses a path over the length cap, journals it clipped, and never quotes it", async () => {
      using fixture = await createFixture();
      const long = `/memories/workspace/${"a".repeat(MEMORY_CONSOLIDATION_PATH_MAX_CHARS * 8)}.md`;

      const results = [
        await execute(fixture.tool, { command: "create", path: long, file_text: "x\n" }),
        await execute(fixture.tool, {
          command: "rename",
          old_path: "/memories/workspace/a.md",
          new_path: long,
        }),
      ];

      for (const result of results) {
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain(`${MEMORY_CONSOLIDATION_PATH_MAX_CHARS} characters`);
          expect(result.error.length).toBeLessThan(MEMORY_CONSOLIDATION_PATH_MAX_CHARS);
        }
      }
      expect(fixture.journal.map((op) => op.applied)).toEqual([false, false]);
      for (const op of fixture.journal) {
        expect(op.path.length).toBeLessThanOrEqual(MEMORY_CONSOLIDATION_PATH_MAX_CHARS);
        expect(op.newPath?.length ?? 0).toBeLessThanOrEqual(MEMORY_CONSOLIDATION_PATH_MAX_CHARS);
        expect(op.note?.length).toBeLessThan(MEMORY_CONSOLIDATION_PATH_MAX_CHARS);
      }
      expect(fixture.getMutationCount()).toBe(0);
    });

    it("bounds every row a run of failed edits journals, and returns each error whole", async () => {
      // The unlimited budget: each failed str_replace spends an edit and journals a row.
      using fixture = await createFixture({ guard: { budget: organizerEditBudget(null).budget } });
      // A near-full-size file in which old_str starts every line: each failed str_replace's error
      // lists every line number. (Few matches per line: findMatchingLines re-reads the file once
      // per match.)
      const line = `x${"-".repeat(126)}\n`;
      const lines = MEMORY_MAX_FILE_BYTES / line.length - 1;
      const created = await execute(fixture.tool, {
        command: "create",
        path: "/memories/global/big.md",
        file_text: line.repeat(lines),
      });
      expect(created.success).toBe(true);

      const failures = 10;
      for (let index = 0; index < failures; index++) {
        const result = await execute(fixture.tool, {
          command: "str_replace",
          path: "/memories/global/big.md",
          old_str: "x",
          new_str: "y",
        });
        expect(result.success).toBe(false);
        if (result.success) continue;
        // The model still gets every line number to pick a unique old_str from.
        expect(result.error).toContain(`matches ${lines} locations`);
        expect(result.error).toContain(`, ${lines})`);
        const row = fixture.journal.at(-1);
        expect(row?.applied).toBe(false);
        expect(row?.note).toHaveLength(MEMORY_CONSOLIDATION_NOTE_MAX_CHARS);
        expect(result.error.startsWith(row?.note?.slice(0, 200) ?? "-")).toBe(true);
      }

      expect(fixture.journal).toHaveLength(failures + 1);
      // Every row stays within what the caps allow (path, newPath and note, plus its JSON keys),
      // so the journal's size is bounded by its row count.
      const maxRowChars =
        2 * MEMORY_CONSOLIDATION_PATH_MAX_CHARS + MEMORY_CONSOLIDATION_NOTE_MAX_CHARS + 100;
      for (const row of fixture.journal) {
        expect(JSON.stringify(row).length).toBeLessThanOrEqual(maxRowChars);
      }
    }, 30_000);

    it("journals a failed edit's error whole when it fits the note cap", async () => {
      using fixture = await createFixture();
      await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "small.md"), "x\nx\n");

      const result = await execute(fixture.tool, {
        command: "str_replace",
        path: "/memories/global/small.md",
        old_str: "x",
        new_str: "y",
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(fixture.journal[0]?.note).toBe(result.error);
    });

    it("accepts a path of exactly the cap", async () => {
      using fixture = await createFixture();
      // Directories of 100 characters stay under the filesystem's name limit.
      const prefix = `/memories/workspace/${"d".repeat(100)}/${"e".repeat(100)}/${"f".repeat(100)}/`;
      const name = `${"n".repeat(MEMORY_CONSOLIDATION_PATH_MAX_CHARS - prefix.length - ".md".length)}.md`;
      const atCap = `${prefix}${name}`;
      expect(atCap).toHaveLength(MEMORY_CONSOLIDATION_PATH_MAX_CHARS);

      const result = await execute(fixture.tool, {
        command: "create",
        path: atCap,
        file_text: "x\n",
      });

      expect(result.success).toBe(true);
    });
  });

  describe("secret check", () => {
    it("rejects create, str_replace and insert text that holds a credential, and journals it without the value", async () => {
      using fixture = await createFixture({ guard: { rejectSecretLike: true } });
      const githubToken = `ghp_${"a1B2".repeat(9)}`;
      await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "notes.md"), "line one\n");

      const results = [
        await execute(fixture.tool, {
          command: "create",
          path: "/memories/global/creds.md",
          file_text: `GITHUB_TOKEN=${githubToken}\n`,
        }),
        await execute(fixture.tool, {
          command: "str_replace",
          path: "/memories/global/notes.md",
          old_str: "line one",
          new_str: "password: hunter2-correct-horse",
        }),
        await execute(fixture.tool, {
          command: "insert",
          path: "/memories/global/notes.md",
          insert_line: 0,
          insert_text: `Authorization: Bearer ${githubToken}\n`,
        }),
      ];

      for (const result of results) {
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error).toContain("credential");
      }
      expect(fixture.journal.map((op) => op.applied)).toEqual([false, false, false]);
      expect(JSON.stringify(fixture.journal)).not.toContain(githubToken);
      expect(JSON.stringify(fixture.journal)).not.toContain("hunter2");
      expect(fixture.getMutationCount()).toBe(0);
      expect(
        await fsPromises.readFile(path.join(fixture.globalMemoryDir, "notes.md"), "utf-8")
      ).toBe("line one\n");
      expect(await pathExists(path.join(fixture.globalMemoryDir, "creds.md"))).toBe(false);
    });

    it("journals an applied rename and delete of a credential-named file without the credential", async () => {
      // A cleanup that renames or deletes such a file is allowed, but its journal row is persisted
      // in the sidecar: the row must not keep the name it cleaned up.
      using fixture = await createFixture({ guard: { rejectSecretLike: true } });
      const githubToken = `ghp_${"a1B2".repeat(9)}`;
      await fsPromises.writeFile(path.join(fixture.globalMemoryDir, `${githubToken}.md`), "a\n");
      await fsPromises.writeFile(
        path.join(fixture.globalMemoryDir, `old-${githubToken}.md`),
        "b\n"
      );

      const renamed = await execute(fixture.tool, {
        command: "rename",
        old_path: `/memories/global/${githubToken}.md`,
        new_path: "/memories/global/deploy-user.md",
      });
      const deleted = await execute(fixture.tool, {
        command: "delete",
        path: `/memories/global/old-${githubToken}.md`,
      });

      expect(renamed.success).toBe(true);
      expect(deleted.success).toBe(true);
      expect(fixture.journal.map((op) => op.applied)).toEqual([true, true]);
      expect(JSON.stringify(fixture.journal)).not.toContain(githubToken);
    });

    it("rejects a credential that has no keyword beside it", async () => {
      // A check on the words `token`, `secret` and `password` lets these shapes through: the
      // guard has to read the credential shapes themselves.
      using fixture = await createFixture({ guard: { rejectSecretLike: true } });
      const githubToken = `ghp_${"a1B2".repeat(9)}`;

      const notes = [
        `The deploy user authenticates as ${githubToken}.\n`,
        "The notifier posts as xoxb-1234567890-abcdefghij.\n",
        "The cache lives at redis://:hunter2pw@cache:6379/0.\n",
      ];

      for (const [index, note] of notes.entries()) {
        const result = await execute(fixture.tool, {
          command: "create",
          path: `/memories/global/note-${index}.md`,
          file_text: note,
        });
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error).toContain("credential");
      }
      expect(JSON.stringify(fixture.journal)).not.toContain("hunter2pw");
      expect(fixture.getMutationCount()).toBe(0);
    });

    it("rejects a credential that two calls assemble, journals the refusal without a value, and leaves the file as it was", async () => {
      // The first call adds two halves that are harmless alone; the second adds no text at all,
      // only removes the newline between them. A check on the new text sees nothing in either.
      using fixture = await createFixture({ guard: { rejectSecretLike: true } });
      const halves = "sk-\nABCDEFGHIJKLMNO\n";

      const created = await execute(fixture.tool, {
        command: "create",
        path: "/memories/global/halves.md",
        file_text: halves,
      });
      const joined = await execute(fixture.tool, {
        command: "str_replace",
        path: "/memories/global/halves.md",
        old_str: "sk-\nABC",
        new_str: "sk-ABC",
      });

      expect(created.success).toBe(true);
      expect(joined.success).toBe(false);
      if (!joined.success) expect(joined.error).toContain("credential");
      expect(fixture.journal.map((op) => op.applied)).toEqual([true, false]);
      expect(fixture.journal[1]?.note).toContain("credential");
      expect(JSON.stringify(fixture.journal)).not.toContain("ABCDEFGHIJKLMNO");
      expect(
        await fsPromises.readFile(path.join(fixture.globalMemoryDir, "halves.md"), "utf-8")
      ).toBe(halves);
    });

    it("leaves the dream pass's default guard free to write that join", async () => {
      // The organizer merges and rewrites whatever memory holds, so it runs without the check.
      using fixture = await createFixture();
      await execute(fixture.tool, {
        command: "create",
        path: "/memories/global/halves.md",
        file_text: "sk-\nABCDEFGHIJKLMNO\n",
      });

      const joined = await execute(fixture.tool, {
        command: "str_replace",
        path: "/memories/global/halves.md",
        old_str: "sk-\nABC",
        new_str: "sk-ABC",
      });

      expect(joined.success).toBe(true);
    });

    it("still edits a file that already holds a credential-like line or a redacted placeholder", async () => {
      using fixture = await createFixture({ guard: { rejectSecretLike: true } });
      await fsPromises.writeFile(
        path.join(fixture.globalMemoryDir, "legacy.md"),
        "password: hunter2-correct-horse\nnotes\n"
      );
      await fsPromises.writeFile(
        path.join(fixture.globalMemoryDir, "placeholder.md"),
        "API_TOKEN: [redacted]\nnotes\n"
      );

      for (const name of ["legacy.md", "placeholder.md"]) {
        const edited = await execute(fixture.tool, {
          command: "str_replace",
          path: `/memories/global/${name}`,
          old_str: "notes",
          new_str: "more notes",
        });
        expect(edited.success).toBe(true);
      }
    });

    it("accepts text that only talks about tokens and passwords", async () => {
      using fixture = await createFixture({ guard: { rejectSecretLike: true } });

      const result = await execute(fixture.tool, {
        command: "create",
        path: "/memories/global/auth.md",
        file_text:
          "The token budget resets each turn; max_tokens: 4096. Passwords live in the vault.\n",
      });

      expect(result.success).toBe(true);
    });

    it("rejects a file name that holds a credential, journals it redacted, and never creates it", async () => {
      using fixture = await createFixture({ guard: { rejectSecretLike: true } });
      const keyName = `sk-ant-api03-${"Ab3d".repeat(8)}`;
      await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "old.md"), "x\n");

      const created = await execute(fixture.tool, {
        command: "create",
        path: `/memories/global/${keyName}.md`,
        file_text: "what the key is for\n",
      });
      const renamed = await execute(fixture.tool, {
        command: "rename",
        old_path: "/memories/global/old.md",
        new_path: `/memories/global/${keyName}.md`,
      });

      for (const result of [created, renamed]) {
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error).toContain("credential");
      }
      expect(fixture.journal.map((op) => op.applied)).toEqual([false, false]);
      expect(JSON.stringify(fixture.journal)).not.toContain(keyName);
      expect(fixture.getMutationCount()).toBe(0);
      expect(await pathExists(path.join(fixture.globalMemoryDir, `${keyName}.md`))).toBe(false);
      expect(await pathExists(path.join(fixture.globalMemoryDir, "old.md"))).toBe(true);
    });

    it("lets a rename or delete clear away a file that already has a credential in its name", async () => {
      using fixture = await createFixture({ guard: { rejectSecretLike: true } });
      const keyName = `sk-ant-api03-${"Ab3d".repeat(8)}.md`;
      await fsPromises.writeFile(path.join(fixture.globalMemoryDir, keyName), "x\n");
      await fsPromises.writeFile(path.join(fixture.globalMemoryDir, `other-${keyName}`), "y\n");

      const renamed = await execute(fixture.tool, {
        command: "rename",
        old_path: `/memories/global/${keyName}`,
        new_path: "/memories/global/clean.md",
      });
      const deleted = await execute(fixture.tool, {
        command: "delete",
        path: `/memories/global/other-${keyName}`,
      });

      expect(renamed.success).toBe(true);
      expect(deleted.success).toBe(true);
    });

    it("keeps a credential it cleans out of memory out of the refinement journal too", async () => {
      // The cleanup's refinement rows would offload each pre-image verbatim to the session blob
      // store and record credential-named paths, so the credential would outlive the cleanup.
      using fixture = await createFixture({ guard: { rejectSecretLike: true } });
      const githubToken = `ghp_${"a1B2".repeat(9)}`;
      const keyName = `sk-ant-api03-${"Ab3d".repeat(8)}`;
      await fsPromises.writeFile(
        path.join(fixture.globalMemoryDir, "deploy.md"),
        `deploy with GITHUB_TOKEN=${githubToken}\n`
      );
      await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "ci.md"), `${githubToken}\n`);
      await fsPromises.writeFile(path.join(fixture.globalMemoryDir, `${keyName}.md`), "x\n");

      const results = [
        await execute(fixture.tool, {
          command: "str_replace",
          path: "/memories/global/deploy.md",
          old_str: `GITHUB_TOKEN=${githubToken}`,
          new_str: "the GitHub token from 1Password",
        }),
        await execute(fixture.tool, { command: "delete", path: "/memories/global/ci.md" }),
        await execute(fixture.tool, {
          command: "rename",
          old_path: `/memories/global/${keyName}.md`,
          new_path: "/memories/global/anthropic-key.md",
        }),
      ];

      // A guarded mutation with no credential in its row is still journaled.
      results.push(
        await execute(fixture.tool, {
          command: "create",
          path: "/memories/global/where-tokens-live.md",
          file_text: "Deploy and CI tokens live in 1Password.\n",
        })
      );

      expect(results.map((result) => result.success)).toEqual([true, true, true, true]);
      const sessionDir = path.join(fixture.xumHome, "sessions", fixture.ctx.workspaceId);
      const rows = await readRefinementEvents(sessionDir);
      expect(rows.map((row) => row.data.action)).toEqual([
        { op: "create", path: "/memories/global/where-tokens-live.md" },
      ]);
      expect(await filesContaining(sessionDir, githubToken)).toEqual([]);
      expect(await filesContaining(sessionDir, keyName)).toEqual([]);
    });

    it("leaves deletes and renames alone", async () => {
      using fixture = await createFixture({ guard: { rejectSecretLike: true } });
      await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "old.md"), "x\n");

      const renamed = await execute(fixture.tool, {
        command: "rename",
        old_path: "/memories/global/old.md",
        new_path: "/memories/global/new.md",
      });
      const deleted = await execute(fixture.tool, {
        command: "delete",
        path: "/memories/global/new.md",
      });

      expect(renamed.success).toBe(true);
      expect(deleted.success).toBe(true);
    });
  });

  it("lets the caller set the lead of the tool description and keeps the command reference", async () => {
    using fixture = await createFixture({ guard: { description: "Edit this workspace's notes." } });

    expect(fixture.tool.description).toStartWith("Edit this workspace's notes. ");
    expect(fixture.tool.description).toEndWith(TOOL_DEFINITIONS.memory.description);
  });

  describe("budget exhaustion", () => {
    it("is judged against the run's own budget limit, not the default one", async () => {
      using fixture = await createFixture({ guard: { budget: createMutationBudget(2) } });
      const create = (name: string) =>
        execute(fixture.tool, {
          command: "create",
          path: `/memories/global/${name}.md`,
          file_text: `${name}\n`,
        });

      expect(fixture.isBudgetExhausted()).toBe(false);
      await create("one");
      expect(fixture.isBudgetExhausted()).toBe(false);
      await create("two");
      expect(fixture.isBudgetExhausted()).toBe(true);
    });

    it("is not triggered by guard rejections", async () => {
      using fixture = await createFixture({
        guard: { budget: createMutationBudget(1), writableScopes: ["workspace"] },
      });

      await execute(fixture.tool, {
        command: "create",
        path: "/memories/global/x.md",
        file_text: "x\n",
      });

      expect(fixture.isBudgetExhausted()).toBe(false);
    });
  });

  it("never deletes or renames pinned files but allows editing them", async () => {
    using fixture = await createFixture();
    await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "pinned.md"), "keep me\n");
    await fixture.metaService.setPinned(
      memoryLogicalKey("global", "pinned.md", {
        projectPath: fixture.ctx.projectPath,
        workspaceId: fixture.ctx.workspaceId,
      }),
      true
    );

    const deletion = await execute(fixture.tool, {
      command: "delete",
      path: "/memories/global/pinned.md",
    });
    expect(deletion.success).toBe(false);
    if (!deletion.success) expect(deletion.error).toContain("pinned");

    const rename = await execute(fixture.tool, {
      command: "rename",
      old_path: "/memories/global/pinned.md",
      new_path: "/memories/global/moved.md",
    });
    expect(rename.success).toBe(false);

    const edit = await execute(fixture.tool, {
      command: "str_replace",
      path: "/memories/global/pinned.md",
      old_str: "keep me",
      new_str: "keep me, polished",
    });
    expect(edit.success).toBe(true);
    expect(
      await fsPromises.readFile(path.join(fixture.globalMemoryDir, "pinned.md"), "utf-8")
    ).toContain("polished");
  });

  it("enforces pin protection inside the mutation against the store the command binds to", async () => {
    using fixture = await createFixture();
    const sessionMemory = path.join(fixture.xumHome, "sessions", fixture.ctx.workspaceId, "memory");
    await fsPromises.mkdir(sessionMemory, { recursive: true });
    await fsPromises.writeFile(path.join(sessionMemory, "pinned.md"), "keep me\n");
    await fixture.metaService.setPinned(
      memoryLogicalKey("workspace", "pinned.md", {
        projectPath: fixture.ctx.projectPath,
        workspaceId: fixture.ctx.workspaceId,
      }),
      true
    );
    // The tool's pre-check resolves the shared-store owner on its own; make
    // that resolution disagree with the command's (as a transiently unreadable
    // config.json can, falling back to a different store) so the pre-check
    // looks at the wrong sidecar key and passes. The command itself must
    // still refuse: its check runs in-lock against the owner its store is
    // bound to.
    const resolve = spyOn(fixture.memoryService, "resolveWorkspaceMemoryOwnerId");
    resolve.mockImplementationOnce(() => "ws-elsewhere");
    try {
      const deletion = await execute(fixture.tool, {
        command: "delete",
        path: "/memories/workspace/pinned.md",
      });
      expect(deletion.success).toBe(false);
      if (!deletion.success) expect(deletion.error).toContain("pinned");
      expect(await pathExists(path.join(sessionMemory, "pinned.md"))).toBe(true);
      resolve.mockImplementationOnce(() => "ws-elsewhere");
      const rename = await execute(fixture.tool, {
        command: "rename",
        old_path: "/memories/workspace/pinned.md",
        new_path: "/memories/workspace/moved.md",
      });
      expect(rename.success).toBe(false);
      if (!rename.success) expect(rename.error).toContain("pinned");
      expect(await pathExists(path.join(sessionMemory, "pinned.md"))).toBe(true);
    } finally {
      resolve.mockRestore();
    }
  });

  it("rejects deleting or renaming a directory that contains a pinned file", async () => {
    using fixture = await createFixture();
    const nestedDir = path.join(fixture.globalMemoryDir, "nested");
    await fsPromises.mkdir(nestedDir, { recursive: true });
    await fsPromises.writeFile(path.join(nestedDir, "pinned.md"), "keep me\n");
    await fixture.metaService.setPinned(
      memoryLogicalKey("global", "nested/pinned.md", {
        projectPath: fixture.ctx.projectPath,
        workspaceId: fixture.ctx.workspaceId,
      }),
      true
    );

    // Directory delete is recursive on disk; the guard must check the whole
    // subtree, not just the directory's own (unpinned) key.
    const deletion = await execute(fixture.tool, {
      command: "delete",
      path: "/memories/global/nested",
    });
    expect(deletion.success).toBe(false);
    if (!deletion.success) expect(deletion.error).toContain("pinned");
    expect(await pathExists(path.join(nestedDir, "pinned.md"))).toBe(true);

    const rename = await execute(fixture.tool, {
      command: "rename",
      old_path: "/memories/global/nested",
      new_path: "/memories/global/renamed",
    });
    expect(rename.success).toBe(false);
    expect(await pathExists(path.join(nestedDir, "pinned.md"))).toBe(true);
  });

  it("never deletes or renames pinned project files but allows editing them", async () => {
    using fixture = await createFixture({ projectPath: "/projects/demo" });
    await fsPromises.mkdir(fixture.projectMemoryDir, { recursive: true });
    await fsPromises.writeFile(path.join(fixture.projectMemoryDir, "pinned.md"), "keep me\n");
    await fixture.metaService.setPinned(
      memoryLogicalKey("project", "pinned.md", {
        projectPath: fixture.ctx.projectPath,
        workspaceId: fixture.ctx.workspaceId,
      }),
      true
    );

    const deletion = await execute(fixture.tool, {
      command: "delete",
      path: "/memories/project/pinned.md",
    });
    expect(deletion.success).toBe(false);
    if (!deletion.success) expect(deletion.error).toContain("pinned");

    const rename = await execute(fixture.tool, {
      command: "rename",
      old_path: "/memories/project/pinned.md",
      new_path: "/memories/project/moved.md",
    });
    expect(rename.success).toBe(false);

    const edit = await execute(fixture.tool, {
      command: "str_replace",
      path: "/memories/project/pinned.md",
      old_str: "keep me",
      new_str: "keep me, polished",
    });
    expect(edit.success).toBe(true);
    expect(
      await fsPromises.readFile(path.join(fixture.projectMemoryDir, "pinned.md"), "utf-8")
    ).toContain("polished");
  });

  it("never over-commits the budget when mutating tool calls run concurrently", async () => {
    using fixture = await createFixture();
    // Consume all but the last budget slot.
    for (let i = 0; i < MEMORY_CONSOLIDATION_OP_BUDGET - 1; i++) {
      const result = await execute(fixture.tool, {
        command: "create",
        path: `/memories/global/file-${i}.md`,
        file_text: "x\n",
      });
      expect(result.success).toBe(true);
    }

    // The AI SDK executes parallel tool calls concurrently; check + reserve
    // must happen in one synchronous block so exactly one of these wins.
    const [a, b] = await Promise.all([
      execute(fixture.tool, {
        command: "create",
        path: "/memories/global/race-a.md",
        file_text: "x\n",
      }),
      execute(fixture.tool, {
        command: "create",
        path: "/memories/global/race-b.md",
        file_text: "x\n",
      }),
    ]);
    expect([a.success, b.success].filter(Boolean)).toHaveLength(1);
    expect(fixture.getMutationCount()).toBe(MEMORY_CONSOLIDATION_OP_BUDGET);
    const loser = a.success ? b : a;
    if (!loser.success) expect(loser.error).toContain("budget");
  });

  it("exhausts the mutation budget and rejects further mutations while reads continue", async () => {
    using fixture = await createFixture();
    for (let i = 0; i < MEMORY_CONSOLIDATION_OP_BUDGET; i++) {
      const result = await execute(fixture.tool, {
        command: "create",
        path: `/memories/global/file-${i}.md`,
        file_text: "x\n",
      });
      expect(result.success).toBe(true);
    }

    const overBudget = await execute(fixture.tool, {
      command: "create",
      path: "/memories/global/one-too-many.md",
      file_text: "x\n",
    });
    expect(overBudget.success).toBe(false);
    if (!overBudget.success) expect(overBudget.error).toContain("budget");
    expect(await pathExists(path.join(fixture.globalMemoryDir, "one-too-many.md"))).toBe(false);

    const read = await execute(fixture.tool, { command: "view", path: "/memories/global/" });
    expect(read.success).toBe(true);
  });

  it("dry-run journals proposed mutations without touching disk and still consumes budget", async () => {
    using fixture = await createFixture({ dryRun: true });
    const result = await execute(fixture.tool, {
      command: "create",
      path: "/memories/global/proposed.md",
      file_text: "x\n",
    });
    expect(result.success).toBe(true);
    expect(await pathExists(path.join(fixture.globalMemoryDir, "proposed.md"))).toBe(false);
    expect(fixture.journal).toEqual([
      { command: "create", path: "/memories/global/proposed.md", applied: false, note: "dry-run" },
    ]);

    // Budget parity with real runs: dry-run proposals are budgeted too.
    for (let i = 1; i < MEMORY_CONSOLIDATION_OP_BUDGET; i++) {
      await execute(fixture.tool, {
        command: "create",
        path: `/memories/global/p-${i}.md`,
        file_text: "x\n",
      });
    }
    const overBudget = await execute(fixture.tool, {
      command: "delete",
      path: "/memories/global/proposed.md",
    });
    expect(overBudget.success).toBe(false);
  });

  it("dry-run rejects proposals the real write path would reject", async () => {
    // Codex round 18: the dry-run staging path returned before
    // executeMemoryCommand, skipping the real service's arg validation and
    // the memory file cap — an oversized/invalid mutation staged
    // successfully, was rendered into chat, and /refine apply later rejected
    // it through the real handler, consuming the staged set as a no-op after
    // the user approved.
    using fixture = await createFixture({ dryRun: true });

    // Over the real write cap: must fail staging with the real cap error.
    const overCap = await execute(fixture.tool, {
      command: "create",
      path: "/memories/global/too-big.md",
      file_text: "x".repeat(MEMORY_MAX_FILE_BYTES + 1),
    });
    expect(overCap.success).toBe(false);
    if (!overCap.success) expect(overCap.error).toContain(`${MEMORY_MAX_FILE_BYTES}`);

    // Missing required args: must fail staging with the real arg error.
    const missingArgs = await execute(fixture.tool, {
      command: "create",
      path: "/memories/global/no-text.md",
    });
    expect(missingArgs.success).toBe(false);
    if (!missingArgs.success) expect(missingArgs.error).toContain("file_text");

    // Both rejections journal as unapplied with the error, never as staged.
    expect(fixture.journal.every((op) => !op.applied && op.note !== "dry-run")).toBe(true);
  });

  it("dry-run rejects state-dependent mutations whose RESULT exceeds the cap", async () => {
    // Codex round 19: the round-18 check measured only the NEW text, but the
    // real write path caps the RESULTING file — inserting 2KiB into a 99KiB
    // file staged successfully, rendered approvable, then apply rejected it
    // and consumed the proposal. Validation must simulate the result.
    using fixture = await createFixture({ dryRun: true });
    const nearCap = `UNIQUE_MARKER${"x".repeat(MEMORY_MAX_FILE_BYTES - 1024)}`;
    await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "near-cap.md"), nearCap);

    const smallInsert = await execute(fixture.tool, {
      command: "insert",
      path: "/memories/global/near-cap.md",
      insert_line: 0,
      insert_text: "y".repeat(2 * 1024),
    });
    expect(smallInsert.success).toBe(false);
    if (!smallInsert.success) expect(smallInsert.error).toContain(`${MEMORY_MAX_FILE_BYTES}`);

    // Same result-size rule for str_replace growth on an existing file
    // (unique old_str so the failure is the cap, not the occurrence check).
    const growingReplace = await execute(fixture.tool, {
      command: "str_replace",
      path: "/memories/global/near-cap.md",
      old_str: "UNIQUE_MARKER",
      new_str: "y".repeat(2 * 1024),
    });
    expect(growingReplace.success).toBe(false);
    if (!growingReplace.success) {
      expect(growingReplace.error).toContain(`${MEMORY_MAX_FILE_BYTES}`);
    }

    // A result that stays under the cap still stages.
    const fits = await execute(fixture.tool, {
      command: "insert",
      path: "/memories/global/near-cap.md",
      insert_line: 0,
      insert_text: "small note",
    });
    expect(fits.success).toBe(true);
    // Dry-run: the target file is untouched.
    const onDisk = await fsPromises.readFile(
      path.join(fixture.globalMemoryDir, "near-cap.md"),
      "utf-8"
    );
    expect(onDisk).toBe(nearCap);
  });

  it("dry-run refuses an edit whose resulting file the guarded write would refuse", async () => {
    // Each half of the key passes the new-text check; only the resulting file holds the key, and
    // the preview must not show as accepted what apply mode refuses.
    const staged: string[] = [];
    using fixture = await createFixture({
      dryRun: true,
      guard: { rejectSecretLike: true, onStagedMutation: (_input, id) => staged.push(id) },
    });
    await fsPromises.writeFile(
      path.join(fixture.globalMemoryDir, "halves.md"),
      "sk-\nABCDEFGHIJKLMNO\n"
    );

    const joined = await execute(fixture.tool, {
      command: "str_replace",
      path: "/memories/global/halves.md",
      old_str: "sk-\nABC",
      new_str: "sk-ABC",
    });

    expect(joined.success).toBe(false);
    if (!joined.success) expect(joined.error).toContain("credential");
    expect(staged).toEqual([]);
    expect(fixture.journal).toMatchObject([{ command: "str_replace", applied: false }]);
  });

  it("dry-run rejects a create into a full memory scope", async () => {
    // Codex round 20: validateMutation accepted a create whenever the target
    // was free, but the real create() also rejects when the scope already
    // holds MEMORY_MAX_FILES_PER_SCOPE files — the proposal staged, rendered
    // approvable, then apply rejected it and consumed the set.
    using fixture = await createFixture({ dryRun: true });
    await Promise.all(
      Array.from({ length: MEMORY_MAX_FILES_PER_SCOPE }, (_, i) =>
        fsPromises.writeFile(path.join(fixture.globalMemoryDir, `filler-${i}.md`), "x\n")
      )
    );

    const intoFull = await execute(fixture.tool, {
      command: "create",
      path: "/memories/global/one-more.md",
      file_text: "must not stage\n",
    });
    expect(intoFull.success).toBe(false);
    if (!intoFull.success) expect(intoFull.error).toContain("full");
  });

  it("dry-run rejects renaming a directory into its own subtree", async () => {
    // Codex round 21: source exists and the exact destination doesn't, so
    // 'notes' -> 'notes/archive/notes' staged, rendered approvable, then the
    // filesystem rejected moving a dir into itself at apply — consuming the
    // approved set. Segment-aware: 'notes-x' must not match 'notes'.
    using fixture = await createFixture({ dryRun: true });
    await fsPromises.mkdir(path.join(fixture.globalMemoryDir, "notes"), { recursive: true });
    await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "notes", "a.md"), "a\n");

    const intoSelf = await execute(fixture.tool, {
      command: "rename",
      old_path: "/memories/global/notes",
      new_path: "/memories/global/notes/archive/notes",
    });
    expect(intoSelf.success).toBe(false);
    if (!intoSelf.success) expect(intoSelf.error).toContain("inside itself");

    // Segment-aware sibling: 'notes-x' shares the prefix but is NOT inside
    // 'notes' — it must stage normally.
    const sibling = await execute(fixture.tool, {
      command: "rename",
      old_path: "/memories/global/notes",
      new_path: "/memories/global/notes-x",
    });
    expect(sibling.success).toBe(true);
  });

  it("dry-run rejects own-subtree renames reached through an aliased path", async () => {
    // Codex round 22 (mirrors the memoryService handler test): staging
    // validation shares the physical-identity guard, so an aliased spelling
    // of the source (case variant on case-insensitive hosts; symlink here,
    // which CI can exercise) must refuse at staging instead of consuming the
    // approved set at apply.
    using fixture = await createFixture({ dryRun: true });
    await fsPromises.mkdir(path.join(fixture.globalMemoryDir, "notes"), { recursive: true });
    await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "notes", "a.md"), "a\n");
    await fsPromises.symlink("notes", path.join(fixture.globalMemoryDir, "alias"));

    const throughAlias = await execute(fixture.tool, {
      command: "rename",
      old_path: "/memories/global/notes",
      new_path: "/memories/global/alias/archive/notes",
    });
    expect(throughAlias.success).toBe(false);
    if (!throughAlias.success) expect(throughAlias.error).toContain("inside itself");
  });

  it("dry-run rejects delete/rename proposals the real handlers would reject", async () => {
    // Codex round 20: delete/rename skipped staging validation entirely —
    // deleting a nonexistent path, renaming a missing source, or renaming
    // onto an existing destination staged and presented for approval, then
    // failed at apply and consumed the set.
    using fixture = await createFixture({ dryRun: true });
    await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "exists-a.md"), "a\n");
    await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "exists-b.md"), "b\n");

    // Rename onto an existing destination: refused with the real error.
    const ontoExisting = await execute(fixture.tool, {
      command: "rename",
      old_path: "/memories/global/exists-a.md",
      new_path: "/memories/global/exists-b.md",
    });
    expect(ontoExisting.success).toBe(false);
    if (!ontoExisting.success) expect(ontoExisting.error).toContain("already exists");

    // Rename of a missing source: refused.
    const missingSource = await execute(fixture.tool, {
      command: "rename",
      old_path: "/memories/global/missing.md",
      new_path: "/memories/global/fresh.md",
    });
    expect(missingSource.success).toBe(false);

    // Delete of a nonexistent path: refused.
    const missingDelete = await execute(fixture.tool, {
      command: "delete",
      path: "/memories/global/never-existed.md",
    });
    expect(missingDelete.success).toBe(false);
    if (!missingDelete.success) {
      expect(missingDelete.error).toContain("No memory file or directory");
    }

    // Valid delete/rename still stage — and touch nothing on disk.
    const validRename = await execute(fixture.tool, {
      command: "rename",
      old_path: "/memories/global/exists-a.md",
      new_path: "/memories/global/renamed-a.md",
    });
    expect(validRename.success).toBe(true);
    const validDelete = await execute(fixture.tool, {
      command: "delete",
      path: "/memories/global/exists-b.md",
    });
    expect(validDelete.success).toBe(true);
    expect(await pathExists(path.join(fixture.globalMemoryDir, "exists-a.md"))).toBe(true);
    expect(await pathExists(path.join(fixture.globalMemoryDir, "exists-b.md"))).toBe(true);
  });

  it("journals failed dispatches as unapplied with the error note", async () => {
    using fixture = await createFixture();
    const result = await execute(fixture.tool, {
      command: "str_replace",
      path: "/memories/global/missing.md",
      old_str: "nothing",
      new_str: "something",
    });
    expect(result.success).toBe(false);
    expect(fixture.journal).toHaveLength(1);
    expect(fixture.journal[0]?.applied).toBe(false);
    expect(fixture.journal[0]?.note).toBeDefined();
  });
});

describe("organizerEditBudget", () => {
  it.each([
    [undefined, MEMORY_CONSOLIDATION_OP_BUDGET],
    [24, 24],
    [1, 1],
    [MEMORY_DREAM_EDIT_LIMIT_MAX, MEMORY_DREAM_EDIT_LIMIT_MAX],
    // Only null is unlimited here: the service turns the user's 0 into null before the run.
    [0, 0],
    // Unlimited, and any limit over the safety cap, runs at the cap.
    [null, MEMORY_DREAM_EDIT_LIMIT_MAX],
    [MEMORY_DREAM_EDIT_LIMIT_MAX + 1, MEMORY_DREAM_EDIT_LIMIT_MAX],
    [1_000_000, MEMORY_DREAM_EDIT_LIMIT_MAX],
    // NaN would make Math.min NaN, a budget that never refuses.
    [Number.NaN, MEMORY_CONSOLIDATION_OP_BUDGET],
  ])("gives a limit of %p a budget of %p and a prompt line that says so", (editLimit, limit) => {
    const editBudget = organizerEditBudget(editLimit);

    expect(editBudget.budget.limit).toBe(limit);
    expect(editBudget.promptLine).toBe(`You have ${limit} mutating commands this run.`);
    expect(editBudget.stepCeiling).toHaveLength(1);
  });

  it("refuses the edit after the safety cap when unlimited", () => {
    const editBudget = organizerEditBudget(null);

    for (let i = 0; i < MEMORY_DREAM_EDIT_LIMIT_MAX; i++) {
      expect(editBudget.budget.tryConsume()).toBe(true);
    }
    expect(editBudget.budget.tryConsume()).toBe(false);
  });
});

describe("createMutationBudget", () => {
  // Bounded, so a budget that never refuses (NaN, -Infinity) fails the test instead of hanging it.
  function consumeAll(budget: ReturnType<typeof createMutationBudget>): number {
    let granted = 0;
    while (granted < 1_000 && budget.tryConsume()) granted++;
    return granted;
  }

  it("resumes what an earlier attempt spent", () => {
    expect(consumeAll(createMutationBudget(8, 3))).toBe(5);
    expect(consumeAll(createMutationBudget(8, 8))).toBe(0);
  });

  // A persisted count that is not a whole, non-negative number must not widen the budget: -100
  // used to grant 108 mutations, and NaN never reached the limit at all.
  it.each([-100, -1, 2.5, Number.NaN, Number.NEGATIVE_INFINITY])(
    "never grants more than its limit when it resumes from %d",
    (alreadyUsed) => {
      const budget = createMutationBudget(8, alreadyUsed);

      expect(consumeAll(budget)).toBeLessThanOrEqual(8);
      expect(budget.used()).toBeLessThanOrEqual(8);
    }
  );
});

// $2 per million input tokens, and a priority tier that bills at twice that: a step of 250k input
// tokens costs $0.50 at Standard and $1.00 at priority.
const PRICED_MODEL = "openai:gpt-6.1-sol";
const HALF_DOLLAR_INPUT_TOKENS = 250_000;

/** A model whose every step lists the memory directory, so the run takes as many steps as it may. */
function listingModel(providerMetadata?: SharedV3ProviderMetadata): {
  model: MockLanguageModelV3;
  calls: Array<number | undefined>;
} {
  const calls: Array<number | undefined> = [];
  const model = new MockLanguageModelV3({
    doStream: (options) => {
      calls.push(options.maxOutputTokens);
      const chunks: LanguageModelV3StreamPart[] = [
        {
          type: "tool-call",
          toolCallId: `list-${calls.length}`,
          toolName: "memory",
          input: JSON.stringify({ command: "view", path: "/memories/" }),
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
          usage: {
            inputTokens: {
              total: HALF_DOLLAR_INPUT_TOKENS,
              noCache: HALF_DOLLAR_INPUT_TOKENS,
              cacheRead: 0,
              cacheWrite: 0,
            },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
          ...(providerMetadata === undefined ? {} : { providerMetadata }),
        },
      ];
      return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
    },
  });
  return { model, calls };
}

/** A model whose first step lands a global file and whose second is cut off at the output limit. */
function outputLimitedModel(): MockLanguageModelV3 {
  let calls = 0;
  const step = (name: string, unified: "tool-calls" | "length"): LanguageModelV3StreamPart[] => [
    {
      type: "tool-call",
      toolCallId: name,
      toolName: "memory",
      input: JSON.stringify({
        command: "create",
        path: `/memories/global/${name}.md`,
        file_text: "fact\n",
      }),
    },
    {
      type: "finish",
      finishReason: { unified, raw: unified },
      usage: {
        inputTokens: {
          total: HALF_DOLLAR_INPUT_TOKENS,
          noCache: HALF_DOLLAR_INPUT_TOKENS,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      },
    },
  ];
  return new MockLanguageModelV3({
    doStream: () => {
      calls += 1;
      const chunks = calls === 1 ? step("landed", "tool-calls") : step("cut", "length");
      return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
    },
  });
}

/**
 * A model whose first step is cut off at the output limit mid tool call (its input is not valid
 * JSON), whose second step creates a global file, and whose third ends the run.
 */
function recoveringModel(): MockLanguageModelV3 {
  let calls = 0;
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
  const finish = (unified: "tool-calls" | "length" | "stop"): LanguageModelV3StreamPart => ({
    type: "finish",
    finishReason: { unified, raw: unified },
    usage,
  });
  const steps: LanguageModelV3StreamPart[][] = [
    [
      {
        type: "tool-call",
        toolCallId: "cut",
        toolName: "memory",
        input: '{"command":"create","pa',
      },
      finish("length"),
    ],
    [
      {
        type: "tool-call",
        toolCallId: "retry",
        toolName: "memory",
        input: JSON.stringify({
          command: "create",
          path: "/memories/global/recovered.md",
          file_text: "fact\n",
        }),
      },
      finish("tool-calls"),
    ],
    [finish("stop")],
  ];
  return new MockLanguageModelV3({
    doStream: () => {
      const chunks = steps[Math.min(calls, steps.length - 1)];
      calls += 1;
      return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
    },
  });
}

describe("runMemoryConsolidation", () => {
  it("redacts a credential the model repeats in its closing summary", async () => {
    // The summary is persisted and shown through status IPC, outside the guarded writes.
    using fixture = await createFixture();
    const key = "sk-ABCDEFGHIJKLMNOPQRSTUV";
    const model = new MockLanguageModelV3({
      doStream: () =>
        Promise.resolve({
          stream: simulateReadableStream<LanguageModelV3StreamPart>({
            chunks: [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: `Removed the stale key ${key}.` },
              { type: "text-end", id: "t" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ],
          }),
        }),
    });

    const result = await runMemoryConsolidation({
      model,
      agentBody: "Consolidate the memory directories.",
      memoryService: fixture.memoryService,
      metaService: fixture.metaService,
      ctx: fixture.ctx,
      dryRun: false,
    });

    expect(result.streamError).toBeUndefined();
    expect(result.summary).not.toContain(key);
    expect(result.summary).toContain("Removed the stale key");
  });

  // What the organizer writes can be promoted where other workspaces' models read it, so its guard
  // refuses a credential in code, whatever the prompt said.
  it("refuses a credential the organizer tries to write", async () => {
    using fixture = await createFixture();
    const githubToken = `ghp_${"a1B2".repeat(9)}`;
    let calls = 0;
    const model = new MockLanguageModelV3({
      doStream: () => {
        calls += 1;
        const usage = {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        };
        const chunks: LanguageModelV3StreamPart[] =
          calls === 1
            ? [
                {
                  type: "tool-call",
                  toolCallId: "leak",
                  toolName: "memory",
                  input: JSON.stringify({
                    command: "create",
                    path: "/memories/global/deploy.md",
                    file_text: `GITHUB_TOKEN=${githubToken}\n`,
                  }),
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                  usage,
                },
              ]
            : [{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }];
        return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
      },
    });

    const result = await runMemoryConsolidation({
      model,
      pricingModel: PRICED_MODEL,
      agentBody: "Consolidate the memory directories.",
      memoryService: fixture.memoryService,
      metaService: fixture.metaService,
      ctx: fixture.ctx,
      dryRun: false,
    });

    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]?.applied).toBe(false);
    expect(JSON.stringify(result.ops)).not.toContain(githubToken);
    expect(await pathExists(path.join(fixture.globalMemoryDir, "deploy.md"))).toBe(false);
  });

  // The SDK runs no tool call of a step that finishes with `length`, and the stream ends without
  // an error: the pass must not read as a success, or it is journaled and the debounce holds off
  // the retry.
  it.each([
    ["a ceiling caps the step", 100],
    ["no ceiling is set", undefined],
  ])("fails a pass whose step ended at the output limit when %s", async (_name, ceilingUsd) => {
    using fixture = await createFixture();

    const result = await runMemoryConsolidation({
      model: outputLimitedModel(),
      pricingModel: PRICED_MODEL,
      ceilingUsd,
      agentBody: "Consolidate the memory directories.",
      memoryService: fixture.memoryService,
      metaService: fixture.metaService,
      ctx: fixture.ctx,
      dryRun: false,
    });

    expect(result.streamError).toContain("output limit");
    expect(result.summary).toContain("stream error");
    // What landed before the cut step stays, and what the steps cost stays counted.
    expect(result.ops.map((op) => op.path)).toEqual(["/memories/global/landed.md"]);
    expect(result.spentUsd).toBeCloseTo(1, 9);
    expect(await pathExists(path.join(fixture.globalMemoryDir, "cut.md"))).toBe(false);
  });

  // Headless runs bypass the chat cost pipeline: what a pass was billed reaches session usage only
  // through `recordUsage`, and a stream that ended at the output limit completed and was billed.
  it("reports the usage of a pass whose step ended at the output limit", async () => {
    using fixture = await createFixture();
    const recorded: Array<number | undefined> = [];

    const result = await runMemoryConsolidation({
      model: outputLimitedModel(),
      pricingModel: PRICED_MODEL,
      agentBody: "Consolidate the memory directories.",
      memoryService: fixture.memoryService,
      metaService: fixture.metaService,
      ctx: fixture.ctx,
      dryRun: false,
      recordUsage: (usage) => {
        recorded.push(usage.inputTokens);
        return Promise.resolve();
      },
    });

    expect(result.streamError).toContain("output limit");
    // Both steps count, the cut-off one too.
    expect(recorded).toEqual([2 * HALF_DOLLAR_INPUT_TOKENS]);
  });

  it("reports no usage for a stream that failed", async () => {
    using fixture = await createFixture();
    const recorded: Array<number | undefined> = [];

    const result = await runMemoryConsolidation({
      model: new MockLanguageModelV3({
        doStream: () =>
          Promise.resolve({
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              pull(controller) {
                controller.error(new Error("provider exploded"));
              },
            }),
          }),
      }),
      agentBody: "Consolidate the memory directories.",
      memoryService: fixture.memoryService,
      metaService: fixture.metaService,
      ctx: fixture.ctx,
      dryRun: false,
      recordUsage: (usage) => {
        recorded.push(usage.inputTokens);
        return Promise.resolve();
      },
    });

    // After a mid-flight error the SDK's usage promise can stay pending forever: nothing waits on it.
    expect(result.streamError).toContain("provider exploded");
    expect(recorded).toEqual([]);
    expect(result.usage).toBeUndefined();
  });

  it("completes a pass whose cut-off step the model retried in a later step", async () => {
    using fixture = await createFixture();

    const result = await runMemoryConsolidation({
      model: recoveringModel(),
      pricingModel: PRICED_MODEL,
      ceilingUsd: 100,
      agentBody: "Consolidate the memory directories.",
      memoryService: fixture.memoryService,
      metaService: fixture.metaService,
      ctx: fixture.ctx,
      dryRun: false,
    });

    expect(result.streamError).toBeUndefined();
    expect(result.ops.map((op) => op.path)).toEqual(["/memories/global/recovered.md"]);
    expect(await pathExists(path.join(fixture.globalMemoryDir, "recovered.md"))).toBe(true);
  });

  describe("cost ceiling", () => {
    async function run(
      fixture: Fixture,
      scripted: ReturnType<typeof listingModel>,
      ceilingUsd?: number
    ) {
      return runMemoryConsolidation({
        model: scripted.model,
        pricingModel: PRICED_MODEL,
        ceilingUsd,
        agentBody: "Consolidate the memory directories.",
        memoryService: fixture.memoryService,
        metaService: fixture.metaService,
        ctx: fixture.ctx,
        dryRun: false,
      });
    }

    it("takes every step it may, and measures their cost, with no ceiling", async () => {
      using fixture = await createFixture();
      const scripted = listingModel();

      const result = await run(fixture, scripted);

      expect(scripted.calls).toHaveLength(MEMORY_CONSOLIDATION_MAX_STEPS);
      expect(result.spentUsd).toBeCloseTo(0.5 * MEMORY_CONSOLIDATION_MAX_STEPS, 9);
      expect(result.note).toBeUndefined();
      expect(result.streamError).toBeUndefined();
    });

    it("stops after the step whose measured cost reaches the ceiling, as a normal end", async () => {
      using fixture = await createFixture();
      const scripted = listingModel();

      // $0.50 a step: the third step brings the spend to $1.50, over the $1.25 ceiling.
      const result = await run(fixture, scripted, 1.25);

      expect(scripted.calls).toHaveLength(3);
      expect(result.spentUsd).toBeCloseTo(1.5, 9);
      expect(result.note).toBe("stopped at the cost ceiling after $1.50");
      expect(result.streamError).toBeUndefined();
    });

    it("counts a step the provider billed at the priority tier at its billed rate", async () => {
      using fixture = await createFixture();
      const standard = listingModel();
      const priority = listingModel({ openai: { serviceTier: "priority" } });

      await run(fixture, standard, 1.25);
      const result = await run(fixture, priority, 1.25);

      // Standard needs three $0.50 steps to pass $1.25; priority bills $1.00 a step, so two do.
      expect(standard.calls).toHaveLength(3);
      expect(priority.calls).toHaveLength(2);
      expect(result.spentUsd).toBeCloseTo(2, 9);
    });

    it("caps what one step can write, which bounds how far it can overshoot", async () => {
      using fixture = await createFixture();
      const scripted = listingModel();

      await run(fixture, scripted, 0.25);

      expect(scripted.calls).toEqual([MEMORY_MAX_OUTPUT_TOKENS_PER_STEP]);
    });

    it("leaves a step's output uncapped when no ceiling is set", async () => {
      using fixture = await createFixture();
      const scripted = listingModel();

      await run(fixture, scripted);

      // Every step the run may take, none of them capped: the cap exists only to bound the step
      // that crosses a ceiling, and a user who set none keeps the model's own limit.
      expect(scripted.calls).toHaveLength(MEMORY_CONSOLIDATION_MAX_STEPS);
      expect(scripted.calls.every((cap) => cap === undefined)).toBe(true);
    });
  });

  describe("edit limit", () => {
    async function run(
      fixture: Fixture,
      model: MockLanguageModelV3,
      options: { editLimit?: number | null; ceilingUsd?: number; dryRun?: boolean } = {}
    ) {
      return runMemoryConsolidation({
        model,
        pricingModel: PRICED_MODEL,
        agentBody: "Consolidate the memory directories.",
        memoryService: fixture.memoryService,
        metaService: fixture.metaService,
        ctx: fixture.ctx,
        dryRun: false,
        ...options,
      });
    }

    /** A model whose first step creates `count` workspace files at once and whose second ends. */
    function creatingModel(count: number): { model: MockLanguageModelV3; prompts: string[] } {
      const prompts: string[] = [];
      let calls = 0;
      const usage = {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      };
      const model = new MockLanguageModelV3({
        doStream: (options) => {
          calls += 1;
          prompts.push(JSON.stringify(options.prompt));
          const creates: LanguageModelV3StreamPart[] = Array.from({ length: count }, (_, i) => ({
            type: "tool-call",
            toolCallId: `create-${i}`,
            toolName: "memory",
            input: JSON.stringify({
              command: "create",
              path: `/memories/workspace/f${i}.md`,
              file_text: "fact\n",
            }),
          }));
          const chunks: LanguageModelV3StreamPart[] =
            calls === 1
              ? [
                  ...creates,
                  {
                    type: "finish",
                    finishReason: { unified: "tool-calls", raw: "tool-calls" },
                    usage,
                  },
                ]
              : [{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }];
          return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
        },
      });
      return { model, prompts };
    }

    it("spends the configured limit and refuses the edit after it", async () => {
      using fixture = await createFixture();
      const scripted = creatingModel(5);

      const result = await run(fixture, scripted.model, { editLimit: 3 });

      expect(result.ops.filter((op) => op.applied)).toHaveLength(3);
      expect(result.budgetExhausted).toBe(true);
      expect(scripted.prompts[0]).toContain("You have 3 mutating commands this run.");
    });

    // Memory contents are untrusted model input: unlimited runs at the safety cap, so one run's
    // accepted writes, and its journal rows, stay bounded (organizerEditBudget's tests refuse the
    // edit after the cap; a cap's worth of parallel creates here would only slow the suite down).
    it("states the safety cap as the budget of an unlimited run", async () => {
      using fixture = await createFixture();
      const scripted = creatingModel(MEMORY_CONSOLIDATION_OP_BUDGET + 4);

      const result = await run(fixture, scripted.model, { editLimit: null });

      expect(result.ops.filter((op) => op.applied)).toHaveLength(
        MEMORY_CONSOLIDATION_OP_BUDGET + 4
      );
      expect(scripted.prompts[0]).toContain(
        `You have ${MEMORY_DREAM_EDIT_LIMIT_MAX} mutating commands this run.`
      );
    });

    // The journal saves every accepted command, so the cap is what keeps an unlimited run's journal
    // bounded. Dry run: the commands are accepted and journaled like real ones without a cap's
    // worth of file writes.
    it("stops accepting edits at the safety cap when unlimited, so its journal stays bounded", async () => {
      using fixture = await createFixture();
      const scripted = creatingModel(MEMORY_DREAM_EDIT_LIMIT_MAX + 3);

      const result = await run(fixture, scripted.model, { editLimit: null, dryRun: true });

      const accepted = result.ops.filter((op) => op.note === "dry-run");
      expect(accepted).toHaveLength(MEMORY_DREAM_EDIT_LIMIT_MAX);
      expect(result.budgetExhausted).toBe(true);
      expect(result.ops.length).toBeLessThanOrEqual(
        MEMORY_DREAM_EDIT_LIMIT_MAX + MEMORY_CONSOLIDATION_JOURNAL_MAX_ENTRIES
      );
    }, 120_000);

    it("keeps the default budget for a caller that passes no limit", async () => {
      using fixture = await createFixture();
      const scripted = creatingModel(MEMORY_CONSOLIDATION_OP_BUDGET + 1);

      const result = await run(fixture, scripted.model);

      expect(result.ops.filter((op) => op.applied)).toHaveLength(MEMORY_CONSOLIDATION_OP_BUDGET);
      expect(scripted.prompts[0]).toContain(
        `You have ${MEMORY_CONSOLIDATION_OP_BUDGET} mutating commands this run.`
      );
    });

    // Up to 96 model steps: slow on a loaded host, so a longer timeout than the default 5 s.
    it("takes 4 steps for each edit of a raised limit", async () => {
      using fixture = await createFixture();
      const scripted = listingModel();

      await run(fixture, scripted.model, { editLimit: 24 });

      expect(scripted.calls).toHaveLength(96);
    }, 30_000);

    it("never takes fewer steps than the default limit allows", async () => {
      using fixture = await createFixture();
      const scripted = listingModel();

      await run(fixture, scripted.model, { editLimit: 2 });

      expect(scripted.calls).toHaveLength(MEMORY_CONSOLIDATION_MAX_STEPS);
    });

    it("lets an unlimited run take more than the default 32 steps", async () => {
      using fixture = await createFixture();
      const scripted = listingModel();

      // $0.50 a step: the 40th step reaches the $20 ceiling, past the default 32 steps.
      const result = await run(fixture, scripted.model, { editLimit: null, ceilingUsd: 20 });

      expect(scripted.calls).toHaveLength(40);
      expect(result.note).toBe("stopped at the cost ceiling after $20.00");
    }, 30_000);
  });

  it("reports a pass cut short by its timeout as a stream error, not a clean run", async () => {
    // A real provider stream ends silently when its request is aborted: no error part reaches
    // consumeStream, so the pass used to read as clean and be journaled as a success.
    using fixture = await createFixture();
    const model = new MockLanguageModelV3({
      doStream: (options) =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener("abort", () =>
            reject(new Error("stalled provider call aborted"))
          );
        }),
    });

    const result = await runMemoryConsolidation({
      model,
      agentBody: "Consolidate the memory directories.",
      memoryService: fixture.memoryService,
      metaService: fixture.metaService,
      ctx: fixture.ctx,
      dryRun: false,
      abortSignal: AbortSignal.timeout(50),
    });

    expect(result.streamError).toContain("cut short");
    expect(result.usage).toBeUndefined();
  });
});
