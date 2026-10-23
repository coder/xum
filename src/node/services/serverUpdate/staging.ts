import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { execFileAsync } from "@/node/utils/disposableExec";
import {
  SERVER_UPDATE_CLI_INTERPRETER,
  SERVER_UPDATE_CLI_SHEBANG,
  SERVER_UPDATE_INSTALL_TIMEOUT_MS,
  SERVER_UPDATE_LOCKFILES,
  SERVER_UPDATE_SMOKE_TIMEOUT_MS,
  SERVER_UPDATE_STAGE_MARKER,
  SERVER_UPDATE_STAGING_PREFIX,
} from "@/constants/serverUpdate";
import {
  isExactVersion,
  readPackageVersion,
  resolveCliEntry,
  type InstallLayout,
} from "./installLayout";
import { verifyStagedDependencies } from "./lockfile";
import { downloadArtifact, fetchArtifact, type RegistryRequest } from "./registry";
import { nestShrinkwrap, pinnedDigests, shrinkwrapSchema, type Shrinkwrap } from "./shrinkwrap";

/**
 * Installs the stage's package.json and npm package-lock.json, which hold the already verified
 * local tarball and the tree its shrinkwrap pins: npm installs that lockfile as written, bun
 * migrates it to bun.lock, and pnpm imports it into pnpm-lock.yaml before installing. Only the
 * pinned dependencies come from the registry.
 */
export function installCommands(layout: InstallLayout): Array<{ file: string; args: string[] }> {
  // CLI flags outrank npmrc files and npm_config_* env, so an inherited strict-ssl=false cannot
  // disable certificate validation for the download, an inherited lockfile=false cannot
  // suppress the pnpm lockfile that dependency verification reads (`npm ci` always uses the
  // lockfile), and an inherited omit of the optional platform packages loses to npm's include and
  // pnpm's optional=true. bun has no such flags; its TLS and lockfile knobs are env variables
  // runInstall strips, while a global bunfig that disables lockfile saving still fails closed at
  // verification and one that disables optional dependencies has no override. The text lockfile
  // is required, so an older bun that only writes bun.lockb must fail here. `pnpm import` accepts
  // neither `--registry` nor `--ignore-scripts`; it runs no scripts.
  const registry = ["--registry", layout.registry];
  const commands = {
    bun: [
      ["install", "--frozen-lockfile", "--ignore-scripts", "--save-text-lockfile", ...registry],
    ],
    npm: [
      [
        "ci",
        "--no-global",
        "--no-audit",
        "--no-fund",
        "--omit=dev",
        "--ignore-scripts",
        "--strict-ssl",
        "--include=optional",
        ...registry,
      ],
    ],
    pnpm: [
      [
        "import",
        `--config.registry=${layout.registry}`,
        "--config.strict-ssl=true",
        "--config.lockfile=true",
      ],
      [
        "install",
        "--no-global",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--config.strict-ssl=true",
        "--config.lockfile=true",
        "--config.optional=true",
        ...registry,
      ],
    ],
  } satisfies Record<InstallLayout["packageManager"], string[][]>;
  return commands[layout.packageManager].map((args) => ({ file: layout.packageManager, args }));
}

/** Reads the shrinkwrap that a release tarball ships next to its package.json. */
async function readShrinkwrap(tarball: string, signal?: AbortSignal): Promise<Shrinkwrap> {
  // GNU tar also takes options from TAR_OPTIONS, which could name a decompression program.
  using tar = execFileAsync("tar", ["-xzOf", tarball, "package/npm-shrinkwrap.json"], {
    env: { TAR_OPTIONS: undefined },
    timeoutMs: SERVER_UPDATE_INSTALL_TIMEOUT_MS,
    signal,
  });
  const { stdout } = await tar.result;
  return shrinkwrapSchema.parse(JSON.parse(stdout));
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
  const stat = await fs.stat(entry);
  if (!stat.isFile()) throw new Error("Staged CLI entry is not a file");
  // The supervisor execs the launcher symlink directly, so the entry must be executable and name
  // the interpreter the running install uses; a parseable file with any other first line would
  // fail every relaunch attempt.
  const shebang = `${SERVER_UPDATE_CLI_SHEBANG}\n`;
  const handle = await fs.open(entry);
  try {
    const { buffer, bytesRead } = await handle.read(
      Buffer.alloc(shebang.length),
      0,
      shebang.length,
      0
    );
    if (buffer.subarray(0, bytesRead).toString() !== shebang)
      throw new Error("Staged CLI entry does not start with the expected interpreter line");
  } finally {
    await handle.close();
  }
  if ((stat.mode & 0o111) === 0) throw new Error("Staged CLI entry is not executable");
  // Parse-only: nothing from the registry runs until the operator activates it. The shebang's
  // interpreter is used because process.execPath may be bun, which has no parse-only mode.
  using smoke = execFileAsync(SERVER_UPDATE_CLI_INTERPRETER, ["--check", entry], {
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
    // The TLS variable disables certificate validation in every manager and the bun variable
    // suppresses the lockfile; neither can be outranked by a flag.
    env: { NODE_TLS_REJECT_UNAUTHORIZED: undefined, BUN_CONFIG_SKIP_SAVE_LOCKFILE: undefined },
    timeoutMs: SERVER_UPDATE_INSTALL_TIMEOUT_MS,
    killTreeOnTermination: true,
    signal,
  });
  await install.result;
}

