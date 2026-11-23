// The `electron` package unpacks a full Electron (about 300 MB, with its own Electron.app on
// macOS) into node_modules/electron/dist on its first launch. electron-builder packs `electron`
// because it is an optional dependency, so a build job whose restored node_modules cache holds
// that folder ships a second Electron inside the app. `build.files` in package.json excludes
// the folder. This file runs that list through electron-builder's own matcher for node_modules.
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally:
// bun test ./scripts/ci/packagedNodeModules.test.ts
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import * as path from "node:path";
import pkg from "../../package.json";

const ROOT = path.resolve(import.meta.dir, "../..");

interface Stat {
  isDirectory(): boolean;
}
// The function is internal to app-builder-lib, so its type declarations leave it out.
interface FileMatcherModule {
  getNodeModuleFileMatcher(
    this: void,
    appDir: string,
    destination: string,
    macroExpander: (pattern: string) => string,
    platformSpecificBuildOptions: object,
    packager: { config: object; debugLogger: { isEnabled: boolean } }
  ): { isEmpty(): boolean; createFilter(): (file: string, stat: Stat) => boolean };
}
const builder = createRequire(require.resolve("electron-builder/package.json"));
const { getNodeModuleFileMatcher } = builder(
  "app-builder-lib/out/fileMatcher"
) as FileMatcherModule;

function isPacked(relativePath: string, kind: "file" | "directory"): boolean {
  const matcher = getNodeModuleFileMatcher(ROOT, "/app", (pattern) => pattern, pkg.build.mac, {
    config: pkg.build,
    debugLogger: { isEnabled: false },
  });
  // Like electron-builder's NodeModuleCopyHelper: a list with no pattern filters nothing.
  if (matcher.isEmpty()) return true;
  return matcher.createFilter()(path.join(ROOT, relativePath), {
    isDirectory: () => kind === "directory",
  });
}

describe("the node_modules files that electron-builder packs", () => {
  test("leave out the Electron that the electron package unpacks", () => {
    expect(isPacked("node_modules/electron/dist", "directory")).toBe(false);
    expect(
      isPacked("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", "file")
    ).toBe(false);
    expect(isPacked("node_modules/electron/dist/electron", "file")).toBe(false);
  });

  test("keep the rest of node_modules, the dist folders of other packages included", () => {
    expect(isPacked("node_modules/electron/index.js", "file")).toBe(true);
    expect(isPacked("node_modules/ai/dist", "directory")).toBe(true);
    expect(isPacked("node_modules/ai/dist/index.js", "file")).toBe(true);
    expect(isPacked("node_modules/sharp/lib/index.js", "file")).toBe(true);
  });
});
