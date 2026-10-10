/**
 * The inputs of a bug-bash sandbox job (#5714): what the container may read and which values
 * reach it. A library: launch.ts (a later step) calls it, nothing else does.
 *
 * - The container reads copies of git-listed files (stage), never the checkout itself.
 * - dist/ and node_modules/ are mounted read-only. Docker resolves a symlinked mount source on
 *   the host, so each must be a plain folder of this checkout (checkMountSource). The launcher
 *   checks them before preflight and again just before `docker run`.
 * - Only allowlisted env names pass, and no credential name passes (containerEnv).
 * - Only an exact-step repro run passes (exactStepRefusal), and its output and app log stay in
 *   one folder that comes back through the export stream (outputDir, jobEnv).
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Refusal } from "./runner";

/** The git-listed inputs that the container reads. A symlink among them stops the launch. */
export const INPUTS = ["src", "tests/bugbash", "tsconfig.json", "package.json"];
/** The host env names that e2e.config.ts and startApp.ts read. No other host value passes. */
// Not BUGBASH_AI_REASON: after a failed probe it holds the provider URL and response text.
// Not BUGBASH_MODEL: the launcher sets it per job kind, and only for a model-driven job.
const PASS_ENV = ["BUGBASH_AI", "BUGBASH_AI_RESOLVED", "BUGBASH_APP_MODEL", "BUGBASH_EFFORT",
  "BUGBASH_SCENARIO", "E2E_TELEMETRY_DISABLED"]; // prettier-ignore
// Any name that looks like a credential, anywhere in it (AWS_SECRET_ACCESS_KEY, GH_TOKEN), or a
// PAT: a backstop behind the allowlist, so it may also refuse a harmless name.
const CREDENTIAL = /SECRET|PASSWORD|TOKEN|KEY|CREDENTIAL|BASE_URL|(^|_)PAT$/i;

/**
 * Checks each folder of `rel` under `base` without following a symlink; with `create`, it makes
 * the missing ones. So a symlinked folder cannot lead a copy or an export out of the checkout.
 */
export function plainFolders(base: string, rel: string, create: boolean, seen = new Set<string>()) {
  let dir = base;
  for (const part of rel.split("/").filter((p) => p !== "" && p !== ".")) {
    dir = path.join(dir, part);
    if (seen.has(dir)) continue;
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (st == null && create) fs.mkdirSync(dir);
    else if (st?.isDirectory() !== true)
      throw new Refusal(`${path.relative(base, dir)}: not a plain folder (a symlink?)`);
    seen.add(dir);
  }
}

/**
 * Copies the inputs of `root` into `into` (which must not exist) and returns the file count.
 * Tracked files, and new files that git does not ignore (a new repro). Ignored files stay out:
 * old .e2e runs, app logs and local env files. Each must be a regular file under plain folders.
 */
