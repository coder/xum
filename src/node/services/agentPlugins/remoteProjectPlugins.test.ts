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
  MAX_COLD_READS,
  MAX_COLD_READS_PER_HOST,
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
    // A whole archive with exit 1, as GNU tar does for "file changed as we read it".
    await writeFile(
      path.join(bin, "tar"),
      `#!/bin/sh\n${Bun.which("tar") ?? "tar"} "$@"\nexit 1\n`
    );
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

describe("buildRemotePluginListingScript", () => {
  test("without `readlink -f` it falls back to realpath; with neither, no plugins", async () => {
    using checkout = new DisposableTempDir("remote-plugins-readlink");
    const { root, container } = await checkoutWithKit(checkout.path);
    const bin = path.join(root, "bin");
    const fake = async (tool: string, script: string) => {
      await writeFile(path.join(bin, tool), `#!/bin/sh\n${script}\n`);
      await fs.chmod(path.join(bin, tool), 0o755);
    };
    await fake(
      "readlink",
      `[ "$1" = -f ] && exit 1\nexec ${Bun.which("readlink") ?? "readlink"} "$@"`
    );
    const snapshot = () =>
      createRemoteProjectPluginSnapshot({
        runtime: new CountingRemoteRuntime(root, "test", `PATH=${bin}:$PATH\n`),
        checkoutRoot: root,
        containers: [container],
      });
    expect((await snapshot())?.plugins.map((plugin) => plugin.name)).toEqual(["kit"]);
    await fake("realpath", "exit 1");
    expect(await snapshot()).toBeNull();
  });

  test("a plugin link to a folder inside its container is walked once", async () => {
    using checkout = new DisposableTempDir("remote-plugins-alias");
    const { root, container, kit } = await checkoutWithKit(checkout.path);
    // Walked twice, these entries would pass the entry cap.
    const many = path.join(kit, "skills", "review", "many");
    await fs.mkdir(many);
    await Promise.all(
      Array.from({ length: MAX_REMOTE_PLUGIN_ENTRIES / 2 + 100 }, (_, i) =>
        fs.mkdir(path.join(many, `d${i}`))
      )
    );
    await fs.symlink(kit, path.join(container, "alias"));
    const snapshot = await createRemoteProjectPluginSnapshot({
      runtime: new CountingRemoteRuntime(root, "test"),
      checkoutRoot: root,
      containers: [container],
    });
    expect(snapshot?.plugins.map((plugin) => plugin.rootPath)).toContain(kit);
  });
});

