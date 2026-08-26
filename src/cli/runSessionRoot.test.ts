import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { prepareRunSessionRootOverride, replacePrivateRunConfigFile } from "./runSessionRoot";

describe("prepareRunSessionRootOverride", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-run-session-root-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("creates private roots and credential files under a permissive umask", async () => {
    const realConfigRoot = path.join(tempDir, "real-config");
    const overrideRoot = path.join(tempDir, "run-session");

    // This host's default umask (0077) would make these assertions pass even
    // without the hardening; pin a permissive umask so the modes are proven.
    const previousUmask = process.umask(0o022);
    try {
      await using preparedRoot = await prepareRunSessionRootOverride(
        { XUM_RUN_SESSION_ROOT: overrideRoot },
        realConfigRoot
      );
      expect(preparedRoot?.path).toBe(overrideRoot);
      const providersFile = path.join(overrideRoot, "providers.jsonc");
      await replacePrivateRunConfigFile(providersFile, "{}", preparedRoot);

      expect((await fs.stat(overrideRoot)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(providersFile)).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  test("rejects symlinked credential files without overwriting their targets", async () => {
    const runRoot = path.join(tempDir, "run-session");
    const targetFile = path.join(tempDir, "dataset-readable.json");
    const providersFile = path.join(runRoot, "providers.jsonc");
    await fs.mkdir(runRoot);
    await fs.writeFile(targetFile, "dataset content");
    await fs.symlink(targetFile, providersFile);

    let error: unknown;
    try {
      await replacePrivateRunConfigFile(providersFile, "copied credentials");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(await fs.readFile(targetFile, "utf8")).toBe("dataset content");
    expect((await fs.lstat(providersFile)).isSymbolicLink()).toBe(true);
  });

  test("removes stale credential files when the real configuration is empty", async () => {
    const runRoot = path.join(tempDir, "run-session");
    await fs.mkdir(runRoot);

    for (const fileName of ["providers.jsonc", "secrets.json"]) {
      const credentialFile = path.join(runRoot, fileName);
      await fs.writeFile(credentialFile, "stale credentials");

      await replacePrivateRunConfigFile(credentialFile, undefined);

      const exists = await fs
        .access(credentialFile)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    }
  });

  test("keeps credential writes pinned when the session root path is replaced", async () => {
    const realConfigRoot = path.join(tempDir, "real-config");
    const runRoot = path.join(tempDir, "run-session");
    const movedRoot = path.join(tempDir, "secured-session");
    await fs.mkdir(runRoot);
    await using preparedRoot = await prepareRunSessionRootOverride(
      { XUM_RUN_SESSION_ROOT: runRoot },
      realConfigRoot
    );
    if (preparedRoot === undefined) {
      throw new Error("Expected a prepared run session root");
    }

    await fs.rename(runRoot, movedRoot);
    await fs.mkdir(runRoot);
    const providersFile = path.join(runRoot, "providers.jsonc");

    let error: unknown;
    try {
      await replacePrivateRunConfigFile(providersFile, "copied credentials", preparedRoot);
    } catch (caught) {
      error = caught;
    }

    const replacementHasCredentials = await fs
      .access(providersFile)
      .then(() => true)
      .catch(() => false);
    expect(replacementHasCredentials).toBe(false);
    if (process.platform === "linux") {
      expect(error).toBeUndefined();
      expect(await fs.readFile(path.join(movedRoot, "providers.jsonc"), "utf8")).toBe(
        "copied credentials"
      );
    } else {
      expect(error).toBeInstanceOf(Error);
    }
  });

  test("tightens a pre-existing override root", async () => {
    const realConfigRoot = path.join(tempDir, "real-config");
    const overrideRoot = path.join(tempDir, "run-session");
    await fs.mkdir(realConfigRoot);
    await fs.mkdir(overrideRoot, { mode: 0o755 });
    await fs.chmod(overrideRoot, 0o755);

    await using preparedRoot = await prepareRunSessionRootOverride(
      { XUM_RUN_SESSION_ROOT: overrideRoot },
      realConfigRoot
    );

    expect(preparedRoot?.path).toBe(overrideRoot);
    expect((await fs.stat(overrideRoot)).mode & 0o777).toBe(0o700);
  });

  test("rejects a symlinked override without chmodding its target", async () => {
    const realConfigRoot = path.join(tempDir, "real-config");
    const targetRoot = path.join(tempDir, "attacker-target");
    const overrideRoot = path.join(tempDir, "run-session");
    await fs.mkdir(targetRoot, { mode: 0o755 });
    await fs.chmod(targetRoot, 0o755);
    await fs.symlink(targetRoot, overrideRoot, "dir");

    let error: unknown;
    try {
      await prepareRunSessionRootOverride({ XUM_RUN_SESSION_ROOT: overrideRoot }, realConfigRoot);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((await fs.stat(targetRoot)).mode & 0o777).toBe(0o755);
    expect((await fs.lstat(overrideRoot)).isSymbolicLink()).toBe(true);
  });

  test("rejects an override that canonically resolves to the real config root", async () => {
    const realConfigRoot = path.join(tempDir, "real-config");
    await fs.mkdir(realConfigRoot);
    const alias = path.join(realConfigRoot, "..", path.basename(realConfigRoot));

    let error: unknown;
    try {
      await prepareRunSessionRootOverride({ XUM_RUN_SESSION_ROOT: alias }, realConfigRoot);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("must not resolve to the Xum config root");
  });
});
