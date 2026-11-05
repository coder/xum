import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { MAX_ARTIFACT_READ_BYTES, type ArtifactsContext } from "./artifactsOperations";
import {
  listShelfRoute,
  pinToShelfRoute,
  readShelfRoute,
  unpinShelfRoute,
} from "./artifactShelfOperations";
import { MAX_SHELF_FILE_BYTES, PROJECT_SHELF_MULTI_PROJECT_ERROR } from "./artifactShelf";
import { recordArtifactPublish } from "./artifactRecordStore";

describe("shelf routes", () => {
  let root: string;
  let context: ArtifactsContext;
  const workspaces: Record<string, { projectPath: string; projects?: unknown[] }> = {};

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-routes-"));
    workspaces.a = { projectPath: "/repos/app" };
    workspaces.b = { projectPath: "/repos/app" };
    workspaces.c = { projectPath: "/repos/other" };
    workspaces.multi = {
      projectPath: "/repos/app",
      projects: [
        { projectPath: "/repos/app", projectName: "app" },
        { projectPath: "/repos/other", projectName: "other" },
      ],
    };
    context = {
      config: { rootDir: root, sessionsDir: path.join(root, "sessions") },
      workspaceService: {
        getInfo: mock((id: string) =>
          Promise.resolve(workspaces[id] ? { id, name: id, ...workspaces[id] } : null)
        ),
      },
      experimentsService: { isExperimentEnabled: mock(() => true) },
    } as unknown as ArtifactsContext;
    const artifactsDir = path.join(root, "sessions", "a", "scratch", "artifacts");
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(path.join(artifactsDir, "chart.html"), "<p>v1</p>");
    await recordArtifactPublish({
      sessionDir: path.join(root, "sessions", "a"),
      relPath: "chart.html",
      title: "interactive chart",
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("a user pin is visible to every workspace of the project, not other projects", async () => {
    await fs.writeFile(
      path.join(root, "sessions", "a", "scratch", "artifacts", "chart.html"),
      "<p>v2</p>"
    );
    expect(
      await pinToShelfRoute(context, {
        workspaceId: "a",
        path: "chart.html",
        scope: "project",
      })
    ).toEqual({ success: true, data: { name: "chart.html" } });

    const fromB = await listShelfRoute(context, { workspaceId: "b" });
    expect(fromB.success && fromB.data.project).toMatchObject({
      available: true,
      entries: [{ name: "chart.html", title: "interactive chart", pinnedBy: "user", kind: "html" }],
    });
    const fromC = await listShelfRoute(context, { workspaceId: "c" });
    expect(fromC.success && fromC.data.project).toEqual({ available: true, entries: [] });

    expect(
      await readShelfRoute(
        context,
        { workspaceId: "b", scope: "project", name: "chart.html" },
        1024
      )
    ).toMatchObject({ success: true, data: { status: "ok", kind: "html", content: "<p>v2</p>" } });

    const listed = fromB.success && fromB.data.project.available ? fromB.data.project.entries : [];
    await unpinShelfRoute(context, {
      workspaceId: "b",
      scope: "project",
      name: "chart.html",
      expectedPinnedAtMs: listed[0]?.pinnedAtMs ?? -1,
    });
    const after = await listShelfRoute(context, { workspaceId: "a" });
    expect(after.success && after.data.project).toEqual({ available: true, entries: [] });
  });

  test("a pin keeps the kind the artifact was published as", async () => {
    const dir = path.join(root, "sessions", "a", "scratch", "artifacts");
    await fs.writeFile(path.join(dir, "notes.txt"), "# Notes");
    await recordArtifactPublish({
      sessionDir: path.join(root, "sessions", "a"),
      relPath: "notes.txt",
      title: "Notes",
      kind: "markdown",
    });
    await pinToShelfRoute(context, { workspaceId: "a", path: "notes.txt", scope: "global" });
    const listed = await listShelfRoute(context, { workspaceId: "a" });
    expect(listed.success && listed.data.global).toMatchObject([
      { name: "notes.txt", title: "Notes", kind: "markdown" },
    ]);
  });

  test("a pin of a file over the read cap fails with its size and leaves the shelf empty", async () => {
    const dir = path.join(root, "sessions", "a", "scratch", "artifacts");
    const size = MAX_ARTIFACT_READ_BYTES + 1;
    await fs.writeFile(path.join(dir, "huge.bin.md"), Buffer.alloc(size, "x"));
    expect(
      await pinToShelfRoute(context, { workspaceId: "a", path: "huge.bin.md", scope: "global" })
    ).toEqual({
      success: false,
      error: `Artifact is ${size} bytes; shelf files are capped at ${MAX_SHELF_FILE_BYTES} bytes`,
    });
    const listed = await listShelfRoute(context, { workspaceId: "a" });
    expect(listed.success && listed.data.global).toEqual([]);
  });

  test("a pin of a file that is gone fails and leaves the shelf empty", async () => {
    expect(
      await pinToShelfRoute(context, { workspaceId: "a", path: "gone.html", scope: "global" })
    ).toEqual({ success: false, error: "Artifact not found: gone.html" });
    const listed = await listShelfRoute(context, { workspaceId: "a" });
    expect(listed.success && listed.data.global).toEqual([]);
  });

  test("global pins show everywhere; multi-project workspaces have no project shelf", async () => {
    await pinToShelfRoute(context, {
      workspaceId: "a",
      path: "chart.html",
      scope: "global",
    });
    const multi = await listShelfRoute(context, { workspaceId: "multi" });
    expect(multi.success && multi.data).toMatchObject({
      project: { available: false, reason: PROJECT_SHELF_MULTI_PROJECT_ERROR },
      global: [{ name: "chart.html", scope: "global" }],
    });
    expect(
      await pinToShelfRoute(context, {
        workspaceId: "multi",
        path: "chart.html",
        scope: "project",
      })
    ).toEqual({ success: false, error: PROJECT_SHELF_MULTI_PROJECT_ERROR });
  });
});
