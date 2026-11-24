import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runScript, SPAWNING_TEST_TIMEOUT_MS } from "./ci/runScript";

setDefaultTimeout(SPAWNING_TEST_TIMEOUT_MS);

const SCRIPT = path.join(import.meta.dir, "generate-version.sh");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "generate-version-"));
  await mkdir(path.join(dir, "src"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function describeFor(releaseTag: string): Promise<string> {
  const result = await runScript(["bash", SCRIPT], {
    cwd: dir,
    env: { RELEASE_TAG: releaseTag, SOURCE_DATE_EPOCH: "0", XUM_GIT_COMMIT: "abc1234" },
  });
  expect(result.exitCode).toBe(0);
  const version = await readFile(path.join(dir, "src/version.ts"), "utf8");
  const match = /git_describe: "([^"]*)"/.exec(version);
  if (!match) throw new Error(`no git_describe in:\n${version}`);
  return match[1];
}

describe("generate-version.sh with RELEASE_TAG", () => {
  test("a nightly tag without the v prefix gets one", async () => {
    expect(await describeFor("0.32.3-nightly.44")).toBe("v0.32.3-nightly.44");
  });

  test("a stable tag keeps its single v prefix", async () => {
    expect(await describeFor("v0.32.2")).toBe("v0.32.2");
  });

  test("a Nix revision stays as it is", async () => {
    const rev = "95a17103abc0def95a17103abc0def95a17103ab";
    expect(await describeFor(rev)).toBe(rev);
  });
});
