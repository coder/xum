import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from ".";
import type { Workspace } from "@/common/types/project";

const older = "2026-01-01T00:00:00.000Z";
const newer = "2026-02-01T00:00:00.000Z";

describe("Config snapshots", () => {
  let root: string;
  let config: Config;
  let projectPath: string;

  const workspace = (id: string, fields: Partial<Workspace> = {}): Workspace => ({
    id,
    name: id,
    path: path.join(root, id),
    createdAt: older,
    runtimeConfig: { type: "local" },
    ...fields,
  });

  async function saveWorkspaces(workspaces: Workspace[]) {
    await config.editConfig((snapshot) => {
      snapshot.projects.set(projectPath, { workspaces });
      return snapshot;
    });
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "xum-config-snapshot-"));
    config = new Config(root);
    projectPath = path.join(root, "project");
    await saveWorkspaces([workspace("active"), workspace("archived", { archivedAt: older })]);
  });

  afterEach(async () => {
    await config.editConfig((snapshot) => snapshot);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("shares unchanged normalized reads and reuses the saved write generation", async () => {
    config = new Config(root);
    const snapshot = config.loadConfigOrDefault();
    const generation = await new Config(root).configFileWriteGeneration();
    const read = spyOn(fs, "readFileSync");
    const asyncRead = spyOn(fs.promises, "readFile");
    try {
      expect(config.loadConfigOrDefault()).toBe(snapshot);
      expect(config.loadConfigOrDefault({ throwOnError: true })).toBe(snapshot);
      expect(await config.configFileWriteGeneration()).toBe(generation);
      expect(
        read.mock.calls.filter(([file]) => file === path.join(root, "config.json"))
      ).toHaveLength(0);
      expect(
        asyncRead.mock.calls.filter(([file]) => file === path.join(root, "config.json"))
      ).toHaveLength(0);
    } finally {
      read.mockRestore();
      asyncRead.mockRestore();
    }
  });

  it("invalidates on atomic external replacement, including same-size bytes and mtime", () => {
    const snapshot = config.loadConfigOrDefault();
    const stat = fs.statSync(path.join(root, "config.json"));
    const replacement = path.join(root, "replacement.json");
    fs.writeFileSync(
      replacement,
      fs.readFileSync(path.join(root, "config.json"), "utf-8").replaceAll('"active"', '"latest"')
    );
    fs.utimesSync(replacement, stat.atime, stat.mtime);
    fs.renameSync(replacement, path.join(root, "config.json"));
    const next = config.loadConfigOrDefault();
    expect(next).not.toBe(snapshot);
    expect(config.findWorkspace("latest")?.workspaceName).toBe("latest");
    expect(config.findWorkspace("active")).toBeNull();
    expect(config.loadConfigOrDefault()).toBe(next);
  });

  it("isolates edits and warms the saved snapshot without another file read", async () => {
    const before = config.loadConfigOrDefault();
    const generation = await config.configFileWriteGeneration();
    const read = spyOn(fs, "readFileSync");
    try {
      await config.editConfig((snapshot) => {
        expect(snapshot).not.toBe(before);
        snapshot.projects.get(projectPath)!.workspaces[0].title = "Changed";
        return snapshot;
      });
      const after = config.loadConfigOrDefault();
      expect(after.projects.get(projectPath)?.workspaces[0].title).toBe("Changed");
      expect(before.projects.get(projectPath)?.workspaces[0].title).toBeUndefined();
      expect(
        read.mock.calls.filter(([file]) => file === path.join(root, "config.json"))
      ).toHaveLength(1);
      expect(await config.configFileWriteGeneration()).not.toBe(generation);
      expect(config.loadConfigOrDefault()).toBe(after);
    } finally {
      read.mockRestore();
    }
    expect(config.loadConfigOrDefault()).toEqual(new Config(root).loadConfigOrDefault());
  });

  it("warms the saved runtime projection with normalized keys and hierarchy", async () => {
    await config.editConfig((snapshot) => {
      snapshot.projects.set(projectPath + "/child/", { workspaces: [workspace("child")] });
      return snapshot;
    });
    const snapshot = config.loadConfigOrDefault();
    expect(snapshot).toEqual(new Config(root).loadConfigOrDefault());
    expect(snapshot.projects.has(projectPath + "/child/")).toBe(false);
    expect(snapshot.projects.get(projectPath + "/child")?.workspaces).toEqual([]);
    expect(
      snapshot.projects.get(projectPath)?.workspaces.find((entry) => entry.id === "child")
        ?.subProjectPath
    ).toBe(projectPath + "/child");
  });

  it("does not reuse a lenient structurally invalid load for a strict read", () => {
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ projects: {} }));
    expect(config.loadConfigOrDefault().projects.size).toBe(0);
    expect(() => config.loadConfigOrDefault({ throwOnError: true })).toThrow();
  });

  it("does not cache structurally invalid entries after an unrelated save", async () => {
    fs.writeFileSync(
      path.join(root, "config.json"),
      JSON.stringify({
        projects: [
          [
            projectPath,
            {
              workspaces: [{ path: path.join(root, "invalid"), id: 42 }],
            },
          ],
        ],
      })
    );
    await config.setUpdateChannel("nightly");
    expect(() => config.loadConfigOrDefault({ throwOnError: true })).toThrow();
  });

  it("treats stat failures as cache misses", () => {
    const snapshot = config.loadConfigOrDefault();
    const stat = spyOn(fs, "statSync").mockImplementation(() => {
      throw new Error("stat unavailable");
    });
    try {
      expect(config.loadConfigOrDefault()).not.toBe(snapshot);
    } finally {
      stat.mockRestore();
    }
  });

  it("does not reuse a cached snapshot after the file disappears", () => {
    config.loadConfigOrDefault();
    fs.unlinkSync(path.join(root, "config.json"));
    expect(config.loadConfigOrDefault().projects.size).toBe(0);
    expect(config.findWorkspace("active")).toBeNull();
  });

  it("looks up modern and archived identities without walking the snapshot again", () => {
    const snapshot = config.loadConfigOrDefault();
    expect(config.findWorkspace("active")?.workspaceName).toBe("active");
    const iterate = spyOn(snapshot.projects, Symbol.iterator).mockImplementation(() => {
      throw new Error("Unexpected registry enumeration");
    });
    try {
      expect(config.findWorkspace("archived")?.workspaceName).toBe("archived");
      expect(config.findWorkspace("missing")).toBeNull();
    } finally {
      iterate.mockRestore();
    }
  });

  it("filters archive timestamps before checkout probes and retains archived ancestors", async () => {
    await saveWorkspaces([
      workspace("root", { archivedAt: older }),
      workspace("active", { parentWorkspaceId: "root" }),
      workspace("restored", { archivedAt: older, unarchivedAt: newer }),
      workspace("equal", { archivedAt: older, unarchivedAt: older }),
      workspace("rearchived", { archivedAt: newer, unarchivedAt: older }),
    ]);
    const stored = config.loadConfigOrDefault().projects.get(projectPath)!.workspaces;
    Object.defineProperty(stored[0], "title", {
      configurable: true,
      enumerable: true,
      get: () => {
        throw new Error("Archived metadata must not be constructed");
      },
    });
    const access = spyOn(fs.promises, "access").mockResolvedValue(undefined);
    try {
      const active = await config.getAllWorkspaceMetadata({ archived: "active" });
      expect(active.map((metadata) => metadata.id)).toEqual(["active", "restored", "equal"]);
      expect(active[0].rootWorkspaceId).toBe("root");
      delete stored[0].title;
      expect(access.mock.calls.map(([file]) => file)).toEqual(
        active.map((metadata) => metadata.namedWorkspacePath)
      );
      access.mockClear();
      const archived = await config.getAllWorkspaceMetadata({ archived: "archived" });
      expect(archived.map((metadata) => metadata.id)).toEqual(["root", "rearchived"]);
      expect(access).toHaveBeenCalledTimes(2);
      access.mockClear();
      expect(await config.getAllWorkspaceMetadata({ probeCheckouts: false })).toHaveLength(5);
      expect(access).not.toHaveBeenCalled();
    } finally {
      access.mockRestore();
      delete stored[0].title;
    }
  });

  it("builds the same metadata for a single id with just one checkout probe", async () => {
    await saveWorkspaces([
      workspace("root", { archivedAt: older }),
      workspace("child", { parentWorkspaceId: "root" }),
    ]);
    const all = await config.getAllWorkspaceMetadata();
    const access = spyOn(fs.promises, "access");
    const enumerate = spyOn(config, "getAllWorkspaceMetadata").mockRejectedValue(
      new Error("Unexpected full metadata enumeration")
    );
    try {
      expect(await config.getWorkspaceMetadataById("child")).toEqual(all[1]);
      expect(access.mock.calls.map(([file]) => file)).toEqual([path.join(root, "child")]);
      expect(await config.getWorkspaceMetadataById("missing")).toBeNull();
      expect(access).toHaveBeenCalledTimes(1);
    } finally {
      access.mockRestore();
      enumerate.mockRestore();
    }
  });

  it("keeps legacy identity migration local until its serialized save", async () => {
    await saveWorkspaces([{ path: path.join(root, "legacy") }]);
    const snapshot = config.loadConfigOrDefault();
    const id = config.generateLegacyId(projectPath, path.join(root, "legacy"));
    expect(config.findWorkspace(id)?.workspacePath).toBe(path.join(root, "legacy"));
    const metadata = await config.getWorkspaceMetadataById(id);
    expect(metadata?.id).toBe(id);
    expect(snapshot.projects.get(projectPath)?.workspaces[0].id).toBeUndefined();
    expect(await config.getAllWorkspaceMetadata()).toEqual([metadata!]);
  });

  it("keeps returned metadata tags independently mutable", async () => {
    await saveWorkspaces([workspace("tagged", { tags: { original: "value" } })]);
    const metadata = await config.getWorkspaceMetadataById("tagged");
    expect(metadata?.tags).toBeDefined();
    metadata!.tags!.changed = "value";
    expect(config.loadConfigOrDefault().projects.get(projectPath)?.workspaces[0].tags).toEqual({
      original: "value",
    });
    expect((await config.getWorkspaceMetadataById("tagged"))?.tags).toEqual({ original: "value" });
  });

  it("classifies legacy archive timestamps before probing", async () => {
    await saveWorkspaces([{ path: path.join(root, "legacy") }]);
    const id = config.generateLegacyId(projectPath, path.join(root, "legacy"));
    fs.mkdirSync(path.join(config.sessionsDir, id), { recursive: true });
    fs.writeFileSync(
      path.join(config.sessionsDir, id, "metadata.json"),
      JSON.stringify({
        id,
        name: "legacy",
        createdAt: older,
        runtimeConfig: { type: "local" },
        archivedAt: older,
      })
    );
    const access = spyOn(fs.promises, "access").mockResolvedValue(undefined);
    try {
      expect(await config.getAllWorkspaceMetadata({ archived: "active" })).toEqual([]);
      expect(access).not.toHaveBeenCalled();
    } finally {
      access.mockRestore();
    }
  });

  it("bounds concurrent probes and preserves registry order", async () => {
    await saveWorkspaces(Array.from({ length: 70 }, (_, index) => workspace(String(index))));
    let started = 0;
    let active = 0;
    let peak = 0;
    let release!: () => void;
    let saturated!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstBatch = new Promise<void>((resolve) => {
      saturated = resolve;
    });
    const access = spyOn(fs.promises, "access").mockImplementation(async () => {
      started++;
      peak = Math.max(peak, ++active);
      if (started === 32) saturated();
      await gate;
      active--;
    });
    try {
      const result = config.getAllWorkspaceMetadata();
      await firstBatch;
      expect(started).toBe(32);
      release();
      const metadata = await result;
      expect(metadata.map((entry) => entry.id)).toEqual(
        Array.from({ length: 70 }, (_, index) => String(index))
      );
      expect(peak).toBe(32);
    } finally {
      release();
      access.mockRestore();
    }
  });
});
