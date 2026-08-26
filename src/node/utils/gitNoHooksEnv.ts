import { shellQuote } from "@/common/utils/shell";
import { projectAutomationDisabled } from "@/node/utils/projectAutomation";
import { providerSecretEnvVarNames } from "@/node/utils/providerRequirements";
import { execFileAsync } from "@/node/utils/disposableExec";

/**
 * Environment variables that disable git hooks by pointing core.hooksPath
 * to /dev/null. Used for untrusted projects to prevent repo-controlled
 * hooks from executing during git operations.
 */
export const GIT_NO_HOOKS_ENV = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
  // Clear the deprecated GIT_CONFIG_PARAMETERS to prevent it from overriding
  // the numbered GIT_CONFIG_* variables above (it takes precedence in git).
  GIT_CONFIG_PARAMETERS: "",
} as const;

/**
 * Git hooks may run only for trusted projects with project automation
 * allowed: under the benchmark kill-switch a dataset repo can plant
 * .git/hooks/post-checkout (or core.hooksPath) that would otherwise execute
 * with provider credentials during git operations (e.g. worktree add for
 * task forks), despite the rest of project automation being disabled.
 */
export function gitHooksAllowed(trusted?: boolean): boolean {
  return trusted === true && !projectAutomationDisabled();
}

/** Empty tree OID: pointing GIT_ATTR_SOURCE here makes git ignore tracked
 * .gitattributes (git >= 2.40). $GIT_DIR/info/attributes has higher
 * precedence and is handled by the repo-aware filter-driver overrides below.
 * Older gits ignore the variable; secret blanking remains a second layer. */
const GIT_EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Environment for repo-automation-off git executions. Hooks are only one of
 * git's repo-controlled process vectors: repo config can also define checkout
 * filters (filter.<name>.smudge selected by attributes), fsmonitor daemons,
 * credential helpers, and core.sshCommand. This static baseline suppresses
 * tracked attributes and those non-filter vectors; repo-aware callers append
 * overrides for drivers selected by $GIT_DIR/info/attributes. It also blanks
 * provider secret env vars, so any process that still slips through inherits
 * nothing worth exfiltrating. Values are empty strings rather than deletions
 * because exec helpers merge overrides onto process.env.
 */
export function gitNoRepoAutomationEnv(): Record<string, string> {
  const env: Record<string, string> = {
    ...GIT_NO_HOOKS_ENV,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
    // An empty credential.helper value resets the helper list.
    GIT_CONFIG_KEY_2: "credential.helper",
    GIT_CONFIG_VALUE_2: "",
    GIT_ATTR_SOURCE: GIT_EMPTY_TREE_OID,
    // Environment beats repo-config core.sshCommand.
    GIT_SSH_COMMAND: "ssh",
  };
  for (const name of providerSecretEnvVarNames()) {
    env[name] = "";
  }
  // Root-dir pointers are not secrets, but they lead any residual
  // repo-controlled process straight to providers.jsonc (benchmark harnesses
  // export them); blank them alongside the provider secrets.
  env.XUM_ROOT = "";
  env.MUX_ROOT = "";
  return env;
}

export const GIT_REPO_AUTOMATION_CONFIG_KEY_PATTERN =
  "^(filter[.].*[.](clean|smudge|process|required)|diff[.].*[.](command|textconv))$";
export const MAX_GIT_REPO_AUTOMATION_CONFIG_OUTPUT_BYTES = 256 * 1024;

const REPO_AUTOMATION_CONFIG_KEY_REGEX =
  /^(filter|diff)[.](.+)[.](clean|smudge|process|required|command|textconv)$/i;
const MAX_REPO_AUTOMATION_DRIVERS = 128;

