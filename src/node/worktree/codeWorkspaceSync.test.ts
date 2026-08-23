import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as jsonc from "jsonc-parser";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { Config } from "@/node/config";
import {
  computeManagedWorktreePaths,
  syncProjectCodeWorkspace,
  updateCodeWorkspaceFile,
} from "./codeWorkspaceSync";

let tempDir: string;
let managedRootDir: string;
let workspaceFilePath: string;

beforeEach(async () => {
  tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "code-workspace-sync-"));
  managedRootDir = path.join(tempDir, "src", "my-project");
  workspaceFilePath = path.join(tempDir, "my-project.code-workspace");
});

afterEach(async () => {
  await fsPromises.rm(tempDir, { recursive: true, force: true });
});

async function readWorkspaceFile(): Promise<string> {
  return fsPromises.readFile(workspaceFilePath, "utf-8");
}

function parseFolders(text: string): Array<{ path: string }> {
  const parsed = jsonc.parse(text) as { folders: Array<{ path: string }> };
  return parsed.folders;
}

describe("updateCodeWorkspaceFile", () => {
  test("creates a missing file with seed folders", async () => {
    const worktree = path.join(managedRootDir, "feature-a");
    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDir,
      desiredPaths: [worktree],
      seedFolders: [path.join(tempDir, "project"), worktree],
    });

    const folders = parseFolders(await readWorkspaceFile());
    expect(folders).toEqual([{ path: path.join(tempDir, "project") }, { path: worktree }]);
  });

  test("adds missing worktree entries to an existing file", async () => {
    const existing = path.join(managedRootDir, "feature-a");
    const added = path.join(managedRootDir, "feature-b");
    await fsPromises.writeFile(
      workspaceFilePath,
      JSON.stringify({ folders: [{ path: existing }] }, null, "\t")
    );

    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDir,
      desiredPaths: [existing, added],
      seedFolders: [],
    });

    expect(parseFolders(await readWorkspaceFile())).toEqual([{ path: existing }, { path: added }]);
  });

  test("removes managed entries that are no longer desired", async () => {
    const kept = path.join(managedRootDir, "feature-a");
    const removedA = path.join(managedRootDir, "feature-b");
    const removedB = path.join(managedRootDir, "feature-c");
    await fsPromises.writeFile(
      workspaceFilePath,
      JSON.stringify({ folders: [{ path: removedA }, { path: kept }, { path: removedB }] })
    );

    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDir,
      desiredPaths: [kept],
      seedFolders: [],
    });

    expect(parseFolders(await readWorkspaceFile())).toEqual([{ path: kept }]);
  });

  test("never removes user-owned entries outside the managed root", async () => {
    const projectRoot = path.join(tempDir, "project");
    const userFolder = "/home/user/some-other-folder";
    const relativeUserFolder = "./relative-folder";
    await fsPromises.writeFile(
      workspaceFilePath,
      JSON.stringify({
        folders: [{ path: projectRoot }, { path: userFolder }, { path: relativeUserFolder }],
      })
    );

    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDir,
      desiredPaths: [],
      seedFolders: [],
    });

    expect(parseFolders(await readWorkspaceFile())).toEqual([
      { path: projectRoot },
      { path: userFolder },
      { path: relativeUserFolder },
    ]);
  });

  test("preserves comments, settings, and folder names through edits", async () => {
    const kept = path.join(managedRootDir, "feature-a");
    const removed = path.join(managedRootDir, "feature-b");
    const added = path.join(managedRootDir, "feature-c");
    const content = [
      "{",
      "\t// user comment survives",
      '\t"folders": [',
      `\t\t{ "path": ${JSON.stringify(kept)}, "name": "Kept" },`,
      `\t\t{ "path": ${JSON.stringify(removed)} }`,
      "\t],",
      '\t"settings": { "editor.tabSize": 2 }',
      "}",
    ].join("\n");
    await fsPromises.writeFile(workspaceFilePath, content);

    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDir,
      desiredPaths: [kept, added],
      seedFolders: [],
    });

    const text = await readWorkspaceFile();
    expect(text).toContain("// user comment survives");
    const parsed = jsonc.parse(text) as {
      folders: Array<{ path: string; name?: string }>;
      settings: Record<string, unknown>;
    };
    expect(parsed.settings).toEqual({ "editor.tabSize": 2 });
    expect(parsed.folders).toEqual([{ path: kept, name: "Kept" }, { path: added }]);
  });

  test("adds a folders array to a file that lacks one", async () => {
    const worktree = path.join(managedRootDir, "feature-a");
    await fsPromises.writeFile(workspaceFilePath, '{\n\t"settings": {}\n}\n');

    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDir,
      desiredPaths: [worktree],
      seedFolders: [],
    });

    expect(parseFolders(await readWorkspaceFile())).toEqual([{ path: worktree }]);
  });

  test("leaves a malformed file untouched without throwing", async () => {
    const malformed = '{ "folders": [ { "path": broken ';
    await fsPromises.writeFile(workspaceFilePath, malformed);

    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDir,
      desiredPaths: [path.join(managedRootDir, "feature-a")],
      seedFolders: [],
    });

    expect(await readWorkspaceFile()).toBe(malformed);
  });

  test("is idempotent: a second sync does not rewrite the file", async () => {
    const worktree = path.join(managedRootDir, "feature-a");
    const update = {
      codeWorkspacePath: workspaceFilePath,
      managedRootDir,
      desiredPaths: [worktree],
      seedFolders: [worktree],
    };
    await updateCodeWorkspaceFile(update);
    const afterFirst = await fsPromises.stat(workspaceFilePath);

    await updateCodeWorkspaceFile(update);
    const afterSecond = await fsPromises.stat(workspaceFilePath);

    expect(afterSecond.mtimeMs).toBe(afterFirst.mtimeMs);
    expect(afterSecond.ino).toBe(afterFirst.ino);
  });

  test("two projects sharing one file manage disjoint entries", async () => {
    const otherManagedRoot = path.join(tempDir, "src", "other-project");
    const mine = path.join(managedRootDir, "feature-a");
    const theirs = path.join(otherManagedRoot, "feature-x");
    await fsPromises.writeFile(
      workspaceFilePath,
      JSON.stringify({ folders: [{ path: mine }, { path: theirs }] })
    );

    // Sync for "my-project" with an empty desired set: must not touch the
    // other project's entry.
    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDir,
      desiredPaths: [],
      seedFolders: [],
    });

    expect(parseFolders(await readWorkspaceFile())).toEqual([{ path: theirs }]);
  });

  test("resolves relative folder entries against the file's directory", async () => {
    // Entry is relative but points inside the managed root; it must count as
    // present (no duplicate added) and be removable when undesired.
    const relative = "./src/my-project/feature-a";
    await fsPromises.writeFile(
      workspaceFilePath,
      JSON.stringify({ folders: [{ path: relative }] })
    );

    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDir,
      desiredPaths: [path.join(managedRootDir, "feature-a")],
      seedFolders: [],
    });
    expect(parseFolders(await readWorkspaceFile())).toEqual([{ path: relative }]);

    await updateCodeWorkspaceFile({
      codeWorkspacePath: workspaceFilePath,
      managedRootDir,
      desiredPaths: [],
      seedFolders: [],
    });
    expect(parseFolders(await readWorkspaceFile())).toEqual([]);
  });
});

