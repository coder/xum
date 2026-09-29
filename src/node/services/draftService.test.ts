import cjsFs from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { describe, expect, it, spyOn } from "bun:test";
import { Config } from "@/node/config";
import { TestTempDir } from "@/node/services/tools/testHelpers";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import { MAX_DRAFT_JSON_BYTES } from "@/constants/drafts";
import { draftTooLargeMessage, isDraftTooLargeError } from "@/common/utils/drafts";
import { withTargetMutationLock } from "@/node/services/refinement/targetMutationLocks";
import type { DraftAttachment, DraftEvent, DraftScope } from "@/common/orpc/schemas/drafts";
import { DraftService } from "./draftService";

const WORKSPACE_ID = "draft-ws";
const WORKSPACE_SCOPE: DraftScope = { kind: "workspace", workspaceId: WORKSPACE_ID };

async function createHarness(tempDir: TestTempDir) {
  const config = new Config(path.join(tempDir.path, "xum-home"));
  const projectPath = path.join(tempDir.path, "project");
  await fs.mkdir(projectPath, { recursive: true });
  await config.addWorkspace(projectPath, {
    id: WORKSPACE_ID,
    name: "draft-branch",
    projectPath,
    projectName: "project",
    runtimeConfig: { type: "local" },
  });
  // The on-disk location is a storage contract (upgrade/downgrade), so spell it out here.
  const workspaceFile = path.join(config.sessionsDir, WORKSPACE_ID, "draft.json");
  return { config, projectPath, workspaceFile };
}

