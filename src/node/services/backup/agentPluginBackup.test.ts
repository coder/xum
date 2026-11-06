import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Config } from "@/node/config";
import { resolveBackupContents } from "@/common/config/schemas/settingsBackup";
import type { SettingsBackupInput } from "@/common/orpc/schemas/backup";
import { createBackupGitRepo, createBackupPayloadStore } from "./adapters";
import { BackupService } from "./backupService";
import { PLUGIN_BACKUP_DIR, PLUGIN_BACKUP_MANIFEST_PATH } from "./agentPluginBackup";
import { captureRejection, commitAll, runGit, writeFixtureFile } from "./testHelpers";

const DEFAULT_CONTENTS = resolveBackupContents({});
const PLUGINS_OFF = resolveBackupContents({ includePlugins: false });

function shaOf(seed: string): string {
  return seed.charCodeAt(0).toString(16).padStart(2, "0").repeat(20);
}

/** A registry row as the installer writes it, trust fields included. */
function registryRow(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    scope: "global",
    source: {
      type: "git",
      url: `https://github.com/example/${name}.git`,
      ref: "main",
      refType: "branch",
    },
    lockedSha: shaOf(name),
    installedAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    importedComponents: { skills: ["review"], mcpServers: ["docs"] },
    componentConsent: {
      skills: { review: "fingerprint" },
      mcpServers: { docs: "fingerprint" },
      workflows: {},
      agents: {},
      slashCommands: {},
    },
    autoUpdate: true,
    ...overrides,
  };
}

async function exists(target: string): Promise<boolean> {
  return await fs.access(target).then(
    () => true,
    () => false
  );
}

async function writeRegistry(root: string, rows: unknown[]): Promise<void> {
  await fs.writeFile(path.join(root, "plugins.json"), JSON.stringify({ plugins: rows }), "utf-8");
}

async function writeGeneratedPlugin(root: string, name: string, generatedFrom: unknown) {
  await writeFixtureFile(
    root,
    `plugins/${name}/plugin.json`,
    JSON.stringify({ name, extensions: { mux: { generatedFrom } } })
  );
}

