import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { ArtifactsContext } from "./artifactsOperations";
import {
  PINNED_FILES_MULTI_PROJECT_REASON,
  listPinnedFiles,
  pinFile,
  readPinnedFile,
  toPinnedRelativePath,
  unpinFile,
} from "./pinnedArtifactFiles";

describe("pinned workspace files", () => {
  let tempDir: string;
  let checkout: string;
  let context: ArtifactsContext;
  let projects: Array<{ projectPath: string; projectName: string }> | undefined;
  let subProjectPath: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pinned-files-"));
    checkout = path.join(tempDir, "checkout");
    await fs.mkdir(path.join(checkout, ".github"), { recursive: true });
    await fs.writeFile(path.join(checkout, "README.md"), "# Readme");
    await fs.writeFile(path.join(checkout, ".github", "ci.yml"), "on: push");
    projects = undefined;
    subProjectPath = undefined;
    context = {
      config: { sessionsDir: path.join(tempDir, "sessions") },
      workspaceService: {
        getInfo: mock((workspaceId: string) =>
          Promise.resolve(
            workspaceId === "ws"
              ? {
                  id: "ws",
                  name: "checkout",
                  projectPath: tempDir,
                  projectName: "project",
                  namedWorkspacePath: checkout,
                  runtimeConfig: { type: "worktree", srcBaseDir: tempDir },
                  projects,
                  subProjectPath,
                }
              : null
          )
        ),
      },
      experimentsService: { isExperimentEnabled: mock(() => true) },
    } as unknown as ArtifactsContext;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("toPinnedRelativePath keeps paths inside the checkout", () => {
    expect(toPinnedRelativePath(checkout, path.join(checkout, "src", "a.ts"))).toBe("src/a.ts");
    expect(toPinnedRelativePath(checkout, "./docs/x.md")).toBe("docs/x.md");
    expect(toPinnedRelativePath(checkout, ".github/ci.yml")).toBe(".github/ci.yml");
    expect(toPinnedRelativePath(checkout, "/etc/passwd")).toHaveProperty("error");
    expect(toPinnedRelativePath(checkout, "../outside.md")).toHaveProperty("error");
  });

  test("pin, list live, read, unpin", async () => {
    expect(
      await pinFile(context, { workspaceId: "ws", path: path.join(checkout, "README.md") })
    ).toEqual({ success: true, data: { path: "README.md" } });
    await pinFile(context, { workspaceId: "ws", path: ".github/ci.yml" });
    // Pinning twice keeps one entry.
    await pinFile(context, { workspaceId: "ws", path: "README.md" });

    const listed = await listPinnedFiles(context, { workspaceId: "ws" });
    if (!listed.success || !listed.data.available) throw new Error("expected pinned files");
    expect(listed.data.files.map(({ path, kind, size }) => ({ path, kind, size }))).toEqual([
      { path: "README.md", kind: "markdown", size: 8 },
      { path: ".github/ci.yml", kind: "text", size: 8 },
    ]);

    // Live: an edit shows up on the next read, no snapshot involved.
    await fs.writeFile(path.join(checkout, "README.md"), "# Changed");
    const read = await readPinnedFile(context, { workspaceId: "ws", path: "README.md" });
    expect(read).toMatchObject({ success: true, data: { status: "ok", content: "# Changed" } });

    await unpinFile(context, { workspaceId: "ws", path: "README.md" });
    const after = await listPinnedFiles(context, { workspaceId: "ws" });
    expect(after.success && after.data.available && after.data.files.map((f) => f.path)).toEqual([
      ".github/ci.yml",
    ]);
  });

  test("a checkout root that is itself a symlink can pin and read files", async () => {
    const linked = path.join(tempDir, "linked-checkout");
    await fs.symlink(checkout, linked);
    checkout = linked;
    expect(await pinFile(context, { workspaceId: "ws", path: "README.md" })).toEqual({
      success: true,
      data: { path: "README.md" },
    });
    expect(await readPinnedFile(context, { workspaceId: "ws", path: "README.md" })).toMatchObject({
      success: true,
      data: { status: "ok", content: "# Readme" },
    });
  });

  test("a deleted pinned file lists with null size and reads as not found", async () => {
    await pinFile(context, { workspaceId: "ws", path: "README.md" });
    await fs.rm(path.join(checkout, "README.md"));
    const listed = await listPinnedFiles(context, { workspaceId: "ws" });
    expect(listed.success && listed.data.available && listed.data.files[0]?.size).toBeNull();
    expect(await readPinnedFile(context, { workspaceId: "ws", path: "README.md" })).toEqual({
      success: false,
      error: "Artifact not found: README.md",
    });
  });

  test("only pinned paths are readable", async () => {
    expect(await readPinnedFile(context, { workspaceId: "ws", path: "README.md" })).toEqual({
      success: false,
      error: "File is not pinned: README.md",
    });
  });

  test("a corrupt store reads as empty and is rewritten by the next pin", async () => {
    const sessionDir = path.join(tempDir, "sessions", "ws");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "pinned-files.json"), "{broken");
    const listed = await listPinnedFiles(context, { workspaceId: "ws" });
    expect(listed.success && listed.data.available && listed.data.files).toEqual([]);
    await pinFile(context, { workspaceId: "ws", path: "README.md" });
    const again = await listPinnedFiles(context, { workspaceId: "ws" });
    expect(again.success && again.data.available && again.data.files.length).toBe(1);
  });

  test("refuses to pin missing files, folders and symlinks", async () => {
    await fs.symlink(path.join(checkout, "README.md"), path.join(checkout, "link.md"));
    for (const target of ["missing.txt", ".github", "link.md"]) {
      const result = await pinFile(context, { workspaceId: "ws", path: target });
      expect(result.success).toBe(false);
    }
    const listed = await listPinnedFiles(context, { workspaceId: "ws" });
    expect(listed.success && listed.data.available && listed.data.files).toEqual([]);
  });

  test("tool-cwd paths resolve from the sub-project dir file tools run in", async () => {
    subProjectPath = path.join(tempDir, "sub");
    await fs.mkdir(path.join(checkout, "sub", "src"), { recursive: true });
    await fs.writeFile(path.join(checkout, "sub", "src", "a.ts"), "export {}");
    expect(
      await pinFile(context, { workspaceId: "ws", path: "src/a.ts", relativeTo: "tool-cwd" })
    ).toEqual({ success: true, data: { path: "sub/src/a.ts" } });
    // Review paths stay checkout-relative.
    expect(
      await pinFile(context, { workspaceId: "ws", path: "README.md", relativeTo: "checkout" })
    ).toEqual({ success: true, data: { path: "README.md" } });
  });

  test("multi-project workspaces have no pinned files", async () => {
    projects = [
      { projectPath: "/a", projectName: "a" },
      { projectPath: "/b", projectName: "b" },
    ];
    expect(await listPinnedFiles(context, { workspaceId: "ws" })).toEqual({
      success: true,
      data: { available: false, reason: PINNED_FILES_MULTI_PROJECT_REASON },
    });
  });
});
