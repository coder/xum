import { describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import type { ToolExecutionOptions } from "ai";
import type { AssistedReviewHunk } from "@/common/types/review";
import type { ReviewPaneGetToolResult, ReviewPaneUpdateToolResult } from "@/common/types/tools";
import {
  applyReviewPaneUpdate,
  createReviewPaneGetTool,
  createReviewPaneUpdateTool,
} from "./review_pane";
import {
  coerceAssistedReviewHunks,
  getAssistedReviewFilePath,
  readAssistedReviewForSessionDir,
} from "@/node/services/reviewPane/assistedReviewStorage";
import { TestTempDir, createTestToolConfig, mockToolCallOptions } from "./testHelpers";

type UpdateExecArgs = Parameters<
  NonNullable<ReturnType<typeof createReviewPaneUpdateTool>["execute"]>
>[0];

async function runUpdate(
  tool: ReturnType<typeof createReviewPaneUpdateTool>,
  args: UpdateExecArgs,
  options: ToolExecutionOptions<unknown> = mockToolCallOptions
): Promise<ReviewPaneUpdateToolResult | { success: false; error: string }> {
  return (await tool.execute!(args, options)) as
    | ReviewPaneUpdateToolResult
    | { success: false; error: string };
}

async function runGet(
  tool: ReturnType<typeof createReviewPaneGetTool>,
  options: ToolExecutionOptions<unknown> = mockToolCallOptions
): Promise<ReviewPaneGetToolResult> {
  return (await tool.execute!({}, options)) as ReviewPaneGetToolResult;
}

describe("applyReviewPaneUpdate", () => {
  it("replaces the current set when operation is 'replace'", () => {
    const current: AssistedReviewHunk[] = [{ path: "old.ts", comment: "stale" }];
    const result = applyReviewPaneUpdate(current, {
      operation: "replace",
      hunks: [{ path: "src/foo.ts:10-20", comment: "review here" }],
    });
    expect(result.hunks).toEqual([
      { path: "src/foo.ts", range: { start: 10, end: 20 }, comment: "review here" },
    ]);
  });

  it("appends to the current set when operation is 'add'", () => {
    const current: AssistedReviewHunk[] = [{ path: "src/a.ts" }];
    const result = applyReviewPaneUpdate(current, {
      operation: "add",
      hunks: [{ path: "src/b.ts:5", comment: "edge case" }],
    });
    expect(result.hunks.map((h) => h.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("dedupes by formatted path:range key when adding, preferring the latest comment", () => {
    const current: AssistedReviewHunk[] = [
      { path: "src/foo.ts", range: { start: 1, end: 10 }, comment: "first" },
    ];
    const result = applyReviewPaneUpdate(current, {
      operation: "add",
      hunks: [{ path: "src/foo.ts:1-10", comment: "refined" }],
    });
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]?.comment).toBe("refined");
  });

  it("normalizes execution-relative paths before deduping", () => {
    const current: AssistedReviewHunk[] = [{ path: "packages/api/src/foo.ts", comment: "old" }];
    const result = applyReviewPaneUpdate(
      current,
      {
        operation: "add",
        hunks: [{ path: "src/foo.ts", comment: "new" }],
      },
      {
        projectPath: "/repo/app",
        executionRootPath: "/repo/app/packages/api",
      }
    );

    expect(result.hunks).toEqual([{ path: "packages/api/src/foo.ts", comment: "new" }]);
  });

  it("keeps incoming canonical paths distinct from ambiguous fallback pins", () => {
    const current: AssistedReviewHunk[] = [{ path: "src/foo.ts", comment: "root" }];
    const result = applyReviewPaneUpdate(
      current,
      {
        operation: "add",
        hunks: [{ path: "packages/api/src/foo.ts", comment: "scoped" }],
      },
      {
        projectPath: "/repo/app",
        executionRootPath: "/repo/app/packages/api",
      }
    );

    expect(result.hunks).toEqual([
      { path: "src/foo.ts", comment: "root" },
      { path: "packages/api/src/foo.ts", comment: "scoped" },
    ]);
  });

  it("prefers exact dedupe keys over fallback keys", () => {
    const current: AssistedReviewHunk[] = [
      { path: "packages/api/src/foo.ts", comment: "scoped" },
      { path: "src/foo.ts", comment: "root" },
    ];
    const result = applyReviewPaneUpdate(
      current,
      {
        operation: "add",
        hunks: [{ path: "packages/api/src/foo.ts", comment: "refined scoped" }],
      },
      {
        projectPath: "/repo/app",
        executionRootPath: "/repo/app/packages/api",
      }
    );

    expect(result.hunks).toEqual([
      { path: "packages/api/src/foo.ts", comment: "refined scoped" },
      { path: "src/foo.ts", comment: "root" },
    ]);
  });

  it("does not fallback-dedupe hunks added earlier in the same update", () => {
    const result = applyReviewPaneUpdate(
      [],
      {
        operation: "add",
        hunks: [
          { path: "packages/api/src/foo.ts", comment: "scoped" },
          { path: "src/foo.ts", comment: "root" },
        ],
      },
      {
        projectPath: "/repo/app",
        executionRootPath: "/repo/app/packages/api",
      }
    );

    expect(result.hunks).toEqual([
      { path: "packages/api/src/foo.ts", comment: "scoped" },
      { path: "src/foo.ts", comment: "root" },
    ]);
  });

  it("keeps project-relative paths outside the execution root canonical", () => {
    const result = applyReviewPaneUpdate(
      [],
      {
        operation: "replace",
        hunks: [{ path: "README.md" }, { path: "packages/shared.ts" }],
      },
      {
        projectPath: "/repo/app",
        executionRootPath: "/repo/app/packages/api",
      }
    );

    expect(result.hunks.map((h) => h.path)).toEqual(["README.md", "packages/shared.ts"]);
  });

  it("returns rejected entries for malformed filters", () => {
    const result = applyReviewPaneUpdate([], {
      operation: "replace",
      hunks: [{ path: "  " }, { path: "src/ok.ts" }],
    });
    expect(result.rejected).toEqual(["  "]);
    expect(result.hunks.map((h) => h.path)).toEqual(["src/ok.ts"]);
  });

  it("normalizes empty comments to undefined", () => {
    const result = applyReviewPaneUpdate([], {
      operation: "replace",
      hunks: [{ path: "a.ts", comment: "   " }],
    });
    expect(result.hunks[0]?.comment).toBeUndefined();
  });

  it("clearing via replace with empty hunks returns empty list", () => {
    const result = applyReviewPaneUpdate([{ path: "a.ts" }, { path: "b.ts" }], {
      operation: "replace",
      hunks: [],
    });
    expect(result.hunks).toEqual([]);
  });
});

describe("coerceAssistedReviewHunks", () => {
  it("returns empty for non-arrays", () => {
    expect(coerceAssistedReviewHunks(null)).toEqual([]);
    expect(coerceAssistedReviewHunks({})).toEqual([]);
    expect(coerceAssistedReviewHunks("nope")).toEqual([]);
  });

  it("filters out entries with missing/invalid path", () => {
    // Defensive parsing means a corrupted-on-disk file can't crash the next
    // tool call. Only entries with a non-empty string `path` survive.
    const out = coerceAssistedReviewHunks([
      { path: "ok.ts" },
      { path: "" },
      { path: 42 },
      { not_a_path: "x" },
    ]);
    expect(out).toEqual([{ path: "ok.ts", range: undefined, comment: undefined }]);
  });

  it("accepts well-formed ranges and drops malformed ones", () => {
    const out = coerceAssistedReviewHunks([
      { path: "a.ts", range: { start: 1, end: 5 } },
      { path: "b.ts", range: { start: "1", end: 5 } },
      { path: "c.ts", range: { end: 5 } },
      { path: "d.ts", range: "garbage" },
    ]);
    expect(out).toEqual([
      { path: "a.ts", range: { start: 1, end: 5 }, comment: undefined },
      { path: "b.ts", range: undefined, comment: undefined },
      { path: "c.ts", range: undefined, comment: undefined },
      { path: "d.ts", range: undefined, comment: undefined },
    ]);
  });

  it("treats empty-string comment as undefined", () => {
    const out = coerceAssistedReviewHunks([{ path: "a.ts", comment: "" }]);
    expect(out[0]?.comment).toBeUndefined();
  });
});

describe("review_pane tool persistence", () => {
  it("persists hunks to disk so `get` and `add` survive a tool re-instantiation", async () => {
    // Simulating an app/backend restart: build a fresh tool factory against
    // the same session dir and verify the prior set is still visible. This
    // is the regression the Codex P2 finding pointed at — without on-disk
    // state, a post-restart `add` would silently start from `[]`.
    using tempDir = new TestTempDir("review-pane-persist");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: "ws-persist",
      sessionsDir: tempDir.path,
    });

    const update = createReviewPaneUpdateTool(config);
    const replace = await runUpdate(update, {
      operation: "replace",
      hunks: [
        { path: "src/foo.ts:10-20", comment: "first" },
        { path: "src/bar.ts", comment: "context" },
      ],
    });
    expect("success" in replace && replace.success).toBe(true);

    // Simulate restart: brand-new factories, same config.
    const updateAfter = createReviewPaneUpdateTool(config);
    const getAfter = createReviewPaneGetTool(config);

    const got = await runGet(getAfter);
    expect(got.hunks.map((h) => h.path)).toEqual(["src/foo.ts:10-20", "src/bar.ts"]);
    expect(got.hunks[0]?.comment).toBe("first");

    // `add` after restart must extend (not truncate) the existing set.
    const added = await runUpdate(updateAfter, {
      operation: "add",
      hunks: [{ path: "src/baz.ts:1-5" }],
    });
    if (!("success" in added) || !added.success) {
      throw new Error("expected add to succeed");
    }
    expect(added.hunks.map((h) => h.path)).toEqual([
      "src/foo.ts:10-20",
      "src/bar.ts",
      "src/baz.ts:1-5",
    ]);
  });

  it("serializes concurrent add operations so no pinned hunks are lost", async () => {
    // Regression guard for Codex P1: locking only the write lets sibling
    // `add` calls all read the same baseline, then last-writer-wins drops
    // earlier pins. The whole read/apply/write sequence must be one critical
    // section so every add composes with the previous one.
    using tempDir = new TestTempDir("review-pane-concurrent");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: "ws-concurrent",
      sessionsDir: tempDir.path,
    });
    const update = createReviewPaneUpdateTool(config);
    const get = createReviewPaneGetTool(config);

    const count = 12;
    await Promise.all(
      Array.from({ length: count }, async (_, i) =>
        runUpdate(update, {
          operation: "add",
          hunks: [{ path: `src/concurrent-${i}.ts`, comment: `pin ${i}` }],
        })
      )
    );

    const got = await runGet(get);
    const paths = got.hunks.map((h) => h.path).sort();
    expect(paths).toEqual(Array.from({ length: count }, (_, i) => `src/concurrent-${i}.ts`).sort());
    expect(got.hunks).toHaveLength(count);
  });

  it("removes the on-disk file when the agent clears its hint set", async () => {
    // A residual file would shadow a fresh start (the file would be re-read
    // and re-applied to dedup math), so a `replace` with no hunks must
    // actually unlink it.
    using tempDir = new TestTempDir("review-pane-clear");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: "ws-clear",
      sessionsDir: tempDir.path,
    });
    const update = createReviewPaneUpdateTool(config);

    await runUpdate(update, {
      operation: "replace",
      hunks: [{ path: "src/foo.ts" }],
    });
    const filePath = getAssistedReviewFilePath(tempDir.path);
    // File should exist after a non-empty replace. Reading it back is the
    // most portable existence check (Bun's `fs.access` typings are
    // inconsistent with Node's in this repo's bun:test setup).
    const onDisk = await fs.readFile(filePath, "utf-8");
    expect(JSON.parse(onDisk)).toEqual([{ path: "src/foo.ts" }]);

    await runUpdate(update, { operation: "replace", hunks: [] });

    // After clearing, the file must be gone — confirm via a read that throws ENOENT.
    let enoent: NodeJS.ErrnoException | null = null;
    try {
      await fs.readFile(filePath, "utf-8");
    } catch (err) {
      enoent = err as NodeJS.ErrnoException;
    }
    expect(enoent?.code).toBe("ENOENT");
    // A subsequent `get` returns the empty list.
    const get = createReviewPaneGetTool(config);
    const got = await runGet(get);
    expect(got.hunks).toEqual([]);
  });

  it("isolates state across workspaces by session directory", async () => {
    // Each workspace writes to its own session dir, so flagging in one
    // workspace must not bleed into another's pinned set.
    using tempDir = new TestTempDir("review-pane-iso");
    const dirA = `${tempDir.path}/wsA`;
    const dirB = `${tempDir.path}/wsB`;
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });

    const configA = createTestToolConfig(tempDir.path, {
      workspaceId: "wsA",
      sessionsDir: dirA,
    });
    const configB = createTestToolConfig(tempDir.path, {
      workspaceId: "wsB",
      sessionsDir: dirB,
    });
    const updateA = createReviewPaneUpdateTool(configA);
    const getB = createReviewPaneGetTool(configB);

    await runUpdate(updateA, {
      operation: "replace",
      hunks: [{ path: "src/foo.ts" }],
    });
    const gotB = await runGet(getB);
    expect(gotB.hunks).toEqual([]);

    // And direct disk reads agree.
    expect(await readAssistedReviewForSessionDir(dirA)).toHaveLength(1);
    expect(await readAssistedReviewForSessionDir(dirB)).toHaveLength(0);
  });

  it("self-heals from a corrupted file by treating it as empty", async () => {
    // Mirrors the doctrine in AGENTS.md (Self-Healing & Crash Resilience):
    // bad JSON on disk should not brick the tool — the next call starts
    // clean and `replace` overwrites the broken file.
    using tempDir = new TestTempDir("review-pane-corrupt");
    const config = createTestToolConfig(tempDir.path, {
      workspaceId: "ws-corrupt",
      sessionsDir: tempDir.path,
    });
    const filePath = getAssistedReviewFilePath(tempDir.path);
    await fs.writeFile(filePath, "{ not: valid json");

    const get = createReviewPaneGetTool(config);
    const update = createReviewPaneUpdateTool(config);

    const got = await runGet(get);
    expect(got.hunks).toEqual([]);

    // `add` on a corrupted baseline should silently start fresh, not crash.
    const added = await runUpdate(update, {
      operation: "add",
      hunks: [{ path: "src/foo.ts" }],
    });
    if (!("success" in added) || !added.success) {
      throw new Error("expected add to succeed");
    }
    expect(added.hunks.map((h) => h.path)).toEqual(["src/foo.ts"]);
  });
});
