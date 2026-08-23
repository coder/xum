import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { log } from "@/node/services/log";
import { Config } from "./config";
import {
  CODER_ARCHIVE_BEHAVIORS,
  DEFAULT_CODER_ARCHIVE_BEHAVIOR,
} from "@/common/config/coderArchiveBehavior";
import {
  DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
  WORKTREE_ARCHIVE_BEHAVIORS,
} from "@/common/config/worktreeArchiveBehavior";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { secretsToRecord } from "@/common/types/secrets";

describe("Config", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    // Create a temporary directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-test-"));
    config = new Config(tempDir);
  });

  afterEach(() => {
    // Clean up temporary directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Load-time migrations persist through the serialized editConfig queue (an async
  // identity transform) instead of a synchronous write-back, so tests asserting the
  // migrated on-disk form must flush the queue first. Awaiting an identity edit is
  // sufficient: it re-runs the idempotent load migrations and writes the result.
  async function flushConfigEdits(): Promise<void> {
    await config.editConfig((cfg) => cfg);
  }

  describe("loadConfigOrDefault corrupt config recovery", () => {
    function configFilePath(): string {
      return path.join(tempDir, "config.json");
    }

    function corruptBackups(): string[] {
      return fs
        .readdirSync(tempDir)
        .filter((name) => name.startsWith("config.json.corrupt-"))
        .map((name) => path.join(tempDir, name));
    }

    it("preserves malformed JSON and falls back to defaults", () => {
      const configFile = configFilePath();
      const corruptData = '{ "projects": ';
      fs.writeFileSync(configFile, corruptData);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);

      const loaded = config.loadConfigOrDefault();

      expect(loaded.projects.size).toBe(0);
      expect(fs.readFileSync(configFile, "utf-8")).toBe(corruptData);
      const backups = corruptBackups();
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(backups[0])).toEqual(Buffer.from(corruptData));
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain(configFile);
      errorSpy.mockRestore();
    });

    it("does not create duplicate backups for identical corrupt bytes", () => {
      const corruptData = '{ "projects": ';
      fs.writeFileSync(configFilePath(), corruptData);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);

      config.loadConfigOrDefault();
      config.loadConfigOrDefault();
      new Config(tempDir).loadConfigOrDefault();

      const backups = corruptBackups();
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(backups[0])).toEqual(Buffer.from(corruptData));
      errorSpy.mockRestore();
    });

    it.each(["null", '"just a string"', "[1,2]"])(
      "recovers from a non-object JSON root: %s",
      (corruptData) => {
        const configFile = configFilePath();
        fs.writeFileSync(configFile, corruptData);
        const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);

        const loaded = config.loadConfigOrDefault();

        expect(loaded.projects.size).toBe(0);
        expect(fs.readFileSync(configFile, "utf-8")).toBe(corruptData);
        const backups = corruptBackups();
        expect(backups).toHaveLength(1);
        expect(fs.readFileSync(backups[0])).toEqual(Buffer.from(corruptData));
        errorSpy.mockRestore();
      }
    );

    it("heals invalid fields in an object without creating a backup", () => {
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({
          projects: [],
          apiServerPort: "abc",
          defaultModel: "openai:gpt-4o",
          taskSettings: { preserveSubagentsUntilArchive: true },
          migrations: {
            defaultModelFallbacksSeeded: true,
            persistentSubagentsDefaulted: true,
          },
        })
      );

      const loaded = config.loadConfigOrDefault();

      expect(loaded.apiServerPort).toBeUndefined();
      expect(loaded.defaultModel).toBe("openai:gpt-4o");
      expect(corruptBackups()).toHaveLength(0);
    });

    it("treats a missing config as a silent fresh install", () => {
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);

      const loaded = config.loadConfigOrDefault();

      expect(loaded.projects.size).toBe(0);
      expect(corruptBackups()).toHaveLength(0);
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it("keeps the corrupt bytes after a settings edit rewrites config.json", async () => {
      const configFile = configFilePath();
      const corruptData = '{ "projects": ';
      fs.writeFileSync(configFile, corruptData);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);

      config.loadConfigOrDefault();
      const [backupPath] = corruptBackups();
      await config.setUpdateChannel("nightly");

      const rewritten = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
        updateChannel?: unknown;
      };
      expect(rewritten.updateChannel).toBe("nightly");
      expect(fs.readFileSync(backupPath)).toEqual(Buffer.from(corruptData));
      errorSpy.mockRestore();
    });

    it("backs up malformed JSON before rethrowing for cleanup guards", () => {
      const corruptData = '{ "projects": ';
      fs.writeFileSync(configFilePath(), corruptData);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);

      expect(() => config.loadConfigOrDefault({ throwOnError: true })).toThrow();

      const backups = corruptBackups();
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(backups[0])).toEqual(Buffer.from(corruptData));
      errorSpy.mockRestore();
    });

    it("retries the backup on the next load after a transient failure", () => {
      const corruptData = '{ "projects": ';
      fs.writeFileSync(configFilePath(), corruptData);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);
      const writeSpy = spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
        throw new Error("disk full");
      });

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.size).toBe(0);
      expect(corruptBackups()).toHaveLength(0);

      const retried = config.loadConfigOrDefault();
      expect(retried.projects.size).toBe(0);
      const backups = corruptBackups();
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(backups[0])).toEqual(Buffer.from(corruptData));

      writeSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("never overwrites an existing sidecar on a timestamp collision", () => {
      const configFile = configFilePath();
      const corruptData = '{ "projects": ';
      fs.writeFileSync(configFile, corruptData);
      const olderSnapshot = "older corrupt snapshot";
      const nowSpy = spyOn(Date, "now").mockReturnValue(1234567890);
      const collidingPath = `${configFile}.corrupt-1234567890`;
      fs.writeFileSync(collidingPath, olderSnapshot);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);

      config.loadConfigOrDefault();

      expect(fs.readFileSync(collidingPath, "utf-8")).toBe(olderSnapshot);
      expect(fs.readFileSync(`${collidingPath}-1`)).toEqual(Buffer.from(corruptData));
      nowSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("does not overwrite the corrupt config through edits until a backup is confirmed", async () => {
      const configFile = configFilePath();
      const corruptData = '{ "projects": ';
      fs.writeFileSync(configFile, corruptData);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);
      const origWrite = fs.writeFileSync.bind(fs);
      const writeSpy = spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
        if (typeof file === "string" && file.includes(".corrupt-")) {
          throw new Error("disk full");
        }
        origWrite(file, data, options);
      });

      // Callers must see the blocked write as a failure, not a silent success.
      const blockedError = await config.setUpdateChannel("nightly").then(
        () => null,
        (e: unknown) => e
      );
      expect(String(blockedError)).toContain("no confirmed backup yet");

      expect(fs.readFileSync(configFile, "utf-8")).toBe(corruptData);
      expect(corruptBackups()).toHaveLength(0);

      writeSpy.mockRestore();

      await config.setUpdateChannel("nightly");

      const backups = corruptBackups();
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(backups[0])).toEqual(Buffer.from(corruptData));
      const rewritten = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
        updateChannel?: unknown;
      };
      expect(rewritten.updateChannel).toBe("nightly");
      errorSpy.mockRestore();
    });

    it("re-blocks edits when new corrupt bytes appear after a confirmed backup", async () => {
      const configFile = configFilePath();
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);
      fs.writeFileSync(configFile, '{ "projects": ');
      config.loadConfigOrDefault();
      expect(corruptBackups()).toHaveLength(1);

      // Different corrupt bytes whose own backup fails must not inherit the
      // earlier confirmation, or an edit would overwrite the only copy.
      const newCorrupt = '{ "taskSettings": ';
      fs.writeFileSync(configFile, newCorrupt);
      const origWrite = fs.writeFileSync.bind(fs);
      const writeSpy = spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
        if (typeof file === "string" && file.includes(".corrupt-")) {
          throw new Error("disk full");
        }
        origWrite(file, data, options);
      });

      const blockedError = await config.setUpdateChannel("nightly").then(
        () => null,
        (e: unknown) => e
      );
      expect(String(blockedError)).toContain("no confirmed backup yet");
      expect(fs.readFileSync(configFile, "utf-8")).toBe(newCorrupt);
      expect(corruptBackups()).toHaveLength(1);

      writeSpy.mockRestore();

      await config.setUpdateChannel("nightly");
      expect(corruptBackups()).toHaveLength(2);
      const rewritten = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
        updateChannel?: unknown;
      };
      expect(rewritten.updateChannel).toBe("nightly");
      errorSpy.mockRestore();
    });

    it("re-creates a deleted sidecar before an edit may overwrite the corrupt config", async () => {
      const configFile = configFilePath();
      const corruptData = '{ "projects": ';
      fs.writeFileSync(configFile, corruptData);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);

      config.loadConfigOrDefault();
      const [firstBackup] = corruptBackups();
      fs.rmSync(firstBackup);

      await config.setUpdateChannel("nightly");

      // The edit-time load must have re-verified against disk and restored preservation.
      const backups = corruptBackups();
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(backups[0])).toEqual(Buffer.from(corruptData));
      const rewritten = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
        updateChannel?: unknown;
      };
      expect(rewritten.updateChannel).toBe("nightly");
      errorSpy.mockRestore();
    });

    it("skips an unreadable stale sidecar and still creates a fresh backup", () => {
      const configFile = configFilePath();
      const corruptData = '{ "projects": ';
      fs.writeFileSync(configFile, corruptData);
      const stalePath = `${configFile}.corrupt-1`;
      fs.writeFileSync(stalePath, "older unrelated snapshot");
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);
      const origRead = fs.readFileSync.bind(fs);
      const readSpy = spyOn(fs, "readFileSync").mockImplementation(((
        file: fs.PathOrFileDescriptor,
        options?: Parameters<typeof fs.readFileSync>[1]
      ) => {
        if (file === stalePath) {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        }
        return origRead(file, options);
      }) as typeof fs.readFileSync);

      const loaded = config.loadConfigOrDefault();

      expect(loaded.projects.size).toBe(0);
      const fresh = corruptBackups().filter((p) => p !== stalePath);
      expect(fresh).toHaveLength(1);
      expect(origRead(fresh[0])).toEqual(Buffer.from(corruptData));
      readSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("logs again when a previously confirmed backup can no longer be restored", () => {
      const configFile = configFilePath();
      const corruptData = '{ "projects": ';
      fs.writeFileSync(configFile, corruptData);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);

      config.loadConfigOrDefault();
      expect(errorSpy).toHaveBeenCalledTimes(1);

      const [backupPath] = corruptBackups();
      fs.rmSync(backupPath);
      const origWrite = fs.writeFileSync.bind(fs);
      const writeSpy = spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
        if (typeof file === "string" && file.includes(".corrupt-")) {
          throw new Error("disk full");
        }
        origWrite(file, data, options);
      });

      // Losing the backup must surface the new failure, not stay deduped.
      config.loadConfigOrDefault();
      expect(errorSpy).toHaveBeenCalledTimes(2);
      expect(String(errorSpy.mock.calls[1]?.[0])).toContain("Backup failed");

      // The still-failing state stays deduped afterwards.
      config.loadConfigOrDefault();
      expect(errorSpy).toHaveBeenCalledTimes(2);

      writeSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("logs again when the backup is re-verified at a different path", () => {
      const configFile = configFilePath();
      const corruptData = '{ "projects": ';
      fs.writeFileSync(configFile, corruptData);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);
      const nowSpy = spyOn(Date, "now").mockReturnValue(1000);

      config.loadConfigOrDefault();
      expect(errorSpy).toHaveBeenCalledTimes(1);

      // Delete the confirmed sidecar; recreation at a new path must replace the stale
      // guidance that points at the deleted file.
      fs.rmSync(`${configFile}.corrupt-1000`);
      nowSpy.mockReturnValue(2000);
      config.loadConfigOrDefault();

      expect(errorSpy).toHaveBeenCalledTimes(2);
      expect(String(errorSpy.mock.calls[1]?.[0])).toContain("corrupt-2000");

      config.loadConfigOrDefault();
      expect(errorSpy).toHaveBeenCalledTimes(2);
      nowSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("creates sidecars with owner-only permissions", () => {
      if (process.platform === "win32") {
        return;
      }
      const configFile = configFilePath();
      // Pin a permissive umask: under a 0077 umask this assertion would pass vacuously.
      const prevUmask = process.umask(0o022);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);
      try {
        fs.writeFileSync(configFile, '{ "projects": ');
        config.loadConfigOrDefault();

        const [backup] = corruptBackups();
        // Sidecars can hold credentials; peer file proves the narrowing is not ambient.
        expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
        expect(fs.statSync(configFile).mode & 0o777).toBe(0o644);
      } finally {
        process.umask(prevUmask);
        errorSpy.mockRestore();
      }
    });

    it("creates readable owner-only sidecars even under a restrictive umask", () => {
      if (process.platform === "win32") {
        return;
      }
      const configFile = configFilePath();
      const corruptData = '{ "projects": ';
      // Write the corrupt config while file creation still works normally; only the
      // sidecar creation should run under the restrictive umask.
      fs.writeFileSync(configFile, corruptData);
      // A 0777 umask strips the requested creation mode to 0000; the backup must still
      // end up readable or recovery guidance points at an unusable file.
      const prevUmask = process.umask(0o777);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);
      try {
        config.loadConfigOrDefault();

        const [backup] = corruptBackups();
        expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(backup)).toEqual(Buffer.from(corruptData));
      } finally {
        process.umask(prevUmask);
        errorSpy.mockRestore();
      }
    });

    it("tightens permissions on a reused permissive sidecar", () => {
      if (process.platform === "win32") {
        return;
      }
      const configFile = configFilePath();
      const corruptData = '{ "projects": ';
      const prevUmask = process.umask(0o022);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);
      try {
        fs.writeFileSync(configFile, corruptData);
        // A byte-identical sidecar left by an older build without the 0600 fix.
        const stale = `${configFile}.corrupt-1`;
        fs.writeFileSync(stale, corruptData);
        fs.chmodSync(stale, 0o644);

        config.loadConfigOrDefault();

        expect(corruptBackups()).toHaveLength(1);
        expect(fs.statSync(stale).mode & 0o777).toBe(0o600);
      } finally {
        process.umask(prevUmask);
        errorSpy.mockRestore();
      }
    });

    it("reuses a later usable duplicate when the first cannot be secured", () => {
      const configFile = configFilePath();
      const corruptData = '{ "projects": ';
      fs.writeFileSync(configFile, corruptData);
      const untightenable = `${configFile}.corrupt-1`;
      const usable = `${configFile}.corrupt-2`;
      fs.writeFileSync(untightenable, corruptData);
      fs.writeFileSync(usable, corruptData);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);
      const origChmod = fs.chmodSync.bind(fs);
      const chmodSpy = spyOn(fs, "chmodSync").mockImplementation((file, mode) => {
        if (file === untightenable) {
          throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
        }
        origChmod(file, mode);
      });
      // Creating a fresh sidecar must not be needed: the usable duplicate is reused.
      const origWrite = fs.writeFileSync.bind(fs);
      const writeSpy = spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
        if (typeof file === "string" && file.includes(".corrupt-") && file !== untightenable) {
          throw new Error("unexpected sidecar creation");
        }
        origWrite(file, data, options);
      });

      config.loadConfigOrDefault();

      expect(corruptBackups().sort()).toEqual([untightenable, usable].sort());
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain(usable);
      writeSpy.mockRestore();
      chmodSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("aborts an edit write when the corrupt file changed after the edit loaded it", async () => {
      const configFile = configFilePath();
      const corruptA = '{ "projects": ';
      const corruptB = '{ "taskSettings": ';
      fs.writeFileSync(configFile, corruptA);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);

      // Simulate a concurrent writer replacing the file between this edit's load and write.
      const raceError = await config
        .editConfig((cfg) => {
          fs.writeFileSync(configFile, corruptB);
          return cfg;
        })
        .then(
          () => null,
          (e: unknown) => e
        );
      expect(String(raceError)).toContain("changed after this edit loaded it");

      // The write was skipped: B is still on disk instead of a defaults rewrite.
      expect(fs.readFileSync(configFile, "utf-8")).toBe(corruptB);

      // The next edit's own load backs up B, so it may proceed.
      await config.setUpdateChannel("nightly");
      const contents = corruptBackups().map((p) => fs.readFileSync(p, "utf-8"));
      expect(contents).toContain(corruptA);
      expect(contents).toContain(corruptB);
      const rewritten = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
        updateChannel?: unknown;
      };
      expect(rewritten.updateChannel).toBe("nightly");
      errorSpy.mockRestore();
    });

    it("dedupes repeated backup failures whose messages embed the generated path", () => {
      const configFile = configFilePath();
      fs.writeFileSync(configFile, '{ "projects": ');
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);
      const nowSpy = spyOn(Date, "now");
      const origWrite = fs.writeFileSync.bind(fs);
      const writeSpy = spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
        if (typeof file === "string" && file.includes(".corrupt-")) {
          throw Object.assign(new Error(`ENOSPC: no space left on device, open '${file}'`), {
            code: "ENOSPC",
          });
        }
        origWrite(file, data, options);
      });

      nowSpy.mockReturnValue(1000);
      config.loadConfigOrDefault();
      nowSpy.mockReturnValue(2000);
      config.loadConfigOrDefault();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      writeSpy.mockRestore();
      nowSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("logs a corrupt config once across Config instances on the same path", () => {
      const corruptData = '{ "projects": ';
      fs.writeFileSync(configFilePath(), corruptData);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);

      config.loadConfigOrDefault();
      new Config(tempDir).loadConfigOrDefault();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    });

    it("recovers from an unreadable config without creating a backup", () => {
      const configFile = configFilePath();
      // A directory at the config path makes readFileSync fail before any bytes exist.
      fs.mkdirSync(configFile);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);

      const loaded = config.loadConfigOrDefault();

      expect(loaded.projects.size).toBe(0);
      expect(corruptBackups()).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain(configFile);

      // Repeated loads of the same unreadable state stay deduped.
      config.loadConfigOrDefault();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    });
  });

  describe("loadConfigOrDefault settingsBackup sanitizing", () => {
    it("degrades a malformed settingsBackup instead of returning it", () => {
      // Reaching the IPC output validator would fail the whole settings read, so one bad field
      // would report a load failure for every unrelated setting on the screen.
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          settingsBackup: { repoUrl: "https://oauth2:hunter2@example.com/repo.git", branch: "" },
          defaultModel: "openai:gpt-4o",
        })
      );

      const loaded = config.loadConfigOrDefault();

      expect(loaded.settingsBackup).toBeUndefined();
      expect(loaded.defaultModel).toBe("openai:gpt-4o");
    });

    it("keeps a valid settingsBackup", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          settingsBackup: {
            repoUrl: "https://github.com/me/dotfiles.git",
            branch: "main",
            path: "mux",
          },
        })
      );

      expect(config.loadConfigOrDefault().settingsBackup).toMatchObject({
        repoUrl: "https://github.com/me/dotfiles.git",
        branch: "main",
        path: "mux",
      });
    });
  });

  describe("persistent sub-agent retention migration", () => {
    it.each([
      ["missing", undefined],
      ["legacy false", false],
    ] as const)("persists true when the previous setting is %s", async (_label, legacyValue) => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          taskSettings:
            legacyValue === undefined ? {} : { preserveSubagentsUntilArchive: legacyValue },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.taskSettings?.preserveSubagentsUntilArchive).toBe(true);

      await flushConfigEdits();

      const persisted = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
        taskSettings?: { preserveSubagentsUntilArchive?: boolean };
        migrations?: { persistentSubagentsDefaulted?: boolean };
      };
      expect(persisted.taskSettings?.preserveSubagentsUntilArchive).toBe(true);
      expect(persisted.migrations?.persistentSubagentsDefaulted).toBe(true);
    });

    it("canonicalizes an explicit legacy false value after the migration", async () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          taskSettings: { preserveSubagentsUntilArchive: false },
          migrations: { persistentSubagentsDefaulted: true },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.taskSettings?.preserveSubagentsUntilArchive).toBe(true);

      await flushConfigEdits();

      const persisted = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
        taskSettings?: { preserveSubagentsUntilArchive?: boolean };
      };
      expect(persisted.taskSettings?.preserveSubagentsUntilArchive).toBe(true);
    });
  });

  describe("loadConfigOrDefault with trailing slash migration", () => {
    it("should strip trailing slashes from project paths on load", () => {
      // Create config file with trailing slashes in project paths
      const configFile = path.join(tempDir, "config.json");
      const corruptedConfig = {
        projects: [
          ["/home/user/project/", { workspaces: [] }],
          ["/home/user/another//", { workspaces: [] }],
          ["/home/user/clean", { workspaces: [] }],
        ],
      };
      fs.writeFileSync(configFile, JSON.stringify(corruptedConfig));

      // Load config - should migrate paths
      const loaded = config.loadConfigOrDefault();

      // Verify paths are normalized (no trailing slashes)
      const projectPaths = Array.from(loaded.projects.keys());
      expect(projectPaths).toContain("/home/user/project");
      expect(projectPaths).toContain("/home/user/another");
      expect(projectPaths).toContain("/home/user/clean");
      expect(projectPaths).not.toContain("/home/user/project/");
      expect(projectPaths).not.toContain("/home/user/another//");
    });
  });

  describe("loadConfigOrDefault customInstructions sanitizing", () => {
    it("discards malformed non-string customInstructions and keeps valid ones", () => {
      // A malformed value must not survive load: it would fail the
      // projects.list z.string() output schema and brick the project list.
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            ["/home/user/number", { workspaces: [], customInstructions: 42 }],
            ["/home/user/object", { workspaces: [], customInstructions: { nested: true } }],
            ["/home/user/blank", { workspaces: [], customInstructions: "   " }],
            ["/home/user/valid", { workspaces: [], customInstructions: "Keep this guidance." }],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();

      expect(loaded.projects.get("/home/user/number")?.customInstructions).toBeUndefined();
      expect(loaded.projects.get("/home/user/object")?.customInstructions).toBeUndefined();
      expect(loaded.projects.get("/home/user/blank")?.customInstructions).toBeUndefined();
      expect(loaded.projects.get("/home/user/valid")?.customInstructions).toBe(
        "Keep this guidance."
      );
    });
  });

  describe("legacy workflow schedule cleanup", () => {
    it("drops named workflow schedule config while loading", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              "/repo",
              {
                workflowSchedules: [
                  {
                    id: "legacy-project-schedule",
                    enabled: true,
                    workflowName: "old-workflow",
                    intervalMs: 300_000,
                    target: { type: "new-workspace", trunkBranch: "main" },
                  },
                ],
                workspaces: [
                  {
                    path: "/repo/workspace",
                    id: "workspace-1",
                    name: "workspace",
                    workflowSchedule: {
                      enabled: true,
                      workflowName: "old-workflow",
                      intervalMs: 300_000,
                    },
                  },
                ],
              },
            ],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();
      const project = loaded.projects.get("/repo") as Record<string, unknown> | undefined;
      const workspaces = project?.workspaces;
      const workspace = Array.isArray(workspaces)
        ? (workspaces[0] as Record<string, unknown> | undefined)
        : undefined;

      expect(project?.workflowSchedules).toBeUndefined();
      expect(workspace?.workflowSchedule).toBeUndefined();
    });
  });

  describe("editConfig", () => {
    it("serializes concurrent edits so no update is lost", async () => {
      // Regression: editConfig used to be a non-serialized read-modify-write
      // (load → mutate → async save). Two concurrent edits could both load the
      // same snapshot, and the later write clobbered the earlier one. TaskService
      // launches tasks in parallel and flips each task's status via editConfig,
      // so a lost update left tasks stuck in "starting" (flaky
      // "resumes accepted queued starts instead of replaying prompts").
      await config.editConfig((cfg) => {
        cfg.projects.set("/repo", {
          workspaces: [
            { path: "/repo/a", id: "aaaaaaaaaa", name: "a", taskStatus: "starting" },
            { path: "/repo/b", id: "bbbbbbbbbb", name: "b", taskStatus: "starting" },
          ],
        });
        return cfg;
      });

      const setStatus = (id: string) =>
        config.editConfig((cfg) => {
          const ws = cfg.projects.get("/repo")?.workspaces.find((w) => w.id === id);
          if (ws) ws.taskStatus = "running";
          return cfg;
        });

      // Fire both edits without awaiting in between, mirroring parallel task launches.
      await Promise.all([setStatus("aaaaaaaaaa"), setStatus("bbbbbbbbbb")]);

      const workspaces = new Config(tempDir)
        .loadConfigOrDefault()
        .projects.get("/repo")?.workspaces;
      expect(workspaces?.map((w) => w.taskStatus)).toEqual(["running", "running"]);
    });
  });

  describe("workspace tags", () => {
    it("persists programmatic tags through save/load and metadata mapping", async () => {
      await config.editConfig((cfg) => {
        cfg.projects.set("/repo", {
          workspaces: [
            {
              path: "/repo/tagged",
              id: "tagged-ws-1",
              name: "tagged",
              tags: { workItemKey: "issue-1-investigate" },
            },
          ],
        });
        return cfg;
      });

      // Fresh instance: prove tags survive the disk round-trip (config
      // serialization + workspace schema + metadata mapping), not just memory.
      const metadata = await new Config(tempDir).getAllWorkspaceMetadata();
      const tagged = metadata.find((m) => m.id === "tagged-ws-1");
      expect(tagged?.tags).toEqual({ workItemKey: "issue-1-investigate" });
    });
  });

  describe("legacy task variant compatibility", () => {
    it("loads variant children as ordinary sub-agents without destroying downgrade metadata", async () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              "/repo",
              {
                workspaces: [
                  {
                    path: "/repo/legacy-variant",
                    id: "legacy-variant",
                    name: "legacy-variant",
                    parentWorkspaceId: "parent",
                    bestOf: {
                      groupId: "legacy-variant-group",
                      index: 0,
                      total: 2,
                      kind: "variants",
                      label: "frontend",
                    },
                  },
                  {
                    path: "/repo/best-of",
                    id: "best-of",
                    name: "best-of",
                    parentWorkspaceId: "parent",
                    bestOf: { groupId: "best-of-group", index: 0, total: 2 },
                  },
                ],
              },
            ],
          ],
        })
      );

      const workspaces = config.loadConfigOrDefault().projects.get("/repo")?.workspaces;
      expect(
        workspaces?.find((workspace) => workspace.id === "legacy-variant")?.bestOf
      ).toBeUndefined();
      expect(workspaces?.find((workspace) => workspace.id === "best-of")?.bestOf).toEqual({
        groupId: "best-of-group",
        index: 0,
        total: 2,
      });

      await flushConfigEdits();
      const persisted = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
        projects?: Array<
          [
            string,
            {
              workspaces?: Array<{
                id?: string;
                bestOf?: {
                  groupId?: string;
                  index?: number;
                  total?: number;
                  kind?: string;
                  label?: string;
                };
              }>;
            },
          ]
        >;
      };
      const persistedWorkspaces = persisted.projects?.[0]?.[1].workspaces;
      expect(
        persistedWorkspaces?.find((workspace) => workspace.id === "legacy-variant")?.bestOf
      ).toEqual({
        groupId: "legacy-variant-group",
        index: 0,
        total: 2,
        kind: "variants",
        label: "frontend",
      });
      expect(
        persistedWorkspaces?.find((workspace) => workspace.id === "best-of")?.bestOf?.groupId
      ).toBe("best-of-group");
    });

    it("drops variant grouping read from legacy metadata.json", async () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [["/repo", { workspaces: [{ path: "/repo/legacy" }] }]],
        })
      );
      const sessionDir = path.join(tempDir, "sessions", "repo-legacy");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "metadata.json"),
        JSON.stringify({
          id: "legacy-child",
          name: "legacy",
          projectName: "repo",
          projectPath: "/repo",
          parentWorkspaceId: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          bestOf: {
            groupId: "legacy-variant-group",
            index: 0,
            total: 2,
            kind: "variants",
            label: "frontend",
          },
        })
      );

      const metadata = await config.getAllWorkspaceMetadata();
      expect(metadata).toHaveLength(1);
      expect(metadata[0]?.parentWorkspaceId).toBe("parent");
      expect(metadata[0]?.bestOf).toBeUndefined();

      await flushConfigEdits();
      const persisted = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        projects?: Array<
          [
            string,
            { workspaces?: Array<{ id?: string; bestOf?: { kind?: string; label?: string } }> },
          ]
        >;
      };
      const persistedWorkspace = persisted.projects?.[0]?.[1].workspaces?.find(
        (workspace) => workspace.id === "legacy-child"
      );
      expect(persistedWorkspace?.bestOf).toMatchObject({
        kind: "variants",
        label: "frontend",
      });
    });
  });

  describe("legacy workspace migration identity", () => {
    // Regression (PR #3694 Codex P2): the queued ??= migration preserves values already
    // persisted in config. Returned metadata must use those same values — returning a
    // generated legacyId for a partially-migrated entry (id present, name missing) hands
    // the UI an ID that findWorkspace cannot resolve until the next reload.
    it("returns the persisted id for a partially-migrated entry and persists the same value", async () => {
      await config.editConfig((cfg) => {
        cfg.projects.set("/repo", {
          workspaces: [
            // id present, name missing -> legacy fallback path (no metadata.json on disk).
            { path: "/repo/partial", id: "persisted-id-1" },
          ],
        });
        return cfg;
      });

      const metadata = await new Config(tempDir).getAllWorkspaceMetadata();
      expect(metadata).toHaveLength(1);
      expect(metadata[0]?.id).toBe("persisted-id-1");

      // The migration must persist exactly what was returned.
      const persisted = new Config(tempDir).loadConfigOrDefault().projects.get("/repo")
        ?.workspaces[0];
      expect(persisted?.id).toBe("persisted-id-1");
      expect(persisted?.name).toBe(metadata[0]?.name);
    });

    // Regression (PR #3694 Codex P2): paths are reusable after deletion. A queued
    // migration replay recorded for a legacy entry must not apply the old workspace's
    // settings to a replacement workspace created at the same path while the replay
    // waited in the editConfig queue.
    it("does not retarget queued migrations onto a replacement workspace at the same path", async () => {
      const sharedPath = "/repo/reused";
      const staleHeartbeat = { enabled: true, intervalMs: 45 * 60 * 1000 };
      await config.editConfig((cfg) => {
        cfg.projects.set("/repo", {
          // Legacy entry (no id/name) with settings the migration would carry over.
          workspaces: [
            { path: sharedPath, aiSettings: { model: "old:model", thinkingLevel: "medium" } },
          ],
        });
        return cfg;
      });

      // Enqueue remove+recreate FIFO-ahead of getAllWorkspaceMetadata's queued replay:
      // its snapshot read (sync) sees the legacy entry, but by the time its editConfig
      // transform runs, the path belongs to a NEW workspace with a different id.
      const loader = new Config(tempDir);
      const removal = loader.editConfig((cfg) => {
        cfg.projects.set("/repo", { workspaces: [] });
        return cfg;
      });
      const recreate = loader.editConfig((cfg) => {
        cfg.projects.get("/repo")?.workspaces.push({
          id: "replacement-id",
          name: "replacement",
          path: sharedPath,
          heartbeat: staleHeartbeat,
        });
        return cfg;
      });
      await loader.getAllWorkspaceMetadata();
      await Promise.all([removal, recreate]);

      const persisted = new Config(tempDir).loadConfigOrDefault().projects.get("/repo")?.workspaces;
      expect(persisted).toHaveLength(1);
      const replacement = persisted?.[0];
      // The replacement keeps its own identity and never inherits the legacy entry's
      // migrated defaults: pre-fix the path-only replay match filled the replacement's
      // missing createdAt/runtimeConfig from the removed legacy workspace's migration.
      expect(replacement?.id).toBe("replacement-id");
      expect(replacement?.name).toBe("replacement");
      expect(replacement?.createdAt).toBeUndefined();
      expect(replacement?.runtimeConfig).toBeUndefined();
      expect(replacement?.heartbeat).toEqual(staleHeartbeat);
    });

    it("returns the persisted name for an entry missing only an id", async () => {
      await config.editConfig((cfg) => {
        cfg.projects.set("/repo", {
          workspaces: [{ path: "/repo/named", name: "persisted-name" }],
        });
        return cfg;
      });

      const metadata = await new Config(tempDir).getAllWorkspaceMetadata();
      expect(metadata).toHaveLength(1);
      expect(metadata[0]?.name).toBe("persisted-name");

      const persisted = new Config(tempDir).loadConfigOrDefault().projects.get("/repo")
        ?.workspaces[0];
      expect(persisted?.name).toBe("persisted-name");
      expect(persisted?.id).toBe(metadata[0]?.id);
    });
  });

  describe("userPreferences", () => {
    it("loads and saves user preferences", async () => {
      await config.editConfig((cfg) => ({
        ...cfg,
        userPreferences: {
          appearance: { theme: "dark" },
          navigation: { projectOrder: ["/repo"] },
        },
      }));

      const restartedConfig = new Config(tempDir);
      expect(restartedConfig.loadConfigOrDefault().userPreferences).toEqual({
        appearance: { theme: "dark" },
        navigation: { projectOrder: ["/repo"] },
      });

      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        migrations?: { userPreferencesInitialized?: unknown };
        userPreferences?: unknown;
      };
      expect(raw.migrations?.userPreferencesInitialized).toBe(true);
      expect(raw.userPreferences).toEqual({
        appearance: { theme: "dark" },
        navigation: { projectOrder: ["/repo"] },
      });
    });

    it("preserves user preferences during unrelated saves", async () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          userPreferences: {
            appearance: { theme: "flexoki-dark" },
          },
        })
      );

      await config.editConfig((cfg) => ({
        ...cfg,
        llmDebugLogs: true,
      }));

      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        userPreferences?: unknown;
        llmDebugLogs?: unknown;
      };
      expect(raw.userPreferences).toEqual({ appearance: { theme: "flexoki-dark" } });
      expect(raw.llmDebugLogs).toBe(true);
    });

    it("treats existing user preferences as initialized for cross-origin sync", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          userPreferences: {
            appearance: { theme: "flexoki-dark" },
          },
        })
      );

      expect(config.loadConfigOrDefault().migrations?.userPreferencesInitialized).toBe(true);
    });

    it("normalizes invalid user preference values on load", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          userPreferences: {
            appearance: { theme: "legacy-light", transcriptDensity: "wide" },
            notifications: { notifyOnResponseByWorkspace: { "ws-1": true, "ws-2": "yes" } },
          },
        })
      );

      expect(config.loadConfigOrDefault().userPreferences).toEqual({
        appearance: { theme: "light" },
        notifications: { notifyOnResponseByWorkspace: { "ws-1": true } },
      });
    });
  });

  describe("chat transcript settings", () => {
    it("persists the full-width transcript flag", async () => {
      await config.editConfig((cfg) => {
        cfg.chatTranscriptFullWidth = true;
        return cfg;
      });

      const restartedConfig = new Config(tempDir);
      expect(restartedConfig.loadConfigOrDefault().chatTranscriptFullWidth).toBe(true);

      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        chatTranscriptFullWidth?: unknown;
      };
      expect(raw.chatTranscriptFullWidth).toBe(true);
    });

    it("omits the full-width transcript flag when disabled", async () => {
      await config.editConfig((cfg) => {
        cfg.chatTranscriptFullWidth = false;
        return cfg;
      });

      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        chatTranscriptFullWidth?: unknown;
      };
      expect(raw.chatTranscriptFullWidth).toBeUndefined();
    });

    it("ignores invalid full-width transcript values on load", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          chatTranscriptFullWidth: "yes",
        })
      );

      expect(config.loadConfigOrDefault().chatTranscriptFullWidth).toBeUndefined();
    });
  });

  describe("api server settings", () => {
    it("should persist apiServerBindHost, apiServerPort, and apiServerServeWebUi", async () => {
      await config.editConfig((cfg) => {
        cfg.apiServerBindHost = "0.0.0.0";
        cfg.apiServerPort = 3000;
        cfg.apiServerServeWebUi = true;
        return cfg;
      });

      const loaded = config.loadConfigOrDefault();
      expect(loaded.apiServerBindHost).toBe("0.0.0.0");
      expect(loaded.apiServerPort).toBe(3000);
      expect(loaded.apiServerServeWebUi).toBe(true);
    });

    it("should ignore invalid apiServerPort values on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          apiServerPort: 70000,
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.apiServerPort).toBeUndefined();
    });
  });

  describe("projectKind normalization", () => {
    it("normalizes unknown projectKind to user semantics on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [["/repo", { workspaces: [], projectKind: "experimental" }]],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.get("/repo")?.projectKind).toBeUndefined();
    });

    it("preserves valid projectKind 'system' on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [["/repo", { workspaces: [], projectKind: "system" }]],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.get("/repo")?.projectKind).toBe("system");
    });
  });

  describe("legacy Chat with Mux cleanup", () => {
    const shippedProjectPath = "/home/user/.mux/system/Mux";
    const xumProjectPath = "/home/user/.xum/system/Xum";

    function shippedMuxChatWorkspace(projectPath: string) {
      return {
        path: projectPath,
        id: "mux-chat",
        name: "chat-with-mux",
        title: "Chat with Mux",
        agentId: "mux",
      };
    }

    function xumGenerationChatWorkspace(projectPath: string) {
      return {
        path: projectPath,
        id: "mux-chat",
        name: "chat-with-xum",
        title: "Chat with Xum",
        agentId: "xum",
      };
    }

    it("removes the shipped system Mux project and persists the cleanup", async () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              shippedProjectPath,
              {
                workspaces: [shippedMuxChatWorkspace(shippedProjectPath)],
                projectKind: "system",
              },
            ],
            ["/repo", { workspaces: [] }],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.has(shippedProjectPath)).toBe(false);
      expect(loaded.projects.has("/repo")).toBe(true);

      await flushConfigEdits();
      const persisted = fs.readFileSync(configFile, "utf-8");
      expect(persisted).not.toContain("mux-chat");
    });

    it("removes later xum-branded leftovers as well", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              xumProjectPath,
              {
                workspaces: [xumGenerationChatWorkspace(xumProjectPath)],
                projectKind: "system",
              },
            ],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.has(xumProjectPath)).toBe(false);
    });

    it("removes stale entries left under other mux roots", () => {
      const staleProjectPath = "/home/user/.mux-dev/system/Mux";
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              shippedProjectPath,
              { workspaces: [shippedMuxChatWorkspace(shippedProjectPath)], projectKind: "system" },
            ],
            [
              staleProjectPath,
              { workspaces: [shippedMuxChatWorkspace(staleProjectPath)], projectKind: "system" },
            ],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.size).toBe(0);
    });

    it("keeps unrelated workspaces whose id collides with mux-chat", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              "/home/user/mux",
              {
                workspaces: [{ path: "/home/user/mux-chat", id: "mux-chat", name: "chat" }],
              },
            ],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.get("/home/user/mux")?.workspaces).toHaveLength(1);
    });

    it("removes entries already merged into an ancestor project via subProjectPath", () => {
      // An earlier load's subproject merge relocated mux-chat into the
      // registered ~/.mux parent and left the system/Mux child empty.
      const parentProjectPath = "/home/user/.mux";
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              parentProjectPath,
              {
                workspaces: [
                  {
                    ...shippedMuxChatWorkspace(shippedProjectPath),
                    subProjectPath: shippedProjectPath,
                  },
                  { path: "/home/user/.mux/other", id: "other-ws", name: "other" },
                ],
              },
            ],
            [shippedProjectPath, { workspaces: [], projectKind: "system" }],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.get(parentProjectPath)?.workspaces.map((w) => w.id)).toEqual([
        "other-ws",
      ]);
      expect(loaded.projects.has(shippedProjectPath)).toBe(false);
    });

    it("survives a corrupted non-string subProjectPath on a mux-chat record", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              "/home/user/repo",
              {
                workspaces: [
                  { path: "/home/user/repo/ws", id: "mux-chat", name: "chat", subProjectPath: 42 },
                ],
              },
            ],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.get("/home/user/repo")?.workspaces).toHaveLength(1);
    });

    it("keeps other workspaces in a system Mux project and retains the project", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              shippedProjectPath,
              {
                workspaces: [
                  shippedMuxChatWorkspace(shippedProjectPath),
                  { path: "/home/user/other", id: "other-ws", name: "other" },
                ],
                projectKind: "system",
              },
            ],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();
      const workspaces = loaded.projects.get(shippedProjectPath)?.workspaces;
      expect(workspaces?.map((w) => w.id)).toEqual(["other-ws"]);
    });

    it("keeps a Mux-named project that is not the hidden system leftover", () => {
      const userMuxProjectPath = "/home/user/code/Mux";
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              userMuxProjectPath,
              {
                workspaces: [
                  {
                    path: userMuxProjectPath,
                    id: "mux-chat",
                    name: "chat-with-mux",
                    title: "Chat with Mux",
                    agentId: "mux",
                  },
                ],
              },
            ],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.get(userMuxProjectPath)?.workspaces).toHaveLength(1);
    });
  });

  describe("modelFallbacks normalization", () => {
    it("self-heals malformed modelFallbacks on load instead of breaking sends", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          // Keep this test focused on normalization, not default seeding.
          migrations: { defaultModelFallbacksSeeded: true },
          modelFallbacks: {
            // Gateway-prefixed key + non-string chain entries + unknown trigger.
            "openrouter:anthropic/claude-opus-4-6": {
              models: [42, null, "openai:gpt-5.5", { nested: true }],
              triggers: ["future_trigger", 7],
            },
            // models is not an array: entry dropped entirely.
            "openai:gpt-5.5": { models: "openai:gpt-5.5-codex" },
            // Chain empties after dropping the self-fallback: entry dropped.
            "google:gemini-3-pro": { models: ["google:gemini-3-pro"] },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.modelFallbacks).toEqual({
        "anthropic:claude-opus-4-6": {
          models: ["openai:gpt-5.5"],
          // Unknown triggers are dropped rather than coerced into refusal
          // triggers. The surviving empty list intentionally disables the
          // chain (it no longer fires on model_refusal).
          triggers: [],
        },
      });
    });
  });

  describe("default model fallbacks seeding", () => {
    const FABLE = KNOWN_MODELS.FABLE.id;
    const OPUS = KNOWN_MODELS.OPUS.id;
    const configFilePath = () => path.join(tempDir, "config.json");

    it("seeds the default chain once on first load and persists the migration flag", async () => {
      fs.writeFileSync(configFilePath(), JSON.stringify({ projects: [] }));

      const loaded = config.loadConfigOrDefault();
      expect(loaded.modelFallbacks).toEqual({ [FABLE]: { models: [OPUS] } });
      expect(loaded.migrations?.defaultModelFallbacksSeeded).toBe(true);

      // Seed is written back so the flag survives restarts even without saves.
      await flushConfigEdits();
      const raw = JSON.parse(fs.readFileSync(configFilePath(), "utf-8")) as {
        modelFallbacks?: unknown;
        migrations?: { defaultModelFallbacksSeeded?: unknown };
      };
      expect(raw.modelFallbacks).toEqual({ [FABLE]: { models: [OPUS] } });
      expect(raw.migrations?.defaultModelFallbacksSeeded).toBe(true);
    });

    it("does not re-seed after the user deletes the default chain", () => {
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({
          projects: [],
          migrations: { defaultModelFallbacksSeeded: true },
        })
      );

      expect(config.loadConfigOrDefault().modelFallbacks).toBeUndefined();
    });

    it("merges the seeded default with pre-existing chains for other source models", async () => {
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({
          projects: [],
          modelFallbacks: {
            "anthropic:claude-opus-4-6": { models: ["openai:gpt-5.5"] },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.modelFallbacks).toEqual({
        "anthropic:claude-opus-4-6": { models: ["openai:gpt-5.5"] },
        [FABLE]: { models: [OPUS] },
      });

      // The user's chain must survive the seed write-back on disk unchanged.
      await flushConfigEdits();
      const raw = JSON.parse(fs.readFileSync(configFilePath(), "utf-8")) as {
        modelFallbacks?: unknown;
        migrations?: { defaultModelFallbacksSeeded?: unknown };
      };
      expect(raw.modelFallbacks).toEqual({
        "anthropic:claude-opus-4-6": { models: ["openai:gpt-5.5"] },
        [FABLE]: { models: [OPUS] },
      });
      expect(raw.migrations?.defaultModelFallbacksSeeded).toBe(true);
    });

    it("does not double-seed when the user chain uses a gateway-prefixed Fable key", () => {
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({
          projects: [],
          modelFallbacks: {
            "openrouter:anthropic/claude-fable-5": { models: ["openai:gpt-5.5"] },
          },
        })
      );

      // The gateway-prefixed key canonicalizes to the same source model, so
      // the seed must treat it as configured and leave the user's chain alone.
      expect(config.loadConfigOrDefault().modelFallbacks).toEqual({
        [FABLE]: { models: ["openai:gpt-5.5"] },
      });
    });

    it("respects a hand-edited tombstone whose chain sanitizes away", () => {
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({
          projects: [],
          modelFallbacks: {
            [FABLE]: { enabled: false, models: [] },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      // The entry sanitizes to nothing at runtime (no fallback fires), but it
      // is still user intent: the seed must not replace it with an enabled
      // default chain, and the raw on-disk form must survive.
      expect(loaded.modelFallbacks).toBeUndefined();
      expect(loaded.migrations?.defaultModelFallbacksSeeded).toBe(true);

      const raw = JSON.parse(fs.readFileSync(configFilePath(), "utf-8")) as {
        modelFallbacks?: unknown;
      };
      expect(raw.modelFallbacks).toEqual({ [FABLE]: { enabled: false, models: [] } });
    });

    it("preserves unknown migration flags from newer app versions across saves", async () => {
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({
          projects: [],
          migrations: { defaultModelFallbacksSeeded: true, futureFlag: true },
        })
      );

      await config.editConfig((cfg) => cfg);

      // A downgrade to this version + save must not strip flags it does not
      // know, or the corresponding one-time migrations re-run on re-upgrade.
      const raw = JSON.parse(fs.readFileSync(configFilePath(), "utf-8")) as {
        migrations?: Record<string, unknown>;
      };
      expect(raw.migrations?.futureFlag).toBe(true);
      expect(raw.migrations?.defaultModelFallbacksSeeded).toBe(true);
    });

    it("preserves a pre-existing user chain for the seeded source model", () => {
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({
          projects: [],
          modelFallbacks: {
            [FABLE]: { enabled: false, models: ["openai:gpt-5.5"] },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.modelFallbacks).toEqual({
        [FABLE]: { enabled: false, models: ["openai:gpt-5.5"] },
      });
      expect(loaded.migrations?.defaultModelFallbacksSeeded).toBe(true);
    });

    it("applies the defaults to fresh installs and locks the flag on first save", async () => {
      expect(config.loadConfigOrDefault().modelFallbacks).toEqual({
        [FABLE]: { models: [OPUS] },
      });

      await config.editConfig((cfg) => cfg);

      const raw = JSON.parse(fs.readFileSync(configFilePath(), "utf-8")) as {
        modelFallbacks?: unknown;
        migrations?: { defaultModelFallbacksSeeded?: unknown };
      };
      expect(raw.modelFallbacks).toEqual({ [FABLE]: { models: [OPUS] } });
      expect(raw.migrations?.defaultModelFallbacksSeeded).toBe(true);
    });
  });

  describe("update channel preference", () => {
    it("defaults to stable when no channel is configured", () => {
      expect(config.getUpdateChannel()).toBe("stable");
    });

    it("persists nightly channel selection", async () => {
      await config.setUpdateChannel("nightly");

      const restartedConfig = new Config(tempDir);
      expect(restartedConfig.getUpdateChannel()).toBe("nightly");

      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        updateChannel?: unknown;
      };
      expect(raw.updateChannel).toBe("nightly");
    });

    it("persists explicit stable channel selection", async () => {
      await config.setUpdateChannel("nightly");
      await config.setUpdateChannel("stable");

      const restartedConfig = new Config(tempDir);
      expect(restartedConfig.getUpdateChannel()).toBe("stable");

      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        updateChannel?: unknown;
      };
      expect(raw.updateChannel).toBe("stable");
    });
  });

  describe("server GitHub owner auth setting", () => {
    it("persists serverAuthGithubOwner", async () => {
      await config.editConfig((cfg) => {
        cfg.serverAuthGithubOwner = "octocat";
        return cfg;
      });

      const loaded = config.loadConfigOrDefault();
      expect(loaded.serverAuthGithubOwner).toBe("octocat");
      expect(config.getServerAuthGithubOwner()).toBe("octocat");
    });

    it("ignores empty serverAuthGithubOwner values on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          serverAuthGithubOwner: "   ",
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.serverAuthGithubOwner).toBeUndefined();
    });
  });

  describe("top-level settings loading", () => {
    it("loads top-level settings even when projects is missing", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          muxGovernorUrl: "https://governor.example.com",
          terminalDefaultShell: "zsh",
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.size).toBe(0);
      expect(loaded.muxGovernorUrl).toBe("https://governor.example.com");
      expect(loaded.terminalDefaultShell).toBe("zsh");
    });

    it("round-trips the legacy 1Password account name across unrelated saves", async () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({ onePasswordAccountName: "my-team.1password.com" })
      );

      await config.editConfig((current) => ({
        ...current,
        terminalDefaultShell: "zsh",
      }));

      const raw = JSON.parse(fs.readFileSync(configFile, "utf-8")) as Record<string, unknown>;
      expect(raw.onePasswordAccountName).toBe("my-team.1password.com");
      expect(raw.terminalDefaultShell).toBe("zsh");
    });
  });

  describe("coderWorkspaceArchiveBehavior", () => {
    const readRawArchiveConfig = () =>
      JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        coderWorkspaceArchiveBehavior?: unknown;
        stopCoderWorkspaceOnArchive?: unknown;
        terminalDefaultShell?: unknown;
      };

    const legacyBooleanForBehavior = (behavior: string): false | undefined =>
      behavior === "keep" ? false : undefined;

    for (const behavior of CODER_ARCHIVE_BEHAVIORS) {
      it(`loads the new enum value ${behavior}`, () => {
        fs.writeFileSync(
          path.join(tempDir, "config.json"),
          JSON.stringify({
            projects: [],
            coderWorkspaceArchiveBehavior: behavior,
          })
        );

        const loaded = config.loadConfigOrDefault();
        expect(loaded.coderWorkspaceArchiveBehavior).toBe(behavior);
        expect(loaded.stopCoderWorkspaceOnArchive).toBe(legacyBooleanForBehavior(behavior));
      });
    }

    it("resolves legacy false to keep when the enum is missing", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          stopCoderWorkspaceOnArchive: false,
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.coderWorkspaceArchiveBehavior).toBe("keep");
      expect(loaded.stopCoderWorkspaceOnArchive).toBe(false);
    });

    it("resolves legacy true or undefined to stop when the enum is missing", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          stopCoderWorkspaceOnArchive: true,
        })
      );
      expect(config.loadConfigOrDefault().coderWorkspaceArchiveBehavior).toBe(
        DEFAULT_CODER_ARCHIVE_BEHAVIOR
      );

      fs.writeFileSync(path.join(tempDir, "config.json"), JSON.stringify({ projects: [] }));
      expect(config.loadConfigOrDefault().coderWorkspaceArchiveBehavior).toBe(
        DEFAULT_CODER_ARCHIVE_BEHAVIOR
      );
    });

    it("prefers the new enum when both fields are present", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          coderWorkspaceArchiveBehavior: "delete",
          stopCoderWorkspaceOnArchive: false,
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.coderWorkspaceArchiveBehavior).toBe("delete");
      expect(loaded.stopCoderWorkspaceOnArchive).toBeUndefined();
    });

    it("falls back to stop when the enum value is invalid", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          coderWorkspaceArchiveBehavior: "hibernate",
          terminalDefaultShell: "zsh",
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.coderWorkspaceArchiveBehavior).toBe(DEFAULT_CODER_ARCHIVE_BEHAVIOR);
      expect(loaded.stopCoderWorkspaceOnArchive).toBeUndefined();
      expect(loaded.terminalDefaultShell).toBe("zsh");
    });

    it("enum field takes precedence over legacy boolean on save", async () => {
      // Simulate: user had "keep" (legacy false), then switches to "stop" via the new enum.
      await config.editConfig((c) => ({
        ...c,
        coderWorkspaceArchiveBehavior: "stop",
        stopCoderWorkspaceOnArchive: false,
      }));

      const loaded = config.loadConfigOrDefault();
      expect(loaded.coderWorkspaceArchiveBehavior).toBe("stop");
    });

    it("round-trips each behavior with the enum field and legacy shim", async () => {
      for (const behavior of CODER_ARCHIVE_BEHAVIORS) {
        await config.editConfig((cfg) => {
          cfg.coderWorkspaceArchiveBehavior = behavior;
          cfg.stopCoderWorkspaceOnArchive = legacyBooleanForBehavior(behavior);
          return cfg;
        });

        const raw = readRawArchiveConfig();
        expect(raw.coderWorkspaceArchiveBehavior).toBe(behavior);
        expect(raw.stopCoderWorkspaceOnArchive).toBe(legacyBooleanForBehavior(behavior));

        const reloaded = new Config(tempDir).loadConfigOrDefault();
        expect(reloaded.coderWorkspaceArchiveBehavior).toBe(behavior);
        expect(reloaded.stopCoderWorkspaceOnArchive).toBe(legacyBooleanForBehavior(behavior));
      }
    });
  });

  describe("worktreeArchiveBehavior", () => {
    const readRawArchiveConfig = () =>
      JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        worktreeArchiveBehavior?: unknown;
        deleteWorktreeOnArchive?: unknown;
      };

    for (const behavior of WORKTREE_ARCHIVE_BEHAVIORS) {
      it(`loads the new enum value ${behavior}`, () => {
        fs.writeFileSync(
          path.join(tempDir, "config.json"),
          JSON.stringify({
            projects: [],
            worktreeArchiveBehavior: behavior,
          })
        );

        const loaded = config.loadConfigOrDefault();
        expect(loaded.worktreeArchiveBehavior).toBe(behavior);
        expect(loaded.deleteWorktreeOnArchive).toBe(behavior === "delete");
      });
    }

    it("resolves legacy delete boolean when the enum is missing", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          deleteWorktreeOnArchive: true,
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.worktreeArchiveBehavior).toBe("delete");
      expect(loaded.deleteWorktreeOnArchive).toBe(true);
    });

    it("defaults to keep when the enum is missing and the legacy boolean is false/undefined", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          deleteWorktreeOnArchive: false,
        })
      );
      expect(config.loadConfigOrDefault().worktreeArchiveBehavior).toBe(
        DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR
      );

      fs.writeFileSync(path.join(tempDir, "config.json"), JSON.stringify({ projects: [] }));
      expect(config.loadConfigOrDefault().worktreeArchiveBehavior).toBe(
        DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR
      );
    });

    it("round-trips each behavior with the enum field and legacy shim", async () => {
      for (const behavior of WORKTREE_ARCHIVE_BEHAVIORS) {
        await config.editConfig((cfg) => {
          cfg.worktreeArchiveBehavior = behavior;
          cfg.deleteWorktreeOnArchive = behavior === "delete";
          return cfg;
        });

        const raw = readRawArchiveConfig();
        expect(raw.worktreeArchiveBehavior).toBe(behavior);
        expect(raw.deleteWorktreeOnArchive).toBe(behavior === "delete");

        const reloaded = new Config(tempDir).loadConfigOrDefault();
        expect(reloaded.worktreeArchiveBehavior).toBe(behavior);
        expect(reloaded.deleteWorktreeOnArchive).toBe(behavior === "delete");
      }
    });
  });

  describe("model preferences", () => {
    it("should preserve explicit gateway-scoped defaultModel and hiddenModels", async () => {
      await config.editConfig((cfg) => {
        cfg.defaultModel = "mux-gateway:openai/gpt-4o";
        cfg.hiddenModels = [
          " mux-gateway:openai/gpt-4o-mini ",
          "invalid-model",
          "openai:gpt-4o-mini",
        ];
        return cfg;
      });

      const loaded = config.loadConfigOrDefault();
      expect(loaded.defaultModel).toBe("mux-gateway:openai/gpt-4o");
      expect(loaded.hiddenModels).toEqual(["mux-gateway:openai/gpt-4o-mini", "openai:gpt-4o-mini"]);
    });

    it("preserves explicit gateway-prefixed model strings on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          defaultModel: "mux-gateway:openai/gpt-4o",
          hiddenModels: ["mux-gateway:openai/gpt-4o-mini"],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.defaultModel).toBe("mux-gateway:openai/gpt-4o");
      expect(loaded.hiddenModels).toEqual(["mux-gateway:openai/gpt-4o-mini"]);
    });

    it("rejects malformed mux-gateway model strings on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          defaultModel: "mux-gateway:openai", // missing "/model"
          hiddenModels: ["mux-gateway:openai", "openai:gpt-4o-mini"],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.defaultModel).toBeUndefined();
      expect(loaded.hiddenModels).toEqual(["openai:gpt-4o-mini"]);
    });

    it("ignores invalid model preference values on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          defaultModel: "gpt-4o", // missing provider
          hiddenModels: ["openai:gpt-4o-mini", "bad"],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.defaultModel).toBeUndefined();
      expect(loaded.hiddenModels).toEqual(["openai:gpt-4o-mini"]);
    });
  });

  describe("agent AI defaults canonical shape", () => {
    it("preserves explicit gateway-scoped model strings in nested AI defaults", async () => {
      await config.editConfig((cfg) => {
        cfg.agentAiDefaults = {
          exec: { modelString: " openrouter:openai/gpt-5 ", thinkingLevel: "high" },
          worker: {
            modelString: " mux-gateway:anthropic/claude-haiku-4-5 ",
            thinkingLevel: "low",
          },
        };
        return cfg;
      });

      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        agentAiDefaults?: Record<string, { modelString?: string; thinkingLevel?: string }>;
        subagentAiDefaults?: Record<string, { modelString?: string; thinkingLevel?: string }>;
      };

      expect(raw.agentAiDefaults).toEqual({
        exec: { modelString: "openrouter:openai/gpt-5", thinkingLevel: "high" },
        worker: {
          modelString: "mux-gateway:anthropic/claude-haiku-4-5",
          thinkingLevel: "low",
        },
      });
      // Downgrade projection mirrors the effective delegated profile for
      // non-built-in agents so old builds keep resolving delegated runs.
      expect(raw.subagentAiDefaults).toEqual({
        worker: {
          modelString: "mux-gateway:anthropic/claude-haiku-4-5",
          thinkingLevel: "low",
        },
      });

      const loaded = config.loadConfigOrDefault();
      expect(loaded.agentAiDefaults?.exec?.modelString).toBe("openrouter:openai/gpt-5");
      expect(loaded.agentAiDefaults?.worker?.modelString).toBe(
        "mux-gateway:anthropic/claude-haiku-4-5"
      );
      // The mirrored projection folds back into nothing: equal delegated
      // fields are pruned rather than frozen as overrides.
      expect(loaded.agentAiDefaults?.worker?.subagent).toBeUndefined();
    });

    it("folds mirrored legacy subagent entries away on load", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          agentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
          },
          subagentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
            worker: { modelString: "openai:gpt-5.2" },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.agentAiDefaults?.exec?.subagent).toBeUndefined();
      // Legacy-only delegated data stays a delegated override; it is not
      // promoted to the interactive profile.
      expect(loaded.agentAiDefaults?.worker?.modelString).toBeUndefined();
      expect(loaded.agentAiDefaults?.worker?.subagent).toEqual({
        modelString: "openai:gpt-5.2",
      });
    });

    it("preserves session usage cache when loading a legacy dual-map config", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          agentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
          },
          subagentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
            worker: { modelString: "openai:gpt-5.2" },
          },
        })
      );

      const usagePath = path.join(config.getSessionDir("workspace-1"), "session-usage.json");
      fs.mkdirSync(path.dirname(usagePath), { recursive: true });
      fs.writeFileSync(usagePath, JSON.stringify({ totalCost: 1.23 }));

      const loaded = config.loadConfigOrDefault();
      expect(loaded.agentAiDefaults?.exec?.subagent).toBeUndefined();
      expect(fs.existsSync(usagePath)).toBe(true);
    });

    it("preserves differing legacy exec subagent defaults under the nested profile", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          agentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
          },
          subagentAiDefaults: {
            exec: { modelString: "anthropic:claude-haiku-4-5", thinkingLevel: "off" },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.agentAiDefaults?.exec?.subagent).toEqual({
        modelString: "anthropic:claude-haiku-4-5",
        thinkingLevel: "off",
      });
    });

    it("keeps only differing fields from a partially mirrored legacy exec entry", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          agentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
          },
          subagentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "off" },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.agentAiDefaults?.exec?.subagent).toEqual({
        thinkingLevel: "off",
      });
    });

    it("keeps a differing legacy exec subagent reasoning mode", () => {
      // UI Exec pro + sub-agent standard share a model: the fold may drop the
      // mirrored model but must keep the explicit standard override (deleting
      // it would silently flip the sub-agent to pro after restart).
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          agentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", reasoningMode: "pro" },
          },
          subagentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", reasoningMode: "standard" },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.agentAiDefaults?.exec?.subagent).toEqual({
        reasoningMode: "standard",
      });
    });

    it("prunes a mirrored legacy exec subagent reasoning mode", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          agentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", reasoningMode: "pro" },
          },
          subagentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", reasoningMode: "pro" },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.agentAiDefaults?.exec?.subagent).toBeUndefined();
    });

    it("prefers nested subagent fields over the legacy projection on load", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          agentAiDefaults: {
            exec: {
              modelString: "openai:gpt-5.3-codex",
              subagent: { thinkingLevel: "high" },
            },
          },
          subagentAiDefaults: {
            exec: { modelString: "anthropic:claude-haiku-4-5", thinkingLevel: "off" },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.agentAiDefaults?.exec?.subagent).toEqual({
        // Canonical nested value wins; the legacy map only fills fields the
        // nested profile leaves unset.
        thinkingLevel: "high",
        modelString: "anthropic:claude-haiku-4-5",
      });
    });

    it("does not synthesize UI exec defaults from legacy subagent-only exec defaults", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          subagentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.agentAiDefaults?.exec?.modelString).toBeUndefined();
      expect(loaded.agentAiDefaults?.exec?.subagent).toEqual({
        modelString: "openai:gpt-5.3-codex",
        thinkingLevel: "xhigh",
      });
    });

    it("writes a downgrade-compatible legacy projection on save", async () => {
      await config.editConfig((cfg) => {
        cfg.agentAiDefaults = {
          exec: {
            modelString: "openai:gpt-5.2",
            thinkingLevel: "medium",
            subagent: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
          },
          plan: { modelString: "anthropic:claude-opus-4-6" },
          worker: {
            modelString: "anthropic:claude-haiku-4-5",
            subagent: { thinkingLevel: "off" },
          },
        };
        return cfg;
      });

      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        subagentAiDefaults?: Record<string, unknown>;
        migrations?: { execSubagentDefaultsSplit?: boolean };
      };
      expect(raw.subagentAiDefaults).toEqual({
        // Exec projects only sparse overrides (old builds treat the exec key
        // as canonical delegated storage).
        exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
        // Other agents project the effective delegated profile; plan/compact
        // stay excluded for parity with old builds.
        worker: { modelString: "anthropic:claude-haiku-4-5", thinkingLevel: "off" },
      });
      expect(raw.migrations?.execSubagentDefaultsSplit).toBe(true);
    });

    it("round-trips distinct interactive and delegated exec profiles through downgrade save", async () => {
      await config.editConfig((cfg) => {
        cfg.agentAiDefaults = {
          exec: {
            modelString: "openai:gpt-5.2",
            thinkingLevel: "medium",
            reasoningMode: "pro",
            subagent: {
              modelString: "openai:gpt-5.3-codex",
              thinkingLevel: "xhigh",
              reasoningMode: "standard",
            },
          },
        };
        return cfg;
      });

      // Simulate a downgrade save: old builds strip the nested subagent
      // profile from agentAiDefaults but keep the legacy root map.
      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        agentAiDefaults?: Record<string, Record<string, unknown>>;
        subagentAiDefaults?: Record<string, unknown>;
      };
      const execEntry = raw.agentAiDefaults?.exec ?? {};
      delete execEntry.subagent;
      fs.writeFileSync(path.join(tempDir, "config.json"), JSON.stringify(raw));

      const reloaded = new Config(tempDir).loadConfigOrDefault();
      expect(reloaded.agentAiDefaults?.exec).toEqual({
        modelString: "openai:gpt-5.2",
        thinkingLevel: "medium",
        reasoningMode: "pro",
        enabled: undefined,
        advisorEnabled: undefined,
        subagent: {
          modelString: "openai:gpt-5.3-codex",
          thinkingLevel: "xhigh",
          reasoningMode: "standard",
        },
      });
    });

    it("clearing the delegated exec profile removes the legacy exec projection on save", async () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          agentAiDefaults: {
            exec: {
              modelString: "openai:gpt-5.2",
              thinkingLevel: "medium",
              subagent: { modelString: "openai:gpt-5.3-codex" },
            },
          },
        })
      );

      await config.editConfig((cfg) => {
        const exec = cfg.agentAiDefaults?.exec;
        if (exec) {
          delete exec.subagent;
        }
        return cfg;
      });

      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        subagentAiDefaults?: Record<string, unknown>;
      };
      expect(raw.subagentAiDefaults).toBeUndefined();
    });
  });
  describe("route priority and overrides persistence", () => {
    it("round-trips routePriority through disk", async () => {
      const expectedPriority = ["openai:gpt-4o", "anthropic:claude-3-5-sonnet"];

      await config.editConfig((cfg) => {
        cfg.routePriority = expectedPriority;
        return cfg;
      });

      const restartedConfig = new Config(tempDir);
      const loaded = restartedConfig.loadConfigOrDefault();
      expect(loaded.routePriority).toEqual(expectedPriority);
    });

    it("round-trips routeOverrides through disk", async () => {
      const expectedOverrides = {
        "openai:gpt-4o": "direct",
        "anthropic:claude-3-5-sonnet": "auto",
      };

      await config.editConfig((cfg) => {
        cfg.routeOverrides = expectedOverrides;
        return cfg;
      });

      const restartedConfig = new Config(tempDir);
      const loaded = restartedConfig.loadConfigOrDefault();
      expect(loaded.routeOverrides).toEqual(expectedOverrides);
    });

    it("normalizes gateway-scoped override keys on save", async () => {
      await config.editConfig((cfg) => {
        cfg.routeOverrides = {
          "openrouter:anthropic/claude-opus-4-6": "direct",
        };
        return cfg;
      });

      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        routeOverrides?: Record<string, string>;
      };

      expect(raw.routeOverrides).toEqual({
        "anthropic:claude-opus-4-6": "direct",
      });
    });

    it("normalizes gateway-scoped override keys on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          routeOverrides: {
            "openrouter:anthropic/claude-opus-4-6": "direct",
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.routeOverrides).toEqual({
        "anthropic:claude-opus-4-6": "direct",
      });
    });

    it("handles key collisions after normalization", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          routeOverrides: {
            "openrouter:anthropic/claude-opus-4-6": "direct",
            "mux-gateway:anthropic/claude-opus-4-6": "openrouter",
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.routeOverrides).toEqual({
        "anthropic:claude-opus-4-6": "openrouter",
      });
    });

    it("keeps routePriority and routeOverrides across unrelated editConfig saves", async () => {
      const expectedPriority = ["openai:gpt-4o"];
      const expectedOverrides = {
        "openai:gpt-4o": "direct",
      };

      await config.editConfig((cfg) => {
        cfg.routePriority = expectedPriority;
        cfg.routeOverrides = expectedOverrides;
        return cfg;
      });

      await config.editConfig((cfg) => {
        cfg.apiServerPort = 4000;
        return cfg;
      });

      const restartedConfig = new Config(tempDir);
      const loaded = restartedConfig.loadConfigOrDefault();

      expect(loaded.routePriority).toEqual(expectedPriority);
      expect(loaded.routeOverrides).toEqual(expectedOverrides);
      expect(loaded.apiServerPort).toBe(4000);
    });
  });

  describe("legacy gateway migration preserves downgrade compatibility", () => {
    const writeRawConfig = (value: Record<string, unknown>) => {
      fs.writeFileSync(path.join(tempDir, "config.json"), JSON.stringify(value));
    };

    const writeProvidersConfig = (value: Record<string, unknown>) => {
      fs.writeFileSync(path.join(tempDir, "providers.jsonc"), JSON.stringify(value, null, 2));
    };

    const readRawConfig = () =>
      JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        muxGatewayEnabled?: boolean;
        muxGatewayModels?: string[];
        routePriority?: string[];
        routeOverrides?: Record<string, string>;
      };

    for (const { name, rawConfig, expectedOverrides } of [
      {
        name: "translates a single legacy allowlisted model into a mux-gateway routeOverride",
        rawConfig: {
          muxGatewayEnabled: true,
          muxGatewayModels: ["anthropic/claude-sonnet-4-6"],
        },
        expectedOverrides: { "anthropic:claude-sonnet-4-6": "mux-gateway" },
      },
      {
        name: "translates multiple legacy models and merges them with existing routeOverrides",
        rawConfig: {
          muxGatewayEnabled: true,
          muxGatewayModels: ["anthropic:claude-sonnet-4-6", "openrouter:anthropic/claude-opus-4-6"],
          routeOverrides: { "openai:gpt-4o": "direct" },
        },
        expectedOverrides: {
          "openai:gpt-4o": "direct",
          "anthropic:claude-sonnet-4-6": "mux-gateway",
          "anthropic:claude-opus-4-6": "mux-gateway",
        },
      },
      {
        name: "keeps existing routeOverrides when a legacy model normalizes to the same canonical key",
        rawConfig: {
          muxGatewayEnabled: true,
          muxGatewayModels: ["openrouter:anthropic/claude-opus-4-6"],
          routeOverrides: { "anthropic:claude-opus-4-6": "openrouter" },
        },
        expectedOverrides: { "anthropic:claude-opus-4-6": "openrouter" },
      },
      {
        name: "synthesizes direct-only priority when the legacy allowlist is empty",
        rawConfig: { muxGatewayEnabled: true, muxGatewayModels: [] },
        expectedOverrides: undefined,
      },
      {
        name: "synthesizes direct-only priority when the legacy gateway flag is disabled",
        rawConfig: {
          muxGatewayEnabled: false,
          muxGatewayModels: ["anthropic/claude-sonnet-4-6"],
        },
        expectedOverrides: undefined,
      },
    ] as const) {
      it(name, () => {
        writeRawConfig(rawConfig);

        const loaded = config.loadConfigOrDefault();

        expect(loaded.routePriority).toEqual(["direct"]);
        if (expectedOverrides === undefined) {
          expect(loaded.routeOverrides).toBeUndefined();
        } else {
          expect(loaded.routeOverrides).toEqual(expectedOverrides);
        }
      });
    }

    it("preserves legacy fields on disk alongside synthesized modern routing state", async () => {
      writeRawConfig({
        muxGatewayEnabled: true,
        muxGatewayModels: ["anthropic/claude-sonnet-4-6"],
      });
      writeProvidersConfig({
        "mux-gateway": { couponCode: "test-coupon" },
      });

      const loaded = config.loadConfigOrDefault();
      expect(loaded.routePriority).toEqual(["mux-gateway", "direct"]);
      expect(loaded.routeOverrides).toEqual({
        "anthropic:claude-sonnet-4-6": "mux-gateway",
      });

      await flushConfigEdits();
      expect(readRawConfig()).toMatchObject({
        muxGatewayEnabled: true,
        muxGatewayModels: ["anthropic/claude-sonnet-4-6"],
        routePriority: ["mux-gateway", "direct"],
        routeOverrides: {
          "anthropic:claude-sonnet-4-6": "mux-gateway",
        },
      });
    });

    it("seeds routePriority from other configured gateways for legacy configs", () => {
      writeRawConfig({
        muxGatewayEnabled: true,
        muxGatewayModels: ["anthropic/claude-sonnet-4-6"],
      });
      writeProvidersConfig({
        openrouter: { apiKey: "test-openrouter-key" },
      });

      const loaded = config.loadConfigOrDefault();

      expect(loaded.routePriority).toEqual(["openrouter", "direct"]);
      expect(loaded.routeOverrides).toEqual({
        "anthropic:claude-sonnet-4-6": "mux-gateway",
      });
    });

    it("excludes mux-gateway from seeded priority when legacy muxGatewayEnabled is false", () => {
      writeRawConfig({
        muxGatewayEnabled: false,
        muxGatewayModels: ["anthropic/claude-sonnet-4-6"],
      });
      writeProvidersConfig({
        "mux-gateway": { couponCode: "test-coupon" },
        openrouter: { apiKey: "test-openrouter-key" },
      });

      const loaded = config.loadConfigOrDefault();

      expect(loaded.routePriority).toEqual(["openrouter", "direct"]);
      expect(loaded.routeOverrides).toBeUndefined();
    });

    it("clears stale muxGatewayEnabled disables when routePriority already includes mux-gateway", async () => {
      writeRawConfig({
        muxGatewayEnabled: false,
        routePriority: ["mux-gateway", "direct"],
      });

      const loaded = config.loadConfigOrDefault();

      expect(loaded.routePriority).toEqual(["mux-gateway", "direct"]);
      expect(loaded.muxGatewayEnabled).toBeUndefined();
      await flushConfigEdits();
      expect(readRawConfig().muxGatewayEnabled).toBeUndefined();
      expect(new Config(tempDir).loadConfigOrDefault().muxGatewayEnabled).toBeUndefined();
    });

    it("does not rewrite configs that already include routePriority", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          muxGatewayEnabled: true,
          muxGatewayModels: ["anthropic/claude-sonnet-4-6"],
          routePriority: ["openrouter", "direct"],
          routeOverrides: {
            "openai:gpt-4o": "direct",
          },
          // Without this flag the one-time default-fallbacks seed would write
          // the file, which is not the rewrite this test guards against.
          migrations: { defaultModelFallbacksSeeded: true },
        })
      );

      const preservedTime = new Date("2000-01-01T00:00:00.000Z");
      fs.utimesSync(configFile, preservedTime, preservedTime);
      const beforeMtimeMs = fs.statSync(configFile).mtimeMs;

      const loaded = config.loadConfigOrDefault();
      expect(loaded.routePriority).toEqual(["openrouter", "direct"]);
      expect(loaded.routeOverrides).toEqual({
        "openai:gpt-4o": "direct",
      });

      const afterMtimeMs = fs.statSync(configFile).mtimeMs;
      expect(afterMtimeMs).toBe(beforeMtimeMs);
    });
  });

  describe("routePriority seeding from providers", () => {
    const gatewayEnvKeys = [
      "OPENROUTER_API_KEY",
      "GITHUB_COPILOT_TOKEN",
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_PROFILE",
    ] as const;
    let originalGatewayEnv: Partial<Record<(typeof gatewayEnvKeys)[number], string | undefined>>;

    const writeProvidersConfig = (providersConfig: Record<string, unknown>) => {
      fs.writeFileSync(
        path.join(tempDir, "providers.jsonc"),
        JSON.stringify(providersConfig, null, 2)
      );
    };

    beforeEach(() => {
      originalGatewayEnv = Object.fromEntries(
        gatewayEnvKeys.map((key) => [key, process.env[key]])
      ) as Partial<Record<(typeof gatewayEnvKeys)[number], string | undefined>>;

      for (const key of gatewayEnvKeys) {
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of gatewayEnvKeys) {
        const value = originalGatewayEnv[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });

    it("seeds routePriority on fresh installs when a gateway is configured", () => {
      writeProvidersConfig({
        // mux-gateway is configured by couponCode/voucher rather than apiKey.
        "mux-gateway": { couponCode: "test-coupon" },
      });

      const loaded = config.loadConfigOrDefault();
      const muxGatewayIndex = loaded.routePriority?.indexOf("mux-gateway") ?? -1;
      const directIndex = loaded.routePriority?.indexOf("direct") ?? -1;

      expect(muxGatewayIndex).toBeGreaterThanOrEqual(0);
      expect(directIndex).toBeGreaterThan(muxGatewayIndex);
    });

    it("does not seed routePriority when a configured gateway is disabled", () => {
      writeProvidersConfig({
        "mux-gateway": { couponCode: "test-coupon", enabled: false },
      });

      const loaded = config.loadConfigOrDefault();

      expect(loaded.routePriority).toBeUndefined();
    });

    it("leaves routePriority undefined on fresh installs without configured gateways", () => {
      const loaded = config.loadConfigOrDefault();

      expect(loaded.routePriority).toBeUndefined();
    });

    it("does not seed routePriority for bedrock when env only exposes a region", () => {
      process.env.AWS_REGION = "us-east-1";

      const loaded = config.loadConfigOrDefault();

      expect(loaded.routePriority).toBeUndefined();
    });

    it("preserves existing routePriority when a gateway is configured", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({ routePriority: ["direct"] })
      );
      writeProvidersConfig({
        // mux-gateway is configured by couponCode/voucher rather than apiKey.
        "mux-gateway": { couponCode: "test-coupon" },
      });

      const loaded = config.loadConfigOrDefault();

      expect(loaded.routePriority).toEqual(["direct"]);
    });
  });

  describe("config change notifications", () => {
    it("emits for editConfig saves and stops after unsubscribe", async () => {
      let notifications = 0;
      const unsubscribe = config.onConfigChanged(() => {
        notifications += 1;
      });

      await config.editConfig((cfg) => {
        cfg.routePriority = ["openai:gpt-4o"];
        return cfg;
      });

      expect(notifications).toBe(1);

      unsubscribe();

      await config.editConfig((cfg) => {
        cfg.routeOverrides = { "openai:gpt-4o": "direct" };
        return cfg;
      });

      expect(notifications).toBe(1);
    });
  });

  describe("generateStableId", () => {
    it("should generate a 10-character hex string", () => {
      const id = config.generateStableId();
      expect(id).toMatch(/^[0-9a-f]{10}$/);
    });

    it("should generate unique IDs", () => {
      const id1 = config.generateStableId();
      const id2 = config.generateStableId();
      const id3 = config.generateStableId();

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });
  });

  describe("findWorkspace", () => {
    it("preserves the config key while exposing a real attribution path for multi-project workspaces", async () => {
      const primaryProjectPath = "/fake/project-a";
      const secondaryProjectPath = "/fake/project-b";
      const workspacePath = path.join(config.srcDir, "project-a+project-b", "feature-branch");

      await config.editConfig((cfg) => {
        cfg.projects.set(MULTI_PROJECT_CONFIG_KEY, {
          workspaces: [
            {
              path: workspacePath,
              id: "workspace-1",
              name: "feature-branch",
              projects: [
                { projectName: "project-a", projectPath: primaryProjectPath },
                { projectName: "project-b", projectPath: secondaryProjectPath },
              ],
            },
          ],
        });
        return cfg;
      });

      expect(config.findWorkspace("workspace-1")).toEqual({
        workspacePath,
        projectPath: MULTI_PROJECT_CONFIG_KEY,
        attributionProjectPath: primaryProjectPath,
        projects: [
          { projectName: "project-a", projectPath: primaryProjectPath },
          { projectName: "project-b", projectPath: secondaryProjectPath },
        ],
        workspaceName: "feature-branch",
        parentWorkspaceId: undefined,
        pendingAutoTitle: undefined,
      });
    });
  });

  describe("getAllWorkspaceMetadata with migration", () => {
    it("should migrate legacy workspace without metadata file", async () => {
      const projectPath = "/fake/project";
      const workspacePath = path.join(config.srcDir, "project", "feature-branch");

      // Create workspace directory
      fs.mkdirSync(workspacePath, { recursive: true });

      // Add workspace to config without metadata file
      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [{ path: workspacePath }],
        });
        return cfg;
      });

      // Get all metadata (should trigger migration)
      const allMetadata = await config.getAllWorkspaceMetadata();

      expect(allMetadata).toHaveLength(1);
      const metadata = allMetadata[0];
      expect(metadata.id).toBe("project-feature-branch"); // Legacy ID format
      expect(metadata.name).toBe("feature-branch");
      expect(metadata.projectName).toBe("project");
      expect(metadata.projectPath).toBe(projectPath);

      // Verify metadata was migrated to config
      const configData = config.loadConfigOrDefault();
      const projectConfig = configData.projects.get(projectPath);
      expect(projectConfig).toBeDefined();
      expect(projectConfig!.workspaces).toHaveLength(1);
      const workspace = projectConfig!.workspaces[0];
      expect(workspace.id).toBe("project-feature-branch");
      expect(workspace.name).toBe("feature-branch");
    });

    it("defaults sparse persisted heartbeat intervals in workspace metadata", async () => {
      const projectPath = "/fake/project";
      const workspacePath = path.join(config.srcDir, "project", "heartbeat-sparse");
      const sparseHeartbeat = { enabled: true } as const;

      await config.editConfig((cfg) => {
        cfg.heartbeatDefaultIntervalMs = 45 * 60 * 1000;
        cfg.projects.set(projectPath, {
          workspaces: [
            {
              path: workspacePath,
              id: "workspace-heartbeat-sparse",
              name: "heartbeat-sparse",
              createdAt: "2025-01-01T00:00:00.000Z",
              runtimeConfig: { type: "local" },
              // Simulates older/corrupt persisted config; workspace metadata must stay schema-valid.
              heartbeat: sparseHeartbeat as NonNullable<WorkspaceMetadata["heartbeat"]>,
            },
          ],
        });
        return cfg;
      });

      const [metadata] = await config.getAllWorkspaceMetadata();

      expect(metadata.heartbeat).toEqual({
        enabled: true,
        intervalMs: 45 * 60 * 1000,
      });
    });

    it("preserves valid heartbeat schedule fields and drops invalid ones in workspace metadata", async () => {
      const projectPath = "/fake/project";
      const workspacePath = path.join(config.srcDir, "project", "heartbeat-schedule");
      // trigger is valid and must survive normalization; whenBusy simulates a corrupt
      // persisted value and must be dropped (self-healing) rather than passed through.
      const persistedHeartbeat = {
        enabled: true,
        intervalMs: 30 * 60 * 1000,
        trigger: "interval",
        whenBusy: "not-a-mode",
      };

      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [
            {
              path: workspacePath,
              id: "workspace-heartbeat-schedule",
              name: "heartbeat-schedule",
              createdAt: "2025-01-01T00:00:00.000Z",
              runtimeConfig: { type: "local" },
              heartbeat: persistedHeartbeat as NonNullable<WorkspaceMetadata["heartbeat"]>,
            },
          ],
        });
        return cfg;
      });

      const [metadata] = await config.getAllWorkspaceMetadata();

      expect(metadata.heartbeat).toEqual({
        enabled: true,
        intervalMs: 30 * 60 * 1000,
        trigger: "interval",
      });
    });

    it("should use existing metadata file if present (legacy format)", async () => {
      const projectPath = "/fake/project";
      const workspaceName = "my-feature";
      const workspacePath = path.join(config.srcDir, "project", workspaceName);

      // Create workspace directory
      fs.mkdirSync(workspacePath, { recursive: true });

      // Test backward compatibility: Create metadata file using legacy ID format.
      // This simulates workspaces created before stable IDs were introduced.
      const legacyId = config.generateLegacyId(projectPath, workspacePath);
      const sessionDir = config.getSessionDir(legacyId);
      fs.mkdirSync(sessionDir, { recursive: true });
      const metadataPath = path.join(sessionDir, "metadata.json");
      const existingMetadata = {
        id: legacyId,
        name: workspaceName,
        projectName: "project",
        projectPath: projectPath,
        createdAt: "2025-01-01T00:00:00.000Z",
      };
      fs.writeFileSync(metadataPath, JSON.stringify(existingMetadata));

      // Add workspace to config (without id/name, simulating legacy format)
      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [{ path: workspacePath }],
        });
        return cfg;
      });

      // Get all metadata (should use existing metadata and migrate to config)
      const allMetadata = await config.getAllWorkspaceMetadata();

      expect(allMetadata).toHaveLength(1);
      const metadata = allMetadata[0];
      expect(metadata.id).toBe(legacyId);
      expect(metadata.name).toBe(workspaceName);
      expect(metadata.createdAt).toBe("2025-01-01T00:00:00.000Z");

      // Verify metadata was migrated to config
      const configData = config.loadConfigOrDefault();
      const projectConfig = configData.projects.get(projectPath);
      expect(projectConfig).toBeDefined();
      expect(projectConfig!.workspaces).toHaveLength(1);
      const workspace = projectConfig!.workspaces[0];
      expect(workspace.id).toBe(legacyId);
      expect(workspace.name).toBe(workspaceName);
      expect(workspace.createdAt).toBe("2025-01-01T00:00:00.000Z");
    });
  });

  describe("transcriptOnly derivation", () => {
    it("leaves transcriptOnly unset for worktree workspaces with an existing checkout", async () => {
      const projectPath = "/fake/project";
      const workspacePath = path.join(config.srcDir, "project", "existing-worktree");
      fs.mkdirSync(workspacePath, { recursive: true });

      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [
            {
              path: workspacePath,
              id: "workspace-existing",
              name: "existing-worktree",
              createdAt: "2025-01-01T00:00:00.000Z",
              runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
            },
          ],
        });
        return cfg;
      });

      const [metadata] = await config.getAllWorkspaceMetadata();

      expect(metadata.transcriptOnly).toBeUndefined();
    });

    it("returns transcriptOnly for missing worktree checkouts even after unarchiving", async () => {
      const projectPath = "/fake/project";
      const workspacePath = path.join(config.srcDir, "project", "missing-worktree");

      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [
            {
              path: workspacePath,
              id: "workspace-missing-worktree",
              name: "missing-worktree",
              createdAt: "2025-01-01T00:00:00.000Z",
              archivedAt: "2025-01-02T00:00:00.000Z",
              unarchivedAt: "2025-01-03T00:00:00.000Z",
              runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
            },
          ],
        });
        return cfg;
      });

      const [metadata] = await config.getAllWorkspaceMetadata();

      expect(metadata.transcriptOnly).toBe(true);
    });

    it("leaves transcriptOnly unset for queued worktree tasks whose checkout is still missing", async () => {
      const projectPath = "/fake/project";
      const workspacePath = path.join(config.srcDir, "project", "queued-missing-worktree");

      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [
            {
              path: workspacePath,
              id: "workspace-queued-missing-worktree",
              name: "queued-missing-worktree",
              createdAt: "2025-01-01T00:00:00.000Z",
              runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
              taskStatus: "queued",
            },
          ],
        });
        return cfg;
      });

      const [metadata] = await config.getAllWorkspaceMetadata();

      expect(metadata.transcriptOnly).toBeUndefined();
    });

    it("never returns transcriptOnly for non-worktree runtimes", async () => {
      const projectPath = "/fake/project";
      const workspacePath = path.join(tempDir, "missing-local-workspace");

      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [
            {
              path: workspacePath,
              id: "workspace-missing-local",
              name: "missing-local-workspace",
              createdAt: "2025-01-01T00:00:00.000Z",
              runtimeConfig: { type: "local" },
            },
          ],
        });
        return cfg;
      });

      const [metadata] = await config.getAllWorkspaceMetadata();

      expect(metadata.transcriptOnly).toBeUndefined();
    });
  });

  describe("secrets", () => {
    it("supports global secrets stored under a sentinel key", async () => {
      await config.updateGlobalSecrets([{ key: "GLOBAL_A", value: "1" }]);

      expect(config.getGlobalSecrets()).toEqual([{ key: "GLOBAL_A", value: "1" }]);

      const raw = fs.readFileSync(path.join(tempDir, "secrets.json"), "utf-8");
      const parsed = JSON.parse(raw) as { __global__?: unknown };
      expect(parsed.__global__).toEqual([{ key: "GLOBAL_A", value: "1" }]);
    });

    it("preserves unsupported legacy entries on disk when saving unrelated secrets", async () => {
      const secretsFile = path.join(tempDir, "secrets.json");
      const legacyEntry = { key: "LEGACY_OP", value: { op: "op://Vault/Item/field" } };
      fs.writeFileSync(
        secretsFile,
        JSON.stringify({
          __global__: [legacyEntry, { key: "KEEP", value: "kept" }],
          "/other/project": [legacyEntry],
        })
      );

      // Legacy entries are hidden from runtime/UI views...
      expect(config.getGlobalSecrets()).toEqual([{ key: "KEEP", value: "kept" }]);

      await config.updateGlobalSecrets([
        { key: "KEEP", value: "kept" },
        { key: "NEW", value: "added" },
      ]);

      // ...but survive on disk so a downgrade can still read them, in both the
      // updated bucket and untouched buckets.
      const parsed = JSON.parse(fs.readFileSync(secretsFile, "utf-8")) as Record<string, unknown>;
      expect(parsed.__global__).toEqual([
        { key: "KEEP", value: "kept" },
        { key: "NEW", value: "added" },
        legacyEntry,
      ]);
      expect(parsed["/other/project"]).toEqual([legacyEntry]);
    });

    it("drops a preserved legacy entry when an update reuses its key", async () => {
      const secretsFile = path.join(tempDir, "secrets.json");
      fs.writeFileSync(
        secretsFile,
        JSON.stringify({
          __global__: [{ key: "TOKEN", value: { op: "op://Vault/Item/field" } }],
        })
      );

      await config.updateGlobalSecrets([{ key: "TOKEN", value: "replaced" }]);

      const parsed = JSON.parse(fs.readFileSync(secretsFile, "utf-8")) as Record<string, unknown>;
      expect(parsed.__global__).toEqual([{ key: "TOKEN", value: "replaced" }]);
    });

    it("preserves legacy entries from trailing-slash duplicate project buckets", async () => {
      const secretsFile = path.join(tempDir, "secrets.json");
      const legacyEntry = { key: "LEGACY_OP", value: { op: "op://Vault/Item/field" } };
      fs.writeFileSync(secretsFile, JSON.stringify({ "/repo/": [legacyEntry] }));

      await config.updateProjectSecrets("/repo", [{ key: "NEW", value: "added" }]);

      const parsed = JSON.parse(fs.readFileSync(secretsFile, "utf-8")) as Record<string, unknown>;
      expect(parsed["/repo/"]).toBeUndefined();
      expect(parsed["/repo"]).toEqual([{ key: "NEW", value: "added" }, legacyEntry]);
    });

    it("does not inherit global secrets by default", async () => {
      await config.updateGlobalSecrets([
        { key: "TOKEN", value: "global" },
        { key: "A", value: "1" },
      ]);

      const projectPath = "/fake/project";
      await config.updateProjectSecrets(projectPath, [
        { key: "TOKEN", value: "project" },
        { key: "B", value: "2" },
      ]);

      const effective = config.getEffectiveSecrets(projectPath);
      const record = await secretsToRecord(effective);

      expect(record).toEqual({
        TOKEN: "project",
        B: "2",
      });
    });

    it("injects global secrets with injectAll into any project's effective secrets", async () => {
      await config.updateGlobalSecrets([
        { key: "INJECTED", value: "everywhere", injectAll: true },
        { key: "STORED_ONLY", value: "shared" },
      ]);

      const record = await secretsToRecord(config.getEffectiveSecrets("/fake/project"));
      expect(record).toEqual({
        INJECTED: "everywhere",
      });
    });

    it("project secrets override injectAll global secrets", async () => {
      await config.updateGlobalSecrets([{ key: "TOKEN", value: "global", injectAll: true }]);

      const projectPath = "/fake/project";
      await config.updateProjectSecrets(projectPath, [{ key: "TOKEN", value: "project" }]);

      const record = await secretsToRecord(config.getEffectiveSecrets(projectPath));
      expect(record).toEqual({
        TOKEN: "project",
      });
    });

    it("injects injectAll globals alongside project-specific secrets", async () => {
      await config.updateGlobalSecrets([{ key: "GLOBAL_TOKEN", value: "global", injectAll: true }]);

      const projectPath = "/fake/project";
      await config.updateProjectSecrets(projectPath, [{ key: "LOCAL_TOKEN", value: "local" }]);

      const record = await secretsToRecord(config.getEffectiveSecrets(projectPath));
      expect(record).toEqual({
        GLOBAL_TOKEN: "global",
        LOCAL_TOKEN: "local",
      });
    });

    it("returns only globally injected secrets for project settings visibility", async () => {
      await config.updateGlobalSecrets([
        { key: "GLOBAL_VISIBLE", value: "v", injectAll: true },
        { key: "GLOBAL_HIDDEN", value: "h" },
        { key: "SHARED", value: "global", injectAll: true },
      ]);

      const projectPath = "/fake/project";
      await config.updateProjectSecrets(projectPath, [
        { key: "LOCAL_ONLY", value: "local" },
        { key: "SHARED", value: "project" },
      ]);

      expect(config.getInjectedGlobalSecrets(projectPath)).toEqual([
        { key: "GLOBAL_VISIBLE", value: "v" },
      ]);
    });

    it("does not inject global secrets unless injectAll is true", async () => {
      await config.updateGlobalSecrets([
        { key: "A", value: "1", injectAll: false },
        { key: "B", value: "2" },
        { key: "C", value: "3", injectAll: true },
      ]);

      const record = await secretsToRecord(config.getEffectiveSecrets("/fake/project"));
      expect(record).toEqual({
        C: "3",
      });
    });

    it("uses last global duplicate to decide injectAll behavior", async () => {
      await config.updateGlobalSecrets([
        { key: "DUP", value: "first", injectAll: true },
        { key: "DUP", value: "second", injectAll: false },
      ]);

      expect(await secretsToRecord(config.getEffectiveSecrets("/fake/project"))).toEqual({});

      await config.updateGlobalSecrets([
        { key: "DUP", value: "first", injectAll: false },
        { key: "DUP", value: "second", injectAll: true },
      ]);

      expect(await secretsToRecord(config.getEffectiveSecrets("/fake/project"))).toEqual({
        DUP: "second",
      });
    });

    it('resolves project secret aliases to global secrets via {secret:"KEY"}', async () => {
      await config.updateGlobalSecrets([{ key: "GLOBAL_TOKEN", value: "abc" }]);

      const projectPath = "/fake/project";
      await config.updateProjectSecrets(projectPath, [
        { key: "TOKEN", value: { secret: "GLOBAL_TOKEN" } },
      ]);

      const record = await secretsToRecord(config.getEffectiveSecrets(projectPath));
      expect(record).toEqual({
        TOKEN: "abc",
      });
    });

    it("resolves same-key project secret references to global values", async () => {
      await config.updateGlobalSecrets([{ key: "OPENAI_API_KEY", value: "abc" }]);

      const projectPath = "/fake/project";
      await config.updateProjectSecrets(projectPath, [
        { key: "OPENAI_API_KEY", value: { secret: "OPENAI_API_KEY" } },
      ]);

      const record = await secretsToRecord(config.getEffectiveSecrets(projectPath));
      expect(record).toEqual({
        OPENAI_API_KEY: "abc",
      });
    });

    it("omits missing referenced secrets when resolving secretsToRecord", async () => {
      const record = await secretsToRecord([
        { key: "GLOBAL", value: "1" },
        { key: "A", value: { secret: "MISSING" } },
      ]);

      expect(record).toEqual({ GLOBAL: "1" });
    });

    it("omits cyclic secret references when resolving secretsToRecord", async () => {
      const record = await secretsToRecord([
        { key: "A", value: { secret: "B" } },
        { key: "B", value: { secret: "A" } },
        { key: "OK", value: "y" },
      ]);

      expect(record).toEqual({ OK: "y" });
    });

    it("resolves mixed literal and { secret } values", async () => {
      const record = await secretsToRecord([
        { key: "LITERAL", value: "raw" },
        { key: "GLOBAL_TOKEN", value: "abc" },
        { key: "ALIAS", value: { secret: "GLOBAL_TOKEN" } },
      ]);

      expect(record).toEqual({
        LITERAL: "raw",
        GLOBAL_TOKEN: "abc",
        ALIAS: "abc",
      });
    });
    it("normalizes project paths so trailing slashes don't split secrets", async () => {
      const projectPath = "/repo";
      const projectPathWithSlash = "/repo/";

      await config.updateProjectSecrets(projectPathWithSlash, [{ key: "A", value: "1" }]);

      expect(config.getProjectSecrets(projectPath)).toEqual([{ key: "A", value: "1" }]);
      expect(config.getProjectSecrets(projectPathWithSlash)).toEqual([{ key: "A", value: "1" }]);

      const raw = fs.readFileSync(path.join(tempDir, "secrets.json"), "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed[projectPath]).toEqual([{ key: "A", value: "1" }]);
      expect(parsed[projectPathWithSlash]).toBeUndefined();
    });

    it("treats malformed store shapes as empty arrays", () => {
      const secretsFile = path.join(tempDir, "secrets.json");
      fs.writeFileSync(
        secretsFile,
        JSON.stringify({
          __global__: { key: "NOPE", value: "1" },
          "/repo": "not-an-array",
          "/repo/": [{ key: "A", value: "1" }, null, { key: 123, value: "x" }],
        })
      );

      expect(config.getGlobalSecrets()).toEqual([]);
      expect(config.getProjectSecrets("/repo")).toEqual([{ key: "A", value: "1" }]);
    });
    it("sanitizes malformed injectAll values without dropping valid secrets", async () => {
      const projectPath = "/repo";
      const secretsFile = path.join(tempDir, "secrets.json");
      fs.writeFileSync(
        secretsFile,
        JSON.stringify({
          __global__: [{ key: "GLOBAL_TOKEN", value: "abc", injectAll: "true" }],
          [projectPath]: [{ key: "TOKEN", value: { secret: "GLOBAL_TOKEN" } }],
        })
      );

      expect(config.getGlobalSecrets()).toEqual([{ key: "GLOBAL_TOKEN", value: "abc" }]);
      expect(await secretsToRecord(config.getEffectiveSecrets(projectPath))).toEqual({
        TOKEN: "abc",
      });
    });
  });

  /**
   * Simulate a crashed lock/lease holder: backdate every generation marker
   * past the TTL and rewrite its owner PID to one that provably does not
   * exist (stale-breaking requires BOTH — a live process's lock is never
   * broken).
   */
  function markCrashedHolder(lockPath: string, ttlMs: number): void {
    const staleTime = new Date(Date.now() - ttlMs - 1_000);
    for (const entry of fs.readdirSync(lockPath)) {
      const entryPath = path.join(lockPath, entry);
      fs.writeFileSync(entryPath, "999999999");
      fs.utimesSync(entryPath, staleTime, staleTime);
    }
  }

  describe("tryAcquireCoderOauthClientLease", () => {
    const TTL_MS = 60_000;

    it("is exclusive until released, including for a second Config on the same root", () => {
      const release = config.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(release).not.toBeNull();

      // Same file root = same lease, even from another Config instance
      // (stands in for another Xum process sharing providers.jsonc).
      const otherProcess = new Config(tempDir);
      expect(otherProcess.tryAcquireCoderOauthClientLease(TTL_MS)).toBeNull();

      release!();
      const reacquired = otherProcess.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(reacquired).not.toBeNull();
      reacquired!();
    });

    it("breaks a stale lease left behind by a crashed holder", () => {
      const leasePath = path.join(tempDir, "providers.jsonc.coder-client.lock");
      fs.mkdirSync(leasePath, { recursive: true });
      const staleTime = new Date(Date.now() - TTL_MS - 1_000);
      fs.utimesSync(leasePath, staleTime, staleTime);

      const release = config.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(release).not.toBeNull();
      release!();
      expect(fs.existsSync(leasePath)).toBe(false);
    });

    it("judges staleness by the holder's generation marker, not the lease directory", () => {
      const leasePath = path.join(tempDir, "providers.jsonc.coder-client.lock");

      const release = config.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(release).not.toBeNull();

      // A breaker that judged staleness by the directory alone could destroy
      // a live successor generation created between its check and its remove
      // (check/remove TOCTOU). Binding staleness to the marker file makes the
      // destructive steps conditional: a fresh marker keeps the lease held
      // even when the directory timestamp looks stale.
      const staleTime = new Date(Date.now() - TTL_MS - 1_000);
      fs.utimesSync(leasePath, staleTime, staleTime);

      const otherProcess = new Config(tempDir);
      expect(otherProcess.tryAcquireCoderOauthClientLease(TTL_MS)).toBeNull();
      release!();
    });

    it("does not stale-break a lease whose holder process is still alive", () => {
      const leasePath = path.join(tempDir, "providers.jsonc.coder-client.lock");

      const release = config.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(release).not.toBeNull();

      // The holder outlives the TTL but its process (this one) is alive —
      // e.g. a suspended laptop or a stalled event loop. Breaking it would
      // let a second flow enter the same critical section and race the
      // resumed original; contenders must fail acquisition instead.
      const staleTime = new Date(Date.now() - TTL_MS - 1_000);
      for (const entry of fs.readdirSync(leasePath)) {
        fs.utimesSync(path.join(leasePath, entry), staleTime, staleTime);
      }

      const otherProcess = new Config(tempDir);
      expect(otherProcess.tryAcquireCoderOauthClientLease(TTL_MS)).toBeNull();
      release!();
    });

    it("does not release a lease that was stale-broken and reacquired by another process", () => {
      const leasePath = path.join(tempDir, "providers.jsonc.coder-client.lock");

      const originalRelease = config.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(originalRelease).not.toBeNull();

      // The lease crosses the staleness boundary and its holder "crashes"
      // (staleness binds to the holder's generation marker + a gone owner
      // PID); another process breaks it and acquires its own generation of
      // the same path.
      markCrashedHolder(leasePath, TTL_MS);
      const otherProcess = new Config(tempDir);
      const otherRelease = otherProcess.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(otherRelease).not.toBeNull();

      // The original holder's late release must NOT remove the new owner's
      // lease — otherwise a third flow could acquire it concurrently and two
      // flows would clobber the stored client's single redirect slot.
      originalRelease!();
      expect(fs.existsSync(leasePath)).toBe(true);
      expect(config.tryAcquireCoderOauthClientLease(TTL_MS)).toBeNull();

      // The rightful owner can still release it.
      otherRelease!();
      expect(fs.existsSync(leasePath)).toBe(false);
    });

    it("reclaims a dead-owner lease immediately, before the TTL elapses", () => {
      // Regression: a crashed holder's PID is deterministically dead, so
      // contenders must recover the orphan right away. Gating recovery on
      // the mtime TTL (which exceeds every acquisition timeout) would make
      // the first operation after a crash always fail despite the owner
      // being provably gone.
      const leasePath = path.join(tempDir, "providers.jsonc.coder-client.lock");
      fs.mkdirSync(leasePath, { recursive: true });
      // Fresh mtime (NOT backdated) + dead owner PID.
      fs.writeFileSync(path.join(leasePath, "owner-crashed"), "999999999");

      const release = config.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(release).not.toBeNull();
      release!();
    });

    it("reclaims an EMPTY orphaned lease directory immediately, before the TTL elapses", () => {
      // Regression: acquisition installs the owner marker atomically with the
      // lock directory (staged rename), so an empty directory can only be a
      // crash remnant — never a live acquisition. A fresh-mtime empty orphan
      // previously read as live until the TTL, and every acquisition timeout
      // is shorter than its TTL, so the first operation after such a crash
      // always failed.
      const leasePath = path.join(tempDir, "providers.jsonc.coder-client.lock");
      fs.mkdirSync(leasePath, { recursive: true }); // Fresh mtime, no marker.

      const release = config.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(release).not.toBeNull();
      release!();
      expect(fs.existsSync(leasePath)).toBe(false);
    });

    it("sweeps stage directories abandoned by a crashed acquisition", () => {
      const leasePath = path.join(tempDir, "providers.jsonc.coder-client.lock");
      const abandonedStage = `${leasePath}.stage-deadbeef`;
      fs.mkdirSync(abandonedStage, { recursive: true });
      fs.writeFileSync(path.join(abandonedStage, "owner-orphan"), "999999999");
      const staleTime = new Date(Date.now() - TTL_MS - 1_000);
      fs.utimesSync(abandonedStage, staleTime, staleTime);
      // A FRESH stage may belong to a concurrent in-flight acquisition and
      // must survive the sweep.
      const freshStage = `${leasePath}.stage-cafebabe`;
      fs.mkdirSync(freshStage, { recursive: true });

      const release = config.tryAcquireCoderOauthClientLease(TTL_MS);
      expect(release).not.toBeNull();
      release!();

      expect(fs.existsSync(abandonedStage)).toBe(false);
      expect(fs.existsSync(freshStage)).toBe(true);
    });
  });

  describe("withProvidersFileLock", () => {
    it("acquires over a dead-owner lock immediately, before the TTL elapses", async () => {
      // Same regression as the lease variant: withDirLock's acquisition
      // timeout (5s) is shorter than its staleness TTL (10s), so a fresh
      // crash orphan must be reclaimed via the dead-PID check or the first
      // config write after the crash would always time out.
      const lockPath = path.join(tempDir, "providers.jsonc.lock");
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(path.join(lockPath, "owner-crashed"), "999999999");

      const startedAt = Date.now();
      const result = await config.withProvidersFileLock(() => "ran");
      expect(result).toBe("ran");
      // Well under the 5s acquisition timeout: the orphan was reclaimed on
      // the first contention check, not waited out.
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("acquires over an EMPTY orphaned lock directory immediately, before the TTL elapses", async () => {
      // Regression: acquisition installs the owner marker atomically with the
      // lock directory (staged rename), so an empty directory can only be a
      // crash remnant — never a live acquisition. Previously a fresh-mtime
      // empty orphan read as live until the 10s TTL, and the 5s acquisition
      // timeout always fired first, so the first config write after such a
      // crash always timed out.
      const lockPath = path.join(tempDir, "providers.jsonc.lock");
      fs.mkdirSync(lockPath, { recursive: true }); // Fresh mtime, no marker.

      const startedAt = Date.now();
      const result = await config.withProvidersFileLock(() => "ran");
      expect(result).toBe("ran");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });

  describe("withCoderOauthRefreshLock", () => {
    it("serializes critical sections, including across Config instances on the same root", async () => {
      // A second Config on the same root stands in for another Xum process
      // sharing providers.jsonc.
      const otherProcess = new Config(tempDir);
      const events: string[] = [];
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
      let firstEntered!: () => void;
      const firstEnteredPromise = new Promise<void>((resolve) => (firstEntered = resolve));

      const first = config.withCoderOauthRefreshLock(async () => {
        events.push("first:enter");
        firstEntered();
        await firstGate;
        events.push("first:exit");
      });
      await firstEnteredPromise;

      const second = otherProcess.withCoderOauthRefreshLock(() => {
        events.push("second:enter");
      });
      // The second section must not start while the first holds the lock.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toEqual(["first:enter"]);

      releaseFirst();
      await Promise.all([first, second]);
      expect(events).toEqual(["first:enter", "first:exit", "second:enter"]);
    });

    it("does not release a successor's lock after being stale-broken mid-section", async () => {
      // A holder that outlives staleLockMs (suspended process, stalled event
      // loop) can be stale-broken and the lock reacquired before its release
      // runs. That release must only remove its OWN generation — deleting the
      // successor's lock would let a third process into the critical section
      // (for the refresh lock, the concurrent rotating-refresh-token race).
      const lockPath = path.join(tempDir, "providers.jsonc.coder-refresh.lock");
      const otherProcess = new Config(tempDir);

      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
      let firstEntered!: () => void;
      const firstEnteredPromise = new Promise<void>((resolve) => (firstEntered = resolve));
      const first = config.withCoderOauthRefreshLock(async () => {
        firstEntered();
        await firstGate;
      });
      await firstEnteredPromise;

      // The first holder's process "crashes" past the staleness boundary
      // (backdated marker + gone owner PID) while its release closure is
      // still pending, and a second process stale-breaks + reacquires.
      markCrashedHolder(lockPath, 120_000);
      let releaseSecond!: () => void;
      const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
      let secondEntered!: () => void;
      const secondEnteredPromise = new Promise<void>((resolve) => (secondEntered = resolve));
      const second = otherProcess.withCoderOauthRefreshLock(async () => {
        secondEntered();
        await secondGate;
      });
      await secondEnteredPromise;

      // The original holder finishes while the successor still holds the
      // lock: its release must keep the successor's generation in place.
      releaseFirst();
      await first;
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.readdirSync(lockPath).length).toBe(1);

      releaseSecond();
      await second;
      // The successor's own release still cleans up normally.
      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });
});
