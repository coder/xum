import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import {
  discoverAgentPlugins,
  discoverAgentPluginsIn,
  type PluginFs,
  type PluginFsStat,
} from "./discovery";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";

/** A minimal in-memory PluginFs: directories and regular files, no symlinks. */
function memoryFs(files: Record<string, string>): PluginFs {
  const dirs = new Set<string>();
  for (const file of Object.keys(files)) {
    for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      dirs.add(dir);
    }
  }
  const missing = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  const statOf = (p: string): PluginFsStat => {
    if (dirs.has(p)) return kind("dir", 0);
    if (p in files) return kind("file", Buffer.byteLength(files[p]));
    throw missing(p);
  };
  const kind = (k: "dir" | "file", size: number) => ({
    isFile: () => k === "file",
    isDirectory: () => k === "dir",
    isSymbolicLink: () => false,
    size,
  });
  // Like node:fs/promises, failures reject instead of throwing synchronously.
  const later = <T>(fn: () => T): Promise<T> => new Promise((resolve) => resolve(fn()));
  const realpath = (p: string) =>
    later(() => {
      statOf(p);
      return p;
    });
  return {
    realpath,
    stat: (p) => later(() => statOf(p)),
    lstat: (p) => later(() => statOf(p)),
    readdir: (dir) =>
      later(() => {
        statOf(dir);
        const names = new Set(
          [...dirs, ...Object.keys(files)]
            .filter((p) => path.dirname(p) === dir)
            .map((p) => path.basename(p))
        );
        return [...names].map((name) => ({ name, ...statOf(path.join(dir, name)) }));
      }),
    ensureContained: async (root, candidate) => {
      const real = await realpath(candidate);
      if (!real.startsWith(root + path.sep)) throw new Error("outside the root");
      return real;
    },
    readFileCapped: (args) => {
      const content = files[args.filePath];
      if (content === undefined) return Promise.reject(missing(args.filePath));
      const bytes = Buffer.from(content);
      return Promise.resolve({ content, bytes, byteSize: bytes.length, modifiedTime: new Date(0) });
    },
  };
}

// None of these paths exist on the host: every read must go through the PluginFs.
const container = "/nonexistent-6426/checkout/.xum/plugins";
const pluginDir = path.join(container, "kit");
const files = {
  [path.join(pluginDir, "plugin.json")]: JSON.stringify({
    $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
    name: "kit",
  }),
  [path.join(pluginDir, "skills", "review", "SKILL.md")]:
    "---\nname: review\ndescription: d\n---\n",
  [path.join(pluginDir, "agents", "helper.md")]: "---\nname: Helper\n---\nBody\n",
};

describe("PluginFs", () => {
  test("discovery reads a plugin container through the given PluginFs", async () => {
    const { plugins } = await discoverAgentPluginsIn(memoryFs(files), [
      { path: container, scope: "project" },
    ]);
    expect(plugins.map((plugin) => [plugin.name, plugin.rootPath])).toEqual([["kit", pluginDir]]);
    expect(plugins[0].skillsDirs?.map((root) => root.dir)).toEqual([
      path.join(pluginDir, "skills"),
    ]);
    expect(plugins[0].agentsDir).toBe(path.join(pluginDir, "agents"));
    // Without it, discovery reads the host, where nothing exists.
    expect((await discoverAgentPlugins([{ path: container, scope: "project" }])).plugins).toEqual(
      []
    );
  });

  // A remote root such as /workspace can exist on the host too, so a host read during the run
  // would mix the two filesystems. Every module of discovery (journals, registry, agent files)
  // reads through node:fs/promises or node:fs, so spying on both catches any host read.
  test("a run on another PluginFs makes no host filesystem read", async () => {
    const readers = [
      ...(
        ["readFile", "readdir", "stat", "lstat", "realpath", "open", "access", "readlink"] as const
      ).map((name) => spyOn(fsPromises, name)),
      ...(
        [
          "readFileSync",
          "readdirSync",
          "statSync",
          "lstatSync",
          "realpathSync",
          "openSync",
          "existsSync",
          "accessSync",
        ] as const
      ).map((name) => spyOn(fs, name)),
    ];
    const hostCalls = () => readers.reduce((total, spy) => total + spy.mock.calls.length, 0);
    try {
      const containers = [{ path: container, scope: "project" as const }];
      const { plugins } = await discoverAgentPluginsIn(memoryFs(files), containers);
      expect(plugins.map((plugin) => plugin.name)).toEqual(["kit"]);
      expect(hostCalls()).toBe(0);
      // The spies do see discovery's host reads: the same run on the host reads node:fs.
      await discoverAgentPlugins(containers);
      expect(hostCalls()).toBeGreaterThan(0);
    } finally {
      for (const spy of readers) spy.mockRestore();
    }
  });

  // Discovery joins paths with the host node:path, which would rewrite POSIX paths on Windows.
  test("a Windows host finds no plugins on another PluginFs", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const { plugins } = await discoverAgentPluginsIn(memoryFs(files), [
        { path: container, scope: "project" },
      ]);
      expect(plugins).toEqual([]);
    } finally {
      if (platform !== undefined) Object.defineProperty(process, "platform", platform);
    }
  });

  test("a non-host PluginFs refuses managed containers", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test types `rejects` as void
    await expect(
      discoverAgentPluginsIn(memoryFs(files), [
        { path: container, scope: "global", registryPath: "/r.json" },
      ])
    ).rejects.toThrow("cannot hold managed containers");
  });
});
