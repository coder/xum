import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBackupContents } from "@/common/config/schemas/settingsBackup";
import type { SettingsBackupInput } from "@/common/orpc/schemas/backup";
import { projectMemoryDirName } from "@/node/services/memoryService";
import { createBackupGitRepo, createBackupPayloadStore } from "./adapters";
import * as artifactShelfBackupModule from "./artifactShelfBackup";
import * as payloadModule from "./payload";
import { pinToShelf, withShelfScopeLock } from "@/node/services/artifactShelf";
import {
  ARTIFACT_SHELF_BACKUP_DIR,
  applyShelfRestore,
  collectShelfBackup,
  planShelfRestore,
  readShelfBackup,
  serializeShelfBackupManifest,
  SHELF_MANIFEST_HEADER_RESERVE,
  writeShelfBackup,
} from "./artifactShelfBackup";
import { MAX_BACKUP_FILE_BYTES, scanBackupFilesForSecrets } from "./payload";
import { TestBackupConfig, captureRejection, runGit } from "./testHelpers";

async function writeEntry(scopeDir: string, entry: string, file: string, content: string | Buffer) {
  await fs.mkdir(path.join(scopeDir, entry), { recursive: true });
  await fs.writeFile(path.join(scopeDir, entry, file), content);
  await fs.writeFile(path.join(scopeDir, entry, "meta.json"), shelfMetaJson(file, entry));
}

/** A meta.json the shelf accepts (an entry is complete only with one). */
function shelfMetaJson(file: string, title: string): string {
  return JSON.stringify({
    sourceWorkspaceId: "ws-1",
    sourcePath: file,
    version: 1,
    title,
    kind: "text",
    pinnedAtMs: 1,
    pinnedBy: "user",
    file,
  });
}

