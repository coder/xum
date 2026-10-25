import * as fs from "fs/promises";
import * as path from "path";
import { describe, expect, it } from "bun:test";
import { Config } from "@/node/config";
import { TestTempDir } from "@/node/services/tools/testHelpers";
import type { Review } from "@/common/types/review";
import { MAX_READ_STATES } from "@/constants/reviewState";
import { workspaceRemovalTombstonePath } from "./workspaceRemoval";
import { REVIEW_STATE_FILE_NAME, ReviewStateService } from "./reviewStateService";

const WORKSPACE_ID = "review-ws";

async function createHarness(tempDir: TestTempDir) {
  const config = new Config(path.join(tempDir.path, "xum-home"));
  const projectPath = path.join(tempDir.path, "project");
  await fs.mkdir(projectPath, { recursive: true });
  await config.addWorkspace(projectPath, {
    id: WORKSPACE_ID,
    name: "review-branch",
    projectPath,
    projectName: "project",
    runtimeConfig: { type: "local" },
  });
  const filePath = path.join(config.sessionsDir, WORKSPACE_ID, REVIEW_STATE_FILE_NAME);
  return { config, filePath };
}

function makeReview(id: string, userNote: string): Review {
  return {
    id,
    data: { filePath: "src/a.ts", lineRange: "+1-2", selectedCode: "x", userNote },
    status: "attached",
    createdAt: 1,
  };
}

