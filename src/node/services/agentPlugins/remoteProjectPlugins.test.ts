import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { DockerRuntime } from "@/node/runtime/DockerRuntime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { ExecOptions, ExecStream } from "@/node/runtime/Runtime";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { ShellRemoteRuntime } from "@/node/runtime/testRemoteRuntime";
import { createSSHTransport } from "@/node/runtime/transports";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  clearRemoteProjectPluginSnapshots,
  discoverRemoteProjectAgentPlugins,
  buildRemotePluginListingScript,
  getRemoteProjectPluginSnapshot,
  isInsideMirror,
  MAX_REMOTE_PLUGIN_ENTRIES,
  parseRemotePluginListing,
} from "./remoteProjectPlugins";
import { execBuffered } from "@/node/utils/runtime/helpers";

// The listing script runs through Runtime.exec, so a LocalRuntime on a temp checkout runs the
// exact command an SSH or Docker runtime would run.

async function writePlugin(container: string, dirName: string, manifest: object): Promise<string> {
  const dir = path.join(container, dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
  return dir;
}

async function writeSkill(skillsDir: string, name: string): Promise<void> {
  await fs.mkdir(path.join(skillsDir, name), { recursive: true });
  await fs.writeFile(
    path.join(skillsDir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`
  );
}

const manifest = (name: string) => ({
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name,
});

async function discover(checkout: string) {
  const realCheckout = await fs.realpath(checkout);
  const container = path.join(realCheckout, ".xum", "plugins");
  const plugins = await discoverRemoteProjectAgentPlugins({
    runtime: new LocalRuntime(realCheckout),
    checkoutRoot: realCheckout,
    containers: [container],
  });
  return { realCheckout, container, byName: new Map(plugins.map((p) => [p.name, p])) };
}

describe("discoverRemoteProjectAgentPlugins", () => {
  test("lists skills and agents roots with remote paths and drops code components", async () => {
    using checkout = new DisposableTempDir("remote-plugins-checkout");
    const container = path.join(checkout.path, ".xum", "plugins");
    const dir = await writePlugin(container, "repo-plugin", manifest("repo-plugin"));
    await writeSkill(path.join(dir, "skills"), "review");
    await fs.mkdir(path.join(dir, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "agents", "helper.md"),
      "---\nname: Helper\ndescription: d\n---\nBody\n"
    );
    await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: {} }));

    const { realCheckout, byName } = await discover(checkout.path);

    const plugin = byName.get("repo-plugin");
    const root = path.join(realCheckout, ".xum", "plugins", "repo-plugin");
    expect(plugin?.rootPath).toBe(root);
    expect(plugin?.containerPath).toBe(path.join(realCheckout, ".xum", "plugins"));
    expect(plugin?.skillsDirs).toEqual([{ dir: path.join(root, "skills") }]);
    expect(plugin?.agentsDir).toBe(path.join(root, "agents"));
    // Code components are out of scope (#7218), so the result has no MCP or hooks fields.
    expect(Object.keys(plugin ?? {})).not.toContain("mcpConfigPath");
  });

  test("a backslash file name loads no plugins and writes nothing outside the mirror", async () => {
    using checkout = new DisposableTempDir("remote-plugins-backslash");
    const root = await fs.realpath(checkout.path);
    const container = path.join(root, ".xum", "plugins");
    const plugin = await writePlugin(container, "good", manifest("good"));
    await writeSkill(path.join(plugin, "skills"), "review");
    const escapeName = "evil-" + String(process.pid);
    await fs.writeFile(path.join(plugin, `..\\..\\${escapeName}`), "x");
    const plugins = await discoverRemoteProjectAgentPlugins({
      runtime: new LocalRuntime(root),
      checkoutRoot: root,
      containers: [container],
    });
    // The whole listing is refused, so the valid plugin next to it does not load either.
    expect(plugins).toEqual([]);
    expect(await fs.stat(path.join(path.dirname(root), escapeName)).catch(() => null)).toBeNull();
  });

  test("refuses symlinks whose realpath leaves the checkout, keeps contained ones", async () => {
    using checkout = new DisposableTempDir("remote-plugins-checkout");
    using outside = new DisposableTempDir("remote-plugins-outside");
    const container = path.join(checkout.path, ".xum", "plugins");
    await fs.mkdir(container, { recursive: true });

    // A plugin folder that is a symlink out of the checkout does not load.
    await writePlugin(outside.path, "outside-plugin", manifest("outside-plugin"));
    await fs.symlink(path.join(outside.path, "outside-plugin"), path.join(container, "outside"));

    // A plugin whose skills folder links out of the checkout loads without those skills.
    const leaky = await writePlugin(container, "leaky", manifest("leaky"));
    await writeSkill(path.join(outside.path, "stolen-skills"), "secret");
    await fs.symlink(path.join(outside.path, "stolen-skills"), path.join(leaky, "skills"));

    // A plugin folder that links to elsewhere INSIDE the checkout loads.
    const vendored = await writePlugin(
      path.join(checkout.path, "vendor"),
      "vendored",
      manifest("vendored")
    );
    await writeSkill(path.join(vendored, "skills"), "lint");
    await fs.symlink(vendored, path.join(container, "vendored"));

    const { realCheckout, byName } = await discover(checkout.path);

    expect(byName.has("outside-plugin")).toBe(false);
    expect(byName.get("leaky")?.skillsDirs).toBeUndefined();
    expect(byName.get("vendored")?.skillsDirs).toEqual([
      { dir: path.join(realCheckout, "vendor", "vendored", "skills") },
    ]);
  });

  test("keeps the manifest size cap of local discovery", async () => {
    using checkout = new DisposableTempDir("remote-plugins-checkout");
    const container = path.join(checkout.path, ".xum", "plugins");
    await writePlugin(container, "small", manifest("small"));
    await writePlugin(container, "huge", { ...manifest("huge"), description: "x".repeat(300_000) });

    const { byName } = await discover(checkout.path);

    expect(byName.has("small")).toBe(true);
    expect(byName.has("huge")).toBe(false);
  });

  test("a missing container or a runtime failure returns no plugins", async () => {
    using checkout = new DisposableTempDir("remote-plugins-checkout");
    expect((await discover(checkout.path)).byName.size).toBe(0);

    const failing = new LocalRuntime(checkout.path);
    failing.exec = () => Promise.reject(new Error("ssh: connection refused"));
    expect(
      await discoverRemoteProjectAgentPlugins({
        runtime: failing,
        checkoutRoot: checkout.path,
        containers: [path.join(checkout.path, ".xum", "plugins")],
      })
    ).toEqual([]);
  });
});

describe("buildRemotePluginListingScript", () => {
  test("never walks a container that resolves outside the checkout", async () => {
    using checkout = new DisposableTempDir("remote-plugins-escape-container");
    using outside = new DisposableTempDir("remote-plugins-outside");
    const root = await fs.realpath(checkout.path);
    await writePlugin(await fs.realpath(outside.path), "secret", manifest("secret"));
    await fs.mkdir(path.join(root, ".xum"), { recursive: true });
    const container = path.join(root, ".xum", "plugins");
    await fs.symlink(await fs.realpath(outside.path), container);
    const result = await execBuffered(
      new LocalRuntime(root),
      buildRemotePluginListingScript(root, [container]),
      { cwd: root, timeout: 30 }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("secret");
  });

  test("exits before reading the files of a tree with too many entries", async () => {
    using checkout = new DisposableTempDir("remote-plugins-many");
    const root = await fs.realpath(checkout.path);
    const container = path.join(root, ".xum", "plugins");
    const dir = path.join(container, "big");
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: MAX_REMOTE_PLUGIN_ENTRIES + 1 }, (_, i) =>
        fs.writeFile(path.join(dir, `f${i}`), "x")
      )
    );
    const result = await execBuffered(
      new LocalRuntime(root),
      buildRemotePluginListingScript(root, [container]),
      { cwd: root, timeout: 30 }
    );
    expect(result.exitCode).toBe(5);
  }, 60_000);
});

describe("parseRemotePluginListing", () => {
  test("fails closed on a cut-off, malformed or escaping listing", () => {
    const ok = "K\t0\t/r/.xum/plugins\t/r/.xum/plugins\nROOT\t0\t/r\t\nEND\n";
    expect(parseRemotePluginListing(ok)?.entries).toHaveLength(1);
    // No END line: the output was cut off.
    expect(parseRemotePluginListing("ROOT\t0\t/r\t\n")).toBeNull();
    // A name with a tab adds a field.
    expect(parseRemotePluginListing("D\t0\t\t/r/a\tb\nROOT\t0\t/r\t\nEND\n")).toBeNull();
    // An F line without its blob.
    expect(parseRemotePluginListing("ROOT\t0\t/r\t\nF\t2\t\t/r/x/plugin.json\nEND\n")).toBeNull();
  });

  test("refuses the whole listing when two paths fold to one name on a case-insensitive host", () => {
    const withDirs = (...dirs: string[]) =>
      parseRemotePluginListing(
        `${dirs.map((dir) => `D\t0\t\t${dir}\n`).join("")}ROOT\t0\t/r\t\nEND\n`
      );
    expect(withDirs("/r/p/guide", "/r/p/GUIDE")).toBeNull();
    // NFC: a precomposed and a decomposed accent are one name on APFS.
    expect(withDirs("/r/p/caf\u00e9", "/r/p/cafe\u0301")).toBeNull();
    // One directory listed twice (two containers resolve to it) is fine.
    expect(withDirs("/r/p/guide", "/r/p/guide")?.entries).toHaveLength(2);
  });

  test("refuses the whole listing for a name a Windows host could read as a path", () => {
    const withDir = (dir: string, target = "") =>
      parseRemotePluginListing(`D\t0\t\t/r/p/ok\nL\t0\t${target}\t${dir}\nROOT\t0\t/r\t\nEND\n`);
    expect(withDir("/r/p/link", "/r/p/ok")?.entries).toHaveLength(2);
    expect(withDir("/r/p/a\\..\\..\\Startup")).toBeNull();
    expect(withDir("/r/p/../../etc")).toBeNull();
    expect(withDir("/r/p/C:x")).toBeNull();
    expect(withDir("/r/p//x")).toBeNull();
    // A symlink target is checked too.
    expect(withDir("/r/p/link", "/r/p/a\\..\\x")).toBeNull();
  });

  test("the mirror containment check follows the host path rules (win32)", () => {
    const mirror = "C:\\Temp\\xum-remote-plugins-1-ab";
    expect(isInsideMirror(path.win32, mirror, `${mirror}\\p\\SKILL.md`)).toBe(true);
    expect(isInsideMirror(path.win32, mirror, `${mirror}\\p\\..\\..\\Startup\\x.cmd`)).toBe(false);
    expect(isInsideMirror(path.win32, mirror, "D:\\x")).toBe(false);
    expect(isInsideMirror(path.win32, mirror, mirror)).toBe(false);
    expect(isInsideMirror(path.win32, mirror, `${mirror}\\..x`)).toBe(true);
  });

  test("splits a blob among its files in order, and fails closed when the sizes do not add up", () => {
    const listing = (sizes: [number, number], blob: string) =>
      `F\t${sizes[0]}\t\t/r/p/a\nF\t${sizes[1]}\t\t/r/p/b\nB\t0\t\t/r/p\n${blob}\n.\nROOT\t0\t/r\t\nEND\n`;
    const blob = Buffer.from("hello").toString("base64");
    const parsed = parseRemotePluginListing(listing([2, 3], blob));
    expect(parsed?.entries.map((entry) => entry.data?.toString())).toEqual(["he", "llo"]);
    // A file that changed between the size pass and the read pass.
    expect(parseRemotePluginListing(listing([2, 4], blob))).toBeNull();
    expect(parseRemotePluginListing(listing([2, 3], "not base64!"))).toBeNull();
  });
});

/** A remote runtime that runs its commands in a local shell and counts them. */
class CountingRemoteRuntime extends ShellRemoteRuntime {
  execs = 0;
  constructor(
    loginDir: string,
    private readonly hostKey: string
  ) {
    super(loginDir);
  }
  override getAgentHostKey(): string {
    return this.hostKey;
  }
  override exec(command: string, options: ExecOptions): Promise<ExecStream> {
    this.execs++;
    return super.exec(command, options);
  }
}

describe("getRemoteProjectPluginSnapshot", () => {
  test("one exec per key until trust changes; the cleared mirror is removed", async () => {
    using checkout = new DisposableTempDir("remote-plugins-cache");
    const root = await fs.realpath(checkout.path);
    const container = path.join(root, ".xum", "plugins");
    await writeSkill(
      path.join(await writePlugin(container, "cached", manifest("cached")), "skills"),
      "review"
    );
    const deepRelative = path.join(
      ".xum/plugins/cached/skills/review/refs",
      ..."abcdefghijkl".split(""),
      "deep.md"
    );
    await fs.mkdir(path.dirname(path.join(root, deepRelative)), { recursive: true });
    await fs.writeFile(path.join(root, deepRelative), "deep");
    const runtime = new CountingRemoteRuntime(root, `test:${root}`);

    const [first, second] = await Promise.all([
      getRemoteProjectPluginSnapshot(runtime, root, [container]),
      getRemoteProjectPluginSnapshot(runtime, root, [container]),
    ]);
    expect(await getRemoteProjectPluginSnapshot(runtime, root, [container])).toBe(first);
    expect(second).toBe(first);
    expect(runtime.execs).toBe(1);
    expect(first?.plugins.map((plugin) => plugin.name)).toEqual(["cached"]);
    // No depth limit: a file far below its skill is in the mirror.
    expect(await fs.readFile(path.join(first?.mirrorRoot ?? "", deepRelative), "utf8")).toBe(
      "deep"
    );
    const mirror = first?.mirrorRoot ?? "";

    clearRemoteProjectPluginSnapshots();
    expect(await fs.stat(mirror).catch(() => null)).toBeNull();
    await getRemoteProjectPluginSnapshot(runtime, root, [container]);
    expect(runtime.execs).toBe(2);
    clearRemoteProjectPluginSnapshots();
  });

  test("a trust change during a read drops that read's snapshot", async () => {
    using checkout = new DisposableTempDir("remote-plugins-inflight");
    const root = await fs.realpath(checkout.path);
    const container = path.join(root, ".xum", "plugins");
    await writePlugin(container, "late", manifest("late"));
    const runtime = new CountingRemoteRuntime(root, `test:${root}`);
    // The clear runs while the create is in flight: its result is not cached.
    const inFlight = getRemoteProjectPluginSnapshot(runtime, root, [container]);
    clearRemoteProjectPluginSnapshots();
    expect(await inFlight).toBeNull();
    expect(await getRemoteProjectPluginSnapshot(runtime, root, [container])).not.toBeNull();
    expect(runtime.execs).toBe(2);
    clearRemoteProjectPluginSnapshots();
  });

  test("a failed read is not retried at once and leaves no mirror", async () => {
    using checkout = new DisposableTempDir("remote-plugins-fail");
    const runtime = new CountingRemoteRuntime(checkout.path, "test:failing");
    runtime.exec = () => {
      runtime.execs++;
      return Promise.reject(new Error("ssh: connection refused"));
    };
    const container = path.join(checkout.path, ".xum", "plugins");
    expect(await getRemoteProjectPluginSnapshot(runtime, checkout.path, [container])).toBeNull();
    expect(await getRemoteProjectPluginSnapshot(runtime, checkout.path, [container])).toBeNull();
    expect(runtime.execs).toBe(1);
    clearRemoteProjectPluginSnapshots();
  });

  test("two Docker containers or two SSH users with the same checkout path get different host keys", () => {
    const keyOf = (containerName?: string) =>
      new DockerRuntime({ image: "node:22", containerName }).getAgentHostKey();
    expect(keyOf("xum-a")).not.toBe(keyOf("xum-b"));
    // A container that is not created yet has no identity: no snapshot is used.
    expect(keyOf(undefined)).toBeUndefined();

    const sshKeyOf = (host: string) => {
      const config = { host, srcBaseDir: "/home/shared/src" };
      return new SSHRuntime(config, createSSHTransport(config, false)).getAgentHostKey();
    };
    expect(sshKeyOf("alice@build.example")).not.toBe(sshKeyOf("bob@build.example"));
    expect(sshKeyOf("alice@build.example")).toBe(sshKeyOf("alice@build.example"));
    // An unset port comes from the SSH config, so it is not the same endpoint as port 22.
    const withPort = (port?: number) => {
      const config = { host: "build", port, srcBaseDir: "/src" };
      return new SSHRuntime(config, createSSHTransport(config, false)).getAgentHostKey();
    };
    expect(withPort(undefined)).not.toBe(withPort(22));
  });
});
