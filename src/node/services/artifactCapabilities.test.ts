import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DISABLE_PROJECT_AUTOMATION_ENV } from "@/node/utils/projectAutomation";
import {
  AgentBrowserProbeCache,
  getArtifactCapabilities,
  probeAgentBrowser,
} from "./artifactCapabilities";

describe("probeAgentBrowser", () => {
  let tempDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-browser-probe-"));
    originalPath = process.env.PATH;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("answers from the runtime's PATH", async () => {
    const bin = path.join(tempDir, "bin");
    await fs.mkdir(bin);
    const runtime = new LocalRuntime(tempDir);

    process.env.PATH = `${bin}:/usr/bin:/bin`;
    expect(await probeAgentBrowser(runtime)).toBe(false);

    await fs.writeFile(path.join(bin, "agent-browser"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(await probeAgentBrowser(runtime)).toBe(true);
  });
});

describe("getArtifactCapabilities", () => {
  let tempDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-browser-env-")));
    originalPath = process.env.PATH;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("finds agent-browser through a trusted project's .xum/tool_env, like the bash tool", async () => {
    // agent-browser lives only in a project-local bin that tool_env puts on PATH.
    const project = path.join(tempDir, "project");
    const bin = path.join(project, "tools", "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "agent-browser"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.mkdir(path.join(project, ".xum"));
    await fs.writeFile(
      path.join(project, ".xum", "tool_env"),
      'export PATH="$PWD/tools/bin:$PATH"\n'
    );
    process.env.PATH = "/usr/bin:/bin";
    const cache = new AgentBrowserProbeCache();
    const probe = (trusted: boolean) =>
      getArtifactCapabilities({
        workspaceId: "ws",
        runtimeKey: "local",
        createRuntime: () => new LocalRuntime(project),
        resolveCwd: () => project,
        trusted,
        cache,
      });

    // Untrusted projects never run repo-controlled tool_env code.
    expect(await probe(false)).toEqual({ agentBrowserAvailable: false });
    // Trusting the project is a new cache key, so the cached false does not stick.
    expect(await probe(true)).toEqual({ agentBrowserAvailable: true });
  });

  test("the project-automation kill switch keeps a trusted project's tool_env from running", async () => {
    const project = path.join(tempDir, "project");
    await fs.mkdir(path.join(project, ".xum"), { recursive: true });
    const marker = path.join(tempDir, "tool_env-ran");
    await fs.writeFile(path.join(project, ".xum", "tool_env"), `touch ${JSON.stringify(marker)}\n`);
    process.env.PATH = "/usr/bin:/bin";
    const previous = process.env[DISABLE_PROJECT_AUTOMATION_ENV];
    process.env[DISABLE_PROJECT_AUTOMATION_ENV] = "1";
    try {
      expect(
        await getArtifactCapabilities({
          workspaceId: "ws",
          runtimeKey: "local",
          createRuntime: () => new LocalRuntime(project),
          resolveCwd: () => project,
          trusted: true,
          cache: new AgentBrowserProbeCache(),
        })
      ).toEqual({ agentBrowserAvailable: false });
    } finally {
      if (previous === undefined) delete process.env[DISABLE_PROJECT_AUTOMATION_ENV];
      else process.env[DISABLE_PROJECT_AUTOMATION_ENV] = previous;
    }
    expect(
      await fs.access(marker).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });
});

describe("AgentBrowserProbeCache", () => {
  test("probes once per workspace and runtime, sharing an in-flight probe", async () => {
    const cache = new AgentBrowserProbeCache();
    let calls = 0;
    const probe = () => {
      calls++;
      return Promise.resolve(false);
    };
    const [a, b] = await Promise.all([
      cache.get("ws", "local", probe),
      cache.get("ws", "local", probe),
    ]);
    expect([a, b, calls]).toEqual([false, false, 1]);
    expect(await cache.get("ws", "local", probe)).toBe(false);
    expect(calls).toBe(1);
    // A recreated workspace on another runtime probes again.
    expect(await cache.get("ws", "ssh", probe)).toBe(false);
    expect(calls).toBe(2);
  });

  test("failures report null and are not cached", async () => {
    const cache = new AgentBrowserProbeCache();
    let calls = 0;
    const failing = () => {
      calls++;
      return Promise.reject(new Error("unreachable"));
    };
    expect(await cache.get("ws", "local", failing)).toBeNull();
    expect(await cache.get("ws", "local", () => Promise.resolve(null))).toBeNull();
    expect(await cache.get("ws", "local", () => Promise.resolve(true))).toBe(true);
    expect(calls).toBe(1);
  });

  test("a runtime that cannot be created reports null", async () => {
    const result = await getArtifactCapabilities({
      workspaceId: "ws",
      runtimeKey: "bad",
      createRuntime: () => {
        throw new Error("no runtime");
      },
      cache: new AgentBrowserProbeCache(),
    });
    expect(result).toEqual({ agentBrowserAvailable: null });
  });
});