// Root reads any directory, so the unreadable one would not fail there.
test.skipIf(process.getuid?.() === 0)(
  "a directory the remote walk cannot read loads no plugins, not a partial set",
  async () => {
    using checkout = new DisposableTempDir("remote-plugins-unreadable");
    const { root, container, kit } = await checkoutWithKit(checkout.path);
    const locked = path.join(kit, "skills", "locked");
    await fs.mkdir(locked);
    await fs.chmod(locked, 0o000);
    try {
      const snapshot = await createRemoteProjectPluginSnapshot({
        runtime: new CountingRemoteRuntime(root, "test"),
        checkoutRoot: root,
        containers: [container],
      });
      expect(snapshot).toBeNull();
    } finally {
      await fs.chmod(locked, 0o755);
    }
  }
);

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

    // A failure is cached; once its retry delay is over it is read again and becomes the newest
    // entry. Here it is the oldest of 16, so a new key would evict it if it kept its place.
    clearRemoteProjectPluginSnapshots();
    const failing = new CountingRemoteRuntime(root, "down");
    failing.exec = () => {
      failing.execs++;
      return Promise.reject(new Error("ssh: connection refused"));
    };
    expect(await getRemoteProjectPluginSnapshot(failing, root, [container])).toBeNull();
    expect(await getRemoteProjectPluginSnapshot(failing, root, [container])).toBeNull();
    expect(failing.execs).toBe(1);
    for (const runtime of runtimes.slice(0, MAX_CACHED_SNAPSHOTS - 1)) {
      await getRemoteProjectPluginSnapshot(runtime, root, [container]);
    }
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    try {
      failing.exec = CountingRemoteRuntime.prototype.exec.bind(failing);
      expect(await getRemoteProjectPluginSnapshot(failing, root, [container])).not.toBeNull();
      await getRemoteProjectPluginSnapshot(runtimes[16], root, [container]);
      await getRemoteProjectPluginSnapshot(failing, root, [container]);
      expect(failing.execs).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  test("concurrent reads past the entry cap stay single-flight", async () => {
    using checkout = new DisposableTempDir("remote-plugins-inflight-cap");
    const { root, container } = await checkoutWithKit(checkout.path);
    const runtimes = Array.from(
      { length: MAX_CACHED_SNAPSHOTS + 1 },
      (_, i) => new CountingRemoteRuntime(root, `burst-${i}`)
    );
    const reads = runtimes.map((runtime) =>
      getRemoteProjectPluginSnapshot(runtime, root, [container])
    );
    // Still in flight: the same key must join the first read, not start another.
    const again = getRemoteProjectPluginSnapshot(runtimes[0], root, [container]);
    expect(await again).toBe(await reads[0]);
    await Promise.all(reads);
    expect(runtimes[0].execs).toBe(1);
  });

  test("at most MAX_COLD_READS distinct reads run at once; a clear drops queued ones", async () => {
    using checkout = new DisposableTempDir("remote-plugins-cold-bound");
    const { root, container } = await checkoutWithKit(checkout.path);
    let active = 0;
    let peak = 0;
    class TrackingRuntime extends CountingRemoteRuntime {
      override async exec(command: string, options: ExecOptions): Promise<ExecStream> {
        const stream = await super.exec(command, options);
        peak = Math.max(peak, ++active);
        return { ...stream, exitCode: stream.exitCode.finally(() => active--) };
      }
    }
    const burst = (name: string) =>
      Array.from(
        { length: MAX_COLD_READS + 2 },
        (_, i) => new TrackingRuntime(root, `${name}-${i}`)
      );
    const runtimes = burst("cold");
    const snapshots = await Promise.all(
      runtimes.map((runtime) => getRemoteProjectPluginSnapshot(runtime, root, [container]))
    );
    expect(snapshots.every((snapshot) => snapshot !== null)).toBe(true);
    expect(peak).toBeLessThanOrEqual(MAX_COLD_READS);
    // A trust change: the running reads are dropped, and the queued ones never run a command.
    const late = burst("late");
    const reads = late.map((runtime) => getRemoteProjectPluginSnapshot(runtime, root, [container]));
    clearRemoteProjectPluginSnapshots();
    expect(await Promise.all(reads)).toEqual(late.map(() => null));
    expect(late.reduce((sum, runtime) => sum + runtime.execs, 0)).toBe(MAX_COLD_READS);
  });

  test("a host that hangs takes at most MAX_COLD_READS_PER_HOST slots; another host still reads", async () => {
    using checkout = new DisposableTempDir("remote-plugins-per-host");
    const { root, container } = await checkoutWithKit(checkout.path);
    let release: (() => void) | undefined;
    const hung = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    class HangingRuntime extends CountingRemoteRuntime {
      override async exec(command: string, options: ExecOptions): Promise<ExecStream> {
        started++;
        await hung;
        return super.exec(command, options);
      }
    }
    // Distinct keys on one host: the same root with different container lists.
    const stuck = Array.from({ length: MAX_COLD_READS }, (_, i) =>
      getRemoteProjectPluginSnapshot(new HangingRuntime(root, "hung-host"), root, [
        container,
        ...Array.from({ length: i }, (_, j) => `${root}/extra-${j}`),
      ])
    );
    // The healthy host's read ends while the hung host still holds its slots; by then the hung
    // reads that got a slot have all reached exec.
    expect(
      await getRemoteProjectPluginSnapshot(new CountingRemoteRuntime(root, "healthy-host"), root, [
        container,
      ])
    ).not.toBeNull();
    expect(started).toBe(MAX_COLD_READS_PER_HOST);
    release?.();
    expect((await Promise.all(stuck)).every((snapshot) => snapshot !== null)).toBe(true);
    expect(started).toBe(MAX_COLD_READS);
  });

  test("a host key that throws or a failed read never throws, and a failed read is retried", async () => {
    using checkout = new DisposableTempDir("remote-plugins-throws");
    const { root, container } = await checkoutWithKit(checkout.path);
    class ThrowingKeyRuntime extends CountingRemoteRuntime {
      override getAgentHostKey(): string {
        throw new Error("no passwd entry");
      }
    }
    expect(
      await getRemoteProjectPluginSnapshot(new ThrowingKeyRuntime(root, "x"), root, [container])
    ).toBeNull();
    // An empty checkout root fails its read; the failure does not stay in flight forever.
    const runtime = new CountingRemoteRuntime(root, "empty-root");
    const debug = spyOn(log, "debug");
    try {
      expect(await getRemoteProjectPluginSnapshot(runtime, "", [container])).toBeNull();
      expect(await getRemoteProjectPluginSnapshot(runtime, "", [container])).toBeNull();
      const failures = debug.mock.calls.filter(
        ([message]) => typeof message === "string" && message.includes("read failed")
      );
      expect(failures).toHaveLength(2);
    } finally {
      debug.mockRestore();
    }
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
