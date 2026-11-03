import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { resolveViteDevServerEnv } from "../src/vite/devServerEnv";

const SCRIPT = path.join(import.meta.dir, "dev-server-sandbox.ts");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * Runs the real sandbox script with a fake `make` that records the environment the sandbox hands
 * to `make dev-server`. The child env is built from scratch so the host's own XUM_VITE_* and
 * proxy variables cannot leak into the result.
 */
async function sandboxChildEnv(overrides: Record<string, string>): Promise<Record<string, string>> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dev-server-sandbox-test-"));
  tempDirs.push(dir);
  const dumpPath = path.join(dir, "child-env.txt");
  const fakeMake = path.join(dir, "fake-make.sh");
  await fs.writeFile(fakeMake, '#!/bin/sh\nenv > "$DUMP_PATH"\n', { mode: 0o755 });

  const proc = Bun.spawn([process.execPath, SCRIPT, "--clean-providers", "--clean-projects"], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      TMPDIR: dir,
      MAKE: fakeMake,
      DUMP_PATH: dumpPath,
      ...overrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(exitCode, stderr).toBe(0);

  const childEnv: Record<string, string> = {};
  for (const line of (await fs.readFile(dumpPath, "utf8")).split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) childEnv[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return childEnv;
}

describe("dev-server-sandbox allowed hosts", () => {
  test("accepts only loopback Host headers unless the user opts in", async () => {
    const childEnv = await sandboxChildEnv({});

    expect(childEnv.XUM_VITE_ALLOWED_HOSTS).toBeUndefined();
    expect(childEnv.MUX_VITE_ALLOWED_HOSTS).toBeUndefined();
    expect(childEnv.VITE_ALLOWED_HOSTS).toBeUndefined();
    expect(resolveViteDevServerEnv(childEnv).allowedHosts).toEqual(["localhost", "127.0.0.1"]);
  });

  test("passes the user's XUM_VITE_ALLOWED_HOSTS through unchanged", async () => {
    const childEnv = await sandboxChildEnv({ XUM_VITE_ALLOWED_HOSTS: "one.example,two.example" });

    expect(resolveViteDevServerEnv(childEnv).allowedHosts).toEqual(["one.example", "two.example"]);
  });

  test("passes the unprefixed VITE_ALLOWED_HOSTS fallback through", async () => {
    const childEnv = await sandboxChildEnv({ VITE_ALLOWED_HOSTS: "legacy.example" });

    expect(resolveViteDevServerEnv(childEnv).allowedHosts).toEqual(["legacy.example"]);
  });
});