describe("artifact shelf backup", () => {
  let tempDir: string;
  let xumRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-shelf-backup-"));
    xumRoot = path.join(tempDir, "root");
    await fs.mkdir(xumRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("collects only the selected scopes and skips oversized or over-budget entries", async () => {
    const projectPath = path.join(tempDir, "proj");
    const projectDir = projectMemoryDirName(projectPath);
    const shelf = path.join(xumRoot, "artifacts");
    await writeEntry(path.join(shelf, "global"), "chart.html", "chart.html", "<p>chart</p>");
    await writeEntry(
      path.join(shelf, "global"),
      "big.bin",
      "big.bin",
      Buffer.alloc(MAX_BACKUP_FILE_BYTES + 1)
    );
    await writeEntry(path.join(shelf, "project", projectDir), "notes.md", "notes.md", "# notes");
    await writeEntry(path.join(shelf, "project", "other-0000"), "x.md", "x.md", "unregistered");

    const globalOnly = await collectShelfBackup({
      xumRoot,
      includeGlobal: true,
      projects: [],
      budgetBytes: 64 * 1024 * 1024,
      maxFileCount: 100,
    });
    expect(globalOnly.backup.files.map((f) => f.path)).toEqual([
      "global/chart.html/chart.html",
      "global/chart.html/meta.json",
    ]);
    expect(globalOnly.skipped).toHaveLength(1);
    expect(globalOnly.skipped[0]).toContain("artifacts/global/big.bin");
    expect(globalOnly.backup.manifest.projects).toEqual([]);

    const projectsOnly = await collectShelfBackup({
      xumRoot,
      includeGlobal: false,
      projects: [{ path: projectPath, dir: projectDir }],
      budgetBytes: 64 * 1024 * 1024,
      maxFileCount: 100,
    });
    expect(projectsOnly.backup.files.map((f) => f.path)).toEqual([
      `project/${projectDir}/notes.md/meta.json`,
      `project/${projectDir}/notes.md/notes.md`,
    ]);
    expect(projectsOnly.backup.manifest.projects).toEqual([{ path: projectPath, dir: projectDir }]);

    // An entry is all or nothing: a budget that fits only part of it skips the whole entry.
    const tight = await collectShelfBackup({
      xumRoot,
      includeGlobal: true,
      projects: [],
      budgetBytes: 20,
      maxFileCount: 100,
    });
    expect(tight.backup.files).toEqual([]);
    expect(tight.skipped.some((notice) => notice.includes("64 MiB"))).toBe(true);
  });

  it("round-trips through the sidecar and refuses tampered or disallowed files", async () => {
    await writeEntry(path.join(xumRoot, "artifacts", "global"), "a.md", "a.md", "alpha");
    const { backup } = await collectShelfBackup({
      xumRoot,
      includeGlobal: true,
      projects: [],
      budgetBytes: 1024 * 1024,
      maxFileCount: 10,
    });
    const out = path.join(tempDir, "out");
    await writeShelfBackup(out, backup);
    const read = await readShelfBackup(out);
    expect(read?.files.map((f) => [f.path, f.content.toString()])).toEqual(
      backup.files.map((f) => [f.path, f.content.toString()])
    );

    // Tampered content no longer matches its manifest hash.
    await fs.writeFile(path.join(out, ARTIFACT_SHELF_BACKUP_DIR, "global/a.md/a.md"), "evil");
    expect(String(await captureRejection(readShelfBackup(out)))).toContain(
      "does not match its manifest"
    );

    // A path outside the shelf layout is refused even with a matching hash.
    const manifestPath = path.join(out, ARTIFACT_SHELF_BACKUP_DIR, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as {
      files: Array<{ path: string; sha256: string }>;
    };
    manifest.files[0] = { ...manifest.files[0], path: "global/../../escape" };
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest }));
    expect(String(await captureRejection(readShelfBackup(out)))).toContain("disallowed path");

    expect(await readShelfBackup(path.join(tempDir, "missing"))).toBeNull();
  });

  it("restores matched scopes only, snapshots replaced entries, and keeps local-only ones", async () => {
    const projectPath = path.join(tempDir, "proj");
    const projectDir = projectMemoryDirName(projectPath);
    const source = path.join(tempDir, "source");
    await writeEntry(path.join(source, "artifacts", "global"), "a.md", "a.md", "from backup");
    await writeEntry(path.join(source, "artifacts", "project", projectDir), "p.md", "p.md", "proj");
    const { backup } = await collectShelfBackup({
      xumRoot: source,
      includeGlobal: true,
      projects: [{ path: projectPath, dir: projectDir }],
      budgetBytes: 1024 * 1024,
      maxFileCount: 10,
    });

    const unregistered = planShelfRestore({
      backup,
      includeGlobal: true,
      includeProjects: true,
      registeredProjects: new Map(),
    });
    expect(unregistered.entries.map((e) => `${e.scopePath}/${e.name}`)).toEqual([
      "artifacts/global/a.md",
    ]);
    expect(unregistered.skipped).toHaveLength(1);
    expect(unregistered.skipped[0]).toContain("not registered here");
    expect(
      planShelfRestore({
        backup,
        includeGlobal: false,
        includeProjects: true,
        registeredProjects: new Map([[projectPath, projectDir]]),
      }).entries.map((e) => e.scopePath)
    ).toEqual([`artifacts/project/${projectDir}`]);

    const globalScope = path.join(xumRoot, "artifacts", "global");
    await writeEntry(globalScope, "a.md", "a.md", "local edit");
    await writeEntry(globalScope, "local.md", "local.md", "local only");
    const snapshotPath = path.join(tempDir, "snapshot");
    const restore = () =>
      applyShelfRestore({
        xumRoot,
        entries: unregistered.entries,
        snapshotPath,
        registeredProjects: new Map(),
      });
    const written = await restore();
    expect(written).toEqual(["artifacts/global/a.md/a.md", "artifacts/global/a.md/meta.json"]);
    expect(await fs.readFile(path.join(globalScope, "a.md", "a.md"), "utf-8")).toBe("from backup");
    expect(await fs.readFile(path.join(globalScope, "local.md", "local.md"), "utf-8")).toBe(
      "local only"
    );
    // The snapshot is a shelf sidecar: the backup reader reads the replaced entry back.
    const snapshot = await readShelfBackup(snapshotPath);
    expect(snapshot?.files.map((f) => [f.path, f.content.toString()])).toEqual([
      ["global/a.md/a.md", "local edit"],
      ["global/a.md/meta.json", shelfMetaJson("a.md", "a.md")],
    ]);

    // Restoring the same entries again changes nothing.
    expect(await restore()).toEqual([]);
  });

  it("snapshots project entries under their registered project", async () => {
    const projectPath = path.join(tempDir, "proj");
    const projectDir = projectMemoryDirName(projectPath);
    const scopeDir = path.join(xumRoot, "artifacts", "project", projectDir);
    await writeEntry(scopeDir, "n.md", "n.md", "local");
    const written = await applyShelfRestore({
      xumRoot,
      entries: [
        {
          scopePath: `artifacts/project/${projectDir}`,
          name: "n.md",
          files: [
            { name: "n.md", content: Buffer.from("restored") },
            { name: "meta.json", content: Buffer.from(shelfMetaJson("n.md", "n.md")) },
          ],
        },
      ],
      snapshotPath: path.join(tempDir, "snapshot"),
      registeredProjects: new Map([
        [projectPath, projectDir],
        [path.join(tempDir, "other"), projectMemoryDirName(path.join(tempDir, "other"))],
      ]),
    });
    expect(written).toHaveLength(2);
    const snapshot = await readShelfBackup(path.join(tempDir, "snapshot"));
    expect(snapshot?.manifest.projects).toEqual([{ path: projectPath, dir: projectDir }]);
    expect(
      snapshot?.files.find((f) => f.path === `project/${projectDir}/n.md/n.md`)?.content.toString()
    ).toBe("local");
  });

  it("a pin racing a restore waits, so the snapshot holds exactly the replaced bytes", async () => {
    const globalScope = path.join(xumRoot, "artifacts", "global");
    await writeEntry(globalScope, "a.md", "a.md", "local edit");
    const resolveOriginal = payloadModule.resolveContainedPath;
    let readLocal = false;
    // A holder object: TS would narrow a reassigned `let` to null after the callback.
    const racing: { pin: Promise<unknown> | null } = { pin: null };
    // Right after the restore read the local entry, a pin of the same artifact arrives.
    const resolveSpy = spyOn(payloadModule, "resolveContainedPath").mockImplementation(
      async (root, relativePath) => {
        if (relativePath === "artifacts/global/a.md") {
          readLocal = true;
        } else if (readLocal && racing.pin == null) {
          racing.pin = pinToShelf({
            shelfRoot: path.join(xumRoot, "artifacts"),
            scopeDir: globalScope,
            relPath: "a.md",
            bytes: Buffer.from("pinned meanwhile"),
            meta: {
              sourceWorkspaceId: "ws-1",
              version: 2,
              title: "a.md",
              kind: "text",
              pinnedAtMs: 2,
              pinnedBy: "user",
            },
          });
          // Long enough for an unlocked pin to land before the restore replaces the entry.
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return resolveOriginal(root, relativePath);
      }
    );
    try {
      await applyShelfRestore({
        xumRoot,
        entries: [
          {
            scopePath: "artifacts/global",
            name: "a.md",
            files: [
              { name: "a.md", content: Buffer.from("from backup") },
              { name: "meta.json", content: Buffer.from(shelfMetaJson("a.md", "a.md")) },
            ],
          },
        ],
        snapshotPath: path.join(tempDir, "snapshot"),
        registeredProjects: new Map(),
      });
    } finally {
      resolveSpy.mockRestore();
    }
    expect(racing.pin).not.toBeNull();
    await racing.pin;
    const snapshot = await readShelfBackup(path.join(tempDir, "snapshot"));
    expect(snapshot?.files.find((f) => f.path === "global/a.md/a.md")?.content.toString()).toBe(
      "local edit"
    );
    // The pin ran after the restore instead of being overwritten by it.
    expect(await fs.readFile(path.join(globalScope, "a.md", "a.md"), "utf-8")).toBe(
      "pinned meanwhile"
    );
  });

  it("collects a scope only while no pin or restore holds its lock", async () => {
    const globalScope = path.join(xumRoot, "artifacts", "global");
    await writeEntry(globalScope, "a.md", "a.md", "alpha");
    let settled = false;
    const collected = await withShelfScopeLock(globalScope, async () => {
      const collecting = collectShelfBackup({
        xumRoot,
        includeGlobal: true,
        projects: [],
        budgetBytes: 1024 * 1024,
        maxFileCount: 10,
      }).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      // Wrapped, so the lock is released before the collection is awaited.
      return { collecting };
    });
    expect((await collected.collecting).backup.files.map((f) => f.path)).toEqual([
      "global/a.md/a.md",
      "global/a.md/meta.json",
    ]);
  });

  it("charges manifest records against the budget, so the sidecar fits", async () => {
    const globalScope = path.join(xumRoot, "artifacts", "global");
    let fileBytes = 0;
    for (let i = 0; i < 300; i++) {
      const name = `${"n".repeat(200)}${i}`;
      await writeEntry(globalScope, name, name, "x");
      fileBytes += (await fs.stat(path.join(globalScope, name, name))).size;
      fileBytes += (await fs.stat(path.join(globalScope, name, "meta.json"))).size;
    }
    // Room for every file's bytes, none for the manifest records.
    const budgetBytes = fileBytes;
    const { backup, skipped } = await collectShelfBackup({
      xumRoot,
      includeGlobal: true,
      projects: [],
      budgetBytes,
      maxFileCount: 4096,
    });
    expect(skipped.length).toBeGreaterThan(0);
    const written =
      backup.files.reduce((sum, f) => sum + f.content.length, 0) +
      serializeShelfBackupManifest(backup.manifest).length;
    expect(written).toBeLessThanOrEqual(budgetBytes + SHELF_MANIFEST_HEADER_RESERVE);
  });

  it("skips restoring an entry whose meta.json holds an oversized field", async () => {
    const source = path.join(tempDir, "source");
    const scopeDir = path.join(source, "artifacts", "global");
    await writeEntry(scopeDir, "big.md", "big.md", "body");
    await fs.writeFile(
      path.join(scopeDir, "big.md", "meta.json"),
      shelfMetaJson("big.md", "t".repeat(2_000_000))
    );
    const { backup } = await collectShelfBackup({
      xumRoot: source,
      includeGlobal: true,
      projects: [],
      budgetBytes: 64 * 1024 * 1024,
      maxFileCount: 10,
    });
    const plan = planShelfRestore({
      backup,
      includeGlobal: true,
      includeProjects: false,
      registeredProjects: new Map(),
    });
    expect(plan.entries).toEqual([]);
    expect(plan.skipped).toEqual(["artifacts/global/big.md (not a complete shelf entry)"]);
  });

  it("reads every manifest the exporter can write (up to the file count cap)", async () => {
    const out = path.join(tempDir, "big-manifest");
    const sidecar = path.join(out, ARTIFACT_SHELF_BACKUP_DIR);
    await fs.mkdir(sidecar, { recursive: true });
    const content = Buffer.from("x");
    const files = Array.from({ length: 4096 }, (_, i) => ({
      path: `global/${"e".repeat(240)}${i}/${"f".repeat(60)}`,
      content,
    }));
    // Only the manifest is read before the first file check, so a missing file fails later:
    // the error must not be the manifest size limit.
    await fs.writeFile(
      path.join(sidecar, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [],
        files: files.map((f) => ({ path: f.path, sha256: "0".repeat(64) })),
      })
    );
    expect((await fs.stat(path.join(sidecar, "manifest.json"))).size).toBeGreaterThan(1024 * 1024);
    expect(String(await captureRejection(readShelfBackup(out)))).not.toContain(
      "manifest is invalid"
    );
  });

  it("restores only complete entries and skips a damaged scope that is not restored", async () => {
    const projectPath = path.join(tempDir, "proj");
    const projectDir = projectMemoryDirName(projectPath);
    const source = path.join(tempDir, "source");
    await writeEntry(path.join(source, "artifacts", "global"), "a.md", "a.md", "alpha");
    await writeEntry(path.join(source, "artifacts", "project", projectDir), "p.md", "p.md", "proj");
    const { backup } = await collectShelfBackup({
      xumRoot: source,
      includeGlobal: true,
      projects: [{ path: projectPath, dir: projectDir }],
      budgetBytes: 1024 * 1024,
      maxFileCount: 10,
    });
    const out = path.join(tempDir, "out");
    await writeShelfBackup(out, backup);

    // A damaged global file blocks only a restore that includes the global shelf.
    await fs.writeFile(path.join(out, ARTIFACT_SHELF_BACKUP_DIR, "global/a.md/a.md"), "evil");
    expect(String(await captureRejection(readShelfBackup(out)))).toContain("does not match");
    const projectsOnly = await readShelfBackup(out, {
      includeGlobal: false,
      includeProjects: true,
    });
    expect(projectsOnly?.files.map((f) => f.path)).toEqual([
      `project/${projectDir}/p.md/meta.json`,
      `project/${projectDir}/p.md/p.md`,
    ]);

    // An entry without its meta.json is reported, never written over a readable local entry.
    const incomplete = planShelfRestore({
      backup: {
        manifest: backup.manifest,
        files: backup.files.filter((f) => f.path !== "global/a.md/meta.json"),
      },
      includeGlobal: true,
      includeProjects: false,
      registeredProjects: new Map(),
    });
    expect(incomplete.entries).toEqual([]);
    expect(incomplete.skipped).toEqual(["artifacts/global/a.md (not a complete shelf entry)"]);
  });

  it("holds shelf content files for secret review but not Xum's own entry metadata", () => {
    const contents = resolveBackupContents({ includeGlobalArtifacts: true });
    const flagged = scanBackupFilesForSecrets(
      [
        { path: `${ARTIFACT_SHELF_BACKUP_DIR}/global/c.html/c.html`, content: Buffer.from("<p>") },
        {
          path: `${ARTIFACT_SHELF_BACKUP_DIR}/global/c.html/meta.json`,
          content: Buffer.from("{}"),
        },
        { path: `${ARTIFACT_SHELF_BACKUP_DIR}/manifest.json`, content: Buffer.from("{}") },
      ],
      contents
    );
    expect(flagged).toEqual([`${ARTIFACT_SHELF_BACKUP_DIR}/global/c.html/c.html`]);
  });
});