export function stage(root: string, into: string): number {
  // prettier-ignore
  const listArgs = ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"];
  const listed = spawnSync("git", ["-C", root, ...listArgs, "--", ...INPUTS], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  if (listed.status !== 0) throw new Refusal(`git ls-files: ${listed.stderr}`);
  fs.mkdirSync(into, { mode: 0o700 });
  let count = 0;
  const seen = new Set<string>();
  for (const rel of listed.stdout.split("\0").filter((name) => name !== "")) {
    const st = fs.lstatSync(path.join(root, rel), { throwIfNoEntry: false });
    if (st == null) continue; // deleted in the work tree
    plainFolders(root, path.dirname(rel), false, seen); // lstat above follows symlinked folders
    if (!st.isFile()) throw new Refusal(`stage: ${rel} is not a regular file`);
    fs.mkdirSync(path.join(into, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(root, rel), path.join(into, rel), fs.constants.COPYFILE_EXCL);
    count += 1;
  }
  // Mount points for the read-only build outputs and the job's tmpfs.
  for (const dir of ["dist", "node_modules", "tests/bugbash/.e2e"])
    fs.mkdirSync(path.join(into, dir), { recursive: true });
  return count;
}

/**
 * The host path of `rel` (dist or node_modules) for a read-only mount. It must be a plain
 * folder whose real path is the path itself: Docker follows a symlinked source on the host
 * (EvalSymlinks), so a symlink here could expose any host folder to the job.
 */
export function checkMountSource(root: string, rel: "dist" | "node_modules"): string {
  if (fs.realpathSync(root) !== root) throw new Refusal(`${root} is not a canonical path`);
  const at = path.join(root, rel);
  const st = fs.lstatSync(at, { throwIfNoEntry: false });
  if (st == null) throw new Refusal(`${rel} is missing: build it first`);
  // A canonical root plus a plain (lstat) folder means that the real path is `at` itself.
  if (!st.isDirectory()) throw new Refusal(`${rel} must be a plain folder, not a symlink`);
  return at;
}

/** The container env: fixed values, the allowlisted host names and the job's own values. */
export function containerEnv(
  host: NodeJS.ProcessEnv,
  job: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = { HOME: "/home/bugbash", TMPDIR: "/tmp" };
  for (const key of PASS_ENV) if (host[key] != null) env[key] = host[key];
  Object.assign(env, job, { BUGBASH_CONTAINER: "1" });
  for (const key of Object.keys(env))
    if (CREDENTIAL.test(key)) throw new Refusal(`${key}: no credential enters the sandbox`);
  return env;
}

/**
 * The job's own env values. The app log always goes into the output folder, so it comes back
 * with the report: an inherited BUGBASH_APP_LOG (run.ts sets a sibling path) is ignored.
 */
export function jobEnv(output: string): Record<string, string> {
  return { BUGBASH_APP_LOG: `${output}/app.log`, E2E_TELEMETRY_DISABLED: "1" };
}

// The `e2e run` options that a repro run may use: selection and output only. Not allowed, among
// others: a second --config, positional files, "--", --agent and the cache and trace switches,
// and --workers and --retries: e2e.config.ts fixes one worker (the tests share one seeded app)
// and no retry (a retry can hide a flaky failure).
// e2e reads no env var that picks a config or an agent (e2e 0.17).
const RUN_VALUE_OPTIONS = ["--config", "--output", "--tag", "--exclude-tag", "--tag-mode",
  "--grep", "--grep-invert", "--target", "--shard", "--max-failures",
  "--reporter"]; // prettier-ignore
const RUN_FLAGS = ["--pass-with-no-tests", "--last-failed", "--debug"];

/**
 * Why these e2e args are not an `e2e run` with `config`, or null. With the default repro config
 * its tests are repros/**, and its agents hold no model (hostPause.ts). The launcher also
 * accepts the MCP Apps config, whose agents get a model only through the job's proxy. e2e
 * resolves --config from its cwd, so the cwd must be tests/bugbash and the config a regular file.
 */
export function exactStepRefusal(
  args: string[],
  cwd: string,
  dir: string,
  config = "e2e.config.ts"
): string | null {
  if (args[0] !== "run") return `${JSON.stringify(args[0] ?? "")} is not \`e2e run\``;
  const configs: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const [name, inline] = args[i].startsWith("--") ? args[i].split(/=(.*)/s, 2) : [args[i]];
    if (RUN_FLAGS.includes(name) && inline == null) continue;
    if (!RUN_VALUE_OPTIONS.includes(name)) return `the argument ${JSON.stringify(args[i])}`;
    const value = inline ?? args[++i];
    if (value == null || value === "" || value.startsWith("-"))
      return `${name} needs a value, got ${JSON.stringify(value ?? "")}`;
    if (name === "--config") configs.push(value);
  }
  if (configs.length !== 1 || configs[0] !== config)
    return `--config must be given once as ${config}, got ${JSON.stringify(configs)}`;
  if (fs.realpathSync(cwd) !== fs.realpathSync(dir)) return `the cwd must be ${dir}, got ${cwd}`;
  if (fs.lstatSync(path.join(dir, config), { throwIfNoEntry: false })?.isFile() !== true)
    return `${dir}/${config} is not a regular file (a symlink?)`;
  return null;
}

/** The one `--output .e2e/<folder>` of the e2e args. The export comes back to that folder only. */
export function outputDir(args: string[]): string {
  const values = args.flatMap((arg, i) =>
    arg === "--output" ? [args[i + 1] ?? ""] : arg.startsWith("--output=") ? [arg.slice(9)] : []
  );
  const [dir] = values;
  if (
    values.length !== 1 ||
    !/^\.e2e(\/[\w.-]+)+$/.test(dir) ||
    dir.split("/").some((part) => /^\.+$/.test(part) && part !== ".e2e")
  )
    throw new Refusal(
      `the e2e args need exactly one --output .e2e/<folder>, got ${JSON.stringify(values)}`
    );
  return dir;
}
