/**
 * The e2e replay cache of a story job (make test-stories): a seed goes in, and the job's cache
 * comes back with its output, so a later run can replay the `agent.act` steps that it recorded.
 *
 * - Host: `tests/stories/.e2e-cache-seed/` holds the seed. It is git-ignored, so a developer
 *   cannot commit cache files by accident (`git add -A` skips them), and stage() in inputs.ts
 *   copies it into the job's stage with its own checks (checkSeed), because git lists no
 *   ignored file. Untracked but not ignored would need no code, but every `git status` would
 *   show the entries and one `git add -A` would commit them.
 * - Container: the launcher sets BUGBASH_CACHE_DIR to `<output>/cache` (jobEnv). The output
 *   folder is a tmpfs that the export stream sends back, so the cache comes back to
 *   `<output>/cache` on the host. To warm the next run, copy those files into the seed folder.
 * - e2e forks its workers with no argv, and each worker loads the config again, with the same
 *   env. So the cache dir comes by env (it is part of the config digest), and the seed copy
 *   (seedCacheDir) runs in every process but copies only once.
 *
 * No import beyond node: the story config loads this module in the container.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** The seed folder, relative to the checkout root. */
export const CACHE_SEED = "tests/stories/.e2e-cache-seed";
/** An e2e file-store entry: `<sha256 of its key>.json` (e2e 0.20 cache/store.js). */
const ENTRY = /^[a-f0-9]{64}\.json$/;
/** e2e reads no entry over 1 MiB (MAX_CACHE_WIRE_BYTES), so a bigger file is not an entry. */
const MAX_ENTRY_BYTES = 1 << 20;
/** A cap that keeps the seed small: the export stream allows 10,000 files per job. */
export const MAX_SEED_ENTRIES = 1000;
/**
 * The seed's total size. The job's cache (seed plus new entries) comes back in the export stream
 * with the reports and videos, under its 1 GiB limit (exportStream.ts), so the seed must leave
 * most of it free (Codex review of #7012).
 */
export const MAX_SEED_BYTES = 128 << 20;

/** Whether `file` (by lstat: no symlink) is an e2e entry that a seed may hold. */
export function isSeedEntry(file: string): boolean {
  const entry = fs.lstatSync(file, { throwIfNoEntry: false });
  return (
    entry != null &&
    entry.isFile() &&
    ENTRY.test(path.basename(file)) &&
    entry.size <= MAX_ENTRY_BYTES
  );
}

/**
 * The entry names of the seed folder `seed`, checked, or none when it does not exist. Each must
 * be a regular file (lstat: no symlink) named like an e2e entry and no bigger than one. Anything
 * else throws with `fail`: a seed is copied into the sandbox, so it must hold only cache entries.
 */
export function checkSeed(seed: string, fail: (reason: string) => Error): string[] {
  const st = fs.lstatSync(seed, { throwIfNoEntry: false });
  if (st == null) return [];
  if (!st.isDirectory()) throw fail(`${CACHE_SEED}: not a plain folder (a symlink?)`);
  const names = fs.readdirSync(seed).sort();
  if (names.length > MAX_SEED_ENTRIES)
    throw fail(`${CACHE_SEED}: ${names.length} files, more than ${MAX_SEED_ENTRIES}`);
  let bytes = 0;
  for (const name of names) {
    const file = path.join(seed, name);
    if (!isSeedEntry(file))
      throw fail(`${CACHE_SEED}/${name}: not an e2e cache entry (<sha256>.json, a regular file)`);
    bytes += fs.lstatSync(file).size;
  }
  if (bytes > MAX_SEED_BYTES)
    throw fail(`${CACHE_SEED}: ${bytes} bytes, more than ${MAX_SEED_BYTES}`);
  return names;
}

/**
 * Copies the entries of `seed` into the cache dir `dir` once: when `dir` does not exist yet.
 * Returns the number copied, or null when `dir` exists (another process of the same run
 * seeded it, or e2e already wrote to it). The copy goes into a sibling folder that is renamed
 * to `dir`, so a racing process sees either no `dir` or a complete one.
 */
export function seedCacheDir(seed: string, dir: string): number | null {
  if (fs.existsSync(dir)) return null;
  const names = checkSeed(seed, (reason) => new Error(reason));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const partial = fs.mkdtempSync(`${dir}.seed-`);
  try {
    for (const name of names)
      fs.copyFileSync(path.join(seed, name), path.join(partial, name), fs.constants.COPYFILE_EXCL);
    fs.renameSync(partial, dir);
    return names.length;
  } catch (error) {
    fs.rmSync(partial, { recursive: true, force: true });
    // Another process renamed its copy first: that one is the seed.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY") return null;
    throw error;
  }
}
