import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import * as runtimeHelpers from "@/node/runtime/runtimeHelpers";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
import * as artifactStoreModule from "./artifactStore";
import type { ArtifactsContext } from "./artifactsOperations";
import {
  PINNED_FILES_DEVCONTAINER_OUTSIDE_REASON,
  PINNED_FILES_MULTI_PROJECT_REASON,
  addPinnedPath,
  listPinnedFiles,
  readPinnedPaths,
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
  let runtimeConfig: Record<string, unknown>;
  let workspaceName: string;
  let projectPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pinned-files-"));
    checkout = path.join(tempDir, "checkout");
    await fs.mkdir(path.join(checkout, ".github"), { recursive: true });
    await fs.writeFile(path.join(checkout, "README.md"), "# Readme");
    await fs.writeFile(path.join(checkout, ".github", "ci.yml"), "on: push");
    projects = undefined;
    subProjectPath = undefined;
    runtimeConfig = { type: "worktree", srcBaseDir: tempDir };
    workspaceName = "checkout";
    projectPath = tempDir;
    context = {
      config: { sessionsDir: path.join(tempDir, "sessions") },
      workspaceService: {
        getInfo: mock((workspaceId: string) =>
          Promise.resolve(
            workspaceId === "ws"
              ? {
                  id: "ws",
                  name: workspaceName,
                  projectPath,
                  projectName: "project",
                  namedWorkspacePath: checkout,
                  runtimeConfig,
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

  test("a file outside the checkout pins by its absolute path and reads live", async () => {
    // File tool cards offer "Open as artifact" for any path the agent read, such as a plan or a
    // skill file under the home folder.
    const outside = path.join(await fs.realpath(tempDir), "notes", "plan.md");
    await fs.mkdir(path.dirname(outside), { recursive: true });
    await fs.writeFile(outside, "# Plan");
    expect(await pinFile(context, { workspaceId: "ws", path: outside })).toEqual({
      success: true,
      data: { path: outside },
    });
    // A tool-cwd path that leaves the checkout names the same file.
    expect(
      await pinFile(context, {
        workspaceId: "ws",
        path: "../notes/plan.md",
        relativeTo: "tool-cwd",
      })
    ).toEqual({ success: true, data: { path: outside } });

    const listed = await listPinnedFiles(context, { workspaceId: "ws" });
    if (!listed.success || !listed.data.available) throw new Error("expected pinned files");
    expect(listed.data.files.map(({ path, kind, size }) => ({ path, kind, size }))).toEqual([
      { path: outside, kind: "markdown", size: 6 },
    ]);

    await fs.writeFile(outside, "# Changed");
    expect(await readPinnedFile(context, { workspaceId: "ws", path: outside })).toMatchObject({
      success: true,
      data: { status: "ok", content: "# Changed" },
    });

    await unpinFile(context, { workspaceId: "ws", path: outside });
    expect(await readPinnedFile(context, { workspaceId: "ws", path: outside })).toEqual({
      success: false,
      error: `File is not pinned: ${outside}`,
    });
  });

  test("one file reached through a symlinked folder is one pin", async () => {
    const real = await fs.realpath(tempDir);
    await fs.mkdir(path.join(real, "notes"));
    await fs.writeFile(path.join(real, "notes", "plan.md"), "# Plan");
    await fs.symlink(path.join(real, "notes"), path.join(real, "notes-link"));
    await fs.mkdir(path.join(checkout, "docs"));
    await fs.writeFile(path.join(checkout, "docs", "x.md"), "x");
    await fs.symlink(path.join(checkout, "docs"), path.join(real, "docs-link"));

    // An alias of an outside folder stores the real path, so both spellings are one pin.
    for (const alias of ["notes", "notes-link"]) {
      expect(
        await pinFile(context, { workspaceId: "ws", path: path.join(real, alias, "plan.md") })
      ).toEqual({ success: true, data: { path: path.join(real, "notes", "plan.md") } });
    }
    // An alias that leads into the checkout is a checkout pin.
    expect(
      await pinFile(context, { workspaceId: "ws", path: path.join(real, "docs-link", "x.md") })
    ).toEqual({ success: true, data: { path: "docs/x.md" } });
    const listed = await listPinnedFiles(context, { workspaceId: "ws" });
    expect(listed.success && listed.data.available && listed.data.files.map((f) => f.path)).toEqual(
      [path.join(real, "notes", "plan.md"), "docs/x.md"]
    );
  });

  test("an SSH checkout pins and reads an outside file in a symlinked folder", async () => {
    // A LocalRuntime stands in for the SSH host: pins and reads run the real runtime scripts.
    const real = await fs.realpath(tempDir);
    runtimeConfig = { type: "ssh", host: "example", srcBaseDir: real };
    // An in-place workspace (name equals project path) roots the checkout at the project path.
    projectPath = workspaceName = path.join(real, "checkout");
    const create = spyOn(runtimeHelpers, "createRuntimeForWorkspace").mockReturnValue(
      new LocalRuntime(real)
    );
    try {
      await fs.mkdir(path.join(real, "notes"));
      await fs.writeFile(path.join(real, "notes", "plan.md"), "# Plan");
      await fs.symlink(path.join(real, "notes"), path.join(real, "notes-link"));
      const stored = path.join(real, "notes", "plan.md");
      expect(
        await pinFile(context, {
          workspaceId: "ws",
          path: path.join(real, "notes-link", "plan.md"),
        })
      ).toEqual({ success: true, data: { path: stored } });
      expect(await readPinnedFile(context, { workspaceId: "ws", path: stored })).toMatchObject({
        success: true,
        data: { status: "ok", content: "# Plan" },
      });
      expect(create).toHaveBeenCalled();
    } finally {
      create.mockRestore();
    }
  });

  test("pinning on an SSH checkout resolves only stored pins with the same file name", async () => {
    // Each folder resolution is one exec on the SSH host; other outside pins cannot be aliases.
    const real = await fs.realpath(tempDir);
    runtimeConfig = { type: "ssh", host: "example", srcBaseDir: real };
    projectPath = workspaceName = path.join(real, "checkout");
    const resolved: string[] = [];
    class CountingRuntime extends LocalRuntime {
      override exec(command: string, options: Parameters<LocalRuntime["exec"]>[1]) {
        if (command.includes("XUMREALDIR1")) resolved.push(options.pathEnv?.XUM_DIR ?? "");
        return super.exec(command, options);
      }
    }
    const create = spyOn(runtimeHelpers, "createRuntimeForWorkspace").mockReturnValue(
      new CountingRuntime(real)
    );
    try {
      const sessionDir = path.join(tempDir, "sessions", "ws");
      for (const name of ["a.md", "b.md", "c.md"]) {
        await addPinnedPath(sessionDir, path.join(real, "old", name));
      }
      await fs.mkdir(path.join(real, "notes"));
      await fs.writeFile(path.join(real, "notes", "plan.md"), "# Plan");
      expect(
        await pinFile(context, { workspaceId: "ws", path: path.join(real, "notes", "plan.md") })
      ).toEqual({ success: true, data: { path: path.join(real, "notes", "plan.md") } });
      // The new pin's folder and the checkout root, nothing for a.md, b.md or c.md.
      expect(resolved.filter((dir) => dir.startsWith(path.join(real, "old")))).toEqual([]);
    } finally {
      create.mockRestore();
    }
  });

  test("re-pinning an alias stored before real folder paths keeps the one entry", async () => {
    const real = await fs.realpath(tempDir);
    await fs.mkdir(path.join(real, "notes"));
    await fs.writeFile(path.join(real, "notes", "plan.md"), "# Plan");
    await fs.symlink(path.join(real, "notes"), path.join(real, "notes-link"));
    const alias = path.join(real, "notes-link", "plan.md");
    // An older build stored the alias as given.
    await addPinnedPath(path.join(tempDir, "sessions", "ws"), alias);
    for (const request of [alias, path.join(real, "notes", "plan.md")]) {
      expect(await pinFile(context, { workspaceId: "ws", path: request })).toEqual({
        success: true,
        data: { path: alias },
      });
    }
    const listed = await listPinnedFiles(context, { workspaceId: "ws" });
    expect(listed.success && listed.data.available && listed.data.files.map((f) => f.path)).toEqual(
      [alias]
    );
  });

  test("a drive-letter entry on a POSIX host is invalid, not a path below the backend's folder", async () => {
    if (process.platform === "win32") return;
    // Only a hand edit of the store can add one. Read as a folder `C:` it would resolve against
    // the backend's working folder.
    const sessionDir = path.join(tempDir, "sessions", "ws");
    await addPinnedPath(sessionDir, "C:/x.md");
    const read = await readPinnedFile(context, { workspaceId: "ws", path: "C:/x.md" });
    expect(read.success).toBe(false);
    expect(read).not.toHaveProperty("missing");
    const listed = await listPinnedFiles(context, { workspaceId: "ws" });
    expect(listed.success && listed.data.available && listed.data.files).toEqual([]);
  });

  test("refuses outside files that are missing, folders or symlinks", async () => {
    const notes = path.join(tempDir, "notes");
    await fs.mkdir(notes, { recursive: true });
    await fs.symlink(path.join(checkout, "README.md"), path.join(notes, "link.md"));
    for (const target of [path.join(notes, "missing.md"), notes, path.join(notes, "link.md")]) {
      expect((await pinFile(context, { workspaceId: "ws", path: target })).success).toBe(false);
    }
    const listed = await listPinnedFiles(context, { workspaceId: "ws" });
    expect(listed.success && listed.data.available && listed.data.files).toEqual([]);
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
      missing: true,
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

  test("pins the exact file name, edge whitespace included", async () => {
    await fs.writeFile(path.join(checkout, ".env"), "plain");
    await fs.writeFile(path.join(checkout, ".env "), "trailing space");
    expect(await pinFile(context, { workspaceId: "ws", path: ".env " })).toEqual({
      success: true,
      data: { path: ".env " },
    });
    expect(await readPinnedFile(context, { workspaceId: "ws", path: ".env " })).toMatchObject({
      success: true,
      data: { status: "ok", content: "trailing space" },
    });
    // A blank path is still refused.
    expect(await pinFile(context, { workspaceId: "ws", path: "  " })).toMatchObject({
      success: false,
    });
  });

  test("a dev container checkout is never read by pathname checks alone", async () => {
    // The container writes the checkout, so it could race a parent-folder swap past the
    // pathname fallback: without descriptor paths, pinned files are refused, not read.
    runtimeConfig = { type: "devcontainer", configPath: ".devcontainer/devcontainer.json" };
    const descriptors = spyOn(artifactStoreModule, "hostSupportsDescriptorPaths");
    try {
      descriptors.mockResolvedValue(false);
      const pinned = await pinFile(context, { workspaceId: "ws", path: "README.md" });
      expect(pinned.success).toBe(false);
      const listed = await listPinnedFiles(context, { workspaceId: "ws" });
      expect(listed).toMatchObject({ success: true, data: { available: false } });

      // With descriptor paths the host reads them, requiring descriptor verification.
      descriptors.mockResolvedValue(true);
      const read = spyOn(artifactStoreModule, "readArtifactBytesFromDir");
      try {
        expect((await pinFile(context, { workspaceId: "ws", path: "README.md" })).success).toBe(
          true
        );
        expect(
          await readPinnedFile(context, { workspaceId: "ws", path: "README.md" })
        ).toMatchObject({ success: true });
        expect(read.mock.calls.length).toBeGreaterThan(0);
        for (const call of read.mock.calls) {
          expect(call[3]).toMatchObject({ requireDescriptorPaths: true });
        }
        // Tool paths outside the checkout name container files, not host files.
        const outside = path.join(tempDir, "outside.md");
        await fs.writeFile(outside, "x");
        expect(await pinFile(context, { workspaceId: "ws", path: outside })).toEqual({
          success: false,
          error: PINNED_FILES_DEVCONTAINER_OUTSIDE_REASON,
        });
      } finally {
        read.mockRestore();
      }
    } finally {
      descriptors.mockRestore();
    }
  });

  test("a pin update waits for another process's store lock", async () => {
    // Held by this process, the file lock looks to the store like another backend mid-update.
    const sessionDir = path.join(tempDir, "sessions", "ws");
    const release = await acquireCrossProcessLock({
      lockPath: path.join(sessionDir, "pinned-files.json.lock"),
      acquireTimeoutMs: 1_000,
      staleMs: 60_000,
      timeoutMessage: "test holder",
    });
    let settled = false;
    const adding = addPinnedPath(sessionDir, "README.md").finally(() => {
      settled = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);
      expect(await readPinnedPaths(sessionDir)).toEqual([]);
    } finally {
      await release();
    }
    await adding;
    expect(await readPinnedPaths(sessionDir)).toEqual(["README.md"]);
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
