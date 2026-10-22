import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  discoverRemoteProjectAgentPlugins,
  parseRemotePluginListing,
} from "./remoteProjectPlugins";

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

describe("parseRemotePluginListing", () => {
  test("fails closed on a cut-off, malformed or escaping listing", () => {
    const ok = "K\t0\t/r/.xum/plugins\t/r/.xum/plugins\nROOT\t0\t/r\t\nEND\n";
    expect(parseRemotePluginListing(ok)?.entries).toHaveLength(1);
    // No END line: the output was cut off.
    expect(parseRemotePluginListing("ROOT\t0\t/r\t\n")).toBeNull();
    // A name with a tab adds a field.
    expect(parseRemotePluginListing("D\t0\t\t/r/a\tb\nROOT\t0\t/r\t\nEND\n")).toBeNull();
    // An F line without its content line.
    expect(parseRemotePluginListing("ROOT\t0\t/r\t\nF\t2\t\t/r/x/plugin.json\nEND\n")).toBeNull();
  });
});
