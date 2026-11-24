import { describe, expect, test } from "bun:test";
import { discoverAgentPluginsIn } from "./discovery";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";
import { createMemoryPluginFs, type MemoryNode } from "./memoryPluginFs";

const root = "/remote/checkout";
const container = `${root}/.xum/plugins`;

function memoryFs(entries: Record<string, MemoryNode>) {
  const nodes = new Map<string, MemoryNode>();
  for (const [remote, node] of Object.entries(entries)) {
    for (let dir = remote; dir !== "/"; ) {
      dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
      if (dir !== "/" && !nodes.has(dir)) nodes.set(dir, { kind: "dir" });
    }
    nodes.set(remote, node);
  }
  return createMemoryPluginFs(nodes, root, new Date(0));
}

const file = (text: string): MemoryNode => ({ kind: "file", bytes: Buffer.from(text) });
const link = (target: string | null): MemoryNode => ({ kind: "symlink", target });
const manifest = (name: string) =>
  file(JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name }));

describe("createMemoryPluginFs", () => {
  test("symlinks resolve inside the root only; an escaping or dangling link is missing", async () => {
    const fs = memoryFs({
      [`${root}/shared/kit/plugin.json`]: manifest("kit"),
      [`${container}/kit`]: link(`${root}/shared/kit`),
      // The root's parent exists in the tree, but it is outside the root.
      [`${container}/escape`]: link("/remote"),
      [`${container}/dangling`]: link(null),
    });
    const { plugins } = await discoverAgentPluginsIn(fs, [{ path: container, scope: "project" }]);
    expect(plugins.map((plugin) => [plugin.name, plugin.rootPath])).toEqual([
      ["kit", `${root}/shared/kit`],
    ]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test types `rejects` as void
    await expect(fs.realpath(`${container}/escape`)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.lstat(`${container}/escape`)).isSymbolicLink()).toBe(true);
  });

  test("a symlink loop fails with ELOOP", async () => {
    const fs = memoryFs({ [`${root}/a`]: link(`${root}/b`), [`${root}/b`]: link(`${root}/a`) });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test types `rejects` as void
    await expect(fs.stat(`${root}/a`)).rejects.toMatchObject({ code: "ELOOP" });
  });

  test("readFileCapped keeps the plugin reader's rules and returns a view of the bytes", async () => {
    const bytes = Buffer.from("body");
    const pluginRoot = `${container}/kit`;
    const fs = memoryFs({
      [`${pluginRoot}/SKILL.md`]: { kind: "file", bytes },
      [`${pluginRoot}/.git/config`]: file("secret"),
      [`${pluginRoot}/leak.md`]: link(`${pluginRoot}/.git/config`),
      [`${root}/outside.md`]: file("x"),
      [`${pluginRoot}/out.md`]: link(`${root}/outside.md`),
    });
    const read = (filePath: string, maxBytes = 99) =>
      fs.readFileCapped({ filePath, pluginRoot, maxBytes, label: "SKILL.md" });
    expect((await read(`${pluginRoot}/SKILL.md`)).bytes.buffer).toBe(bytes.buffer);
    for (const [filePath, message] of [
      [`${pluginRoot}/leak.md`, ".git"],
      [`${pluginRoot}/out.md`, "outside containment root"],
      [pluginRoot, "not a regular file"],
    ]) {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test types `rejects` as void
      await expect(read(filePath)).rejects.toThrow(message);
    }
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test types `rejects` as void
    await expect(read(`${pluginRoot}/SKILL.md`, 3)).rejects.toThrow("too large");
    expect(
      await fs.ensureContained(pluginRoot, `${pluginRoot}/new/x.md`, { allowMissing: true })
    ).toBe(`${pluginRoot}/new/x.md`);
    // A relative path once looped forever (dirname(".") is ".").
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test types `rejects` as void
    await expect(
      fs.ensureContained(pluginRoot, "rel/x", { allowMissing: true })
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
