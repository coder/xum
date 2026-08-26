import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { prepareRunSessionRootOverride, writePrivateRunConfigFile } from "./runSessionRoot";

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
      expect(
        await prepareRunSessionRootOverride({ XUM_RUN_SESSION_ROOT: overrideRoot }, realConfigRoot)
      ).toBe(overrideRoot);
      const providersFile = path.join(overrideRoot, "providers.jsonc");
      await writePrivateRunConfigFile(providersFile, "{}");

      expect((await fs.stat(overrideRoot)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(providersFile)).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  test("tightens a pre-existing override root", async () => {
    const realConfigRoot = path.join(tempDir, "real-config");
    const overrideRoot = path.join(tempDir, "run-session");
    await fs.mkdir(realConfigRoot);
    await fs.mkdir(overrideRoot, { mode: 0o755 });
    await fs.chmod(overrideRoot, 0o755);

    await prepareRunSessionRootOverride({ XUM_RUN_SESSION_ROOT: overrideRoot }, realConfigRoot);

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
