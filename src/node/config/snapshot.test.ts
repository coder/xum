import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import nativeFs, * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from ".";
import { log } from "@/node/services/log";
import type { ProjectConfig, ProjectsConfig, Workspace } from "@/common/types/project";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

/** Signature of Config's private buildWorkspaceMetadata, spied on to count rebuilds. */
type BuildWorkspaceMetadata = (
  config: ProjectsConfig,
  projects: Iterable<[string, ProjectConfig]>,
  options?: { legacyAliasIds?: Set<string> }
) => Promise<FrontendWorkspaceMetadata[]>;

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
    const timestamp = new Date("2026-03-01T00:00:00.000Z");
    fs.utimesSync(path.join(root, "config.json"), timestamp, timestamp);
    const snapshot = config.loadConfigOrDefault();
    const stat = fs.statSync(path.join(root, "config.json"));
    const replacement = path.join(root, "replacement.json");
    fs.writeFileSync(
      replacement,
      fs.readFileSync(path.join(root, "config.json"), "utf-8").replaceAll('"active"', '"latest"')
    );
    fs.utimesSync(replacement, timestamp, timestamp);
    const replacementStat = fs.statSync(replacement);
    expect(replacementStat.mtimeMs).toBe(stat.mtimeMs);
    expect(replacementStat.size).toBe(stat.size);
    expect(replacementStat.ino).not.toBe(stat.ino);
    fs.renameSync(replacement, path.join(root, "config.json"));
    const next = config.loadConfigOrDefault();
    expect(next).not.toBe(snapshot);
    expect(config.findWorkspace("latest")?.workspaceName).toBe("latest");
    expect(config.findWorkspace("active")).toBeNull();
    expect(config.loadConfigOrDefault()).toBe(next);
  });

  it("isolates edits and reloads the saved snapshot once", async () => {
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
      ).toHaveLength(2);
      expect(await config.configFileWriteGeneration()).not.toBe(generation);
      expect(config.loadConfigOrDefault()).toBe(after);
    } finally {
      read.mockRestore();
    }
    expect(config.loadConfigOrDefault()).toEqual(new Config(root).loadConfigOrDefault());
  });

  it("memoizes registry-only enumerations per config snapshot and option slot", async () => {
    const internals = config as unknown as { buildWorkspaceMetadata: BuildWorkspaceMetadata };
    const original = internals.buildWorkspaceMetadata.bind(config);
    const build = spyOn(internals, "buildWorkspaceMetadata").mockImplementation(
      async (snapshot, projects, options) => {
        const result = await original(snapshot, projects, options);
        // Stand-in for a second legacy metadata.json alias surfaced by the walk.
        options?.legacyAliasIds?.add("alias-from-build");
        return result;
      }
    );
    try {
      const firstAliases = new Set<string>();
      const first = await config.getAllWorkspaceMetadata({
        probeCheckouts: false,
        legacyAliasIds: firstAliases,
      });
      const secondAliases = new Set<string>();
      const second = await config.getAllWorkspaceMetadata({
        probeCheckouts: false,
        legacyAliasIds: secondAliases,
      });
      expect(build).toHaveBeenCalledTimes(1);
      expect(second).not.toBe(first);
      expect(second).toEqual(first);
      expect(second[0]).toBe(first[0]);
      expect(firstAliases).toEqual(new Set(["alias-from-build"]));
      expect(secondAliases).toEqual(new Set(["alias-from-build"]));

      // Concurrent callers of one slot share the in-flight build.
      const [a, b] = await Promise.all([
        config.getAllWorkspaceMetadata({ probeCheckouts: false, archived: "archived" }),
        config.getAllWorkspaceMetadata({ probeCheckouts: false, archived: "archived" }),
      ]);
      expect(build).toHaveBeenCalledTimes(2);
      expect(a.map((entry) => entry.id)).toEqual(["archived"]);
      expect(b).toEqual(a);

      // Filter and strictness are separate slots; the probing variant is never memoized.
      await config.getAllWorkspaceMetadata({ probeCheckouts: false, archived: "active" });
      await config.getAllWorkspaceMetadata({ probeCheckouts: false, throwOnError: true });
      expect(build).toHaveBeenCalledTimes(4);
      await config.getAllWorkspaceMetadata();
      await config.getAllWorkspaceMetadata();
      expect(build).toHaveBeenCalledTimes(6);

      // A write from this process yields a new snapshot, so the next read rebuilds.
      await config.editConfig((snapshot) => {
        snapshot.projects.get(projectPath)!.workspaces[0].title = "Changed";
        return snapshot;
      });
      const rebuilt = await config.getAllWorkspaceMetadata({ probeCheckouts: false });
      expect(build).toHaveBeenCalledTimes(7);
      expect(rebuilt.find((entry) => entry.id === "active")?.title).toBe("Changed");
      expect(first.find((entry) => entry.id === "active")?.title).toBeUndefined();
      await config.getAllWorkspaceMetadata({ probeCheckouts: false });
      expect(build).toHaveBeenCalledTimes(7);

      // An external rewrite changes the stat key and invalidates too.
      const configPath = path.join(root, "config.json");
      fs.writeFileSync(
        configPath,
        fs.readFileSync(configPath, "utf-8").replace('"title": "Changed"', '"title": "External"')
      );
      const external = await config.getAllWorkspaceMetadata({ probeCheckouts: false });
      expect(build).toHaveBeenCalledTimes(8);
      expect(external.find((entry) => entry.id === "active")?.title).toBe("External");
    } finally {
      build.mockRestore();
    }
  });

  it("does not memoize a lenient build that degraded on an unreadable legacy metadata file", async () => {
    const legacyPath = path.join(root, "legacy");
    await saveWorkspaces([{ path: legacyPath }]);
    const legacyId = config.generateLegacyId(projectPath, legacyPath);
    const metadataPath = path.join(config.sessionsDir, legacyId, "metadata.json");
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fs.writeFileSync(metadataPath, "{ not json");
    const internals = config as unknown as { buildWorkspaceMetadata: BuildWorkspaceMetadata };
    const build = spyOn(internals, "buildWorkspaceMetadata");
    const logError = spyOn(log, "error").mockImplementation(() => undefined);
    try {
      const snapshot = config.loadConfigOrDefault();
      // Fallback identity while the file is unreadable; nothing to migrate, so the snapshot
      // identity stays put and only the memo could hide the repair.
      const [degraded] = await Promise.all([
        config.getAllWorkspaceMetadata({ probeCheckouts: false }),
        config.getAllWorkspaceMetadata({ probeCheckouts: false }),
      ]);
      expect(degraded.map((entry) => entry.id)).toEqual([legacyId]);
      expect(build).toHaveBeenCalledTimes(1);
      expect(config.loadConfigOrDefault()).toBe(snapshot);

      fs.writeFileSync(
        metadataPath,
        JSON.stringify({
          id: "stable-legacy-id",
          name: "legacy",
          createdAt: older,
          runtimeConfig: { type: "local" },
        })
      );
      const repaired = await config.getAllWorkspaceMetadata({ probeCheckouts: false });
      expect(build).toHaveBeenCalledTimes(2);
      expect(repaired.map((entry) => entry.id)).toEqual(["stable-legacy-id"]);
    } finally {
      logError.mockRestore();
      build.mockRestore();
    }
  });

  it("drops a failed registry-only build from the memo", async () => {
    const internals = config as unknown as { buildWorkspaceMetadata: BuildWorkspaceMetadata };
    const original = internals.buildWorkspaceMetadata.bind(config);
    const build = spyOn(internals, "buildWorkspaceMetadata")
      .mockImplementationOnce(() => Promise.reject(new Error("legacy metadata unreadable")))
      .mockImplementation(original);
    try {
      const failure = await config
        .getAllWorkspaceMetadata({ probeCheckouts: false, throwOnError: true })
        .then(
          () => "resolved",
          (error: unknown) => (error instanceof Error ? error.message : "non-error")
        );
      expect(failure).toBe("legacy metadata unreadable");
      const recovered = await config.getAllWorkspaceMetadata({
        probeCheckouts: false,
        throwOnError: true,
      });
      expect(build).toHaveBeenCalledTimes(2);
      expect(recovered.map((entry) => entry.id).sort()).toEqual(["active", "archived"]);
    } finally {
      build.mockRestore();
    }
  });

  it("reloads the saved runtime projection with normalized keys and hierarchy", async () => {
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

  it("sees an external atomic replacement between our rename and save completion", async () => {
    config.loadConfigOrDefault();
    const configPath = path.join(root, "config.json");
    const external = fs
      .readFileSync(configPath, "utf8")
      .replace('"name": "active"', '"name": "external"');
    const rename = nativeFs.rename;
    const filesystem: { rename: (...args: Parameters<typeof rename>) => void } = nativeFs;
    let replaced = false;
    const renameSpy = spyOn(filesystem, "rename").mockImplementation(
      (source, destination, callback) => {
        rename(source, destination, (error) => {
          if (!error && destination === configPath) {
            const replacement = path.join(root, "external.json");
            fs.writeFileSync(replacement, external);
            fs.renameSync(replacement, configPath);
            replaced = true;
          }
          callback(error);
        });
      }
    );
    try {
      await config.setUpdateChannel("nightly");
      expect(replaced).toBe(true);
      expect(await config.configFileWriteGeneration()).toBe(
        await new Config(root).configFileWriteGeneration()
      );
      expect(config.findWorkspace("active")?.workspaceName).toBe("external");
    } finally {
      renameSpy.mockRestore();
    }
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
    const enumerate = spyOn(config, "getAllWorkspaceMetadata").mockImplementation(() => {
      throw new Error("Unexpected full metadata enumeration");
    });
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