describe("syncProjectCodeWorkspace", () => {
  test("creates the file from project config, resolving relative setting paths", async () => {
    const config = new Config(tempDir);
    const projectPath = path.join(tempDir, "repo");
    await fsPromises.mkdir(projectPath, { recursive: true });
    const worktreePath = path.join(config.srcDir, "repo", "feat-1");
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          {
            path: worktreePath,
            id: "aaaaaaaaaa",
            name: "feat-1",
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
          },
        ],
        codeWorkspaceSyncPath: "repo.code-workspace",
      });
      return cfg;
    });

    await syncProjectCodeWorkspace(config, projectPath);

    const text = await fsPromises.readFile(path.join(projectPath, "repo.code-workspace"), "utf-8");
    expect(parseFolders(text)).toEqual([{ path: projectPath }, { path: worktreePath }]);
  });

  test("does nothing when the setting is unset", async () => {
    const config = new Config(tempDir);
    const projectPath = path.join(tempDir, "repo");
    await fsPromises.mkdir(projectPath, { recursive: true });
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, { workspaces: [] });
      return cfg;
    });

    await syncProjectCodeWorkspace(config, projectPath);

    expect((await fsPromises.readdir(projectPath)).length).toBe(0);
  });

  test("refuses paths without the .code-workspace extension", async () => {
    const config = new Config(tempDir);
    const projectPath = path.join(tempDir, "repo");
    await fsPromises.mkdir(projectPath, { recursive: true });
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, { workspaces: [], codeWorkspaceSyncPath: "notes.json" });
      return cfg;
    });

    await syncProjectCodeWorkspace(config, projectPath);

    expect((await fsPromises.readdir(projectPath)).length).toBe(0);
  });
});

