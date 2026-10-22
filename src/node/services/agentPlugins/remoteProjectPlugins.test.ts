import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DockerRuntime, getContainerName } from "@/node/runtime/DockerRuntime";
import type { ExecOptions, ExecStream } from "@/node/runtime/Runtime";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { ShellRemoteRuntime } from "@/node/runtime/testRemoteRuntime";
import { createSSHTransport } from "@/node/runtime/transports";
import { log } from "@/node/services/log";
import { DisposableTempDir } from "@/node/services/tempDir";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";
import {
  clearRemoteProjectPluginSnapshots,
  createRemoteProjectPluginSnapshot,
  getRemoteProjectPluginSnapshot,
  MAX_CACHED_SNAPSHOTS,
} from "./remoteProjectPlugins";
import { MAX_REMOTE_PLUGIN_ENTRIES } from "./remotePluginListing";

// The listing script runs through RemoteRuntime.exec in a local shell, so these tests run the
// exact command an SSH or Docker runtime would run (with the host's GNU tools).

/** Counts execs; `prefix` runs before the listing script (e.g. a PATH without tar). */
class CountingRemoteRuntime extends ShellRemoteRuntime {
  execs = 0;
  constructor(
    loginDir: string,
    private readonly hostKey: string,
    private readonly prefix = ""
  ) {
    super(loginDir);
  }
  override getAgentHostKey(): string {
    return this.hostKey;
  }
  override exec(command: string, options: ExecOptions): Promise<ExecStream> {
    this.execs++;
    return super.exec(this.prefix + command, options);
  }
}

async function writeFile(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

/** A checkout with plugin `kit` (one skill, one agent, an MCP config) in `.xum/plugins`. */
async function checkoutWithKit(dir: string) {
  const root = await fs.realpath(dir);
  const container = path.join(root, ".xum", "plugins");
  const kit = path.join(container, "kit");
  await writeFile(
    path.join(kit, "plugin.json"),
    JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "kit" })
  );
  await writeFile(
    path.join(kit, "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: d\n---\nBody\n"
  );
  await writeFile(path.join(kit, "agents", "helper.md"), "---\nname: Helper\n---\nBody\n");
  await writeFile(path.join(kit, "mcp.json"), JSON.stringify({ mcpServers: {} }));
  return { root, container, kit };
}

afterEach(() => clearRemoteProjectPluginSnapshots());

describe("createRemoteProjectPluginSnapshot", () => {
  test("lists skills and agents with remote paths, readable from memory", async () => {
    using checkout = new DisposableTempDir("remote-plugins");
    const { root, container, kit } = await checkoutWithKit(checkout.path);
    // A container that resolves outside the checkout is never walked.
    using outside = new DisposableTempDir("remote-plugins-outside");
    await writeFile(path.join(outside.path, "evil", "plugin.json"), "{}");
    await fs.symlink(outside.path, path.join(root, "linked"));
    const runtime = new CountingRemoteRuntime(root, "test");
    const snapshot = await createRemoteProjectPluginSnapshot({
      runtime,
      checkoutRoot: root,
      containers: [container, path.join(root, "linked")],
    });
    expect(snapshot?.plugins).toEqual([
      expect.objectContaining({
        name: "kit",
        rootPath: kit,
        skillsDirs: [expect.objectContaining({ dir: path.join(kit, "skills") })],
        agentsDir: path.join(kit, "agents"),
      }),
    ]);
    // MCP servers, hooks, workflows and commands run code: not part of the result.
    expect(snapshot?.plugins[0]).not.toHaveProperty("mcpConfigPath");
    expect(await snapshot?.fs.realpath(path.join(root, "linked")).catch(() => null)).toBeNull();
  });

  test("no tar, a failing tar or too many entries loads no plugins", async () => {
    using checkout = new DisposableTempDir("remote-plugins-tar");
    const { root, container } = await checkoutWithKit(checkout.path);
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    for (const tool of ["find", "readlink", "sed", "head", "wc", "base64"]) {
      await fs.symlink(Bun.which(tool) ?? tool, path.join(bin, tool));
    }
    const snapshotWith = (prefix: string) =>
      createRemoteProjectPluginSnapshot({
        runtime: new CountingRemoteRuntime(root, "test", prefix),
        checkoutRoot: root,
        containers: [container],
      });
    expect(await snapshotWith("")).not.toBeNull();
    const debug = spyOn(log, "debug");
    try {
      expect(await snapshotWith(`PATH=${bin}\n`)).toBeNull();
      const ours = debug.mock.calls.filter(
        ([message]) => typeof message === "string" && message.startsWith("Remote project plugins")
      );
      expect(ours).toEqual([[expect.any(String), { exitCode: 6 }]]);
    } finally {
      debug.mockRestore();
    }
    await writeFile(path.join(bin, "tar"), "#!/bin/sh\nexit 2\n");
    await fs.chmod(path.join(bin, "tar"), 0o755);
    expect(await snapshotWith(`PATH=${bin}\n`)).toBeNull();
    await fs.rm(bin, { recursive: true });
    const crowded = path.join(container, "kit", "skills", "crowded");
    await fs.mkdir(crowded);
    await Promise.all(
      Array.from({ length: MAX_REMOTE_PLUGIN_ENTRIES }, (_, i) =>
        fs.mkdir(path.join(crowded, `d${i}`))
      )
    );
    expect(await snapshotWith("")).toBeNull();
  });
});