const image: DraftAttachment = {
  kind: "provider",
  id: "img-1",
  url: "data:image/png;base64,iVBORw0KGgo=",
  mediaType: "image/png",
  filename: "shot.png",
};

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("DraftService", () => {
  it("persists partial updates and deletes the file when the draft becomes empty", async () => {
    using tempDir = new TestTempDir("drafts-roundtrip");
    const { config, workspaceFile } = await createHarness(tempDir);
    const service = new DraftService(config);

    await service.update({ scope: WORKSPACE_SCOPE, text: "hello", attachments: [image] });
    // Typing sends only text: the stored attachments must survive it.
    await service.update({ scope: WORKSPACE_SCOPE, text: "hello world" });

    const reloaded = await new DraftService(config).get(WORKSPACE_SCOPE);
    expect(reloaded.text).toBe("hello world");
    expect(reloaded.attachments).toEqual([image]);

    await service.update({ scope: WORKSPACE_SCOPE, text: "", attachments: [] });
    expect(await exists(workspaceFile)).toBe(false);
    expect(await service.list()).toEqual([]);
  });

  it("lists metadata without payloads and drops drafts whose session dir was removed", async () => {
    using tempDir = new TestTempDir("drafts-list");
    const { config } = await createHarness(tempDir);
    const service = new DraftService(config);
    await service.update({ scope: WORKSPACE_SCOPE, text: "t", attachments: [image] });

    // A fresh instance builds its index from disk.
    const fresh = new DraftService(config);
    const [summary] = await fresh.list();
    expect(summary.scope).toEqual(WORKSPACE_SCOPE);
    expect(summary.attachments.map(({ id, filename }) => ({ id, filename }))).toEqual([
      { id: "img-1", filename: "shot.png" },
    ]);
    expect(JSON.stringify(summary)).not.toContain("iVBORw0KGgo");

    // Workspace removal deletes the session dir without telling the service.
    await fs.rm(path.join(config.sessionsDir, WORKSPACE_ID), { recursive: true });
    expect(await fresh.list()).toEqual([]);
  });

  it("self-heals malformed and unparseable files but throws on other read errors", async () => {
    using tempDir = new TestTempDir("drafts-self-heal");
    const { config, workspaceFile } = await createHarness(tempDir);
    const service = new DraftService(config);
    await fs.mkdir(path.dirname(workspaceFile), { recursive: true });

    await fs.writeFile(
      workspaceFile,
      JSON.stringify({ text: "kept", attachments: [image, { kind: "provider", id: 7 }] })
    );
    const sanitized = await service.get(WORKSPACE_SCOPE);
    expect(sanitized.text).toBe("kept");
    expect(sanitized.attachments).toEqual([image]);

    await fs.writeFile(workspaceFile, "{not json");
    expect((await service.get(WORKSPACE_SCOPE)).text).toBe("");

    // EISDIR: the data may exist but cannot be read, so a write must not replace it.
    await fs.rm(workspaceFile);
    await fs.mkdir(workspaceFile);
    let getError: unknown;
    try {
      await service.get(WORKSPACE_SCOPE);
    } catch (error) {
      getError = error;
    }
    expect(getError).toBeDefined();
    let updateError: unknown;
    try {
      await service.update({ scope: WORKSPACE_SCOPE, text: "new" });
    } catch (error) {
      updateError = error;
    }
    expect(updateError).toBeDefined();
  });

  it("imports legacy drafts without clobbering and reports ownerless scopes as orphaned", async () => {
    using tempDir = new TestTempDir("drafts-import");
    const { config } = await createHarness(tempDir);
    const service = new DraftService(config);

    const applied = await service.importLegacy({ scope: WORKSPACE_SCOPE, text: "legacy" });
    expect(applied.result).toBe("applied");
    await service.update({ scope: WORKSPACE_SCOPE, text: "edited on the backend" });

    // Another origin still holding its old localStorage copy must not overwrite the backend.
    const present = await service.importLegacy({
      scope: WORKSPACE_SCOPE,
      text: "stale",
      attachments: [image],
    });
    expect(present.result).toBe("present");
    const stored = await service.get(WORKSPACE_SCOPE);
    expect(stored.text).toBe("edited on the backend");
    expect(stored.attachments).toEqual([]);

    const unknown = await service.importLegacy({
      scope: { kind: "workspace", workspaceId: "never-registered" },
      text: "orphan",
    });
    expect(unknown.result).toBe("orphaned");
    expect(await exists(path.join(config.sessionsDir, "never-registered"))).toBe(false);
  });

  it("refuses an oversized legacy import like an oversized update", async () => {
    using tempDir = new TestTempDir("drafts-import-too-large");
    const { config, workspaceFile } = await createHarness(tempDir);
    const service = new DraftService(config);
    const text = "x".repeat(MAX_DRAFT_JSON_BYTES);

    let error: unknown;
    try {
      await service.importLegacy({ scope: WORKSPACE_SCOPE, text });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      draftTooLargeMessage(JSON.stringify({ text, attachments: [] }).length)
    );
    expect(await exists(workspaceFile)).toBe(false);
  });

  it("measures the size limit in UTF-8 bytes", async () => {
    using tempDir = new TestTempDir("drafts-too-large-bytes");
    const { config, workspaceFile } = await createHarness(tempDir);
    const service = new DraftService(config);
    // Under the limit in UTF-16 code units, over it in bytes (2 bytes per "é").
    const text = "é".repeat(Math.ceil(MAX_DRAFT_JSON_BYTES * 0.6));

    let error: unknown;
    try {
      await service.update({ scope: WORKSPACE_SCOPE, text });
    } catch (caught) {
      error = caught;
    }
    expect(isDraftTooLargeError(error)).toBe(true);
    expect(await exists(workspaceFile)).toBe(false);
  });

  it("a write that fails during the first scan does not hide the draft on disk", async () => {
    using tempDir = new TestTempDir("drafts-scan-failed-write");
    const { config, workspaceFile } = await createHarness(tempDir);
    await new DraftService(config).update({ scope: WORKSPACE_SCOPE, text: "on disk" });
    const service = new DraftService(config);

    // The write lands while the scan runs (between its sessions-dir listing and its reads) and
    // fails like ENOSPC: the atomic write's rename onto draft.json is refused.
    const realReaddir = fs.readdir.bind(fs);
    const realRename = cjsFs.rename.bind(cjsFs);
    let failedWrite = null as Promise<unknown> | null;
    const readdirSpy = spyOn(fs, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fs.readdir>
    ) => {
      const listing = await (realReaddir as (...a: typeof args) => Promise<unknown>)(...args);
      if (failedWrite === null && args[0] === config.sessionsDir) {
        const renameSpy = spyOn(cjsFs, "rename").mockImplementation(((
          from: cjsFs.PathLike,
          to: cjsFs.PathLike,
          callback: cjsFs.NoParamCallback
        ) => {
          if (String(to) === workspaceFile) {
            callback(
              Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" })
            );
            return;
          }
          realRename(from, to, callback);
        }) as typeof cjsFs.rename);
        failedWrite = service
          .update({ scope: WORKSPACE_SCOPE, text: "lost write" })
          .catch((error: unknown) => error);
        await failedWrite;
        renameSpy.mockRestore();
      }
      return listing;
    }) as typeof fs.readdir);
    try {
      const summaries = await service.list();
      expect(await failedWrite).toBeInstanceOf(Error);
      expect(summaries.map((summary) => summary.text)).toEqual(["on disk"]);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it("rejects scopes that would resolve outside their storage dir", async () => {
    using tempDir = new TestTempDir("drafts-traversal");
    const { config, projectPath } = await createHarness(tempDir);
    const service = new DraftService(config);

    const escapes: DraftScope[] = [
      { kind: "workspace", workspaceId: "../escape" },
      { kind: "creation", projectPath, draftId: "../escape" },
    ];
    for (const scope of escapes) {
      let error: unknown;
      try {
        await service.update({ scope, text: "x" });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      expect((await service.importLegacy({ scope, text: "x" })).result).toBe("orphaned");
    }
    expect(await exists(path.join(config.rootDir, "escape"))).toBe(false);
    expect(await exists(path.join(config.rootDir, "escape.json"))).toBe(false);
  });

  it("stores creation drafts per project and removes them on project deletion and GC", async () => {
    using tempDir = new TestTempDir("drafts-creation");
    const { config, projectPath } = await createHarness(tempDir);
    const service = new DraftService(config);
    const events: DraftEvent[] = [];
    service.on(DraftService.CHANGE_EVENT, (event: DraftEvent) => events.push(event));

    const creation: DraftScope = { kind: "creation", projectPath, draftId: "draft-a" };
    const scratch: DraftScope = {
      kind: "creation",
      projectPath: SCRATCH_PROJECT_CONFIG_KEY,
      draftId: "draft-s",
    };
    await service.update({ scope: creation, text: "creation" });
    await service.update({ scope: scratch, text: "scratch" });
    // An unconfigured project owns nothing: the write is skipped, not stored.
    await service.update({
      scope: { kind: "creation", projectPath: "/not/configured", draftId: "draft-x" },
      text: "ignored",
    });
    expect((await service.list()).map(({ text }) => text).sort()).toEqual(["creation", "scratch"]);

    // Removal: the config write lands first, then the cleanup runs.
    const projectEntry = config.loadConfigOrDefault().projects.get(projectPath)!;
    await config.editConfig((current) => {
      current.projects.delete(projectPath);
      return current;
    });
    await service.deleteProjectDrafts(projectPath);
    expect((await service.get(creation)).text).toBe("");
    expect(events.at(-1)).toMatchObject({ type: "deleted", scope: creation });

    // GC: a project removed while this build was not running loses its drafts; scratch stays.
    await config.editConfig((current) => {
      current.projects.set(projectPath, projectEntry);
      return current;
    });
    await service.update({ scope: creation, text: "again" });
    await config.editConfig((current) => {
      current.projects.delete(projectPath);
      return current;
    });
    await new DraftService(config).collectOrphanedCreationDrafts();
    const survivor = new DraftService(config);
    expect((await survivor.list()).map(({ scope }) => scope)).toEqual([scratch]);
  });

  it("removes a project's whole drafts dir, including unparseable files", async () => {
    using tempDir = new TestTempDir("drafts-project-dir");
    const { config, projectPath } = await createHarness(tempDir);
    const service = new DraftService(config);
    await service.update({
      scope: { kind: "creation", projectPath, draftId: "draft-a" },
      text: "creation",
    });
    const draftsRoot = path.join(config.rootDir, "drafts");
    const [projectDirName] = await fs.readdir(draftsRoot);
    const projectDir = path.join(draftsRoot, projectDirName);
    await fs.writeFile(path.join(projectDir, "draft-b.json"), "{truncated");
    await config.editConfig((current) => {
      current.projects.delete(projectPath);
      return current;
    });

    await service.deleteProjectDrafts(projectPath);
    expect(await exists(projectDir)).toBe(false);
  });

  it("GC removes unparseable files of unconfigured projects and keeps scratch", async () => {
    using tempDir = new TestTempDir("drafts-gc-unparseable");
    const { config, projectPath } = await createHarness(tempDir);
    const service = new DraftService(config);
    const scratch: DraftScope = {
      kind: "creation",
      projectPath: SCRATCH_PROJECT_CONFIG_KEY,
      draftId: "draft-s",
    };
    await service.update({ scope: scratch, text: "scratch" });
    const draftsRoot = path.join(config.rootDir, "drafts");
    const [scratchDirName] = await fs.readdir(draftsRoot);
    await service.update({
      scope: { kind: "creation", projectPath, draftId: "draft-a" },
      text: "creation",
    });
    const projectDirName = (await fs.readdir(draftsRoot)).find((name) => name !== scratchDirName);
    expect(projectDirName).toBeDefined();
    const projectDir = path.join(draftsRoot, projectDirName!);
    // Only an unparseable file is left: nothing in it names its project.
    await fs.writeFile(path.join(projectDir, "draft-a.json"), "{truncated");
    await config.editConfig((current) => {
      current.projects.delete(projectPath);
      return current;
    });

    await new DraftService(config).collectOrphanedCreationDrafts();
    expect(await exists(projectDir)).toBe(false);
    expect((await new DraftService(config).get(scratch)).text).toBe("scratch");
  });

  it("GC keeps the drafts of a project re-added after its config snapshot", async () => {
    using tempDir = new TestTempDir("drafts-gc-readd");
    const { config, projectPath } = await createHarness(tempDir);
    const service = new DraftService(config);
    const creation: DraftScope = { kind: "creation", projectPath, draftId: "draft-a" };
    await service.update({ scope: creation, text: "keep me" });
    const projectEntry = config.loadConfigOrDefault().projects.get(projectPath);
    expect(projectEntry).toBeDefined();
    await config.editConfig((current) => {
      current.projects.delete(projectPath);
      return current;
    });
    const draftsRoot = path.join(config.rootDir, "drafts");
    const [projectDirName] = await fs.readdir(draftsRoot);

    let gc: Promise<void> | undefined;
    // Hold the lock creation-draft writes take, so the GC reads the config (project absent) but
    // cannot delete until the project is configured again.
    await withTargetMutationLock(
      config.rootDir,
      path.join(draftsRoot, projectDirName),
      async () => {
        gc = new DraftService(config).collectOrphanedCreationDrafts();
        await config.editConfig((current) => {
          current.projects.set(projectPath, projectEntry!);
          return current;
        });
      }
    );
    await gc;

    expect((await new DraftService(config).get(creation)).text).toBe("keep me");
  });

  it("project removal keeps the drafts of a project registered again before the cleanup", async () => {
    using tempDir = new TestTempDir("drafts-removal-readd");
    const { config, projectPath } = await createHarness(tempDir);
    const service = new DraftService(config);
    const creation: DraftScope = { kind: "creation", projectPath, draftId: "draft-a" };
    await service.update({ scope: creation, text: "keep me" });
    const projectEntry = config.loadConfigOrDefault().projects.get(projectPath);
    expect(projectEntry).toBeDefined();
    await config.editConfig((current) => {
      current.projects.delete(projectPath);
      return current;
    });
    const draftsRoot = path.join(config.rootDir, "drafts");
    const [projectDirName] = await fs.readdir(draftsRoot);

    let cleanup: Promise<void> | undefined;
    // The removal's cleanup runs after its config write; the path is registered again first.
    await withTargetMutationLock(
      config.rootDir,
      path.join(draftsRoot, projectDirName),
      async () => {
        cleanup = service.deleteProjectDrafts(projectPath);
        await config.editConfig((current) => {
          current.projects.set(projectPath, projectEntry!);
          return current;
        });
      }
    );
    await cleanup;

    expect((await new DraftService(config).get(creation)).text).toBe("keep me");
  });
});
