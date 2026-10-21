// The files and lines changed since a base commit, shared by the quality
// gates (crap/check.ts, dry/check.ts, mutate/check.ts) so they agree on what
// "changed" means: the working tree against `base`, with renames paired.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseChangedLines, type ChangedLines } from "./policy";

export function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

// Cheap pre-filter so binaries and lockfiles never reach a scorer. The
// adapters apply the full production-file rule (crapper_report.py).
export const SCORED = /^src\/.*\.[cm]?[jt]sx?$/;

/**
 * One changed file since `base`. `basePath` is null for an added file,
 * `headPath` null for a deleted one. `-M` pairs a renamed file's two paths so
 * its functions keep their identity (the policy keys on the path).
 */
export interface ChangedFile {
  basePath: string | null;
  headPath: string | null;
}

export function parseNameStatus(output: string): ChangedFile[] {
  const fields = output.split("\0");
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < fields.length && fields[i] !== "") {
    const status = fields[i];
    // `-M` without `-C` reports renames (R<similarity>) but never copies.
    if (status.startsWith("R")) {
      files.push({ basePath: fields[i + 1], headPath: fields[i + 2] });
      i += 3;
    } else {
      const path = fields[i + 1];
      files.push({
        basePath: status === "A" ? null : path,
        headPath: status === "D" ? null : path,
      });
      i += 2;
    }
  }
  return files.filter((file) => [file.basePath, file.headPath].some((p) => p && SCORED.test(p)));
}

export interface Changes {
  root: string;
  /** The resolved base commit SHA. */
  base: string;
  files: ChangedFile[];
  changed: ChangedLines;
}

export function changesSince(cwd: string, baseRef: string): Changes {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const base = git(root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${baseRef}^{commit}`,
  ]).trim();
  // The working tree is the head: unstaged edits count, untracked files do not.
  // Pin the output format against user config (diff.mnemonicPrefix,
  // diff.noprefix, core.quotePath) so paths match the scorer's.
  const diffArgs = [
    "-c",
    "core.quotePath=false",
    "diff",
    "-M",
    "--default-prefix",
    "--no-color",
    "--no-ext-diff",
    base,
  ];
  const files = parseNameStatus(git(root, [...diffArgs, "--name-status", "-z"])).filter(
    (file) => file.headPath === null || existsSync(join(root, file.headPath))
  );
  const pathspec = files.flatMap((file) =>
    [file.basePath, file.headPath].filter((p) => p !== null)
  );
  const changed =
    pathspec.length === 0
      ? new Map()
      : parseChangedLines(git(root, [...diffArgs, "-U0", "--", ...new Set(pathspec)]));
  return { root, base, files, changed };
}

/**
 * Writes the base content of every changed file that existed at `base` into a
 * new temp tree, at its base path. The caller removes the tree.
 */
export function writeBaseTree(
  root: string,
  base: string,
  files: readonly ChangedFile[]
): { tree: string; paths: string[] } {
  const tree = mkdtempSync(join(tmpdir(), "gate-base-"));
  const paths: string[] = [];
  try {
    for (const { basePath } of files) {
      if (basePath === null) continue;
      mkdirSync(dirname(join(tree, basePath)), { recursive: true });
      const blob = execFileSync("git", ["show", `${base}:${basePath}`], {
        cwd: root,
        maxBuffer: 256 * 1024 * 1024,
      });
      writeFileSync(join(tree, basePath), blob);
      paths.push(basePath);
    }
  } catch (error) {
    // The caller owns the tree only once this returns.
    rmSync(tree, { recursive: true, force: true });
    throw error;
  }
  return { tree, paths };
}
