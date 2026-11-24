#!/usr/bin/env bun
// Merges the macOS update files of two electron-builder runs into the one file a release needs.
//
// electron-updater on every Mac reads the same file (`latest-mac.yml`, `nightly-mac.yml` on the
// nightly channel) and picks the zip of its own architecture from the `files` list. One
// electron-builder run for both architectures writes that file, but `--prepackaged` takes one
// app, so `make package-mac` runs electron-builder once for each architecture and each run
// writes a file with only its own architecture.
//
// Usage: bun scripts/macos-signing/mergeUpdateInfo.ts <x64 dir> <arm64 dir> <output dir>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { parse, stringify } from "yaml";

interface UpdateFile {
  url: string;
  sha512: string;
}

interface UpdateInfo {
  version: string;
  files: UpdateFile[];
  path: string;
  sha512: string;
}

// The file of a run for both architectures lists the zips before the dmgs and x64 before arm64.
// Its `path` and `sha512`, which electron-updater reads only when `files` is empty, name the
// first file.
function mergeUpdateInfo(x64: UpdateInfo, arm64: UpdateInfo): UpdateInfo {
  if (x64.version !== arm64.version) {
    throw new Error(`the x64 app is version ${x64.version} and the arm64 app ${arm64.version}`);
  }
  const zipsFirst = (file: UpdateFile) => (file.url.endsWith(".zip") ? 0 : 1);
  const files = [...x64.files, ...arm64.files].sort((a, b) => zipsFirst(a) - zipsFirst(b));
  return { ...x64, files, path: files[0].url, sha512: files[0].sha512 };
}

function updateFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith("-mac.yml"))
    .sort();
}

const [x64Dir, arm64Dir, outputDir] = process.argv.slice(2);
if (!x64Dir || !arm64Dir || !outputDir) {
  console.error("usage: mergeUpdateInfo.ts <x64 dir> <arm64 dir> <output dir>");
  process.exit(2);
}
const names = updateFilesIn(x64Dir);
const arm64Names = updateFilesIn(arm64Dir);
if (names.length === 0 || names.join() !== arm64Names.join()) {
  throw new Error(
    `the update files differ: x64 has [${names.join(", ")}], arm64 has [${arm64Names.join(", ")}]`
  );
}
// Merge every file before writing one, so a failure leaves no half of a release.
const merged = names.map((name) => {
  const read = (dir: string) => parse(readFileSync(path.join(dir, name), "utf8")) as UpdateInfo;
  return { name, info: mergeUpdateInfo(read(x64Dir), read(arm64Dir)) };
});
for (const { name, info } of merged) {
  // These options give the bytes that electron-builder writes for the same data.
  const text = stringify(info, { version: "1.1", lineWidth: 0, singleQuote: true });
  writeFileSync(path.join(outputDir, name), text);
  console.log(`Merged ${name}: ${info.files.map((file) => file.url).join(", ")}`);
}
