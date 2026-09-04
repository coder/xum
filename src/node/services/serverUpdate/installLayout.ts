import { getErrorMessage } from "@/common/utils/errors";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import type { UpdateChannel } from "@/common/types/project";

export interface InstallLayout {
  launcher: string;
  entry: string;
  workdir: string;
  packageManager: "bun" | "npm" | "pnpm";
  version: string;
  registry: string;
}

export type LayoutResult =
  | { supported: true; layout: InstallLayout }
  | { supported: false; reason: string };

export function inferChannel(version: string): UpdateChannel {
  return version.includes("-next.") ? "nightly" : "stable";
}

export function isExactVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
  );
}

export function readPackageVersion(packageDir: string): string {
  const pkg: unknown = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  if (
    !pkg ||
    typeof pkg !== "object" ||
    !("name" in pkg) ||
    pkg.name !== "@coder/xum" ||
    !("version" in pkg) ||
    !isExactVersion(pkg.version)
  ) {
    throw new Error("Expected an installed @coder/xum package with an exact version");
  }
  return pkg.version;
}

export function resolveInstallLayout(
  env: NodeJS.ProcessEnv,
  argv: readonly string[]
): LayoutResult {
  try {
    // coder/mux registry module v1.5 declares its restart loop through RESTART_ON_KILL_VALUE.
    const supervised = resolveXumEnvironmentValue("SERVER_SUPERVISED", env);
    if (!(/^(1|true|yes)$/i.test(supervised ?? "") || env.RESTART_ON_KILL_VALUE === "true")) {
      throw new Error("Server updates require a supervisor configured to restart after exit");
    }
    const running = argv[1];
    if (!running) throw new Error("Cannot identify the server launcher");
    // The supervisor relaunches whatever path it started; a direct entry path would keep running
    // the old version after the launcher symlink is re-pointed.
    if (!lstatSync(path.resolve(running)).isSymbolicLink())
      throw new Error("Server must be started through its launcher symlink");
    const launcher = path.resolve(resolveXumEnvironmentValue("BINARY", env) ?? running);
    if (!lstatSync(launcher).isSymbolicLink()) throw new Error("Server launcher must be a symlink");
    const entry = realpathSync(running);
    if (realpathSync(launcher) !== entry)
      throw new Error("Server launcher does not point to the running entry");
    const packageDir = path.dirname(path.dirname(path.dirname(entry)));
    if (entry !== path.join(packageDir, "dist", "cli", "index.js"))
      throw new Error("Unsupported server entry layout");
    const version = readPackageVersion(packageDir);
    let workdir: string | undefined;
    let packageManager: InstallLayout["packageManager"] | undefined;
    for (let dir = packageDir; path.dirname(dir) !== dir; dir = path.dirname(dir)) {
      if (path.basename(dir) !== "node_modules") continue;
      const parent = path.dirname(dir);
      const managers: Array<InstallLayout["packageManager"]> = [];
      if (["bun.lock", "bun.lockb"].some((lock) => existsSync(path.join(parent, lock))))
        managers.push("bun");
      if (existsSync(path.join(parent, "package-lock.json"))) managers.push("npm");
      if (existsSync(path.join(parent, "pnpm-lock.yaml"))) managers.push("pnpm");
      if (managers.length > 1) throw new Error("Ambiguous package manager lockfiles");
      if (managers.length === 1) {
        workdir = parent;
        packageManager = managers[0];
        break;
      }
    }
    if (!workdir || !packageManager) throw new Error("No supported package manager lockfile found");
    if (launcher.startsWith(workdir + path.sep))
      throw new Error("Server launcher must be outside the package installation");
    const registry =
      resolveXumEnvironmentValue("UPDATE_REGISTRY_URL", env) ??
      env.npm_config_registry ??
      "https://registry.npmjs.org";
    const url = new URL(registry);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Unsupported update registry URL");
    return {
      supported: true,
      layout: {
        launcher,
        entry,
        workdir,
        packageManager,
        version,
        registry: registry.replace(/\/+$/, ""),
      },
    };
  } catch (error) {
    return { supported: false, reason: getErrorMessage(error) };
  }
}
