import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SettingsBackupInput } from "@/common/orpc/schemas/backup";
import { BackupNonFastForwardError, backupCachePath, isBackupCacheName } from "./gitRepo";
import { BackupRemoteUnreachableError } from "./credentials";
import { BackupCommandApprovalRequiredError } from "./payload";
import {
  BackupService,
  BackupServiceError,
  type BackupGitRepo,
  type BackupPayloadStore,
  type PreparedBackupRepository,
} from "./backupService";
import { TestBackupConfig } from "./testHelpers";

const SETTINGS: SettingsBackupInput = {
  repoUrl: "git@github.com:example/settings.git",
  branch: "main",
  path: "mux",
};

async function pathExists(target: string): Promise<boolean> {
  return fs.stat(target).then(
    () => true,
    () => false
  );
}

async function snapshotDirectories(cacheRoot: string): Promise<string[]> {
  const entries = await fs.readdir(cacheRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("restore-"))
    .map((entry) => entry.name);
}

async function cacheDirectories(cacheRoot: string): Promise<string[]> {
  const entries = await fs.readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && isBackupCacheName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function createCacheDirectory(
  cacheRoot: string,
  settings: SettingsBackupInput
): Promise<string> {
  const cachePath = backupCachePath(cacheRoot, settings.repoUrl, settings.branch);
  await fs.mkdir(path.join(cachePath, ".git"), { recursive: true });
  return cachePath;
}

function createRepository(
  overrides: Partial<PreparedBackupRepository> = {}
): PreparedBackupRepository {
  return {
    rootDir: "/cache/repository",
    credential: "ssh",
    remoteCommit: "remote-commit",
    managedPath: SETTINGS.path,
    ...overrides,
  };
}

function createGitRepo(overrides: Partial<BackupGitRepo> = {}): BackupGitRepo {
  return {
    validate: () => Promise.resolve({ credential: "ssh", empty: false }),
    prepare: () => Promise.resolve(createRepository()),
    getPushChanges: () => Promise.resolve([]),
    commitAndPush: () =>
      Promise.resolve({ commit: "pushed-commit", changed: true, credential: "gh" as const }),
    ...overrides,
  };
}

function createPayload(overrides: Partial<BackupPayloadStore> = {}): BackupPayloadStore {
  return {
    exportTo: () => Promise.resolve({ redactions: [], secretFiles: [], secretApproval: "" }),
    previewRestore: () =>
      Promise.resolve({ changes: [], localOnlyFiles: [], commandApprovals: [] }),
    validateRestore: () => Promise.resolve(),
    writeSafetySnapshot: () => Promise.resolve(),
    restore: () => Promise.resolve({ changedFiles: [], localOnlyFiles: [] }),
    ...overrides,
  };
}
function createService(
  rootDir: string,
  overrides: {
    config?: TestBackupConfig;
    gitRepo?: BackupGitRepo;
    payload?: BackupPayloadStore;
  } = {}
): BackupService {
  return new BackupService(overrides.config ?? new TestBackupConfig(rootDir), {
    gitRepo: overrides.gitRepo ?? createGitRepo(),
    payload: overrides.payload ?? createPayload(),
  });
}

describe("BackupService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-backup-service-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("creates a safety snapshot before restoring and records the restored commit", async () => {
    const events: string[] = [];
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () => {
          events.push("validate");
          return Promise.resolve();
        },
        writeSafetySnapshot: async (snapshotRoot) => {
          events.push("snapshot");
          await fs.writeFile(path.join(snapshotRoot, "AGENTS.md"), "before restore", "utf8");
        },
        restore: () => {
          events.push("restore");
          return Promise.resolve({
            changedFiles: ["AGENTS.md"],
            localOnlyFiles: ["skills/local/SKILL.md"],
          });
        },
      }),
    });

    const result = await service.restore(SETTINGS);

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(result.error.message);
    }
    expect(result.data.commit).toBe("remote-commit");
    expect(
      result.data.snapshotPath.startsWith(path.join(tempDir, "backup-cache", "restore-"))
    ).toBe(true);
    expect(result.data.changedFiles).toEqual(["AGENTS.md"]);
    expect(result.data.localOnlyFiles).toEqual(["skills/local/SKILL.md"]);
    expect(events).toEqual(["validate", "snapshot", "restore"]);
    expect(await fs.readFile(path.join(result.data.snapshotPath, "AGENTS.md"), "utf8")).toBe(
      "before restore"
    );
    expect(service.getSettings()?.lastRestoredCommit).toBe("remote-commit");
  });

  test("keeps a bounded number of restore snapshots", async () => {
    const service = createService(tempDir, {
      payload: createPayload({
        writeSafetySnapshot: async (snapshotRoot) => {
          await fs.writeFile(path.join(snapshotRoot, "AGENTS.md"), "before restore", "utf8");
        },
      }),
    });
    const cacheRoot = path.join(tempDir, "backup-cache");
    await fs.mkdir(cacheRoot, { recursive: true });
    // A cache clone lives beside the snapshots and must survive the reap.
    const clone = path.join(cacheRoot, "0123456789ab");
    await fs.mkdir(clone, { recursive: true });

    const snapshots: string[] = [];
    for (let restore = 0; restore < 5; restore++) {
      const result = await service.restore(SETTINGS);
      if (!result.success) throw new Error(result.error.message);
      snapshots.push(result.data.snapshotPath);
    }

    const surviving = new Set(await snapshotDirectories(cacheRoot));
    expect(surviving.size).toBe(3);
    // The newest are the ones a recovery would reach for.
    for (const kept of snapshots.slice(-3)) {
      expect(surviving.has(path.basename(kept))).toBe(true);
    }
    expect((await fs.stat(clone)).isDirectory()).toBe(true);
  });

  test("keeps a returned snapshot until later restores have replaced it", async () => {
    const service = createService(tempDir, {
      payload: createPayload({
        writeSafetySnapshot: async (snapshotRoot) => {
          await fs.writeFile(path.join(snapshotRoot, "AGENTS.md"), "before restore", "utf8");
        },
      }),
    });

    const first = await service.restore(SETTINGS);
    if (!first.success) throw new Error(first.error.message);
    // The path handed to the caller has to stay readable for as many later restores as the
    // retention promises, which is what makes it usable after the call returns.
    for (let later = 0; later < BackupService.RETAINED_SNAPSHOTS - 1; later++) {
      const next = await service.restore(SETTINGS);
      if (!next.success) throw new Error(next.error.message);
      expect(await fs.readFile(path.join(first.data.snapshotPath, "AGENTS.md"), "utf8")).toBe(
        "before restore"
      );
    }
  });

  test("keeps only the two most recently used inactive repository caches", async () => {
    const cacheRoot = path.join(tempDir, "backup-cache");
    const gitRepo = createGitRepo({
      prepare: async (settings) =>
        createRepository({ rootDir: await createCacheDirectory(cacheRoot, settings) }),
    });
    const service = createService(tempDir, { gitRepo });
    const settings: [
      SettingsBackupInput,
      SettingsBackupInput,
      SettingsBackupInput,
      SettingsBackupInput,
    ] = [
      { ...SETTINGS, branch: "a" },
      { ...SETTINGS, branch: "b" },
      { ...SETTINGS, branch: "c" },
      { ...SETTINGS, branch: "d" },
    ];

    for (const current of settings.slice(0, 3)) {
      expect((await service.preview(current)).success).toBe(true);
    }
    for (const [index, current] of settings.slice(0, 3).entries()) {
      const usedAt = new Date((index + 1) * 1_000);
      await fs.utimes(backupCachePath(cacheRoot, current.repoUrl, current.branch), usedAt, usedAt);
    }

    const snapshot = path.join(cacheRoot, "restore-in-progress");
    const tombstone = path.join(cacheRoot, "000000000000.discarded-1234-test");
    await fs.mkdir(snapshot, { recursive: true });
    await fs.mkdir(tombstone, { recursive: true });

    expect((await service.preview(settings[3])).success).toBe(true);

    const surviving = await cacheDirectories(cacheRoot);
    expect(surviving).toEqual(
      settings
        .slice(1)
        .map((current) =>
          path.basename(backupCachePath(cacheRoot, current.repoUrl, current.branch))
        )
        .sort()
    );
    expect(
      await pathExists(backupCachePath(cacheRoot, settings[0].repoUrl, settings[0].branch))
    ).toBe(false);
    expect(await pathExists(snapshot)).toBe(true);
    expect(await pathExists(tombstone)).toBe(false);
  });

  test("reaps inactive repository caches when preparation rejects", async () => {
    const cacheRoot = path.join(tempDir, "backup-cache");
    const settings = ["a", "b", "c", "d"].map((branch) => ({ ...SETTINGS, branch }));
    for (const [index, current] of settings.slice(0, 3).entries()) {
      const cachePath = await createCacheDirectory(cacheRoot, current);
      const usedAt = new Date((index + 1) * 1_000);
      await fs.utimes(cachePath, usedAt, usedAt);
    }
    const gitRepo = createGitRepo({
      prepare: async (current, options) => {
        const repositoryRoot = await createCacheDirectory(cacheRoot, current);
        const cleanup = options?.onPrepareError?.(repositoryRoot);
        await cleanup?.catch(() => undefined);
        throw new BackupServiceError("INVALID_BACKUP", "Invalid remote payload");
      },
    });
    const service = createService(tempDir, { gitRepo });

    const result = await service.preview(settings[3]);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected invalid preparation to fail");
    expect(result.error.code).toBe("INVALID_BACKUP");
    expect(await cacheDirectories(cacheRoot)).toEqual(
      settings
        .slice(1)
        .map((current) =>
          path.basename(backupCachePath(cacheRoot, current.repoUrl, current.branch))
        )
        .sort()
    );
  });

  test("never reaps a repository cache while another operation is using it", async () => {
    const cacheRoot = path.join(tempDir, "backup-cache");
    const settings = Object.fromEntries(
      ["a", "b", "c", "d", "e"].map((branch) => [branch, { ...SETTINGS, branch }])
    ) as Record<"a" | "b" | "c" | "d" | "e", SettingsBackupInput>;
    const gitRepo = createGitRepo({
      prepare: async (current) =>
        createRepository({ rootDir: await createCacheDirectory(cacheRoot, current) }),
    });
    for (const [index, current] of [settings.b, settings.c, settings.d].entries()) {
      const cachePath = await createCacheDirectory(cacheRoot, current);
      const usedAt = new Date((index + 1) * 1_000);
      await fs.utimes(cachePath, usedAt, usedAt);
    }

    let releaseActive: (() => void) | undefined;
    const activeHeld = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    let activeEntered: (() => void) | undefined;
    const activeInPayload = new Promise<void>((resolve) => {
      activeEntered = resolve;
    });
    const activeService = createService(tempDir, {
      gitRepo,
      payload: createPayload({
        previewRestore: async () => {
          activeEntered?.();
          await activeHeld;
          return { changes: [], localOnlyFiles: [], commandApprovals: [] };
        },
      }),
    });
    const otherService = createService(tempDir, { gitRepo });

    const active = activeService.preview(settings.a);
    await activeInPayload;
    const activeCache = backupCachePath(cacheRoot, settings.a.repoUrl, settings.a.branch);
    const old = new Date(500);
    await fs.utimes(activeCache, old, old);

    try {
      expect((await otherService.preview(settings.e)).success).toBe(true);
      expect(await pathExists(activeCache)).toBe(true);
      expect(
        await pathExists(backupCachePath(cacheRoot, settings.b.repoUrl, settings.b.branch))
      ).toBe(false);
    } finally {
      releaseActive?.();
    }
    expect((await active).success).toBe(true);
  });

  test("holds a push out of a Xum root a restore is still writing", async () => {
    const events: string[] = [];
    let releaseRestore: (() => void) | undefined;
    const restoreHeld = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let restoreEntered: (() => void) | undefined;
    const restoreInFlight = new Promise<void>((resolve) => {
      restoreEntered = resolve;
    });
    const service = createService(tempDir, {
      payload: createPayload({
        restore: async () => {
          events.push("restore-start");
          restoreEntered?.();
          await restoreHeld;
          events.push("restore-end");
          return { changedFiles: ["AGENTS.md"], localOnlyFiles: [] };
        },
        exportTo: () => {
          events.push("export");
          return Promise.resolve({ redactions: [], secretFiles: [], secretApproval: "digest" });
        },
      }),
    });

    const restoring = service.restore(SETTINGS);
    await restoreInFlight;
    // A different repository, so withRepoLock does not serialize these two.
    const pushing = service.push({ ...SETTINGS, repoUrl: `${SETTINGS.repoUrl}-other` });
    // Every step between push() and its export is a microtask here (the git repo is a test double),
    // so draining the queue parks the push on the payload lock instead of merely unscheduled. Without
    // the drain the push exports after this restore regardless, and the test passes with no lock.
    for (let i = 0; i < 50; i++) await Promise.resolve();
    releaseRestore?.();
    const [restored, pushed] = await Promise.all([restoring, pushing]);

    expect(restored.success).toBe(true);
    expect(pushed.success).toBe(true);
    // The export must read the root after the restore finished writing it, not during.
    expect(events).toEqual(["restore-start", "restore-end", "export"]);
  });

  test("never reaps a snapshot whose restore has not returned", async () => {
    const cacheRoot = path.join(tempDir, "backup-cache");
    // withRepoLock is per repository, so this stands in for restores of other repositories
    // that are still running while this one completes.
    await fs.mkdir(cacheRoot, { recursive: true });
    const inFlight: string[] = [];
    for (const stamp of ["2020-01-01T00-00-00-000Z", "2020-01-02T00-00-00-000Z"]) {
      const directory = path.join(cacheRoot, `restore-${stamp}-aaaaaa`);
      await fs.mkdir(directory, { recursive: true });
      inFlight.push(path.basename(directory));
    }

    const service = createService(tempDir, {
      payload: createPayload({
        writeSafetySnapshot: async (snapshotRoot) => {
          await fs.writeFile(path.join(snapshotRoot, "AGENTS.md"), "before restore", "utf8");
        },
      }),
    });

    for (let restore = 0; restore < 4; restore++) {
      const result = await service.restore(SETTINGS);
      if (!result.success) throw new Error(result.error.message);
    }

    const surviving = await snapshotDirectories(cacheRoot);
    for (const unreleased of inFlight) {
      expect(surviving).toContain(unreleased);
    }
  });

  test("reports the completed snapshot when the restore fails after it", async () => {
    const service = createService(tempDir, {
      payload: createPayload({
        writeSafetySnapshot: async (snapshotRoot) => {
          await fs.writeFile(path.join(snapshotRoot, "AGENTS.md"), "before restore", "utf8");
        },
        // Fails after the snapshot, when files may already be overwritten, so the snapshot
        // is the only recovery path and the failure must carry it.
        restore: () => Promise.reject(new Error("disk full")),
      }),
    });

    const result = await service.restore(SETTINGS);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the restore to fail");
    const snapshotPath = result.error.snapshotPath;
    if (snapshotPath == null) throw new Error("Expected the failure to carry the snapshot path");
    expect(snapshotPath.startsWith(path.join(tempDir, "backup-cache", "restore-"))).toBe(true);
    expect(await fs.readFile(path.join(snapshotPath, "AGENTS.md"), "utf8")).toBe("before restore");
  });

  test("does not attach a snapshot path to failures before the snapshot exists", async () => {
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () => Promise.reject(new Error("no backup here")),
      }),
    });

    const result = await service.restore(SETTINGS);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the restore to fail");
    // Nothing was restored and no snapshot survives, so a path here would send the user
    // hunting for a recovery copy that does not exist.
    expect(result.error.snapshotPath == null).toBe(true);
  });

  test("computes restore preview before materializing the local export", async () => {
    const events: string[] = [];
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        getPushChanges: () => {
          events.push("push-preview");
          return Promise.resolve([{ path: "AGENTS.md", status: "M" }]);
        },
      }),
      payload: createPayload({
        previewRestore: () => {
          events.push("restore-preview");
          return Promise.resolve({
            changes: [{ path: "preferences.json", status: "M" }],
            localOnlyFiles: [],
            commandApprovals: [],
          });
        },
        exportTo: () => {
          events.push("export");
          return Promise.resolve({ redactions: [], secretFiles: [], secretApproval: "" });
        },
      }),
    });

    const result = await service.preview(SETTINGS);

    expect(result.success).toBe(true);
    expect(events).toEqual(["restore-preview", "export", "push-preview"]);
  });

  test("addresses payload operations to the prepared repository's managed path", async () => {
    // prepare() may select the legacy `mux` spelling of the configured path (backups
    // pushed before the product rename); every payload call must follow that selection
    // rather than the configured settings path.
    const managedPaths: string[] = [];
    const recordManagedPath = (options: { managedPath: string }) => {
      managedPaths.push(options.managedPath);
    };
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        prepare: () => Promise.resolve(createRepository({ managedPath: "legacy-spelling" })),
      }),
      payload: createPayload({
        previewRestore: (options) => {
          recordManagedPath(options);
          return Promise.resolve({ changes: [], localOnlyFiles: [], commandApprovals: [] });
        },
        exportTo: (options) => {
          recordManagedPath(options);
          return Promise.resolve({ redactions: [], secretFiles: [], secretApproval: "" });
        },
        validateRestore: (options) => {
          recordManagedPath(options);
          return Promise.resolve();
        },
        restore: (options) => {
          recordManagedPath(options);
          return Promise.resolve({ changedFiles: [], localOnlyFiles: [] });
        },
      }),
    });

    expect((await service.preview(SETTINGS)).success).toBe(true);
    expect((await service.push(SETTINGS)).success).toBe(true);
    expect((await service.restore(SETTINGS)).success).toBe(true);
    expect(managedPaths).not.toContain(SETTINGS.path);
    expect(new Set(managedPaths)).toEqual(new Set(["legacy-spelling"]));
  });

  test("returns repository drift as expected Result data without updating settings", async () => {
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        commitAndPush: () => {
          throw new BackupServiceError(
            "REPOSITORY_CHANGED",
            "The backup changed since you last read it"
          );
        },
      }),
    });

    const result = await service.push(SETTINGS);

    expect(result).toEqual({
      success: false,
      error: {
        code: "REPOSITORY_CHANGED",
        message: "The backup changed since you last read it",
        files: undefined,
      },
    });
    expect(service.getSettings()).toBeNull();
  });

  test("blocks a push when the payload secret scan reports files", async () => {
    let commitAttempted = false;
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        commitAndPush: () => {
          commitAttempted = true;
          return Promise.resolve({
            commit: "unexpected",
            changed: true,
            credential: "gh" as const,
          });
        },
      }),
      payload: createPayload({
        exportTo: () =>
          Promise.resolve({
            redactions: [],
            secretFiles: ["skills/private/SKILL.md"],
            secretApproval: "digest-v1",
          }),
      }),
    });

    const result = await service.push(SETTINGS);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected secret detection to block the push");
    expect(result.error.code).toBe("SECRET_DETECTED");
    expect(result.error.files).toEqual(["skills/private/SKILL.md"]);
    expect(commitAttempted).toBe(false);
    expect(result.error.secretApproval).toBe("digest-v1");
  });

  test("rejects an override issued for a payload that has since changed", async () => {
    const service = createService(tempDir, {
      payload: createPayload({
        exportTo: () =>
          Promise.resolve({
            redactions: [],
            secretFiles: ["skills/private/SKILL.md"],
            secretApproval: "digest-v2",
          }),
      }),
    });

    const stale = await service.push(SETTINGS, { approvedSecretDigest: "digest-v1" });
    expect(stale.success).toBe(false);
    if (stale.success) throw new Error("Expected the stale override to be refused");
    expect(stale.error.code).toBe("SECRET_DETECTED");

    const current = await service.push(SETTINGS, { approvedSecretDigest: "digest-v2" });
    expect(current.success).toBe(true);
  });

  test("maps a real non-fast-forward failure to repository drift", async () => {
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        commitAndPush: () => Promise.reject(new BackupNonFastForwardError()),
      }),
    });

    const result = await service.push(SETTINGS);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the drifted remote to block the push");
    expect(result.error.code).toBe("REPOSITORY_CHANGED");
    expect(result.error.message).toBe("The backup changed since you last read it");
  });

  test("surfaces an unreachable remote to the client as REMOTE_UNREACHABLE", async () => {
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        validate: () => Promise.reject(new BackupRemoteUnreachableError(new Error("no dns"))),
      }),
    });

    const result = await service.validate(SETTINGS);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the unreachable remote to fail validation");
    expect(result.error.code).toBe("REMOTE_UNREACHABLE");
  });

  const managedPathRejectionCases = [
    { name: "rejects a managed path that targets the git directory", managedPath: ".git" },
    { name: "rejects a reserved Windows device name", managedPath: "CON/mux" },
    { name: "rejects a Windows path containing a colon", managedPath: "foo:bar/mux" },
    { name: "rejects a Windows path ending in a period", managedPath: "mux." },
  ];

  for (const testCase of managedPathRejectionCases) {
    test(testCase.name, async () => {
      const service = createService(tempDir);

      const result = await service.saveSettings({ ...SETTINGS, path: testCase.managedPath });

      expect(result.success).toBe(false);
      if (result.success) throw new Error(`Expected '${testCase.managedPath}' to be rejected`);
      expect(result.error.code).toBe("INVALID_BACKUP");
    });
  }

  test("reports a config write that never landed instead of claiming success", async () => {
    const config = new TestBackupConfig(tempDir);
    const service = createService(tempDir, {
      config,
    });
    // saveConfig logs and swallows write errors, so a full disk looks exactly like this:
    // the edit callback runs, editConfig resolves, and the stored config never changes.
    spyOn(config, "editConfig").mockImplementation((edit) => {
      edit(config.loadConfigOrDefault());
      return Promise.resolve();
    });

    const result = await service.saveSettings(SETTINGS);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the lost write to be reported");
    expect(result.error.code).toBe("IO_ERROR");
  });

  test("rejects and does not persist a repository URL that embeds a credential", async () => {
    const config = new TestBackupConfig(tempDir);
    const service = createService(tempDir, {
      config,
    });

    for (const repoUrl of [
      "https://oauth2:hunter2@example.com/repo.git",
      "https://oauth2:hunter2@",
      "https:oauth2:hunter2@",
      "ssh://user:hunter2@",
      "ssh:user:hunter2@",
      "https://example.com/repo.git?access_token=hunter2",
      "https://example.com/repo.git#access_token=hunter2",
    ]) {
      const result = await service.saveSettings({ ...SETTINGS, repoUrl });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected the credential URL to be rejected");
      expect(result.error.code).toBe("INVALID_BACKUP");
      expect(service.getSettings()).toBeNull();
    }
  });

  test("rejects invalid settings before config or repository access", async () => {
    const config = new TestBackupConfig(tempDir);
    let validateCalls = 0;
    let prepareCalls = 0;
    const service = createService(tempDir, {
      config,
      gitRepo: createGitRepo({
        validate: () => {
          validateCalls += 1;
          return Promise.resolve({ credential: "ssh", empty: false });
        },
        prepare: () => {
          prepareCalls += 1;
          return Promise.resolve(createRepository());
        },
      }),
    });

    for (const settings of [
      { ...SETTINGS, branch: "my branch" },
      { ...SETTINGS, branch: "-backup" },
      { ...SETTINGS, branch: "refs/heads/main" },
      { ...SETTINGS, repoUrl: "   " },
      { ...SETTINGS, branch: null } as unknown as SettingsBackupInput,
    ]) {
      const results = await Promise.all([
        service.saveSettings(settings),
        service.validate(settings),
        service.preview(settings),
        service.push(settings),
        service.restore(settings),
      ]);

      for (const result of results) {
        expect(result.success).toBe(false);
        if (result.success) throw new Error("Expected the invalid settings to be rejected");
        expect(result.error.code).toBe("INVALID_BACKUP");
      }
      expect(service.getSettings()).toBeNull();
    }
    expect(validateCalls).toBe(0);
    expect(prepareCalls).toBe(0);
  });

  test("normalizes direct service input like the ORPC schema", async () => {
    const seen: SettingsBackupInput[] = [];
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        validate: (settings) => {
          seen.push(settings);
          return Promise.resolve({ credential: "ssh", empty: false });
        },
      }),
    });
    const input = {
      repoUrl: ` ${SETTINGS.repoUrl} `,
      branch: ` ${SETTINGS.branch} `,
      path: ` ${SETTINGS.path} `,
    };

    const saved = await service.saveSettings(input);
    const validated = await service.validate(input);

    expect(saved.success).toBe(true);
    expect(validated.success).toBe(true);
    expect(service.getSettings()).toMatchObject(SETTINGS);
    expect(seen).toEqual([SETTINGS]);
  });

  test("surfaces the current command approvals when a restore is blocked", async () => {
    const approvals = [
      { path: "servers.notes.command", command: "npx notes-mcp", token: "token-notes" },
    ];
    const service = createService(tempDir, {
      payload: createPayload({
        validateRestore: () => Promise.reject(new BackupCommandApprovalRequiredError(approvals)),
      }),
    });
    await service.saveSettings(SETTINGS);

    const result = await service.restore(SETTINGS);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the unapproved restore to be blocked");
    expect(result.error.code).toBe("COMMAND_APPROVAL_REQUIRED");
    // Without the list, a restore attempted before any preview leaves the user with an
    // empty approval box and no way forward except guessing to run Preview again.
    expect(result.error.commandApprovals).toEqual(approvals);
  });

  test("does not revert a repository saved while a push was still running", async () => {
    const config = new TestBackupConfig(tempDir);
    const service = createService(tempDir, {
      config,
    });
    await service.saveSettings(SETTINGS);

    const other = { ...SETTINGS, repoUrl: "https://example.com/other.git" };
    await service.saveSettings(other);
    await service.push(SETTINGS);

    const stored = service.getSettings();
    expect(stored?.repoUrl).toBe(other.repoUrl);
  });

  test("serializes operations for the same repository", async () => {
    const firstCanFinish = Promise.withResolvers<void>();
    const starts: string[] = [];
    let prepareCount = 0;
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        prepare: async () => {
          prepareCount += 1;
          starts.push(`prepare-${prepareCount}`);
          if (prepareCount === 1) {
            await firstCanFinish.promise;
          }
          return createRepository();
        },
      }),
    });

    const first = service.preview(SETTINGS);
    await Promise.resolve();
    const second = service.preview(SETTINGS);
    await Promise.resolve();

    expect(starts).toEqual(["prepare-1"]);
    firstCanFinish.resolve();
    await Promise.all([first, second]);
    expect(starts).toEqual(["prepare-1", "prepare-2"]);
  });

  test("rejects invalid settings before waiting for the repository lock", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const firstCanFinish = Promise.withResolvers<void>();
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        prepare: async () => {
          firstStarted.resolve();
          await firstCanFinish.promise;
          return createRepository();
        },
      }),
    });

    const first = service.preview(SETTINGS);
    await firstStarted.promise;
    const invalid = service.preview({ ...SETTINGS, path: ".git" });
    const pending = Symbol("pending");
    try {
      const result = await Promise.race([
        invalid,
        new Promise<typeof pending>((resolve) => setImmediate(() => resolve(pending))),
      ]);
      if (result === pending) throw new Error("Invalid settings waited for the repository lock");
      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected the invalid settings to be rejected");
      expect(result.error.code).toBe("INVALID_BACKUP");
    } finally {
      firstCanFinish.resolve();
      await Promise.all([first, invalid]);
    }
  });

  test("snapshots settings before waiting for the repository lock", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const firstCanFinish = Promise.withResolvers<void>();
    const prepared: SettingsBackupInput[] = [];
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        prepare: async (settings) => {
          prepared.push(settings);
          if (prepared.length === 1) {
            firstStarted.resolve();
            await firstCanFinish.promise;
          }
          return createRepository();
        },
      }),
    });

    const first = service.preview(SETTINGS);
    await firstStarted.promise;
    const mutable = { ...SETTINGS };
    const second = service.preview(mutable);
    mutable.branch = "refs/heads/main";
    firstCanFinish.resolve();
    await Promise.all([first, second]);

    expect(prepared).toEqual([SETTINGS, SETTINGS]);
  });

  test("snapshots push approval before waiting for the repository lock", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const firstCanFinish = Promise.withResolvers<void>();
    let prepareCalls = 0;
    let pushCalls = 0;
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        prepare: async () => {
          prepareCalls += 1;
          if (prepareCalls === 1) {
            firstStarted.resolve();
            await firstCanFinish.promise;
          }
          return createRepository();
        },
        commitAndPush: () => {
          pushCalls += 1;
          return Promise.resolve({ commit: "pushed-commit", changed: true, credential: "gh" });
        },
      }),
      payload: createPayload({
        exportTo: () =>
          Promise.resolve({
            redactions: [],
            secretFiles: ["AGENTS.md"],
            secretApproval: "approved-digest",
          }),
      }),
    });

    const first = service.preview(SETTINGS);
    await firstStarted.promise;
    const options = { approvedSecretDigest: "stale-digest" };
    const second = service.push(SETTINGS, options);
    options.approvedSecretDigest = "approved-digest";
    firstCanFinish.resolve();
    const [, result] = await Promise.all([first, second]);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the stale approval to be rejected");
    expect(result.error.code).toBe("SECRET_DETECTED");
    expect(pushCalls).toBe(0);
  });

  test("snapshots restore approvals before waiting for the repository lock", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const firstCanFinish = Promise.withResolvers<void>();
    let prepareCalls = 0;
    const approvals = [
      { path: "servers.notes.command", command: "npx notes-mcp", token: "approved-token" },
    ];
    const seenTokens: string[][] = [];
    const service = createService(tempDir, {
      gitRepo: createGitRepo({
        prepare: async () => {
          prepareCalls += 1;
          if (prepareCalls === 1) {
            firstStarted.resolve();
            await firstCanFinish.promise;
          }
          return createRepository();
        },
      }),
      payload: createPayload({
        validateRestore: ({ approvedCommandTokens }) => {
          const tokens = [...(approvedCommandTokens ?? [])];
          seenTokens.push(tokens);
          return tokens.includes("approved-token")
            ? Promise.resolve()
            : Promise.reject(new BackupCommandApprovalRequiredError(approvals));
        },
      }),
    });

    const first = service.preview(SETTINGS);
    await firstStarted.promise;
    const options = { approvedCommandTokens: ["stale-token"] };
    const second = service.restore(SETTINGS, options);
    options.approvedCommandTokens[0] = "approved-token";
    firstCanFinish.resolve();
    const [, result] = await Promise.all([first, second]);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the stale approval to be rejected");
    expect(result.error.code).toBe("COMMAND_APPROVAL_REQUIRED");
    expect(seenTokens).toEqual([["stale-token"]]);
  });

  test("preserves commit metadata when saving the same repository settings", async () => {
    const service = createService(tempDir);

    const pushed = await service.push(SETTINGS);
    expect(pushed.success).toBe(true);

    const saved = await service.saveSettings(SETTINGS);

    expect(saved).toEqual({
      success: true,
      data: {
        ...SETTINGS,
        lastPushedCommit: "pushed-commit",
        lastRestoredCommit: undefined,
      },
    });
  });
});
