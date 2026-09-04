import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFileAsync } from "@/node/utils/disposableExec";
import {
  SERVER_UPDATE_INSTALL_TIMEOUT_MS,
  SERVER_UPDATE_SMOKE_TIMEOUT_MS,
  SERVER_UPDATE_STAGING_PREFIX,
} from "@/constants/serverUpdate";
import {
  isExactVersion,
  readPackageVersion,
  resolveCliEntry,
  type InstallLayout,
} from "./installLayout";

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

export async function verifyStagedPackage(
  dir: string,
  version: string,
  signal?: AbortSignal
): Promise<string> {
  const packageDir = path.join(dir, "node_modules/@coder/xum");
  if (readPackageVersion(packageDir) !== version)
    throw new Error("Staged package version does not match the requested update");
  const entry = path.join(packageDir, "dist/cli/index.js");
  if (!(await fs.stat(entry)).isFile()) throw new Error("Staged CLI entry is not a file");
  using smoke = execFileAsync(process.execPath, [entry, "--version"], {
    timeoutMs: SERVER_UPDATE_SMOKE_TIMEOUT_MS,
    signal,
  });
  await smoke.result;
  return entry;
}

async function runInstall(
  file: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal
): Promise<void> {
  using install = execFileAsync(file, args, {
    cwd,
    timeoutMs: SERVER_UPDATE_INSTALL_TIMEOUT_MS,
    killTreeOnTermination: true,
    signal,
  });
  await install.result;
}

export async function stageUpdate(
  layout: InstallLayout,
  version: string,
  install = runInstall,
  signal?: AbortSignal
): Promise<string> {
  const command = installCommand(layout, version);
  // Pruning must never remove the target of a launcher that was re-pointed behind this process.
  if (resolveCliEntry(layout.launcher) !== layout.entry)
    throw new Error("Server launcher changed since startup");
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
  await install(command.file, command.args, dir, signal);
  return verifyStagedPackage(dir, version, signal);
}