describe("backup of the managed plugin list", () => {
  let tempDir: string;
  let muxRoot: string;
  let originPath: string;
  let cacheRoot: string;
  let settings: SettingsBackupInput;
  let config: Config;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-plugin-backup-"));
    muxRoot = path.join(tempDir, "mux-root");
    originPath = path.join(tempDir, "origin.git");
    cacheRoot = path.join(tempDir, "cache");
    await fs.mkdir(muxRoot, { recursive: true });
    await runGit(["init", "--bare", "--initial-branch=main", originPath]);
    settings = { repoUrl: originPath, branch: "main", path: "xum" };
    config = new Config(muxRoot);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function prepare() {
    const gitRepo = createBackupGitRepo({ cacheRoot });
    const payload = createBackupPayloadStore({ config });
    const repository = await gitRepo.prepare(settings);
    const managed = path.join(repository.rootDir, settings.path);
    const request = { repositoryRoot: repository.rootDir, managedPath: settings.path };
    return { gitRepo, payload, repository, managed, request };
  }

  async function readSidecar(managed: string): Promise<unknown> {
    return JSON.parse(
      await fs.readFile(path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH), "utf-8")
    ) as unknown;
  }

  describe("push", () => {
    it("writes the source and the pin of every managed plugin, and no local trust state", async () => {
      await writeRegistry(muxRoot, [
        registryRow("zeta", {
          source: {
            type: "git",
            url: "https://github.com/example/mono.git",
            ref: "v2.0.0",
            refType: "tag",
            subpath: "packages/zeta",
          },
        }),
        registryRow("alpha"),
      ]);
      const { payload, managed, request } = await prepare();

      const exported = await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

      expect(exported.secretFiles).toEqual([]);
      const sidecar = (await readSidecar(managed)) as { schemaVersion: number; plugins: unknown[] };
      expect(sidecar.schemaVersion).toBe(1);
      expect(sidecar.plugins).toEqual([
        {
          name: "alpha",
          source: {
            type: "git",
            url: "https://github.com/example/alpha.git",
            ref: "main",
            refType: "branch",
          },
          lockedSha: shaOf("alpha"),
          importedComponents: { skills: ["review"], mcpServers: ["docs"] },
        },
        {
          name: "zeta",
          source: {
            type: "git",
            url: "https://github.com/example/mono.git",
            ref: "v2.0.0",
            refType: "tag",
            subpath: "packages/zeta",
          },
          lockedSha: shaOf("zeta"),
          importedComponents: { skills: ["review"], mcpServers: ["docs"] },
        },
      ]);
      const raw = await fs.readFile(path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH), "utf-8");
      for (const local of ["componentConsent", "installedAt", "updatedAt", "autoUpdate"]) {
        expect(raw).not.toContain(local);
      }
    });

    it("records the install method of a plugin whose plugin.json Xum generated", async () => {
      await writeRegistry(muxRoot, [
        registryRow("skills-only"),
        registryRow("from-market"),
        registryRow("own-manifest"),
      ]);
      await writeGeneratedPlugin(muxRoot, "skills-only", { kind: "skills" });
      await writeGeneratedPlugin(muxRoot, "from-market", {
        kind: "claude-marketplace",
        entry: "Market-Entry",
      });
      await writeFixtureFile(
        muxRoot,
        "plugins/own-manifest/plugin.json",
        '{"name":"own-manifest"}'
      );
      const { payload, managed, request } = await prepare();

      await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

      const sidecar = (await readSidecar(managed)) as {
        plugins: Array<{ name: string; method?: unknown }>;
      };
      const methods = Object.fromEntries(sidecar.plugins.map((p) => [p.name, p.method]));
      expect(methods).toEqual({
        "from-market": { kind: "claude-marketplace", entry: "Market-Entry" },
        "own-manifest": undefined,
        "skills-only": { kind: "skills" },
      });
    });

    it("writes no list with the flag off, and drops one pushed before", async () => {
      await writeRegistry(muxRoot, [registryRow("alpha")]);
      const { payload, managed, request } = await prepare();
      await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });
      expect(await exists(path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH))).toBe(true);

      await payload.exportTo({ ...request, contents: PLUGINS_OFF });

      expect(await exists(path.join(managed, PLUGIN_BACKUP_DIR))).toBe(false);
    });

    it("writes no list when nothing is installed", async () => {
      const { payload, managed, request } = await prepare();

      await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

      expect(await exists(path.join(managed, PLUGIN_BACKUP_DIR))).toBe(false);
    });

    it("leaves a row the restore side would refuse out of the list, not out of the push", async () => {
      await writeRegistry(muxRoot, [
        registryRow("alpha"),
        registryRow("oversized", {
          source: {
            type: "git",
            url: `https://github.com/example/${"x".repeat(3000)}.git`,
            ref: "main",
            refType: "branch",
          },
        }),
        registryRow("unpinned", { lockedSha: "abc123" }),
      ]);
      const { payload, managed, request } = await prepare();

      await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

      const sidecar = (await readSidecar(managed)) as { plugins: Array<{ name: string }> };
      expect(sidecar.plugins.map((p) => p.name)).toEqual(["alpha"]);
    });

    it("holds a list that looks like a secret for the push review", async () => {
      await writeRegistry(muxRoot, [
        registryRow("alpha", {
          source: {
            type: "git",
            url: `https://github.com/example/ghp_${"a".repeat(36)}.git`,
            ref: "main",
            refType: "branch",
          },
        }),
      ]);
      const { payload, request } = await prepare();

      const exported = await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

      expect(exported.secretFiles).toEqual([PLUGIN_BACKUP_MANIFEST_PATH]);
    });
  });

  describe("preview and restore", () => {
    /** A backup of `rows`, pushed from this root and read back through the store. */
    async function backupOf(rows: unknown[]) {
      await writeRegistry(muxRoot, rows);
      const prepared = await prepare();
      await prepared.payload.exportTo({ ...prepared.request, contents: DEFAULT_CONTENTS });
      return prepared;
    }

    async function useLocalRegistry(rows: unknown[]) {
      await fs.rm(path.join(muxRoot, "plugins"), { recursive: true, force: true });
      await writeRegistry(muxRoot, rows);
    }

    it("compares each listed plugin with this machine's managed installs", async () => {
      const { payload, request } = await backupOf([
        registryRow("missing-one"),
        registryRow("same-one"),
        registryRow("moved-one"),
        registryRow("unmanaged-one"),
      ]);
      await useLocalRegistry([
        registryRow("same-one"),
        registryRow("moved-one", { lockedSha: shaOf("z") }),
      ]);
      await writeFixtureFile(muxRoot, "plugins/unmanaged-one/plugin.json", "{}");

      const preview = await payload.previewRestore({ ...request, contents: DEFAULT_CONTENTS });

      const statuses = Object.fromEntries(
        (preview.pluginInstalls ?? []).map((row) => [row.name, row.status])
      );
      expect(statuses).toEqual({
        "missing-one": "missing",
        "same-one": "installed",
        "moved-one": "conflict",
        "unmanaged-one": "conflict",
      });
      expect(preview.pluginListSkipped).toBe(false);
    });

    it("hands back the pin and the source a reinstall needs", async () => {
      const { payload, request } = await backupOf([
        registryRow("alpha", {
          source: {
            type: "git",
            url: "https://github.com/example/mono.git",
            ref: "v1.0.0",
            refType: "tag",
            subpath: "plugins/alpha",
          },
        }),
      ]);
      await useLocalRegistry([]);

      const preview = await payload.previewRestore({ ...request, contents: DEFAULT_CONTENTS });

      expect(preview.pluginInstalls).toEqual([
        {
          name: "alpha",
          source: {
            type: "git",
            url: "https://github.com/example/mono.git",
            ref: "v1.0.0",
            refType: "tag",
            subpath: "plugins/alpha",
          },
          lockedSha: shaOf("alpha"),
          importedComponents: { skills: ["review"], mcpServers: ["docs"] },
          status: "missing",
        },
      ]);
    });

    it("reports the list on restore and installs nothing", async () => {
      const { payload, request } = await backupOf([registryRow("alpha")]);
      await useLocalRegistry([]);
      const registryBefore = await fs.readFile(path.join(muxRoot, "plugins.json"), "utf-8");

      const restored = await payload.restore({
        ...request,
        contents: DEFAULT_CONTENTS,
        snapshotPath: path.join(tempDir, "snapshot"),
        matchedProjects: [],
      });

      expect(restored.pluginInstalls?.map((row) => [row.name, row.status])).toEqual([
        ["alpha", "missing"],
      ]);
      expect(await fs.readFile(path.join(muxRoot, "plugins.json"), "utf-8")).toBe(registryBefore);
      expect(await exists(path.join(muxRoot, "plugins"))).toBe(false);
      expect(restored.changedFiles.some((file) => file.includes("plugin"))).toBe(false);
    });

    it("skips the list with the flag off and reports that it did", async () => {
      const { payload, request } = await backupOf([registryRow("alpha")]);
      await useLocalRegistry([]);

      const preview = await payload.previewRestore({ ...request, contents: PLUGINS_OFF });
      const restored = await payload.restore({
        ...request,
        contents: PLUGINS_OFF,
        snapshotPath: path.join(tempDir, "snapshot"),
        matchedProjects: [],
      });

      expect(preview.pluginInstalls).toEqual([]);
      expect(preview.pluginListSkipped).toBe(true);
      expect(restored.pluginInstalls).toEqual([]);
      expect(restored.pluginListSkipped).toBe(true);
    });

    it("restores a backup that has no list as before", async () => {
      await writeFixtureFile(muxRoot, "AGENTS.md", "instructions\n");
      const { payload, request } = await backupOf([]);

      const preview = await payload.previewRestore({ ...request, contents: DEFAULT_CONTENTS });

      expect(preview.pluginInstalls).toEqual([]);
      expect(preview.pluginListSkipped).toBe(false);
    });

    it("refuses a malformed list as an invalid backup", async () => {
      const { payload, managed, request } = await backupOf([registryRow("alpha")]);
      await fs.writeFile(path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH), "{ not json", "utf-8");

      const preview = await captureRejection(
        payload.previewRestore({ ...request, contents: DEFAULT_CONTENTS })
      );
      const validation = await captureRejection(
        payload.validateRestore({ ...request, contents: DEFAULT_CONTENTS })
      );

      expect((preview as { code?: string }).code).toBe("INVALID_BACKUP");
      expect((validation as { code?: string }).code).toBe("INVALID_BACKUP");
    });

    it("refuses a list whose entries break the schema", async () => {
      const { payload, managed, request } = await backupOf([registryRow("alpha")]);
      const sidecar = (await readSidecar(managed)) as { plugins: Array<Record<string, unknown>> };
      sidecar.plugins[0] = { ...sidecar.plugins[0], lockedSha: "main" };
      await fs.writeFile(
        path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH),
        JSON.stringify(sidecar),
        "utf-8"
      );

      const error = await captureRejection(
        payload.validateRestore({ ...request, contents: DEFAULT_CONTENTS })
      );

      expect((error as { code?: string }).code).toBe("INVALID_BACKUP");
    });

    it("refuses a list that is a symlink out of the backup", async () => {
      const { payload, managed, request } = await backupOf([registryRow("alpha")]);
      const outside = path.join(tempDir, "outside.json");
      await fs.writeFile(outside, '{"schemaVersion":1,"plugins":[]}', "utf-8");
      const manifest = path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH);
      await fs.rm(manifest);
      await fs.symlink(outside, manifest);

      const error = await captureRejection(
        payload.validateRestore({ ...request, contents: DEFAULT_CONTENTS })
      );

      expect((error as { code?: string }).code).toBe("INVALID_BACKUP");
    });

    it("lets a malformed list through when the flag is off", async () => {
      const { payload, managed, request } = await backupOf([registryRow("alpha")]);
      await fs.writeFile(path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH), "{ not json", "utf-8");

      const preview = await payload.previewRestore({ ...request, contents: PLUGINS_OFF });

      expect(preview.pluginListSkipped).toBe(true);
    });
  });

  describe("through the service", () => {
    function serviceFor(root: string): BackupService {
      return new BackupService(new Config(root), {
        gitRepo: createBackupGitRepo({ cacheRoot: path.join(root, "backup-cache") }),
        payload: createBackupPayloadStore({ config: new Config(root) }),
      });
    }

    async function pushFromFirstMachine(rows: unknown[]) {
      await writeFixtureFile(muxRoot, "AGENTS.md", "from the first machine\n");
      await writeRegistry(muxRoot, rows);
      const pushed = await serviceFor(muxRoot).push(settings);
      if (!pushed.success) throw new Error(pushed.error.message);
    }

    async function secondMachine(): Promise<string> {
      const root = path.join(tempDir, "second-root");
      await fs.mkdir(root, { recursive: true });
      return root;
    }

    it("offers the first machine's plugins on a second one without installing them", async () => {
      await pushFromFirstMachine([registryRow("alpha"), registryRow("beta")]);
      const second = await secondMachine();

      const restored = await serviceFor(second).restore(settings);

      if (!restored.success) throw new Error(restored.error.message);
      expect(await fs.readFile(path.join(second, "AGENTS.md"), "utf-8")).toBe(
        "from the first machine\n"
      );
      expect(restored.data.pluginInstalls?.map((row) => [row.name, row.status])).toEqual([
        ["alpha", "missing"],
        ["beta", "missing"],
      ]);
      expect(await exists(path.join(second, "plugins.json"))).toBe(false);
      expect(await exists(path.join(second, "plugins"))).toBe(false);
    });

    it("reports the same rows from a preview", async () => {
      await pushFromFirstMachine([registryRow("alpha")]);

      const preview = await serviceFor(await secondMachine()).preview(settings);

      if (!preview.success) throw new Error(preview.error.message);
      expect(preview.data.pluginInstalls?.map((row) => row.name)).toEqual(["alpha"]);
    });

    it("refuses a malformed list before the safety snapshot, with nothing written", async () => {
      await pushFromFirstMachine([registryRow("alpha")]);
      const clone = path.join(tempDir, "tamper");
      await runGit(["clone", "--quiet", originPath, clone]);
      await fs.writeFile(path.join(clone, "xum", PLUGIN_BACKUP_MANIFEST_PATH), "[]", "utf-8");
      await commitAll(clone, "break the plugin list");
      await runGit(["-C", clone, "push", "--quiet", "origin", "HEAD:refs/heads/main"]);
      const second = await secondMachine();

      const restored = await serviceFor(second).restore(settings);

      if (restored.success) throw new Error("Expected the malformed list to block the restore");
      expect(restored.error.code).toBe("INVALID_BACKUP");
      expect(restored.error.snapshotPath ?? null).toBeNull();
      expect((await fs.readdir(second)).sort()).toEqual(["backup-cache"]);
    });
  });
});