export interface StageOptions {
  install?: typeof runInstall;
  request?: RegistryRequest;
  signal?: AbortSignal;
}

const markerSchema = z.object({ launcher: z.string() });

/** Only a stage this installation created may be pruned; a name collision is not ownership. */
async function ownsStage(candidate: string, layout: InstallLayout): Promise<boolean> {
  try {
    const raw: unknown = JSON.parse(
      await fs.readFile(path.join(candidate, SERVER_UPDATE_STAGE_MARKER), "utf8")
    );
    const marker = markerSchema.safeParse(raw);
    return marker.success && marker.data.launcher === layout.launcher;
  } catch {
    return false;
  }
}

export async function stageUpdate(
  layout: InstallLayout,
  version: string,
  options: StageOptions = {}
): Promise<string> {
  const { install = runInstall, request, signal } = options;
  if (!isExactVersion(version)) throw new Error("Invalid update version");
  // Pruning must never remove the target of a launcher that was re-pointed behind this process.
  if (resolveCliEntry(layout.launcher) !== layout.entry)
    throw new Error("Server launcher changed since startup");
  const parent = path.dirname(layout.workdir);
  const active = await fs.realpath(layout.workdir);
  for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(SERVER_UPDATE_STAGING_PREFIX)) continue;
    const candidate = path.join(parent, entry.name);
    if ((await fs.realpath(candidate)) !== active && (await ownsStage(candidate, layout)))
      await fs.rm(candidate, { recursive: true });
  }
  // A fresh, uniquely named directory: a foreign directory sharing the version's name can neither
  // block the stage nor be replaced by it (rename would replace an empty one), and the marker
  // lands first so a crash at any later point leaves a directory the next attempt prunes.
  const dir = await fs.mkdtemp(path.join(parent, `${SERVER_UPDATE_STAGING_PREFIX}${version}.`));
  await fs.writeFile(
    path.join(dir, SERVER_UPDATE_STAGE_MARKER),
    JSON.stringify({ launcher: layout.launcher })
  );
  // An absolute path: bun records a relative one without the prefix that marks it as local.
  const tarball = path.join(dir, `xum-${version}.tgz`);
  const dependencies = { "@coder/xum": `file:${tarball}` };
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ private: true, dependencies })
  );
  // Package managers follow redirects, so the release itself is fetched and digest-checked here.
  await downloadArtifact(
    await fetchArtifact(layout.registry, version, request, signal),
    tarball,
    request,
    signal
  );
  // No manager honors the shrinkwrap inside a tarball file, so each would resolve every dependency
  // afresh; the stage's lockfile carries the release's pinned tree instead, and the staged tree is
  // then held to those pins and anchored to the registry. A dependency the shrinkwrap lacks fails
  // npm and pnpm but is left out by bun; the publish workflow refuses such a shrinkwrap.
  const shrinkwrap = await readShrinkwrap(tarball, signal);
  const pins = pinnedDigests(shrinkwrap);
  const seed = path.join(dir, SERVER_UPDATE_LOCKFILES.npm);
  await fs.writeFile(
    seed,
    JSON.stringify({
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { dependencies },
        ...nestShrinkwrap(shrinkwrap, "@coder/xum", `file:${tarball}`),
      },
    })
  );
  for (const command of installCommands(layout)) {
    await install(command.file, command.args, dir, signal);
  }
  // bun and pnpm keep the npm lockfile they converted, and a second lockfile would make the
  // next update's layout ambiguous.
  if (layout.packageManager !== "npm") await fs.rm(seed);
  await verifyStagedDependencies(layout, dir, pins, request, signal);
  return verifyStagedPackage(dir, version, signal);
}
