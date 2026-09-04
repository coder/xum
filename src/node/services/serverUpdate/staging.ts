import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFileAsync } from "@/node/utils/disposableExec";
import {
  SERVER_UPDATE_INSTALL_TIMEOUT_MS,
  SERVER_UPDATE_SMOKE_TIMEOUT_MS,
  SERVER_UPDATE_STAGING_PREFIX,
} from "@/constants/serverUpdate";
import { isExactVersion, readPackageVersion, type InstallLayout } from "./installLayout";

export function installCommand(
  layout: InstallLayout,
  version: string
): { file: string; args: string[] } {
  if (!isExactVersion(version)) throw new Error("Invalid update version");
  const spec = `@coder/xum@${version}`;
  const flags = {
    bun: ["add", "--ignore-scripts", "--exact"],
    npm: ["install", "--no-audit", "--no-fund", "--omit=dev", "--ignore-scripts"],
    pnpm: ["add", "--ignore-scripts"],
  } satisfies Record<InstallLayout["packageManager"], string[]>;
  return {
    file: layout.packageManager,
    args: [...flags[layout.packageManager], spec, "--registry", layout.registry],
  };
}

export async function verifyStagedPackage(dir: string, version: string): Promise<string> {
  const packageDir = path.join(dir, "node_modules/@coder/xum");
  if (readPackageVersion(packageDir) !== version)
    throw new Error("Staged package version does not match the requested update");
  const entry = path.join(packageDir, "dist/cli/index.js");
  if (!(await fs.stat(entry)).isFile()) throw new Error("Staged CLI entry is not a file");
  const bin = path.join(dir, "node_modules/.bin/mux");
  await fs.access(bin);
  // pnpm emits shell shims; a direct link keeps the next launch identifiable by realpath.
  if (!(await fs.lstat(bin)).isSymbolicLink()) {
    await fs.unlink(bin);
    await fs.symlink(entry, bin);
  }
  if ((await fs.realpath(bin)) !== (await fs.realpath(entry)))
    throw new Error("Staged launcher does not resolve to the CLI entry");
  using smoke = execFileAsync("node", [entry, "--version"], {
    timeoutMs: SERVER_UPDATE_SMOKE_TIMEOUT_MS,
  });
  await smoke.result;
  return bin;
}

async function runInstall(file: string, args: string[], cwd: string): Promise<void> {
  using install = execFileAsync(file, args, {
    cwd,
    timeoutMs: SERVER_UPDATE_INSTALL_TIMEOUT_MS,
    killTreeOnTermination: true,
  });
  await install.result;
}

export async function stageUpdate(
  layout: InstallLayout,
  version: string,
  install = runInstall
): Promise<string> {
  const command = installCommand(layout, version);
  const parent = path.dirname(layout.workdir);
  const active = await fs.realpath(layout.workdir);
  const dir = path.join(parent, `${SERVER_UPDATE_STAGING_PREFIX}${version}`);
  for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !entry.name.startsWith(SERVER_UPDATE_STAGING_PREFIX) ||
      !isExactVersion(entry.name.slice(SERVER_UPDATE_STAGING_PREFIX.length))
    )
      continue;
    const candidate = path.join(parent, entry.name);
    if ((await fs.realpath(candidate)) !== active) await fs.rm(candidate, { recursive: true });
  }
  // Exclusive creation refuses pre-existing links, and never mutates the running installation.
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ private: true }));
  await install(command.file, command.args, dir);
  return verifyStagedPackage(dir, version);
}