describe("artifact shelf through the backup payload store", () => {
  let tempDir: string;
  let muxRoot: string;
  let settings: SettingsBackupInput;
  let config: TestBackupConfig;
  let cacheRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-shelf-store-"));
    muxRoot = path.join(tempDir, "root");
    cacheRoot = path.join(tempDir, "cache");
    const originPath = path.join(tempDir, "origin.git");
    await fs.mkdir(muxRoot, { recursive: true });
    await fs.writeFile(path.join(muxRoot, "AGENTS.md"), "instructions\n");
    await runGit(["init", "--bare", "--initial-branch=main", originPath]);
    settings = { repoUrl: originPath, branch: "main", path: "xum" };
    config = new TestBackupConfig(muxRoot);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("exports the global shelf only when opted in, then previews and restores it", async () => {
    const globalScope = path.join(muxRoot, "artifacts", "global");
    await writeEntry(globalScope, "chart.html", "chart.html", "<p>v1</p>");
    const gitRepo = createBackupGitRepo({ cacheRoot });
    const payload = createBackupPayloadStore({ config });
    const repository = await gitRepo.prepare(settings);
    const managed = path.join(repository.rootDir, settings.path);

    await payload.exportTo({
      repositoryRoot: repository.rootDir,
      managedPath: settings.path,
      contents: resolveBackupContents({}),
    });
    expect(await readShelfBackup(managed)).toBeNull();

    const contents = resolveBackupContents({ includeGlobalArtifacts: true });
    const exported = await payload.exportTo({
      repositoryRoot: repository.rootDir,
      managedPath: settings.path,
      contents,
    });
    expect(exported.secretFiles).toContain(
      `${ARTIFACT_SHELF_BACKUP_DIR}/global/chart.html/chart.html`
    );
    expect(exported.shelfSkipped).toEqual([]);

    await writeEntry(globalScope, "chart.html", "chart.html", "<p>local v2</p>");
    const preview = await payload.previewRestore({
      repositoryRoot: repository.rootDir,
      managedPath: settings.path,
      contents,
    });
    expect(preview.changes).toContainEqual({
      status: "M",
      path: "artifacts/global/chart.html/chart.html",
    });
    // With the toggle off the sidecar is reported, not restored.
    const off = await payload.previewRestore({
      repositoryRoot: repository.rootDir,
      managedPath: settings.path,
      contents: resolveBackupContents({}),
    });
    expect(off.changes.some((change) => change.path.startsWith("artifacts/"))).toBe(false);
    expect(off.shelfSkipped).toHaveLength(1);

    const restored = await payload.restore({
      repositoryRoot: repository.rootDir,
      managedPath: settings.path,
      contents,
      snapshotPath: path.join(tempDir, "snapshot"),
      matchedProjects: [],
    });
    expect(restored.changedFiles).toContain("artifacts/global/chart.html/chart.html");
    expect(await fs.readFile(path.join(globalScope, "chart.html", "chart.html"), "utf-8")).toBe(
      "<p>v1</p>"
    );
    // The replaced entry is recoverable from the snapshot's shelf sidecar.
    const snapshot = await readShelfBackup(path.join(tempDir, "snapshot"));
    expect(
      snapshot?.files.find((f) => f.path === "global/chart.html/chart.html")?.content.toString()
    ).toBe("<p>local v2</p>");
  });

  it("carries a project shelf with the project bundle, and a malformed sidecar never blocks a settings-only restore", async () => {
    const projectPath = path.join(tempDir, "proj");
    await fs.mkdir(projectPath);
    config.state.projects.set(projectPath, { workspaces: [] });
    const projectScope = path.join(
      muxRoot,
      "artifacts",
      "project",
      projectMemoryDirName(projectPath)
    );
    await writeEntry(projectScope, "notes.md", "notes.md", "# notes");
    const gitRepo = createBackupGitRepo({ cacheRoot });
    const payload = createBackupPayloadStore({ config });
    const repository = await gitRepo.prepare(settings);
    const managed = path.join(repository.rootDir, settings.path);

    await payload.exportTo({
      repositoryRoot: repository.rootDir,
      managedPath: settings.path,
      contents: resolveBackupContents({ includeProjects: true }),
    });
    const backup = await readShelfBackup(managed);
    expect(backup?.manifest.projects.map((p) => p.path)).toEqual([projectPath]);

    await fs.writeFile(path.join(managed, ARTIFACT_SHELF_BACKUP_DIR, "manifest.json"), "not json");
    const restored = await payload.restore({
      repositoryRoot: repository.rootDir,
      managedPath: settings.path,
      contents: resolveBackupContents({}),
      snapshotPath: path.join(tempDir, "snapshot"),
      matchedProjects: [],
    });
    expect(restored.shelfSkipped).toHaveLength(1);
  });

  it("backs up the shelves of exactly the projects in the bundle", async () => {
    const projectPath = path.join(tempDir, "proj");
    const lateProject = path.join(tempDir, "late");
    await fs.mkdir(projectPath);
    await fs.mkdir(lateProject);
    config.state.projects.set(projectPath, { workspaces: [] });
    const realWrite = payloadModule.writeProjectBundle;
    // A project registered right after the bundle was written (outside the registration lock).
    const writeBundle = spyOn(payloadModule, "writeProjectBundle").mockImplementation(
      async (...args) => {
        await realWrite(...args);
        config.state.projects.set(lateProject, { workspaces: [] });
      }
    );
    const collect = spyOn(artifactShelfBackupModule, "collectShelfBackup");
    try {
      const gitRepo = createBackupGitRepo({ cacheRoot });
      const payload = createBackupPayloadStore({ config });
      const repository = await gitRepo.prepare(settings);
      await payload.exportTo({
        repositoryRoot: repository.rootDir,
        managedPath: settings.path,
        contents: resolveBackupContents({ includeProjects: true }),
      });
      expect(collect.mock.calls[0]?.[0].projects.map((p) => p.path)).toEqual([projectPath]);
    } finally {
      writeBundle.mockRestore();
      collect.mockRestore();
    }
  });
});