describe("computeManagedWorktreePaths", () => {
  const projectPath = "/home/user/projects/my-project";

  function makeMetadata(overrides: Partial<FrontendWorkspaceMetadata>): FrontendWorkspaceMetadata {
    const base: FrontendWorkspaceMetadata = {
      id: "abc123def0",
      name: "feature-a",
      projectName: "my-project",
      projectPath,
      namedWorkspacePath: path.join("/base/src/my-project", "feature-a"),
      runtimeConfig: { type: "worktree", srcBaseDir: "/base/src" },
    };
    return { ...base, ...overrides };
  }

  const managedRoot = "/base/src/my-project";

  test("includes active worktree workspaces and sorts deduped paths", () => {
    const paths = computeManagedWorktreePaths({
      allMetadata: [
        makeMetadata({ name: "b", namedWorkspacePath: `${managedRoot}/b` }),
        makeMetadata({ name: "a", namedWorkspacePath: `${managedRoot}/a` }),
        makeMetadata({ name: "a-dup", namedWorkspacePath: `${managedRoot}/a` }),
      ],
      projectPath,
      managedRootDir: managedRoot,
    });
    expect(paths).toEqual([`${managedRoot}/a`, `${managedRoot}/b`]);
  });

  test("excludes archived, sub-agent, isolation-none, other-project, and out-of-root workspaces", () => {
    const paths = computeManagedWorktreePaths({
      allMetadata: [
        makeMetadata({ archivedAt: "2026-01-02T00:00:00Z" }),
        makeMetadata({ parentWorkspaceId: "parent1234" }),
        makeMetadata({ taskIsolation: "none" }),
        makeMetadata({ projectPath: "/home/user/projects/other" }),
        makeMetadata({ namedWorkspacePath: "/elsewhere/feature-a" }),
        makeMetadata({ runtimeConfig: { type: "local" } }),
      ],
      projectPath,
      managedRootDir: managedRoot,
    });
    expect(paths).toEqual([]);
  });

  test("re-includes unarchived workspaces", () => {
    const paths = computeManagedWorktreePaths({
      allMetadata: [
        makeMetadata({
          archivedAt: "2026-01-01T00:00:00Z",
          unarchivedAt: "2026-01-02T00:00:00Z",
        }),
      ],
      projectPath,
      managedRootDir: managedRoot,
    });
    expect(paths).toEqual([`${managedRoot}/feature-a`]);
  });

  test("derives secondary checkout paths for multi-project workspaces", () => {
    const paths = computeManagedWorktreePaths({
      allMetadata: [
        makeMetadata({
          projectPath: "/home/user/projects/primary",
          namedWorkspacePath: "/base/src/primary/feature-a",
          projects: [
            { projectPath: "/home/user/projects/primary", projectName: "primary" },
            { projectPath, projectName: "my-project" },
          ],
        }),
      ],
      projectPath,
      managedRootDir: managedRoot,
    });
    expect(paths).toEqual([`${managedRoot}/feature-a`]);
  });
});
