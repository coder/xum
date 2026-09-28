import * as fs from "fs/promises";
import * as path from "path";
import { describe, expect, it } from "bun:test";
import { Config } from "@/node/config";
import { TestTempDir } from "@/node/services/tools/testHelpers";
import type { Review } from "@/common/types/review";
import { MAX_READ_STATES } from "@/constants/reviewState";
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

  it("imports legacy sections only where the backend has never written them", async () => {
    using tempDir = new TestTempDir("review-state-import");
    const { config } = await createHarness(tempDir);
    const service = new ReviewStateService(config);
    // Present-but-empty: the user cleared all reviews on the backend already.
    await service.applyDelta(WORKSPACE_ID, { reviews: { delete: ["gone"] } });

    const result = await service.importLegacy(WORKSPACE_ID, {
      reviews: { stale: makeReview("stale", "from localStorage") },
      readState: { h1: { hunkId: "h1", isRead: true, timestamp: 5 } },
    });

    expect(result.results).toEqual({ reviews: "present", readState: "applied" });
    const reloaded = await new ReviewStateService(config).getSnapshot(WORKSPACE_ID);
    expect(reloaded.sections.reviews).toEqual({});
    expect(reloaded.sections.readState).toEqual({
      h1: { hunkId: "h1", isRead: true, timestamp: 5 },
    });
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
});
