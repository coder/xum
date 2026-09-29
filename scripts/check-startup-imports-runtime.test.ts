// Fixture tests for scripts/check-startup-imports-runtime.ts. Each test writes a tiny
// project to a temp dir and loads its main.js through the real Node harness.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import {
  type DesktopPlatform,
  findBannedModules,
  loadEagerModules,
} from "./check-startup-imports-runtime";

const BANNED = ["ai", "@ai-sdk/*"];

let rootDir: string;

beforeEach(async () => {
  // realpath: require.cache (and so the module list) holds real paths.
  rootDir = await realpath(await mkdtemp(path.join(tmpdir(), "startup-imports-runtime-test-")));
  await writeFiles({
    "node_modules/ai/index.js": "module.exports = {};\n",
    "node_modules/ok-pkg/index.js": "module.exports = {};\n",
    "node_modules/wrapper-pkg/index.js": 'module.exports = require("ai");\n',
    "node_modules/@ai-sdk/openai/index.js": "module.exports = {};\n",
  });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

async function writeFiles(files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
}

async function loadMain(source: string): Promise<string[]> {
  await writeFiles({ "main.js": source });
  return (await loadEagerModules(path.join(rootDir, "main.js"))).modules;
}

async function bannedPackagesOf(source: string): Promise<string[]> {
  return findBannedModules(await loadMain(source), BANNED).map((m) => m.packageName);
}

test.each([
  ["an eager require", 'require("ok-pkg");\nrequire("ai");\n'],
  // tsc's emit for a module-scope `import("ai")`, which the static guard treats as lazy.
  ["a module-scope import()", 'Promise.resolve().then(() => require("ai"));\n'],
  ["a computed require", 'const name = ["a", "i"].join("");\nrequire(name);\n'],
  ["an allowed package that loads a banned one", 'require("wrapper-pkg");\n'],
  // main.ts awaits its storage setup (real file I/O) before it waits for the ready event.
  [
    "startup code that runs after real I/O but before the ready gate",
    [
      'const { app } = require("electron");',
      'const fs = require("fs");',
      "(async () => {",
      "  await fs.promises.stat(__filename);",
      "  await fs.promises.readFile(__filename);",
      '  require("ai");',
      "  await app.whenReady();",
      "})();",
      "",
    ].join("\n"),
  ],
])("reports a banned package loaded through %s", async (_name, source) => {
  expect(await bannedPackagesOf(source)).toEqual(["ai"]);
});

test("code that waits for Electron to be ready does not run", async () => {
  await writeFiles({
    "main.js": [
      'const { app } = require("electron");',
      'require("ok-pkg");',
      'app.whenReady().then(() => require("ai"));',
      '(async () => { await app.whenReady(); require("@ai-sdk/openai"); })();',
      "",
    ].join("\n"),
  });
  const { trigger, modules } = await loadEagerModules(path.join(rootDir, "main.js"));

  // The driver requires the real entry to end here, not at an idle event loop.
  expect(trigger).toBe("app.whenReady()");
  expect(findBannedModules(modules, BANNED)).toEqual([]);
  // The load really ran past the Electron calls.
  expect(modules).toContain(path.join(rootDir, "node_modules/ok-pkg/index.js"));
});

test("startup branches run for the simulated platform", async () => {
  await writeFiles({ "main.js": 'if (process.platform === "darwin") require("ai");\n' });
  const target = path.join(rootDir, "main.js");

  const banned = async (platform: DesktopPlatform) =>
    findBannedModules((await loadEagerModules(target, platform)).modules, BANNED).map(
      (m) => m.packageName
    );

  expect(await banned("darwin")).toEqual(["ai"]);
  expect(await banned("linux")).toEqual([]);
});

test("top-level Electron calls and constructors do not throw", async () => {
  const modules = await loadMain(
    [
      'const { app, BrowserWindow, ipcMain } = require("electron");',
      'app.setName("x");',
      "const win = new BrowserWindow({ show: false });",
      'win.loadURL("x");',
      'ipcMain.handle("channel", () => {});',
      "if (app.isPackaged) {}",
      "const label = `${app.getVersion()}`;",
      'const userData = require("path").join(app.getPath("appData"), "xum");',
      'require("ok-pkg");',
      "",
    ].join("\n")
  );

  expect(modules).toContain(path.join(rootDir, "node_modules/ok-pkg/index.js"));
});

test("a target that throws at load fails instead of passing vacuously", async () => {
  await expect(loadMain('throw new Error("boom at load");\n')).rejects.toThrow(/boom at load/);
});

test("a target that exits before the ready gate fails instead of passing vacuously", async () => {
  await expect(loadMain('require("ai");\nprocess.exit(0);\n')).rejects.toThrow(/exited before/);
});

test("startup cannot reach the real home or app data directories", async () => {
  // Startup runs real home/userData migrations, so the check must sandbox them.
  const modules = await loadMain(
    [
      'const { app } = require("electron");',
      `const realHome = ${JSON.stringify(homedir())};`,
      'if (process.env.HOME === realHome) throw new Error("HOME not sandboxed");',
      'if (app.getPath("appData").startsWith(realHome)) throw new Error("appData not sandboxed");',
      'require("ok-pkg");',
      "",
    ].join("\n")
  );

  expect(modules).toContain(path.join(rootDir, "node_modules/ok-pkg/index.js"));
});

test("attributes files to the innermost package and reports each package once", () => {
  expect(
    findBannedModules(
      [
        "/app/node_modules/x/node_modules/@ai-sdk/openai/dist/index.js",
        "/app/node_modules/ai/dist/index.js",
        "/app/node_modules/ai/dist/other.js",
        "/app/node_modules/ok-pkg/index.js",
        "/app/src/ai/index.js",
      ],
      BANNED
    )
  ).toEqual([
    {
      packageName: "@ai-sdk/openai",
      file: "/app/node_modules/x/node_modules/@ai-sdk/openai/dist/index.js",
    },
    { packageName: "ai", file: "/app/node_modules/ai/dist/index.js" },
  ]);
});
