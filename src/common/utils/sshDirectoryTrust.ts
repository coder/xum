import type { z } from "zod";
import type { TrustedSshDirectorySchema } from "@/common/schemas/project";
import { isSshSharedProjectDirRuntime, type RuntimeConfig } from "@/common/types/runtime";

/**
 * Trust for SSH+None directories. An SSH+None workspace runs directly in an existing directory on
 * the host (runtimeConfig.projectDir). That directory is not the local project, and collaborators
 * may control its contents, so project trust alone cannot vouch for it: the user trusts each
 * directory separately, per project (ProjectConfig.trustedSshDirectories).
 *
 * Identity is exact: the host string, the port (absent matches only absent) and projectDir as the
 * workspace persists it (absolute, resolved on the host at create). No normalization beyond that,
 * so a differently spelled path is a different, untrusted directory: failing closed.
 */
export type TrustedSshDirectory = z.infer<typeof TrustedSshDirectorySchema>;

/** The SSH+None directory a runtime runs in, or null for every other runtime. */
export function sshDirectoryOfRuntime(
  runtimeConfig: RuntimeConfig | undefined
): TrustedSshDirectory | null {
  if (!isSshSharedProjectDirRuntime(runtimeConfig)) return null;
  // A persisted SSH+None runtime always has projectDir (create rejects it otherwise); an empty one
  // matches no entry, so it stays untrusted.
  return {
    host: runtimeConfig.host,
    ...(runtimeConfig.port !== undefined ? { port: runtimeConfig.port } : {}),
    projectDir: runtimeConfig.projectDir ?? "",
  };
}

export function isSameSshDirectory(a: TrustedSshDirectory, b: TrustedSshDirectory): boolean {
  return a.host === b.host && a.port === b.port && a.projectDir === b.projectDir;
}

/**
 * Whether the directory a workspace runs in is covered by its project's trust: always for runtimes
 * whose checkout the project owns, and for SSH+None only when the user trusted that exact
 * directory. Callers AND this with project trust; it never grants trust on its own.
 */
export function isWorkspaceDirTrustedBy(
  trustedSshDirectories: readonly TrustedSshDirectory[] | undefined,
  runtimeConfig: RuntimeConfig | undefined
): boolean {
  const directory = sshDirectoryOfRuntime(runtimeConfig);
  if (directory === null) return true;
  if (directory.projectDir === "") return false;
  return (trustedSshDirectories ?? []).some((entry) => isSameSshDirectory(entry, directory));
}

/**
 * Config is hand-editable: keep only well-formed entries (non-empty host and projectDir, an
 * integer port in range), once each. Returns undefined when none remain so config.json stays
 * sparse. Never throws.
 */
export function normalizeTrustedSshDirectories(value: unknown): TrustedSshDirectory[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: TrustedSshDirectory[] = [];
  for (const raw of value as unknown[]) {
    if (raw === null || typeof raw !== "object") continue;
    const { host, port, projectDir } = raw as Record<string, unknown>;
    if (typeof host !== "string" || host.trim() === "") continue;
    if (typeof projectDir !== "string" || projectDir.trim() === "") continue;
    if (port !== undefined && !isValidPort(port)) continue;
    const entry: TrustedSshDirectory = {
      host,
      ...(typeof port === "number" ? { port } : {}),
      projectDir,
    };
    if (!result.some((existing) => isSameSshDirectory(existing, entry))) result.push(entry);
  }
  return result.length > 0 ? result : undefined;
}

/** The list with `directory` added (trusted) or removed (untrusted); undefined when empty. */
export function withSshDirectoryTrust(
  trustedSshDirectories: readonly TrustedSshDirectory[] | undefined,
  directory: TrustedSshDirectory,
  trusted: boolean
): TrustedSshDirectory[] | undefined {
  const others = (trustedSshDirectories ?? []).filter(
    (entry) => !isSameSshDirectory(entry, directory)
  );
  const next = trusted ? [...others, directory] : others;
  return next.length > 0 ? next : undefined;
}

function isValidPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535;
}
