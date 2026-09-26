/**
 * Branch-by-branch contract for gitNoRepoAutomationEnvForLocalRepo, the repo-controlled git
 * config discovery that untrusted projects run before every local bash command and worktree
 * operation. Each case builds a real repository and pins the outcome: the exact env, or the
 * error message plus the refusal/parser cause. Git failures that real repositories cannot produce
 * are injected with a PATH-first git shim.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  GIT_REPO_AUTOMATION_CONFIG_KEY_PATTERN,
  gitNoRepoAutomationEnv,
  gitNoRepoAutomationEnvForConfigKeys,
  gitNoRepoAutomationEnvForLocalRepo,
} from "./gitNoHooksEnv";

const AUTOMATION = "Failed to inspect repository automation drivers";
const WORKTREE = "Failed to inspect repository worktree config";
const INCLUDES = "Failed to inspect repository conditional includes";
const REFUSED_INCLUDEIF = "Refusing git operation with conditional config includes";
const REFUSED_EXECUTABLE = "Refusing git operation with unsupported executable config";
const UNREPRESENTABLE_PATTERN =
  "^(includeif[.].*[.]path|gc[.]recentobjectshook|uploadpack[.]packobjectshook)$";
const TEST_TIMEOUT_MS = 30_000;

type Outcome = { env: Record<string, string> } | { error: string; cause?: string };

async function discover(repo: string, allowNonRepository = false, signal?: AbortSignal) {
  try {
    return { env: await gitNoRepoAutomationEnvForLocalRepo(repo, signal, allowNonRepository) };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // Refusal and parser causes are part of the contract. Process failures (exit codes, signals,
    // overflow, abort) carry a `code` and are only identified by the outer message.
    const cause = error.cause instanceof Error && !("code" in error.cause) ? error.cause : null;
    return cause == null
      ? { error: error.message }
      : { error: error.message, cause: cause.message };
  }
}

const baseEnv = (): Outcome => ({ env: gitNoRepoAutomationEnv() });
const driversEnv = (...entries: string[]): Outcome => ({
  env: gitNoRepoAutomationEnvForConfigKeys(entries),
});

function git(repo: string, ...args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
}

async function makeRepo(
  root: string,
  name: string,
  setup?: (repo: string) => void | Promise<void>
): Promise<string> {
  const repo = path.join(root, name);
  await fs.mkdir(repo, { recursive: true });
  git(repo, "init", "-q");
  // Newer git templates no longer create .git/info.
  await fs.mkdir(path.join(repo, ".git", "info"), { recursive: true });
  await setup?.(repo);
  return repo;
}

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false
  );

const appendConfig = (repo: string, text: string | Buffer) =>
  fs.appendFile(path.join(repo, ".git", "config"), text);

const ISOLATED_ENV_KEYS = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "LC_ALL",
  "PATH",
  "XUM_TEST_GIT_LOG",
  "XUM_TEST_GIT_FAULT_MATCH",
  "XUM_TEST_GIT_FAULT_EXIT",
  "XUM_TEST_GIT_FAULT_STDOUT",
] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: DisposableTempDir;

beforeEach(async () => {
  savedEnv = Object.fromEntries(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
  root = new DisposableTempDir("git-discovery");
  // Host git config (for example git-lfs filters) would leak into every result.
  const globalConfig = path.join(root.path, "global.gitconfig");
  await fs.writeFile(globalConfig, "");
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  delete process.env.LC_ALL;
});

afterEach(() => {
  for (const key of ISOLATED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  root[Symbol.dispose]();
});

interface DiscoveryCase {
  name: string;
  repo: (root: string) => string | Promise<string>;
  allowNonRepository?: boolean;
  signal?: AbortSignal;
  expected: () => Outcome;
}

const DRIVER_ENTRIES = [
  "filter.evil.smudge\ncat",
  "diff.evil.command\nhelper",
  "diff.evil.textconv\nhelper",
  "diff.external\nhelper",
  "merge.evil.driver\nhelper",
  "remote.origin.uploadpack\nhelper",
  "alias.evil\n!steal",
  "alias.plain\nstatus",
  "submodule.sub.update\n!helper",
  "hook.evil.command\nhelper",
  "tar.evil.command\nhelper",
  "trailer.evil.command\nhelper",
];

const worktreeConfigRepo = (root: string, name: string, key: string, value: string) =>
  makeRepo(root, name, (repo) => {
    git(repo, "config", "extensions.worktreeConfig", "true");
    git(repo, "config", "--worktree", key, value);
  });

const CASES: DiscoveryCase[] = [
  { name: "clean repository", repo: (r) => makeRepo(r, "clean"), expected: baseEnv },
  ...[true, false].flatMap((allow): DiscoveryCase[] => [
    {
      name: `non-repository (allowNonRepository=${allow})`,
      repo: (r) => fs.mkdtemp(path.join(r, "plain-")),
      allowNonRepository: allow,
      expected: () => (allow ? baseEnv() : { error: AUTOMATION }),
    },
    {
      name: `missing path (allowNonRepository=${allow})`,
      repo: (r) => path.join(r, "missing"),
      allowNonRepository: allow,
      expected: () => (allow ? baseEnv() : { error: AUTOMATION }),
    },
    {
      // rev-parse itself exits 128 on unparsable config, so this is the non-repository branch.
      name: `malformed .git/config (allowNonRepository=${allow})`,
      repo: (r) => makeRepo(r, `malformed-${allow}`, (repo) => appendConfig(repo, "[core\n")),
      allowNonRepository: allow,
      expected: () => (allow ? baseEnv() : { error: AUTOMATION }),
    },
  ]),
  {
    name: "local conditional include",
    repo: (r) =>
      makeRepo(r, "includeif", (repo) => git(repo, "config", "includeIf.onbranch:x.path", "x")),
    expected: () => ({ error: INCLUDES, cause: REFUSED_INCLUDEIF }),
  },
  ...["gc.recentObjectsHook", "uploadpack.packObjectsHook"].map((key) => ({
    name: `local ${key}`,
    repo: (r: string) => makeRepo(r, key, (repo) => git(repo, "config", key, "helper")),
    expected: (): Outcome => ({ error: INCLUDES, cause: REFUSED_EXECUTABLE }),
  })),
  {
    name: "worktree-scoped conditional include",
    repo: (r) => worktreeConfigRepo(r, "wt-includeif", "includeIf.onbranch:x.path", "x"),
    expected: () => ({ error: INCLUDES, cause: REFUSED_INCLUDEIF }),
  },
  {
    name: "worktree-scoped gc.recentObjectsHook",
    repo: (r) => worktreeConfigRepo(r, "wt-gc", "gc.recentObjectsHook", "helper"),
    expected: () => ({ error: INCLUDES, cause: REFUSED_EXECUTABLE }),
  },
  {
    name: "worktree config without drivers",
    repo: (r) =>
      makeRepo(r, "wt-clean", (repo) => git(repo, "config", "extensions.worktreeConfig", "true")),
    expected: baseEnv,
  },
  {
    name: "worktree-scoped filter driver",
    repo: (r) => worktreeConfigRepo(r, "wt-filter", "filter.wt.smudge", "cat"),
    expected: () => driversEnv("filter.wt.smudge\ncat"),
  },
  {
    name: "global conditional include is allowed",
    repo: async (r) => {
      await fs.writeFile(process.env.GIT_CONFIG_GLOBAL!, '[includeIf "onbranch:x"]\n\tpath = x\n');
      return makeRepo(r, "global-includeif");
    },
    expected: baseEnv,
  },
  {
    name: "every driver class",
    repo: (r) =>
      makeRepo(r, "drivers", (repo) => {
        for (const entry of DRIVER_ENTRIES) git(repo, "config", ...entry.split("\n"));
      }),
    expected: () => driversEnv(...DRIVER_ENTRIES),
  },
  {
    name: "driver reached through include.path",
    repo: (r) =>
      makeRepo(r, "include-path", async (repo) => {
        const included = path.join(r, "included.gitconfig");
        await fs.writeFile(included, '[merge "inc"]\n\tdriver = helper\n');
        git(repo, "config", "include.path", included);
      }),
    expected: () => driversEnv("merge.inc.driver\nhelper"),
  },
  {
    name: "non-UTF-8 driver name",
    repo: (r) =>
      makeRepo(r, "non-utf8", (repo) =>
        appendConfig(repo, Buffer.from('[filter "\xff"]\n\tsmudge = cat\n', "latin1"))
      ),
    expected: () => ({
      error: AUTOMATION,
      cause: "Refusing git operation with an unsupported config key",
    }),
  },
  {
    name: "driver name over 512 characters",
    repo: (r) =>
      makeRepo(r, "long-name", (repo) =>
        appendConfig(repo, `[filter "${"a".repeat(513)}"]\n\tsmudge = cat\n`)
      ),
    expected: () => ({
      error: AUTOMATION,
      cause: "Refusing git operation with an unsupported driver name",
    }),
  },
  {
    name: "more than 128 drivers",
    repo: (r) =>
      makeRepo(r, "many-drivers", (repo) =>
        appendConfig(
          repo,
          Array.from({ length: 129 }, (_, i) => `[filter "f${i}"]\n\tsmudge = cat\n`).join("")
        )
      ),
    expected: () => ({
      error: AUTOMATION,
      cause: "Refusing git operation with more than 128 repo automation drivers",
    }),
  },
  {
    name: "driver output over 256 KiB",
    repo: (r) =>
      makeRepo(r, "oversized", (repo) =>
        appendConfig(repo, `[alias]\n\tbig = ${"x".repeat(300 * 1024)}\n`)
      ),
    expected: () => ({ error: AUTOMATION }),
  },
  {
    name: "pre-aborted signal",
    repo: (r) => makeRepo(r, "aborted"),
    signal: AbortSignal.abort(),
    expected: () => ({ error: AUTOMATION }),
  },
  {
    name: "path with a space, an apostrophe and non-ASCII characters",
    repo: (r) =>
      makeRepo(r, "it's a répo ü", (repo) => git(repo, "config", "filter.odd.clean", "cat")),
    expected: () => driversEnv("filter.odd.clean\ncat"),
  },
];

describe("gitNoRepoAutomationEnvForLocalRepo discovery", () => {
  for (const c of CASES) {
    test(
      c.name,
      async () => {
        const repo = await c.repo(root.path);
        expect(await discover(repo, c.allowNonRepository, c.signal)).toEqual(c.expected());
      },
      TEST_TIMEOUT_MS
    );
  }
});

describe.skipIf(process.platform === "win32")("automation stays off (POSIX)", () => {
  test(
    "hooks, fsmonitor and info/attributes filters do not run",
    async () => {
      const marker = (name: string) => path.join(root.path, `${name}-ran`);
      const writeScript = async (name: string, body: string) => {
        const file = path.join(root.path, `${name}.sh`);
        await fs.writeFile(file, `#!/bin/sh\ntouch '${marker(name)}'\n${body}`);
        await fs.chmod(file, 0o755);
        return file;
      };
      const repo = await makeRepo(root.path, "armed", async (r) => {
        await fs.writeFile(path.join(r, "data.txt"), "payload\n");
        git(r, "add", "data.txt");
        git(r, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
        await fs.writeFile(path.join(r, ".git", "info", "attributes"), "* filter=evil\n");
        git(r, "config", "filter.evil.smudge", await writeScript("smudge", "cat\n"));
        git(r, "config", "core.fsmonitor", await writeScript("fsmonitor", ""));
        const hook = path.join(r, ".git", "hooks", "post-checkout");
        await fs.mkdir(path.dirname(hook), { recursive: true });
        await fs.copyFile(await writeScript("hook", ""), hook);
        await fs.chmod(hook, 0o755);
      });
      const markers = ["smudge", "fsmonitor", "hook"].map(marker);
      const ranMarkers = async () => {
        const ran: string[] = [];
        for (const file of markers) if (await exists(file)) ran.push(file);
        return ran;
      };
      const runVectors = async (env: Record<string, string>, branch: string) => {
        const run = (...args: string[]) =>
          execFileSync("git", ["-C", repo, ...args], { stdio: "pipe", env });
        await fs.rm(path.join(repo, "data.txt"));
        run("checkout", "--", "data.txt");
        run("checkout", "-q", "-b", branch);
        run("status", "--porcelain");
      };

      const env = await gitNoRepoAutomationEnvForLocalRepo(repo);
      await runVectors({ ...process.env, ...env } as Record<string, string>, "protected");
      expect(await ranMarkers()).toEqual([]);

      // Control: without the env the same commands run every vector, so the fixture is armed.
      await runVectors(process.env as Record<string, string>, "control");
      expect(await ranMarkers()).toEqual(markers);
    },
    TEST_TIMEOUT_MS
  );
});

describe.skipIf(process.platform === "win32")("injected git failures (POSIX)", () => {
  let log = "";

  beforeEach(async () => {
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const shimDir = path.join(root.path, "shim");
    await fs.mkdir(shimDir);
    // Logs each call, then fails the call whose args contain XUM_TEST_GIT_FAULT_MATCH.
    await fs.writeFile(
      path.join(shimDir, "git"),
      [
        "#!/bin/sh",
        `printf '%s|%s\\n' "\${LC_ALL-<unset>}" "$*" >> "$XUM_TEST_GIT_LOG"`,
        'if [ -n "${XUM_TEST_GIT_FAULT_MATCH-}" ]; then',
        '  case "$*" in *"$XUM_TEST_GIT_FAULT_MATCH"*)',
        `    printf '%b' "\${XUM_TEST_GIT_FAULT_STDOUT-}"`,
        '    if [ "$XUM_TEST_GIT_FAULT_EXIT" = kill ]; then kill -9 $$; fi',
        '    exit "$XUM_TEST_GIT_FAULT_EXIT" ;;',
        "  esac",
        "fi",
        `exec '${realGit}' "$@"`,
        "",
      ].join("\n")
    );
    await fs.chmod(path.join(shimDir, "git"), 0o755);
    log = path.join(root.path, "git-calls.log");
    process.env.XUM_TEST_GIT_LOG = log;
    process.env.PATH = shimDir + path.delimiter + (process.env.PATH ?? "");
  });

  const FAULTS: Array<{
    name: string;
    match: string;
    exit: string;
    stdout?: string;
    worktreeConfig?: boolean;
    allowNonRepository?: boolean;
    expected: () => Outcome;
  }> = [
    // Only exit 128 means "not a repository".
    {
      name: "rev-parse exits 3",
      match: "rev-parse --git-dir",
      exit: "3",
      allowNonRepository: true,
      expected: () => ({ error: AUTOMATION }),
    },
    {
      name: "rev-parse is killed",
      match: "rev-parse --git-dir",
      exit: "kill",
      allowNonRepository: true,
      expected: () => ({ error: AUTOMATION }),
    },
    {
      name: "worktree config query exits 3",
      match: "--bool extensions.worktreeConfig",
      exit: "3",
      expected: () => ({ error: WORKTREE }),
    },
    {
      name: "local unrepresentable-key query exits 3",
      match: "--name-only",
      exit: "3",
      expected: () => ({ error: INCLUDES }),
    },
    {
      name: "worktree unrepresentable-key query exits 3",
      match: "config --worktree",
      exit: "3",
      worktreeConfig: true,
      expected: () => ({ error: INCLUDES }),
    },
    {
      name: "driver query exits 3",
      match: "--includes",
      exit: "3",
      expected: () => ({ error: AUTOMATION }),
    },
    // Real git never prints matches with exit 1; this pins how such output is handled.
    {
      name: "driver query exits 1 with output",
      match: "--includes",
      exit: "1",
      stdout: "filter.x.smudge\\ncat\\0",
      expected: baseEnv,
    },
  ];

  for (const fault of FAULTS) {
    test(
      fault.name,
      async () => {
        const repo = await makeRepo(root.path, "faulted", (r) => {
          if (fault.worktreeConfig) git(r, "config", "extensions.worktreeConfig", "true");
        });
        process.env.XUM_TEST_GIT_FAULT_MATCH = fault.match;
        process.env.XUM_TEST_GIT_FAULT_EXIT = fault.exit;
        process.env.XUM_TEST_GIT_FAULT_STDOUT = fault.stdout ?? "";
        expect(await discover(repo, fault.allowNonRepository)).toEqual(fault.expected());
        // The injected failure actually hit a discovery query.
        expect(await fs.readFile(log, "utf8")).toContain(fault.match);
      },
      TEST_TIMEOUT_MS
    );
  }

  test(
    "runs the expected git queries with LC_ALL=C after rev-parse",
    async () => {
      const repo = await makeRepo(root.path, "queries", (r) =>
        git(r, "config", "extensions.worktreeConfig", "true")
      );
      await fs.writeFile(log, "");
      expect(await discover(repo)).toEqual(baseEnv());
      const at = `-C ${repo}`;
      expect((await fs.readFile(log, "utf8")).trimEnd().split("\n")).toEqual([
        `<unset>|${at} rev-parse --git-dir`,
        `C|${at} config --local --bool extensions.worktreeConfig`,
        `C|${at} config --local --null --name-only --get-regexp ${UNREPRESENTABLE_PATTERN}`,
        `C|${at} config --worktree --null --name-only --get-regexp ${UNREPRESENTABLE_PATTERN}`,
        `C|${at} config --null --includes --get-regexp ${GIT_REPO_AUTOMATION_CONFIG_KEY_PATTERN}`,
      ]);
    },
    TEST_TIMEOUT_MS
  );
});
