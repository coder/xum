import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");

/**
 * `uv` arguments that run a Python script with one dependency group of the repository's
 * pyproject.toml, installed as uv.lock pins it. `--locked` fails when uv.lock is out of date.
 */
export function uvRunArgs(group: string, script: string): string[] {
  return [
    "run",
    "--locked",
    "--quiet",
    "--project",
    REPO_ROOT,
    "--only-group",
    group,
    "python",
    script,
  ];
}