describe("ReviewStateService", () => {
  it("persists merged deltas so a fresh service instance reads them back", async () => {
    using tempDir = new TestTempDir("review-state-roundtrip");
    const { config } = await createHarness(tempDir);
    const service = new ReviewStateService(config);

    await service.applyDelta(WORKSPACE_ID, {
      reviews: { set: { r1: makeReview("r1", "first"), r2: makeReview("r2", "second") } },
      firstSeen: { set: { h1: 100 } },
      hunkExpand: { set: { h1: true } },
    });
    await service.applyDelta(WORKSPACE_ID, {
      reviews: { set: { r1: makeReview("r1", "edited") }, delete: ["r2"] },
      // A second client reporting a later first-seen must not move it later.
      firstSeen: { set: { h1: 500, h2: 600 } },
    });

    const reloaded = await new ReviewStateService(config).getSnapshot(WORKSPACE_ID);
    expect(reloaded.sections.reviews).toEqual({ r1: makeReview("r1", "edited") });
    expect(reloaded.sections.firstSeen).toEqual({ h1: 100, h2: 600 });
    expect(reloaded.sections.hunkExpand).toEqual({ h1: true });
    // Never-written sections stay absent (this is what keeps the legacy import non-clobbering).
    expect(reloaded.sections.readState).toBeUndefined();
  });

  it("orders writes with a revision shared by the reply, the change event and new subscriptions", async () => {
    using tempDir = new TestTempDir("review-state-revision");
    const { config } = await createHarness(tempDir);
    const service = new ReviewStateService(config);
    const emitted: number[] = [];
    service.on(ReviewStateService.changeEventName(WORKSPACE_ID), (change: { revision: number }) =>
      emitted.push(change.revision)
    );

    const first = await service.applyDelta(WORKSPACE_ID, { hunkExpand: { set: { h1: true } } });
    const second = await service.applyDelta(WORKSPACE_ID, { hunkExpand: { set: { h1: false } } });

    expect(second.revision).toBeGreaterThan(first.revision);
    expect(emitted).toEqual([first.revision, second.revision]);
    const initial = await service.getSnapshotWithRevision(WORKSPACE_ID);
    expect(initial.revision).toBe(second.revision);
    expect(initial.snapshot.sections.hunkExpand).toEqual({ h1: false });
  });

  it("evicts the oldest read states beyond the cap", async () => {
    using tempDir = new TestTempDir("review-state-caps");
    const { config } = await createHarness(tempDir);
    const service = new ReviewStateService(config);

    const set: Record<string, { hunkId: string; isRead: boolean; timestamp: number }> = {};
    for (let i = 0; i <= MAX_READ_STATES; i++) {
      set[`h${i}`] = { hunkId: `h${i}`, isRead: true, timestamp: i };
    }
    const snapshot = await service.applyDelta(WORKSPACE_ID, { readState: { set } });

    const kept = Object.keys(snapshot.sections.readState ?? {});
    expect(kept).toHaveLength(MAX_READ_STATES);
    expect(kept).not.toContain("h0");
    expect(kept).toContain(`h${MAX_READ_STATES}`);
  });

  it("self-heals a malformed file to its valid subset", async () => {
    using tempDir = new TestTempDir("review-state-malformed");
    const { config, filePath } = await createHarness(tempDir);
    const service = new ReviewStateService(config);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    await fs.writeFile(filePath, "{not json");
    expect(await service.getSnapshot(WORKSPACE_ID)).toEqual({ sections: {} });

    await fs.writeFile(
      filePath,
      JSON.stringify({
        sections: {
          reviews: { good: makeReview("good", "ok"), bad: { id: "bad", status: "weird" } },
          readState: "not an object",
          readMore: { h1: { up: 30, down: 0 }, h2: { up: -1, down: 0 } },
        },
      })
    );
    const healed = await service.getSnapshot(WORKSPACE_ID);
    expect(healed.sections.reviews).toEqual({ good: makeReview("good", "ok") });
    expect(healed.sections.readState).toBeUndefined();
    expect(healed.sections.readMore).toEqual({ h1: { up: 30, down: 0 } });

    // Writes keep working on top of the healed data.
    const updated = await service.applyDelta(WORKSPACE_ID, { hunkExpand: { set: { h1: false } } });
    expect(updated.sections.reviews).toEqual({ good: makeReview("good", "ok") });
    expect(updated.sections.hunkExpand).toEqual({ h1: false });
  });

  it("imports legacy notes the backend lacks but leaves present hunk-keyed sections untouched", async () => {
    using tempDir = new TestTempDir("review-state-import");
    const { config } = await createHarness(tempDir);
    const service = new ReviewStateService(config);
    await service.applyDelta(WORKSPACE_ID, {
      reviews: { set: { shared: makeReview("shared", "backend copy") } },
      firstSeen: { set: { h1: 100 } },
      // The user marked h1 unread (deleted its entry) after an earlier import.
      readState: { delete: ["h1"] },
    });

    // Another origin's localStorage: its own note, an older copy of a shared one, and hunk keys.
    const result = await service.importLegacy(WORKSPACE_ID, {
      reviews: {
        shared: makeReview("shared", "legacy copy"),
        other: makeReview("other", "other origin"),
      },
      firstSeen: { h1: 40, h2: 80 },
      readState: { h1: { hunkId: "h1", isRead: true, timestamp: 5 } },
      hunkExpand: { h1: true },
    });

    expect(result.results).toEqual({
      reviews: "present",
      firstSeen: "present",
      readState: "present",
      hunkExpand: "applied",
    });
    const reloaded = await new ReviewStateService(config).getSnapshot(WORKSPACE_ID);
    expect(reloaded.sections.reviews).toEqual({
      shared: makeReview("shared", "backend copy"),
      other: makeReview("other", "other origin"),
    });
    // Hunk ids are deterministic: merging them would resurrect the cleared read state.
    expect(reloaded.sections.readState).toEqual({});
    expect(reloaded.sections.firstSeen).toEqual({ h1: 100 });
    expect(reloaded.sections.hunkExpand).toEqual({ h1: true });
  });

  it("rejects a workspace id that escapes the sessions dir", async () => {
    using tempDir = new TestTempDir("review-state-escape");
    const { config } = await createHarness(tempDir);
    const service = new ReviewStateService(config);
    const escaped = path.join(config.sessionsDir, "..", "x");

    let error: unknown = null;
    await service.applyDelta("../x", { hunkExpand: { set: { h1: true } } }).catch((e) => {
      error = e;
    });

    expect(error).not.toBeNull();
    expect(
      await fs.stat(escaped).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  it("fails a write instead of replacing a review-state file it cannot read", async () => {
    // Root reads a 0o000 file anyway, so the unreadable-file condition cannot be staged.
    if (process.getuid?.() === 0) return;
    using tempDir = new TestTempDir("review-state-unreadable");
    const { config, filePath } = await createHarness(tempDir);
    const service = new ReviewStateService(config);
    await service.applyDelta(WORKSPACE_ID, { reviews: { set: { r1: makeReview("r1", "keep") } } });
    const original = await fs.readFile(filePath, "utf-8");
    await fs.chmod(filePath, 0o000);

    let error: unknown = null;
    try {
      await service.applyDelta(WORKSPACE_ID, { hunkExpand: { set: { h1: true } } }).catch((e) => {
        error = e;
      });
    } finally {
      await fs.chmod(filePath, 0o600);
    }

    expect(error).not.toBeNull();
    expect(await fs.readFile(filePath, "utf-8")).toBe(original);
  });

  it("does not recreate the session dir for a workspace missing from config", async () => {
    using tempDir = new TestTempDir("review-state-deleted");
    const { config } = await createHarness(tempDir);
    const service = new ReviewStateService(config);

    await service.applyDelta("deleted-ws", { hunkExpand: { set: { h1: true } } });
    await service.importLegacy("deleted-ws", { hunkExpand: { h1: true } });

    const exists = await fs.stat(path.join(config.sessionsDir, "deleted-ws")).then(
      () => true,
      () => false
    );
    expect(exists).toBe(false);
  });

  it("does not recreate the session dir of a workspace whose removal deleted it but has not deregistered it yet", async () => {
    using tempDir = new TestTempDir("review-state-removing");
    const { config } = await createHarness(tempDir);
    const service = new ReviewStateService(config);
    // Removal's order: tombstone, delete the session dir, and only then deregister from config.
    const tombstone = workspaceRemovalTombstonePath(config.rootDir, WORKSPACE_ID);
    await fs.mkdir(path.dirname(tombstone), { recursive: true });
    await fs.writeFile(tombstone, "{}");

    // Rejected (retryable), not reported as written: the tombstone may be transient.
    let refused = false;
    await service
      .applyDelta(WORKSPACE_ID, { hunkExpand: { set: { h1: true } } })
      .catch(() => (refused = true));
    expect(refused).toBe(true);

    const exists = await fs.stat(path.join(config.sessionsDir, WORKSPACE_ID)).then(
      () => true,
      () => false
    );
    expect(exists).toBe(false);
  });

  it("fails the update without announcing it when the config cannot be read", async () => {
    using tempDir = new TestTempDir("review-state-unreadable-config");
    const { config, filePath } = await createHarness(tempDir);
    const service = new ReviewStateService(config);
    let changes = 0;
    service.on(ReviewStateService.changeEventName(WORKSPACE_ID), () => changes++);
    await fs.writeFile(path.join(config.rootDir, "config.json"), "{not json");

    let error: unknown = null;
    await service.applyDelta(WORKSPACE_ID, { hunkExpand: { set: { h1: true } } }).catch((e) => {
      error = e;
    });

    // A rejection makes the client keep the change and retry; a skipped write reported as
    // success would make it drop the change.
    expect(error).not.toBeNull();
    expect(changes).toBe(0);
    expect(
      await fs.stat(filePath).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });
});
