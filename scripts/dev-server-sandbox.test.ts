import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { resolveViteDevServerEnv } from "../src/vite/devServerEnv";
import { deriveProxyAllowedHost } from "./sandboxUtils";

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
async function runSandbox(
  overrides: Record<string, string>
): Promise<{ childEnv: Record<string, string>; stderr: string }> {
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
  return { childEnv, stderr };
}

async function sandboxChildEnv(overrides: Record<string, string>): Promise<Record<string, string>> {
  return (await runSandbox(overrides)).childEnv;
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

  test("allows only the Coder port-forward host of the sandbox's own Vite port", async () => {
    const childEnv = await sandboxChildEnv({
      VSCODE_PROXY_URI: "https://{{port}}--main--ws--user.coder.test",
    });

    expect(resolveViteDevServerEnv(childEnv).allowedHosts).toEqual([
      `${childEnv.XUM_VITE_PORT}--main--ws--user.coder.test`,
    ]);
  });

  test("an explicit opt-in replaces the derived Coder port-forward host", async () => {
    const childEnv = await sandboxChildEnv({
      VSCODE_PROXY_URI: "https://{{port}}--main--ws--user.coder.test",
      XUM_VITE_ALLOWED_HOSTS: "one.example",
    });

    expect(resolveViteDevServerEnv(childEnv).allowedHosts).toEqual(["one.example"]);
  });
});

describe("dev-server-sandbox proxy template warning", () => {
  test("names the variable and the opt-in when the template yields no host", async () => {
    const { stderr } = await runSandbox({ VSCODE_PROXY_URI: "https://coder.test/proxy/{{port}}/" });

    expect(stderr).toContain("WARNING: VSCODE_PROXY_URI");
    expect(stderr).toContain("XUM_VITE_ALLOWED_HOSTS=<host>");
  });

  test("names XUM_PROXY_URI when that is the variable in use", async () => {
    const { stderr } = await runSandbox({
      XUM_PROXY_URI: "https://coder.test",
      VSCODE_PROXY_URI: "https://{{port}}.vscode.test",
    });

    expect(stderr).toContain("WARNING: XUM_PROXY_URI");
  });

  test.each([
    ["no template is set", {}],
    ["a host is derived", { VSCODE_PROXY_URI: "https://{{port}}.vscode.test" }],
    [
      "the user opted in",
      { VSCODE_PROXY_URI: "https://coder.test", XUM_VITE_ALLOWED_HOSTS: "one.example" },
    ],
  ])("stays silent when %s", async (_name, overrides) => {
    const { stderr } = await runSandbox(overrides);

    expect(stderr).not.toContain("WARNING");
  });
});

describe("deriveProxyAllowedHost", () => {
  test("puts the port into a subdomain proxy template", () => {
    expect(
      deriveProxyAllowedHost({ VSCODE_PROXY_URI: "https://{{port}}--main--ws--user.coder.test" }, 5173)
    ).toBe("5173--main--ws--user.coder.test");
  });

  test("XUM_PROXY_URI wins over VSCODE_PROXY_URI", () => {
    expect(
      deriveProxyAllowedHost(
        {
          XUM_PROXY_URI: "https://{{port}}.xum.test",
          VSCODE_PROXY_URI: "https://{{port}}.vscode.test",
        },
        5173
      )
    ).toBe("5173.xum.test");
  });

  test.each([
    ["no template", {}],
    ["a template without the port", { VSCODE_PROXY_URI: "https://coder.test" }],
    ["a path-based template", { VSCODE_PROXY_URI: "https://coder.test/proxy/{{port}}/" }],
    ["a template that is not a URL", { VSCODE_PROXY_URI: "{{port}}--main" }],
    ["a leading dot, which Vite matches as a suffix", { VSCODE_PROXY_URI: "https://.{{port}}.test" }],
    ["a comma, which would add a second host", { VSCODE_PROXY_URI: "https://{{port}}.a,.b.test" }],
  ])("derives nothing from %s", (_name, env) => {
    expect(deriveProxyAllowedHost(env, 5173)).toBeNull();
  });
});
