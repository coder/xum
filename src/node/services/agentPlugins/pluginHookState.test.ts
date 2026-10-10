import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  PLUGIN_HOOK_STATE_FILE,
  PLUGIN_HOOK_STATE_MAX_BYTES,
  PLUGIN_HOOK_STATE_WORKSPACE_DIR,
  readPluginHookState,
} from "./pluginHookState";

const temps: DisposableTempDir[] = [];
afterEach(() => {
  for (const tmp of temps.splice(0)) tmp[Symbol.dispose]();
});

async function makeDataDir(): Promise<string> {
  const tmp = new DisposableTempDir("plugin-hook-state");
  temps.push(tmp);
  const dataPath = path.join(tmp.path, "plugin-data", "0123456789abcdef");
  await fs.mkdir(path.join(dataPath, PLUGIN_HOOK_STATE_WORKSPACE_DIR), { recursive: true });
  return dataPath;
}

async function writeGlobal(dataPath: string, content: string): Promise<void> {
  await fs.writeFile(path.join(dataPath, PLUGIN_HOOK_STATE_FILE), content, "utf8");
}

async function writeWorkspace(dataPath: string, workspaceId: string, content: string) {
  await fs.writeFile(
    path.join(dataPath, PLUGIN_HOOK_STATE_WORKSPACE_DIR, `${workspaceId}.json`),
    content,
    "utf8"
  );
}

describe("readPluginHookState", () => {
  test("workspace keys override global keys; other workspaces see only the global file", async () => {
    const dataPath = await makeDataDir();
    await writeGlobal(dataPath, JSON.stringify({ styleGuide: true, rule: "global" }));
    await writeWorkspace(dataPath, "ws-a", JSON.stringify({ rule: "workspace" }));

    expect(await readPluginHookState(dataPath, "ws-a")).toEqual({
      styleGuide: true,
      rule: "workspace",
    });
    expect(await readPluginHookState(dataPath, "ws-b")).toEqual({
      styleGuide: true,
      rule: "global",
    });
  });

  test("a non-object workspace value replaces the global value as a whole", async () => {
    const dataPath = await makeDataDir();
    await writeGlobal(dataPath, JSON.stringify({ a: 1 }));
    await writeWorkspace(dataPath, "ws-a", JSON.stringify(["only", "this"]));
    expect(await readPluginHookState(dataPath, "ws-a")).toEqual(["only", "this"]);
  });

  test("a broken workspace file falls back to the global settings", async () => {
    const dataPath = await makeDataDir();
    await writeGlobal(dataPath, JSON.stringify({ a: 1 }));
    await writeWorkspace(dataPath, "ws-a", "{ not json");
    expect(await readPluginHookState(dataPath, "ws-a")).toEqual({ a: 1 });

    await writeWorkspace(
      dataPath,
      "ws-a",
      JSON.stringify({ pad: "x".repeat(PLUGIN_HOOK_STATE_MAX_BYTES) })
    );
    expect(await readPluginHookState(dataPath, "ws-a")).toEqual({ a: 1 });
  });

  test("an unsafe workspace ID never reaches a path outside the data directory", async () => {
    const dataPath = await makeDataDir();
    await writeGlobal(dataPath, JSON.stringify({ a: 1 }));
    // Used as a file name, "../evil" would read <data>/evil.json instead of a workspace file.
    await fs.writeFile(path.join(dataPath, "evil.json"), JSON.stringify({ a: 2 }), "utf8");
    expect(await readPluginHookState(dataPath, "../evil")).toEqual({ a: 1 });
  });

  test("a symlink that leaves the data directory is ignored", async () => {
    const dataPath = await makeDataDir();
    const outside = path.join(path.dirname(path.dirname(dataPath)), "secret.json");
    await fs.writeFile(outside, JSON.stringify({ secret: true }), "utf8");
    await fs.symlink(outside, path.join(dataPath, PLUGIN_HOOK_STATE_FILE));
    expect(await readPluginHookState(dataPath, "ws-a")).toBeNull();
  });

  test("a named pipe in place of the settings file never blocks the read", async () => {
    const dataPath = await makeDataDir();
    const fifo = path.join(dataPath, PLUGIN_HOOK_STATE_FILE);
    const made = Bun.spawnSync(["mkfifo", fifo]);
    if (made.exitCode !== 0) return; // no mkfifo on this platform
    // Without the regular-file check, open() waits for a writer and this test times out.
    expect(await readPluginHookState(dataPath, "ws-a")).toBeNull();
  });

  test("legacy workspace IDs with dots and spaces keep their workspace file", async () => {
    const dataPath = await makeDataDir();
    await writeGlobal(dataPath, JSON.stringify({ a: 1, b: 1 }));
    await writeWorkspace(dataPath, "my.app-feature 2", JSON.stringify({ b: 2 }));
    expect(await readPluginHookState(dataPath, "my.app-feature 2")).toEqual({ a: 1, b: 2 });
    for (const unsafe of ["../evil", "a/b", "a\\b", "a\u0000b", ""]) {
      expect(await readPluginHookState(dataPath, unsafe)).toEqual({ a: 1, b: 1 });
    }
  });

  test("a data directory that does not exist yet reads as no settings", async () => {
    const dataPath = await makeDataDir();
    expect(await readPluginHookState(path.join(dataPath, "missing"), "ws-a")).toBeNull();
  });
});