function appendDisabledRepoAutomationDrivers(
  env: Record<string, string>,
  configKeys: Iterable<string>
): Record<string, string> {
  const drivers = new Map<string, { kind: "filter" | "diff"; name: string }>();
  for (const key of configKeys) {
    const match = REPO_AUTOMATION_CONFIG_KEY_REGEX.exec(key);
    if (match == null) {
      continue;
    }
    const kind = match[1].toLowerCase() as "filter" | "diff";
    const name = match[2];
    if (name.length > 512 || /[\0\r\n]/.test(name)) {
      throw new Error("Refusing git operation with an unsupported driver name");
    }
    drivers.set(kind + "\0" + name, { kind, name });
    if (drivers.size > MAX_REPO_AUTOMATION_DRIVERS) {
      throw new Error(
        "Refusing git operation with more than " +
          MAX_REPO_AUTOMATION_DRIVERS +
          " repo automation drivers"
      );
    }
  }

  let configIndex = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  for (const { kind, name } of [...drivers.values()].sort((a, b) =>
    (a.kind + "\0" + a.name).localeCompare(b.kind + "\0" + b.name)
  )) {
    const fields =
      kind === "filter"
        ? ([
            ["clean", ""],
            ["smudge", ""],
            ["process", ""],
            ["required", "false"],
          ] as const)
        : ([
            ["command", ""],
            ["textconv", ""],
          ] as const);
    for (const [field, value] of fields) {
      env["GIT_CONFIG_KEY_" + configIndex] = kind + "." + name + "." + field;
      env["GIT_CONFIG_VALUE_" + configIndex] = value;
      configIndex += 1;
    }
  }
  env.GIT_CONFIG_COUNT = String(configIndex);
  return env;
}

export function gitNoRepoAutomationEnvForConfigKeys(
  configKeys: Iterable<string>
): Record<string, string> {
  return appendDisabledRepoAutomationDrivers(gitNoRepoAutomationEnv(), configKeys);
}

export function gitNoRepoAutomationEnvForFilterConfigKeys(
  configKeys: Iterable<string>
): Record<string, string> {
  return gitNoRepoAutomationEnvForConfigKeys(configKeys);
}

export function gitEnvPrefix(env: Record<string, string>): string {
  return (
    Object.entries(env)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ") + " "
  );
}

function isNoMatchingConfigError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 1
  );
}

/**
 * Build a repo-aware automation-off environment for local git operations.
 * GIT_ATTR_SOURCE suppresses tracked .gitattributes, but Git gives
 * $GIT_DIR/info/attributes higher precedence. Discovering every configured
 * attribute driver and overriding it at command scope neutralizes both sources
 * without mutating repository files (which would be racy and destructive).
 */
export async function gitNoRepoAutomationEnvForLocalRepo(
  repoPath: string,
  signal?: AbortSignal
): Promise<Record<string, string>> {
  const baseEnv = gitNoRepoAutomationEnv();
  try {
    using proc = execFileAsync(
      "git",
      [
        "-C",
        repoPath,
        "config",
        "--null",
        "--name-only",
        "--includes",
        "--get-regexp",
        GIT_REPO_AUTOMATION_CONFIG_KEY_PATTERN,
      ],
      {
        env: baseEnv,
        signal,
        timeoutMs: 10_000,
        maxOutputBytes: MAX_GIT_REPO_AUTOMATION_CONFIG_OUTPUT_BYTES,
        killTreeOnTermination: true,
      }
    );
    const { stdout } = await proc.result;
    return appendDisabledRepoAutomationDrivers(baseEnv, stdout.split("\0"));
  } catch (error) {
    // git config --get-regexp exits 1 when no keys match.
    if (isNoMatchingConfigError(error)) {
      return baseEnv;
    }
    // Fail closed: materialization must not proceed with an unknown set of
    // repo-configured attribute drivers.
    throw new Error("Failed to inspect repository automation drivers", { cause: error });
  }
}

/**
 * Build the static shell prefix for git operations where repository config
 * cannot be inspected on the host (for example remote clone paths). Local
 * materialization uses gitNoRepoAutomationEnvForLocalRepo so info-attribute
 * drivers are also overridden. Returns empty string when automation
 * is allowed.
 */
export function gitNoHooksPrefix(trusted?: boolean): string {
  if (gitHooksAllowed(trusted)) return "";
  return gitEnvPrefix(gitNoRepoAutomationEnv());
}