describe("getRemoteProjectPluginSnapshot", () => {
  test("one exec per key, shared while in flight, until trust changes", async () => {
    using checkout = new DisposableTempDir("remote-plugins-cache");
    const { root, container } = await checkoutWithKit(checkout.path);
    const runtime = new CountingRemoteRuntime(root, "test");
    const [first, second] = await Promise.all([
      getRemoteProjectPluginSnapshot(runtime, root, [container]),
      getRemoteProjectPluginSnapshot(runtime, root, [container]),
    ]);
    expect(second).toBe(first);
    expect(await getRemoteProjectPluginSnapshot(runtime, root, [container])).toBe(first);
    expect(runtime.execs).toBe(1);
    // A trust change during a read: that read is not used, the next one reads again.
    clearRemoteProjectPluginSnapshots();
    const inFlight = getRemoteProjectPluginSnapshot(runtime, root, [container]);
    clearRemoteProjectPluginSnapshots();
    expect(await inFlight).toBeNull();
    expect(await getRemoteProjectPluginSnapshot(runtime, root, [container])).not.toBeNull();
    expect(runtime.execs).toBe(3);
  });

  test("the least recently used key goes over the entry cap; a failure is not retried at once", async () => {
    using checkout = new DisposableTempDir("remote-plugins-lru");
    const { root, container } = await checkoutWithKit(checkout.path);
    const runtimes = Array.from(
      { length: MAX_CACHED_SNAPSHOTS + 1 },
      (_, i) => new CountingRemoteRuntime(root, `host-${i}`)
    );
    for (const runtime of runtimes)
      await getRemoteProjectPluginSnapshot(runtime, root, [container]);
    await getRemoteProjectPluginSnapshot(runtimes[1], root, [container]);
    await getRemoteProjectPluginSnapshot(runtimes[0], root, [container]);
    // runtimes[1] was used last, so runtimes[2] made room for runtimes[0].
    await getRemoteProjectPluginSnapshot(runtimes[1], root, [container]);
    await getRemoteProjectPluginSnapshot(runtimes[2], root, [container]);
    expect(runtimes.slice(0, 3).map((runtime) => runtime.execs)).toEqual([2, 1, 2]);

    const failing = new CountingRemoteRuntime(root, "down");
    failing.exec = () => {
      failing.execs++;
      return Promise.reject(new Error("ssh: connection refused"));
    };
    expect(await getRemoteProjectPluginSnapshot(failing, root, [container])).toBeNull();
    expect(await getRemoteProjectPluginSnapshot(failing, root, [container])).toBeNull();
    expect(failing.execs).toBe(1);
  });

  test("host keys separate SSH users, ports and keys, and recreated Docker containers", async () => {
    const sshKey = (config: { host: string; port?: number; identityFile?: string }) => {
      const full = { ...config, srcBaseDir: "/src" };
      return new SSHRuntime(full, createSSHTransport(full, false)).getAgentHostKey();
    };
    const keys = [
      sshKey({ host: "alice@build" }),
      sshKey({ host: "bob@build" }),
      // An unset port comes from the SSH config, so it is not port 22.
      sshKey({ host: "alice@build", port: 22 }),
      sshKey({ host: "alice@build", identityFile: "~/.ssh/other" }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(sshKey({ host: "alice@build" })).toBe(keys[0]);

    const docker = new DockerRuntime({
      image: "node:22",
      containerName: getContainerName("/p6426", "w"),
    });
    const before = docker.getAgentHostKey();
    // Deleting (or creating) the container under this name gives it a new key.
    await docker.deleteWorkspace("/p6426", "w", true).catch(() => undefined);
    expect(docker.getAgentHostKey()).not.toBe(before);
    expect(new DockerRuntime({ image: "node:22" }).getAgentHostKey()).toBeUndefined();
  });
});
