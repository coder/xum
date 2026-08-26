import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { prepareRunSessionRootOverride, writePrivateRunConfigFile } from "./runSessionRoot";

describe("prepareRunSessionRootOverride", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xum-run-session-root-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("creates private roots and credential files under a permissive umask", () => {
    const realConfigRoot = path.join(tempDir, "real-config");
    const overrideRoot = path.join(tempDir, "run-session");

    const previousUmask = process.umask(0o022);
    try {
      expect(
        prepareRunSessionRootOverride({ XUM_RUN_SESSION_ROOT: overrideRoot }, realConfigRoot)
      ).toBe(overrideRoot);
      const providersFile = path.join(overrideRoot, "providers.jsonc");
      writePrivateRunConfigFile(providersFile, "{}");

      expect(fs.statSync(overrideRoot).mode & 0o777).toBe(0o700);
      expect(fs.statSync(providersFile).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  test("tightens a pre-existing override root", () => {
    const realConfigRoot = path.join(tempDir, "real-config");
    const overrideRoot = path.join(tempDir, "run-session");
    fs.mkdirSync(realConfigRoot);
    fs.mkdirSync(overrideRoot, { mode: 0o755 });
    fs.chmodSync(overrideRoot, 0o755);

    prepareRunSessionRootOverride({ XUM_RUN_SESSION_ROOT: overrideRoot }, realConfigRoot);

    expect(fs.statSync(overrideRoot).mode & 0o777).toBe(0o700);
  });

  test("rejects an override that canonically resolves to the real config root", () => {
    const realConfigRoot = path.join(tempDir, "real-config");
    fs.mkdirSync(realConfigRoot);
    const alias = path.join(realConfigRoot, "..", path.basename(realConfigRoot));

    expect(() =>
      prepareRunSessionRootOverride({ XUM_RUN_SESSION_ROOT: alias }, realConfigRoot)
    ).toThrow("must not resolve to the Xum config root");
  });
});
