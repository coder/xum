import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ResolvedAgentSandboxSettings } from "@/common/config/schemas/agentSandbox";
import {
  AgentSandboxStartError,
  agentSandboxPolicyAllows,
  agentSandboxSettingsFor,
  buildAgentSandboxPolicy,
  buildStrictestAgentSandboxPolicy,
  setAgentSandboxTargets,
} from "./agentSandboxTargets";
import { askpassSessionsRoot } from "../sshAskpass";
import { isPathAtOrUnder, realpathOfNearest, sandboxToolEnv } from "./sandboxPaths";

const SETTINGS: ResolvedAgentSandboxSettings = {
  enabled: true,
  network: "loopback",
  allowedHosts: [],
  extraWritePaths: [],
  extraReadPaths: [],
};

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/**
 * Moves the temp write root off the test's temp folder, so a home folder there is outside the
 * write roots, as it is outside a test: the policy fails closed on a link in a write root that
 * Xum, git or ssh follows.
 */
function homeOutsideWriteRoots(): Disposable {
  const tmpdir = spyOn(os, "tmpdir").mockReturnValue("/private/tmp");
  return { [Symbol.dispose]: () => tmpdir.mockRestore() };
}

/** Reads `standIn` where the policy reads the system file `system`; every other call is real. */
function redirectSystemFile(system: string, standIn: string): Disposable {
  const redirected = <F extends (...args: never[]) => unknown>(real: F): F =>
    ((file: unknown, ...rest: unknown[]) =>
      (real as unknown as (...args: unknown[]) => unknown)(
        file === system ? standIn : file,
        ...rest
      )) as unknown as F;
  const { statSync, readFileSync } = fsSync;
  const stat = spyOn(fsSync, "statSync").mockImplementation(redirected(statSync));
  const read = spyOn(fsSync, "readFileSync").mockImplementation(redirected(readFileSync));
  return {
    [Symbol.dispose]: () => {
      stat.mockRestore();
      read.mockRestore();
    },
  };
}

const savedRoot = process.env.XUM_ROOT;
// Outside every write root, so a test that moves the home folder into a temp folder does not
// move Xum's home folder there too, where the policy fails closed. It need not exist.
const xumRoot = path.join(path.parse(os.tmpdir()).root, `xum-sandbox-test-${process.pid}`);

beforeEach(() => {
  process.env.XUM_ROOT = xumRoot;
});

afterEach(() => {
  if (savedRoot === undefined) delete process.env.XUM_ROOT;
  else process.env.XUM_ROOT = savedRoot;
});

// Where a credential store moves when `name` is `<workspace>/<value>`.
const MOVED_CREDENTIAL_STORES = [
  { name: "UV_CREDENTIALS_DIR", value: "uv-creds", file: "uv-creds/credentials.toml" },
  { name: "XDG_DATA_HOME", value: "data", file: "data/uv/credentials/credentials.toml" },
  { name: "CARGO_HOME", value: "cargo", file: "cargo/credentials.toml" },
  { name: "HF_TOKEN_PATH", value: "hf-token", file: "hf-token" },
  { name: "HF_TOKEN_PATH", value: "hf/token", file: "hf/stored_tokens" },
  { name: "HF_HOME", value: "hf", file: "hf/stored_tokens" },
  { name: "XDG_CACHE_HOME", value: "cache", file: "cache/huggingface/stored_tokens" },
  { name: "GOENV", value: "go-env", file: "go-env" },
  { name: "npm_config_userconfig", value: "npmrc", file: "npmrc" },
  { name: "NPM_CONFIG_USERCONFIG", value: "npmrc", file: "npmrc" },
  { name: "Npm_Config_GlobalConfig", value: "npmrc", file: "npmrc" },
  { name: "NPM_CONFIG_PREFIX", value: "npm", file: "npm/etc/npmrc" },
  { name: "PREFIX", value: "npm", file: "npm/etc/npmrc" },
  { name: "PIP_CONFIG_FILE", value: "pip.conf", file: "pip.conf" },
  { name: "GRADLE_USER_HOME", value: "gradle", file: "gradle/gradle.properties" },
  { name: "DOCKER_CONFIG", value: "docker", file: "docker/config.json" },
  { name: "AWS_SHARED_CREDENTIALS_FILE", value: "aws-credentials", file: "aws-credentials" },
  { name: "AWS_CONFIG_FILE", value: "aws-config", file: "aws-config" },
  { name: "GOOGLE_APPLICATION_CREDENTIALS", value: "sa.json", file: "sa.json" },
  { name: "CLOUDSDK_CONFIG", value: "gcloud", file: "gcloud/credentials.db" },
  { name: "AZURE_CONFIG_DIR", value: "azure", file: "azure/msal_token_cache.json" },
  { name: "GH_CONFIG_DIR", value: "gh", file: "gh/hosts.yml" },
  { name: "KUBECONFIG", value: "kubeconfig", file: "kubeconfig" },
  { name: "AZURE_CLIENT_CERTIFICATE_PATH", value: "azure.pem", file: "azure.pem" },
  { name: "NETRC", value: "netrc", file: "netrc" },
  { name: "AWS_WEB_IDENTITY_TOKEN_FILE", value: "web-identity", file: "web-identity" },
  { name: "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE", value: "gcloud-token", file: "gcloud-token" },
  { name: "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE", value: "gcloud.json", file: "gcloud.json" },
  { name: "AZURE_FEDERATED_TOKEN_FILE", value: "azure-token", file: "azure-token" },
  { name: "PGPASSFILE", value: "pgpass", file: "pgpass" },
  { name: "POSTGRES_PASSWORD_FILE", value: "pg-password", file: "pg-password" },
];

describe("buildAgentSandboxPolicy", () => {
  let root: string;
  let repo: string;
  let worktree: string;
  let commonDir: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-targets-")));
    repo = path.join(root, "repo");
    worktree = path.join(root, "wt");
    commonDir = path.join(repo, ".git");
    await fs.mkdir(repo);
    git(repo, "init", "-q");
    git(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "i"
    );
    git(repo, "worktree", "add", "-q", worktree);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // Git outside the sandbox takes the config and hooks of the folder that commondir names.
  test("fails closed when a worktree's commondir file names another git folder", async () => {
    expect(buildAgentSandboxPolicy(SETTINGS, { cwd: worktree }).gitCommonDirs).toEqual([commonDir]);
    const elsewhere = path.join(worktree, "elsewhere");
    await fs.mkdir(elsewhere);
    await fs.writeFile(path.join(commonDir, "worktrees", "wt", "commondir"), `${elsewhere}\n`);

    expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: worktree })).toThrow(
      AgentSandboxStartError
    );
  });

  test("a .git file without a matching back pointer opens no git folder", async () => {
    const plain = path.join(root, "plain");
    const target = path.join(root, "target");
    await fs.mkdir(path.join(target, "worktrees", "x"), { recursive: true });
    await fs.writeFile(path.join(target, "HEAD"), "ref: refs/heads/main\n");
    await fs.mkdir(plain);
    await fs.writeFile(
      path.join(plain, ".git"),
      `gitdir: ${path.join(target, "worktrees", "x")}\n`
    );

    expect(buildAgentSandboxPolicy(SETTINGS, { cwd: plain }).gitCommonDirs).toEqual([]);
  });

  // spawnProcess() starts a background command in a temp folder and names its checkout in
  // workspaceRoots.
  test("opens the git folder of a worktree among the workspace roots", () => {
    const policy = buildAgentSandboxPolicy(SETTINGS, {
      cwd: os.tmpdir(),
      workspaceRoots: [worktree],
    });

    expect(policy.gitCommonDirs).toEqual([commonDir]);
  });

  test("keeps the worktree config and submodule git folders read-only", () => {
    const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: worktree });
    const linked = path.join(commonDir, "worktrees", "wt");

    for (const target of [
      path.join(linked, "config.worktree"),
      path.join(linked, "modules", "sub", "hooks", "post-checkout"),
      // Git outside the sandbox reads the config and hooks of the folder it names.
      path.join(linked, "commondir"),
      path.join(commonDir, "config.worktree"),
      path.join(commonDir, "modules", "sub", "config"),
    ]) {
      expect(agentSandboxPolicyAllows(policy, target, "write")).toBe(false);
    }
    expect(agentSandboxPolicyAllows(policy, path.join(linked, "index"), "write")).toBe(true);
  });

  // Git outside the sandbox runs the script that a hook links to.
  test("keeps the scripts that git hooks link to read-only", async () => {
    const script = path.join(worktree, "scripts", "post-checkout");
    await fs.mkdir(path.dirname(script));
    await fs.writeFile(script, "#!/bin/sh\n");
    await fs.symlink(script, path.join(commonDir, "hooks", "post-checkout"));
    await fs.symlink("../../scripts/pre-commit", path.join(commonDir, "hooks", "pre-commit"));

    const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: worktree });
    expect(agentSandboxPolicyAllows(policy, script, "write")).toBe(false);
    expect(
      agentSandboxPolicyAllows(policy, path.join(repo, "scripts", "pre-commit"), "write")
    ).toBe(false);
    expect(agentSandboxPolicyAllows(policy, path.join(worktree, "scripts", "x"), "write")).toBe(
      true
    );
  });

  // Git outside the sandbox follows a .git file, or a commondir file in a git folder, to the
  // config and hooks of the folder it names.
  test("lets no command point git at a git folder of its choosing", async () => {
    const plain = path.join(root, "plain");
    const linked = path.join(root, "linked");
    await fs.mkdir(plain);
    await fs.mkdir(linked);
    await fs.symlink(commonDir, path.join(linked, ".git"));

    const plainPolicy = buildAgentSandboxPolicy(SETTINGS, { cwd: plain });
    expect(agentSandboxPolicyAllows(plainPolicy, path.join(plain, ".git"), "write")).toBe(false);
    expect(agentSandboxPolicyAllows(plainPolicy, path.join(plain, "notes"), "write")).toBe(true);
    const repoPolicy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });
    expect(agentSandboxPolicyAllows(repoPolicy, path.join(commonDir, "commondir"), "write")).toBe(
      false
    );
    // Git follows a .git link, and a command could point it at a git folder that it wrote.
    expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: linked })).toThrow(
      AgentSandboxStartError
    );
  });

  // Git outside the sandbox, such as Xum's own `git worktree add`, runs the hooks and config of
  // the git folder that a `.git` file names.
  test("keeps the git folder of a separate-git-dir repository read-only", async () => {
    const separate = path.join(root, "separate");
    const gitDir = path.join(separate, "gitdir");
    await fs.mkdir(separate);
    git(separate, "init", "-q", `--separate-git-dir=${gitDir}`);

    const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: separate });

    for (const name of ["hooks/post-checkout", "config", "modules/sub/config", "commondir"]) {
      expect(agentSandboxPolicyAllows(policy, path.join(gitDir, name), "write")).toBe(false);
    }
    expect(agentSandboxPolicyAllows(policy, path.join(gitDir, "index"), "write")).toBe(true);
  });

  test("keeps the folder that a linked commondir names read-only", async () => {
    const separate = path.join(root, "separate");
    const gitDir = path.join(separate, "gitdir");
    const common = path.join(separate, "common");
    await fs.mkdir(separate);
    git(separate, "init", "-q", `--separate-git-dir=${gitDir}`);
    await fs.mkdir(path.join(common, "hooks"), { recursive: true });
    await fs.writeFile(path.join(separate, "commondir.txt"), `${common}\n`);
    await fs.symlink(path.join(separate, "commondir.txt"), path.join(gitDir, "commondir"));

    const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: separate });

    for (const name of ["hooks/post-checkout", "config"]) {
      expect(agentSandboxPolicyAllows(policy, path.join(common, name), "write")).toBe(false);
    }
  });

  test("keeps a protected file that is a symlink read-only where it points", async () => {
    const actual = path.join(commonDir, "config.actual");
    await fs.rename(path.join(commonDir, "config"), actual);
    await fs.symlink("config.actual", path.join(commonDir, "config"));

    expect(
      agentSandboxPolicyAllows(buildAgentSandboxPolicy(SETTINGS, { cwd: repo }), actual, "write")
    ).toBe(false);
  });

  // Git outside the sandbox follows the whole chain, so a command must not replace a link on it.
  test("keeps every link on the way from a protected path read-only", async () => {
    const outside = path.join(root, "outside-hooks");
    const alias = path.join(repo, "hooks-alias");
    await fs.mkdir(outside);
    await fs.rm(path.join(commonDir, "hooks"), { recursive: true });
    await fs.symlink(outside, alias);
    await fs.symlink(alias, path.join(commonDir, "hooks"));

    const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });

    expect(agentSandboxPolicyAllows(policy, alias, "write")).toBe(false);
    expect(agentSandboxPolicyAllows(policy, path.join(outside, "pre-commit"), "write")).toBe(false);
  });

  // A command could point the folder link at another folder, and git would follow it there.
  test("fails closed when a protected path links through a folder link in a write root", async () => {
    await fs.mkdir(path.join(repo, "real", "hooks"), { recursive: true });
    await fs.symlink(path.join(repo, "real"), path.join(repo, "dirlink"));
    await fs.rm(path.join(commonDir, "hooks"), { recursive: true });
    await fs.symlink(path.join(repo, "dirlink", "hooks"), path.join(commonDir, "hooks"));

    expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).toThrow(AgentSandboxStartError);
  });

  test("opens a PATH folder in the home folder, not the folder around it", async () => {
    const documents = path.join(await fs.realpath(os.homedir()), "Documents");
    const bin = path.join(documents, "bin");
    const { allowRead } = buildAgentSandboxPolicy(SETTINGS, { cwd: repo, pathEnv: bin });

    expect(allowRead).toContain(bin);
    expect(allowRead).not.toContain(documents);
  });

  // A sandboxed command may write a cache folder or a temp folder, so it can swap one for a link
  // that the next command's policy must not follow.
  test("does not open where a cache folder that is a symlink points", async () => {
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.symlink(home, path.join(home, ".cargo-registry"));
    await fs.mkdir(path.join(home, ".cargo"));
    await fs.symlink(home, path.join(home, ".cargo", "registry"));
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    using _tmpdir = homeOutsideWriteRoots();
    try {
      expect(buildAgentSandboxPolicy(SETTINGS, { cwd: repo }).writeRoots).not.toContain(home);
    } finally {
      homedir.mockRestore();
    }
  });

  // npx outside the sandbox runs ~/.npm/_npx through the link, which a command can replace.
  test("fails closed when the npm cache folder is a symlink", async () => {
    const home = path.join(root, "home");
    await fs.mkdir(path.join(home, "npm-cache"), { recursive: true });
    await fs.symlink(path.join(home, "npm-cache"), path.join(home, ".npm"));
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    using _tmpdir = homeOutsideWriteRoots();
    try {
      expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).toThrow(
        AgentSandboxStartError
      );
    } finally {
      homedir.mockRestore();
    }
  });

  test("does not follow a symlink in a write root to a PATH folder", async () => {
    const home = path.join(root, "home");
    const documents = path.join(home, "Documents");
    await fs.mkdir(path.join(documents, "bin"), { recursive: true });
    await fs.mkdir(path.join(home, ".cache"));
    await fs.symlink(documents, path.join(home, ".cache", "tool"));
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    try {
      const { allowRead } = buildAgentSandboxPolicy(SETTINGS, {
        cwd: repo,
        pathEnv: path.join(home, ".cache", "tool", "bin"),
      });

      expect(allowRead).not.toContain(path.join(documents, "bin"));
    } finally {
      homedir.mockRestore();
    }
  });

  // Bash sources tool_env before the script, also for a call that the user let run outside, and
  // MCP servers (also those of plugins) start outside the sandbox.
  test("keeps the project files that Xum runs outside the sandbox read-only", () => {
    const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });

    for (const file of [
      ...[".xum", ".mux"].flatMap((dir) =>
        ["tool_env", "mcp.local.jsonc", "mcp.local.json", "plugins/p/.mcp.json"].map((name) =>
          path.join(dir, name)
        )
      ),
      ".agents/plugins/p/.mcp.json",
      ".devcontainer.json",
      ".devcontainer/py/devcontainer.json",
    ]) {
      expect(agentSandboxPolicyAllows(policy, path.join(repo, file), "write")).toBe(false);
    }
  });

  // root is in the temp folder, a write root outside the (hidden) home folder.
  test("keeps a global plugin folder that is a link into a write root read-only", async () => {
    const home = path.join(root, "home");
    const plugins = path.join(repo, "agent-plugins");
    await fs.mkdir(plugins);
    await fs.mkdir(path.join(home, ".agents"), { recursive: true });
    await fs.symlink(plugins, path.join(home, ".agents", "plugins"));
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    using _tmpdir = homeOutsideWriteRoots();
    try {
      const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });

      expect(agentSandboxPolicyAllows(policy, path.join(plugins, "p", ".mcp.json"), "write")).toBe(
        false
      );
    } finally {
      homedir.mockRestore();
    }
  });

  // Xum loads a linked plugin from its checkout and starts its MCP servers outside the sandbox.
  test("keeps a linked global plugin read-only, and fails closed in a linked skill", async () => {
    const home = path.join(root, "home");
    await fs.mkdir(path.join(home, ".agents", "plugins"), { recursive: true });
    await fs.mkdir(path.join(home, ".agents", "skills"), { recursive: true });
    await fs.mkdir(path.join(repo, "plugin"));
    await fs.symlink(path.join(repo, "plugin"), path.join(home, ".agents", "plugins", "demo"));
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    using _tmpdir = homeOutsideWriteRoots();
    try {
      const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });
      const writable = (name: string) =>
        agentSandboxPolicyAllows(policy, path.join(repo, name), "write");
      expect(writable("plugin/.mcp.json")).toBe(false);
      expect(writable("notes.md")).toBe(true);

      // The workspace itself is a global skill: it cannot stay writable and read-only at once.
      await fs.symlink(repo, path.join(home, ".agents", "skills", "demo"));
      expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).toThrow(
        AgentSandboxStartError
      );
    } finally {
      homedir.mockRestore();
    }
  });

  // A command could replace the link in the workspace that the chain goes through.
  test("fails closed when a global plugin links through a link in a write root", async () => {
    const home = path.join(root, "home");
    await fs.mkdir(path.join(home, ".agents", "plugins"), { recursive: true });
    // Any existing folder outside the write roots and the home folder.
    await fs.symlink("/usr", path.join(repo, "plugin"));
    await fs.symlink(path.join(repo, "plugin"), path.join(home, ".agents", "plugins", "demo"));
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    using _tmpdir = homeOutsideWriteRoots();
    try {
      expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).toThrow(
        AgentSandboxStartError
      );
    } finally {
      homedir.mockRestore();
    }
  });

  // Git opens an include as spelled, so a command could replace a link there.
  test("fails closed when a git include is a link in a write root", async () => {
    // Any existing file outside the write roots and the home folder.
    await fs.symlink("/etc/hosts", path.join(repo, "git.inc"));
    git(repo, "config", "include.path", path.join(repo, "git.inc"));

    expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).toThrow(AgentSandboxStartError);
  });

  // bunx for an MCP server outside the sandbox runs what such a folder holds, through the link.
  test("fails closed when a bunx temp folder is a link in a write root", async () => {
    const temp = path.join(root, "tmp");
    const uid = process.getuid?.() ?? 0;
    await fs.mkdir(temp);
    await fs.mkdir(path.join(temp, `bunx-${uid}-a@latest`));
    const tmpdir = spyOn(os, "tmpdir").mockReturnValue(temp);
    try {
      expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).not.toThrow();

      await fs.symlink(path.join(repo, "pkg"), path.join(temp, `bunx-${uid}-b@latest`));
      expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).toThrow(
        AgentSandboxStartError
      );
    } finally {
      tmpdir.mockRestore();
    }
  });

  // Git that Xum runs outside the sandbox runs a credential.helper from the global config.
  test("keeps a global git config that is a link into a write root read-only", async () => {
    const home = path.join(root, "home");
    const dotfiles = path.join(repo, "dotfiles");
    await fs.mkdir(path.join(dotfiles, "git"), { recursive: true });
    await fs.writeFile(path.join(dotfiles, "gitconfig"), "");
    await fs.mkdir(path.join(home, ".config"), { recursive: true });
    await fs.symlink(path.join(dotfiles, "gitconfig"), path.join(home, ".gitconfig"));
    await fs.symlink(path.join(dotfiles, "git"), path.join(home, ".config", "git"));
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    using _tmpdir = homeOutsideWriteRoots();
    try {
      const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });
      const writable = (target: string) => agentSandboxPolicyAllows(policy, target, "write");

      expect(writable(path.join(dotfiles, "gitconfig"))).toBe(false);
      expect(writable(path.join(dotfiles, "git", "config"))).toBe(false);
      expect(writable(path.join(dotfiles, "notes.md"))).toBe(true);
    } finally {
      homedir.mockRestore();
    }
  });

  // Xum starts MCP servers with npx, uvx and bunx outside the sandbox, and each runs what it
  // caches.
  test("keeps what npx, uvx and bunx run read-only, and the rest of their caches writable", async () => {
    const home = path.join(root, "home");
    const movedUvCache = path.join(root, "uv-cache");
    const movedNpmCache = path.join(root, "npm-cache");
    const uid = process.getuid?.() ?? 0;
    await fs.mkdir(path.join(home, ".npm", "_npx"), { recursive: true });
    const saved = { uv: process.env.UV_CACHE_DIR, npm: process.env.npm_config_cache };
    process.env.UV_CACHE_DIR = movedUvCache;
    process.env.npm_config_cache = movedNpmCache;
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    try {
      const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });
      const npm = path.join(home, ".npm");
      const cache = path.join(home, ".cache");
      const temp = await fs.realpath(os.tmpdir());

      for (const file of [
        path.join(npm, "_npx", "a", "cli.js"),
        path.join(cache, "uv", "environments-v2", "a", "bin", "tool"),
        path.join(movedUvCache, "archive-v0", "a", "tool.py"),
        path.join(movedNpmCache, "_npx", "a", "cli.js"),
        path.join(home, ".bun", "install", "cache", "a@1.0.0@@@1", "cli.js"),
        path.join(home, "Library", "Caches", "bun", "@t@", "a.pile"),
        path.join(temp, `bunx-${uid}-a@latest`, "node_modules", ".bin", "a"),
        path.join(temp, `.bunx-${uid}`, "a@latest", "package.json"),
      ]) {
        expect(agentSandboxPolicyAllows(policy, file, "write")).toBe(false);
      }
      // Bun in the sandbox installs and runs bunx in a cache of its own.
      const ownBunCache = sandboxToolEnv().BUN_INSTALL_CACHE_DIR;
      expect(
        agentSandboxPolicyAllows(policy, path.join(ownBunCache, `.bunx-${uid}`, "a"), "write")
      ).toBe(true);
      expect(agentSandboxPolicyAllows(policy, path.join(temp, `bunx-${uid}`), "write")).toBe(true);
      // The home folder is in a temp folder here, so the allows cannot show the rest is open.
      expect(
        policy.denyWrite.filter(
          (denied) => isPathAtOrUnder(denied, npm) || isPathAtOrUnder(denied, cache)
        )
      ).toEqual([
        path.join(cache, "huggingface", "token"),
        path.join(cache, "huggingface", "stored_tokens"),
        path.join(npm, "_npx"),
        path.join(cache, "uv"),
      ]);
    } finally {
      homedir.mockRestore();
      for (const [name, value] of [
        ["UV_CACHE_DIR", saved.uv],
        ["npm_config_cache", saved.npm],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("does not follow a symlink in a write root that extraReadPaths names", async () => {
    const home = path.join(root, "home");
    await fs.mkdir(path.join(home, ".cache"), { recursive: true });
    await fs.symlink(home, path.join(home, ".cache", "input"));
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    try {
      const { allowRead } = buildAgentSandboxPolicy(
        { ...SETTINGS, extraReadPaths: ["~/.cache/input"] },
        { cwd: repo }
      );

      expect(allowRead).not.toContain(home);
    } finally {
      homedir.mockRestore();
    }
  });

  test("fails closed when Xum's home folder is in a folder that commands can write", () => {
    process.env.XUM_ROOT = path.join(root, "xum-home");

    expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).toThrow(AgentSandboxStartError);
  });

  // Xum starts the MCP servers of its global plugins outside the sandbox.
  test("fails closed when an extraWritePaths entry is in Xum's home folder", () => {
    expect(() =>
      buildAgentSandboxPolicy(
        { ...SETTINGS, extraWritePaths: [path.join(xumRoot, "plugins")] },
        { cwd: repo }
      )
    ).toThrow(AgentSandboxStartError);
  });

  // Git outside the sandbox (Xum's `git worktree add` too) takes an included file as config.
  test("keeps the files that the global git config includes read-only, also nested", async () => {
    // The home folder is a nested deny in the temp folder, so the included files live in repo.
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.mkdir(path.join(repo, "nested"));
    await fs.writeFile(
      path.join(home, ".gitconfig"),
      "[user]\n\tname = t\n[include]\n\tpath = ~/../repo/a.gitconfig ; shared\n"
    );
    await fs.writeFile(
      path.join(repo, "a.gitconfig"),
      '[IncludeIf "onbranch:main"]\n\tpath = "nested/b c.gitconfig"\n'
    );
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    try {
      const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });
      const writable = (...parts: string[]) =>
        agentSandboxPolicyAllows(policy, path.join(repo, ...parts), "write");

      expect(writable("a.gitconfig")).toBe(false);
      expect(writable("nested", "b c.gitconfig")).toBe(false);
      expect(writable("notes.md")).toBe(true);
    } finally {
      homedir.mockRestore();
    }
  });

  test("keeps a file that the repository's git config includes read-only", () => {
    git(repo, "config", "include.path", "../shared.gitconfig");

    const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });

    expect(agentSandboxPolicyAllows(policy, path.join(repo, "shared.gitconfig"), "write")).toBe(
      false
    );
  });

  // Git reads the config of the repository that a workspace folder is in, and of each submodule.
  test("keeps what the enclosing repository's git config includes read-only", async () => {
    const workspace = path.join(repo, "sub");
    await fs.mkdir(workspace);
    git(repo, "config", "include.path", path.join(workspace, "repo.gitconfig"));

    const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: workspace });

    expect(agentSandboxPolicyAllows(policy, path.join(workspace, "repo.gitconfig"), "write")).toBe(
      false
    );
    expect(agentSandboxPolicyAllows(policy, path.join(workspace, "notes.md"), "write")).toBe(true);
  });

  test("keeps what a submodule's git config includes read-only, also under a name with a /", async () => {
    const submodule = path.join(commonDir, "modules", "vendor", "lib");
    const nested = path.join(submodule, "modules", "deep");
    for (const gitDir of [submodule, nested]) {
      await fs.mkdir(gitDir, { recursive: true });
      await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    }
    await fs.writeFile(path.join(submodule, "config"), `[include]\n\tpath = ${repo}/lib.inc\n`);
    await fs.writeFile(path.join(nested, "config"), `[include]\n\tpath = ${repo}/deep.inc\n`);

    const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });

    expect(agentSandboxPolicyAllows(policy, path.join(repo, "lib.inc"), "write")).toBe(false);
    expect(agentSandboxPolicyAllows(policy, path.join(repo, "deep.inc"), "write")).toBe(false);
  });

  test("keeps a submodule git folder that a link in .git/modules names read-only", async () => {
    const linked = path.join(repo, "vendor-git");
    await fs.mkdir(path.join(linked, "hooks"), { recursive: true });
    await fs.writeFile(path.join(linked, "HEAD"), "ref: refs/heads/main\n");
    await fs.mkdir(path.join(commonDir, "modules"));
    await fs.symlink(linked, path.join(commonDir, "modules", "vendor"));

    const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });

    for (const name of ["hooks/post-checkout", "config"]) {
      expect(agentSandboxPolicyAllows(policy, path.join(linked, name), "write")).toBe(false);
    }
    expect(agentSandboxPolicyAllows(policy, path.join(repo, "notes.md"), "write")).toBe(true);
  });

  test("fails closed on a git include path that it cannot read as git does", () => {
    git(repo, "config", "include.path", '../"git config"');

    expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).toThrow(AgentSandboxStartError);
  });

  // ssh runs a ProxyCommand outside the sandbox for Xum's own git fetch.
  test("keeps a home dotfile that links into a write root read-only", async () => {
    const home = path.join(root, "home");
    await fs.mkdir(path.join(home, ".ssh"), { recursive: true });
    await fs.writeFile(path.join(repo, "ssh_config"), "Host *\n");
    await fs.symlink(path.join(repo, "ssh_config"), path.join(home, ".ssh", "config"));
    await fs.symlink(repo, path.join(home, ".dotfiles"));
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    using _tmpdir = homeOutsideWriteRoots();
    try {
      const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });
      const writable = (name: string) =>
        agentSandboxPolicyAllows(policy, path.join(repo, name), "write");

      expect(writable("ssh_config")).toBe(false);
      expect(writable("notes.md")).toBe(true);
    } finally {
      homedir.mockRestore();
    }
  });

  test("keeps what ~/.ssh/config includes read-only, also through a wildcard", async () => {
    const home = path.join(root, "home");
    await fs.mkdir(path.join(home, ".ssh"), { recursive: true });
    await fs.mkdir(path.join(repo, "ssh"));
    await fs.writeFile(
      path.join(home, ".ssh", "config"),
      "Include ~/../repo/ssh/*.conf # Mike's hosts\n"
    );
    await fs.writeFile(
      path.join(repo, "ssh", "a.conf"),
      `Include "${repo}/deep conf" '${repo}/single conf'\n`
    );
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    try {
      const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });
      const writable = (...parts: string[]) =>
        agentSandboxPolicyAllows(policy, path.join(repo, ...parts), "write");

      expect(writable("ssh", "new.conf")).toBe(false);
      expect(writable("deep conf")).toBe(false);
      expect(writable("single conf")).toBe(false);
      expect(writable("notes.md")).toBe(true);
    } finally {
      homedir.mockRestore();
    }
  });

  // Xum's own git fetch runs a ProxyCommand from it outside the sandbox.
  test("keeps ~/.ssh/config read-only in a write root", async () => {
    const home = path.join(root, "home");
    await fs.mkdir(path.join(home, ".ssh"), { recursive: true });
    await fs.writeFile(path.join(home, ".ssh", "config"), "Host *\n");
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    using _tmpdir = homeOutsideWriteRoots();
    try {
      const policy = buildAgentSandboxPolicy(
        { ...SETTINGS, extraWritePaths: ["~/.ssh"] },
        { cwd: repo }
      );
      const writable = (name: string) =>
        agentSandboxPolicyAllows(policy, path.join(home, ".ssh", name), "write");

      expect(writable("config")).toBe(false);
      expect(writable("known_hosts")).toBe(true);
    } finally {
      homedir.mockRestore();
    }
  });

  // Xum reads them into the prompt outside the sandbox, so a command could swap the target for a
  // link to a key.
  test("keeps a global instruction file that links into a write root read-only", async () => {
    const home = path.join(root, "home");
    const xumHome = path.join(root, "xum-home");
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.mkdir(xumHome);
    for (const name of ["CLAUDE.md", "AGENTS.md"]) await fs.writeFile(path.join(repo, name), "");
    await fs.symlink(path.join(repo, "CLAUDE.md"), path.join(home, ".claude", "CLAUDE.md"));
    await fs.symlink(path.join(repo, "AGENTS.md"), path.join(xumHome, "AGENTS.md"));
    process.env.XUM_ROOT = xumHome;
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    using _tmpdir = homeOutsideWriteRoots();
    try {
      const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });
      const writable = (name: string) =>
        agentSandboxPolicyAllows(policy, path.join(repo, name), "write");

      expect(writable("CLAUDE.md")).toBe(false);
      expect(writable("AGENTS.md")).toBe(false);
      expect(writable("notes.md")).toBe(true);
    } finally {
      homedir.mockRestore();
    }
  });

  // A write through the other name changes what every workspace gets in its prompt.
  test.each([
    { name: "Xum's AGENTS.md", file: (root: string) => path.join(root, "xum-home", "AGENTS.md") },
    {
      name: "~/.claude/CLAUDE.md",
      file: (root: string) => path.join(root, "home", ".claude", "CLAUDE.md"),
    },
  ])("fails closed on a hard link to $name", async ({ file }) => {
    const home = path.join(root, "home");
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.mkdir(path.join(root, "xum-home"));
    await fs.writeFile(file(root), "");
    await fs.link(file(root), path.join(repo, "alias.md"));
    process.env.XUM_ROOT = path.join(root, "xum-home");
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    using _tmpdir = homeOutsideWriteRoots();
    try {
      expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).toThrow(
        AgentSandboxStartError
      );
    } finally {
      homedir.mockRestore();
    }
  });

  // ssh reads the system config too, and looks for its relative includes in /etc/ssh.
  test("keeps what the system ssh config includes read-only", async () => {
    const systemConfig = path.join(root, "ssh_config");
    await fs.writeFile(systemConfig, `Include ${repo}/system.conf ../../${repo}/relative.conf\n`);
    using _redirect = redirectSystemFile("/etc/ssh/ssh_config", systemConfig);
    const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });
    const writable = (name: string) =>
      agentSandboxPolicyAllows(policy, path.join(repo, name), "write");

    expect(writable("system.conf")).toBe(false);
    expect(writable("relative.conf")).toBe(false);
    expect(writable("notes.md")).toBe(true);
  });

  // Git reads the system config in every repository too, Xum's own git included.
  test("keeps what the system git config includes read-only", async () => {
    const systemConfig = path.join(root, "gitconfig");
    await fs.writeFile(systemConfig, `[include]\n\tpath = ${repo}/system.gitconfig\n`);
    using _redirect = redirectSystemFile("/etc/gitconfig", systemConfig);
    const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });
    const writable = (name: string) =>
      agentSandboxPolicyAllows(policy, path.join(repo, name), "write");

    expect(writable("system.gitconfig")).toBe(false);
    expect(writable("notes.md")).toBe(true);
  });

  // ssh follows a link that an Include wildcard matches.
  test("keeps where a link that an ssh Include wildcard matches leads read-only", async () => {
    const home = path.join(root, "home");
    const confD = path.join(home, ".ssh", "conf.d");
    await fs.mkdir(confD, { recursive: true });
    await fs.writeFile(path.join(home, ".ssh", "config"), "Include conf.d/*\n");
    await fs.writeFile(path.join(repo, "proxy.conf"), "Host *\n");
    await fs.symlink(path.join(repo, "proxy.conf"), path.join(confD, "proxy"));
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    using _tmpdir = homeOutsideWriteRoots();
    try {
      const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });
      const writable = (name: string) =>
        agentSandboxPolicyAllows(policy, path.join(repo, name), "write");
      expect(writable("proxy.conf")).toBe(false);
      expect(writable("notes.md")).toBe(true);

      // A command could make the missing target, which ssh would then read.
      await fs.symlink(path.join(repo, "later.conf"), path.join(confD, "later"));
      expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).toThrow(
        AgentSandboxStartError
      );
    } finally {
      homedir.mockRestore();
    }
  });

  // OpenSSH reads `a\ b` and `a" b"` as the one name `a b`.
  test("fails closed on an ssh Include argument that is escaped or quoted in part", async () => {
    const home = path.join(root, "home");
    await fs.mkdir(path.join(home, ".ssh"), { recursive: true });
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    try {
      for (const include of ["proxy\\ config", 'proxy" config"']) {
        await fs.writeFile(path.join(home, ".ssh", "config"), `Include ${repo}/${include}\n`);

        expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).toThrow(
          AgentSandboxStartError
        );
      }
    } finally {
      homedir.mockRestore();
    }
  });

  // Xum's own git reads the global config where its environment moves it.
  test("keeps the global git config that the environment names read-only", async () => {
    const saved = { XDG: process.env.XDG_CONFIG_HOME, GLOBAL: process.env.GIT_CONFIG_GLOBAL };
    process.env.XDG_CONFIG_HOME = path.join(repo, "xdg");
    process.env.GIT_CONFIG_GLOBAL = path.join(repo, "global.gitconfig");
    await fs.writeFile(path.join(repo, "global.gitconfig"), "[include]\n\tpath = more.gitconfig\n");
    try {
      const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });
      const writable = (...parts: string[]) =>
        agentSandboxPolicyAllows(policy, path.join(repo, ...parts), "write");

      expect(writable("xdg", "git", "config")).toBe(false);
      expect(writable("global.gitconfig")).toBe(false);
      expect(writable("more.gitconfig")).toBe(false);
      expect(writable("notes.md")).toBe(true);
    } finally {
      for (const [name, value] of [
        ["XDG_CONFIG_HOME", saved.XDG],
        ["GIT_CONFIG_GLOBAL", saved.GLOBAL],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  // Git reads all of it, so an include past the first MiB still counts.
  test("fails closed on a git config that is too large to read", async () => {
    await fs.appendFile(path.join(commonDir, "config"), `#${"x".repeat(1024 * 1024)}\n`);

    expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).toThrow(AgentSandboxStartError);
  });

  // A write through the other name changes the protected file, and no rule can name every link.
  test("fails closed on a protected file with another hard link", async () => {
    await fs.mkdir(path.join(repo, ".xum"));
    await fs.writeFile(path.join(repo, ".xum", "mcp.jsonc"), "{}\n");
    await fs.link(path.join(repo, ".xum", "mcp.jsonc"), path.join(repo, "editable-mcp.jsonc"));

    expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).toThrow(AgentSandboxStartError);
  });

  // Xum starts a global plugin's MCP servers outside the sandbox.
  test("fails closed when the workspace is inside a global plugin folder", async () => {
    const home = path.join(root, "home");
    const plugin = path.join(home, ".agents", "plugins", "tool");
    await fs.mkdir(plugin, { recursive: true });
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    try {
      expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: plugin })).toThrow(
        AgentSandboxStartError
      );
    } finally {
      homedir.mockRestore();
    }
  });

  test("hides a home folder outside /Users", async () => {
    const home = path.join(root, "home");
    await fs.mkdir(home);
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    try {
      const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });

      expect(agentSandboxPolicyAllows(policy, path.join(home, ".ssh", "id_rsa"), "read")).toBe(
        false
      );
    } finally {
      homedir.mockRestore();
    }
  });

  // xumRoot is outside the home folder, /Users and /Volumes.
  test("hides Xum's home folder outside the home folder, except the folders it opens", () => {
    const scratchDir = path.join(xumRoot, "sessions", "ws", "scratch");
    const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo, scratchDir });
    const readable = (...parts: string[]) =>
      agentSandboxPolicyAllows(policy, path.join(xumRoot, ...parts), "read");

    expect(readable("bash-ai-proxy.json")).toBe(false);
    expect(readable("sessions", "other", "chat.jsonl")).toBe(false);
    expect(readable("sessions", "ws", "scratch", "notes.md")).toBe(true);
    expect(readable("skills", "demo", "SKILL.md")).toBe(true);
  });

  // A Cursor hook gets its chat's transcript in transcript_path.
  test("opens the files a call names in readPaths, not their neighbors", () => {
    const transcript = path.join(xumRoot, "sessions", "ws", "chat.jsonl");
    const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo, readPaths: [transcript] });
    const allows = (file: string, access: "read" | "write") =>
      agentSandboxPolicyAllows(policy, file, access);

    expect(allows(transcript, "read")).toBe(true);
    expect(allows(transcript, "write")).toBe(false);
    expect(allows(path.join(xumRoot, "sessions", "ws", "partial.json"), "read")).toBe(false);
  });

  // A command can rename a checkout in a write root and leave a link to ~/.ssh in its place.
  test("fails closed when the workspace leads through a link in a write root", async () => {
    // Any existing folder outside the write roots and the home folder.
    const linked = path.join(root, "linked");
    await fs.symlink("/usr", linked);

    expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: linked })).toThrow(
      AgentSandboxStartError
    );
    expect(() =>
      buildAgentSandboxPolicy(SETTINGS, { cwd: repo, workspaceRoots: [linked] })
    ).toThrow(AgentSandboxStartError);
  });

  // Xum, its git, npx and uvx use these as spelled, outside the sandbox, so a command could
  // replace the link.
  test.each([
    // Any existing folder and file outside the write roots and the home folder.
    { name: "XUM_ROOT", target: "/usr" },
    { name: "GIT_CONFIG_GLOBAL", target: "/etc/hosts" },
    { name: "npm_config_cache", target: "/usr" },
    { name: "UV_CACHE_DIR", target: "/usr" },
  ])("fails closed when $name is a link in a write root", async ({ name, target }) => {
    const alias = path.join(repo, "alias");
    await fs.symlink(target, alias);
    const saved = process.env[name];
    process.env[name] = alias;
    try {
      expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).toThrow(
        AgentSandboxStartError
      );
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  });

  // Git and uv resolve a relative value from where they run, for Xum's own git the workspace.
  test.each(["GIT_CONFIG_GLOBAL", "XDG_CACHE_HOME", "GRADLE_USER_HOME"])(
    "fails closed when %s is a relative path",
    (name) => {
      const saved = process.env[name];
      process.env[name] = "relative";
      try {
        expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).toThrow(
          AgentSandboxStartError
        );
      } finally {
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
      }
    }
  );

  // It can hold a registry token, as ~/.npmrc can.
  test("keeps ~/.bunfig.toml closed for reads unless extraReadPaths opens it", () => {
    const bunfig = path.join(realpathOfNearest(os.homedir()), ".bunfig.toml");
    const readable = (extraReadPaths: string[]) =>
      agentSandboxPolicyAllows(
        buildAgentSandboxPolicy({ ...SETTINGS, extraReadPaths }, { cwd: repo }),
        bunfig,
        "read"
      );

    expect(readable([])).toBe(false);
    expect(readable(["~/.bunfig.toml"])).toBe(true);
  });

  // Xum reads its config through the link, outside the sandbox, so a command could replace the hop.
  test("fails closed when a file in Xum's home folder links through a link in a write root", async () => {
    const xumHome = path.join(root, "xum-home");
    await fs.mkdir(xumHome);
    // Any existing file outside the write roots and the home folder.
    await fs.symlink("/etc/hosts", path.join(repo, "config-alias"));
    await fs.symlink(path.join(repo, "config-alias"), path.join(xumHome, "config.json"));
    process.env.XUM_ROOT = xumHome;
    using _tmpdir = homeOutsideWriteRoots();

    expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).toThrow(AgentSandboxStartError);
  });

  // Seatbelt hides and protects names, so a hard link in the workspace would write Xum's config.
  test("fails closed on a hidden file with a hard link in the workspace", async () => {
    const xumHome = path.join(root, "xum-home");
    await fs.mkdir(xumHome);
    await fs.writeFile(path.join(xumHome, "config.json"), "{}\n");
    await fs.link(path.join(xumHome, "config.json"), path.join(repo, "config-alias"));
    process.env.XUM_ROOT = xumHome;
    using _tmpdir = homeOutsideWriteRoots();

    expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).toThrow(AgentSandboxStartError);
  });

  // The folder is the deny, but the hard-link check reads files.
  test("fails closed on uv's token file with a hard link in the workspace", async () => {
    const home = path.join(root, "home");
    const store = path.join(home, ".local", "share", "uv", "credentials");
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(path.join(store, "credentials.toml"), "\n");
    await fs.link(path.join(store, "credentials.toml"), path.join(repo, "uv-tokens"));
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    using _tmpdir = homeOutsideWriteRoots();
    try {
      expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).toThrow(
        AgentSandboxStartError
      );
    } finally {
      homedir.mockRestore();
    }
  });

  // A credential store that Xum's environment moves into the workspace is open there otherwise.
  test.each(MOVED_CREDENTIAL_STORES)(
    "hides $file where $name moves it",
    ({ name, value, file }) => {
      const saved = process.env[name];
      process.env[name] = path.join(repo, value);
      try {
        const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });

        expect(agentSandboxPolicyAllows(policy, path.join(repo, file), "read")).toBe(false);
        expect(agentSandboxPolicyAllows(policy, path.join(repo, file), "write")).toBe(false);
      } finally {
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
      }
    }
  );

  // Bash and the file tools overlay the project's secrets onto Xum's environment.
  test.each(MOVED_CREDENTIAL_STORES)(
    "hides $file where the command's $name moves it",
    ({ name, value, file }) => {
      const policy = buildAgentSandboxPolicy(SETTINGS, {
        cwd: repo,
        env: { [name]: path.join(repo, value) },
      });

      expect(agentSandboxPolicyAllows(policy, path.join(repo, file), "read")).toBe(false);
      expect(agentSandboxPolicyAllows(policy, path.join(repo, file), "write")).toBe(false);
    }
  );

  test("hides every file that KUBECONFIG lists, and an AWS file that starts with ~/", () => {
    const policy = buildAgentSandboxPolicy(SETTINGS, {
      cwd: repo,
      env: {
        KUBECONFIG: [path.join(repo, "kube-a"), path.join(repo, "kube-b")].join(path.delimiter),
        AWS_SHARED_CREDENTIALS_FILE: "~/.cache/uv/aws-credentials",
      },
    });

    expect(agentSandboxPolicyAllows(policy, path.join(repo, "kube-a"), "read")).toBe(false);
    expect(agentSandboxPolicyAllows(policy, path.join(repo, "kube-b"), "read")).toBe(false);
    expect(policy.denyRead).toContain(path.join(os.homedir(), ".cache", "uv", "aws-credentials"));
  });

  test("hides a secret file that a variable names by convention, and nothing else", () => {
    const policy = buildAgentSandboxPolicy(SETTINGS, {
      cwd: repo,
      env: {
        SOPS_AGE_KEY_FILE: "~/.cache/uv/age.key",
        // A tool Xum does not know resolves this from where it runs: nothing to hide here.
        DEPLOY_TOKEN_FILE: "deploy-token",
        SSL_CERT_FILE: path.join(repo, "ca.pem"),
      },
    });

    expect(policy.denyRead).toContain(path.join(os.homedir(), ".cache", "uv", "age.key"));
    expect(agentSandboxPolicyAllows(policy, path.join(repo, "ca.pem"), "read")).toBe(true);
  });

  // Xum runs `git submodule update` outside the sandbox with the project's secrets.
  test("keeps the git config that the command's environment names read-only", async () => {
    await fs.writeFile(path.join(repo, "global.gitconfig"), "[include]\n\tpath = more.gitconfig\n");
    const policy = buildAgentSandboxPolicy(SETTINGS, {
      cwd: repo,
      env: {
        XDG_CONFIG_HOME: path.join(repo, "xdg"),
        GIT_CONFIG_GLOBAL: path.join(repo, "global.gitconfig"),
        GIT_CONFIG_SYSTEM: path.join(repo, "system.gitconfig"),
      },
    });
    const writable = (...parts: string[]) =>
      agentSandboxPolicyAllows(policy, path.join(repo, ...parts), "write");

    expect(writable("xdg", "git", "config")).toBe(false);
    expect(writable("global.gitconfig")).toBe(false);
    expect(writable("more.gitconfig")).toBe(false);
    expect(writable("system.gitconfig")).toBe(false);
    expect(writable("notes.md")).toBe(true);
  });

  // Git, npm and the MCP servers that Xum starts with the project's secrets read their settings
  // in HOME, which the policy protects in Xum's home only.
  test("fails closed when the command's environment moves HOME", () => {
    const policyWithHome = (home: string | undefined) => () =>
      buildAgentSandboxPolicy(SETTINGS, { cwd: repo, env: { HOME: home } });

    expect(policyWithHome(path.join(repo, "home"))).toThrow(AgentSandboxStartError);
    expect(policyWithHome(process.env.HOME)).not.toThrow();
    // `.` names the real home only where Xum starts in it; git resolves it in the workspace.
    const cwd = process.cwd();
    process.chdir(process.env.HOME ?? os.homedir());
    try {
      expect(policyWithHome(".")).toThrow(AgentSandboxStartError);
    } finally {
      process.chdir(cwd);
    }
  });

  // `go env -w GOPROXY=https://user:password@host` writes the password there.
  test("hides Go's env file in the Go folder that stays open", async () => {
    const home = path.join(root, "home");
    const goDir = path.join(home, "Library", "Application Support", "go");
    await fs.mkdir(path.join(goDir, "telemetry"), { recursive: true });
    await fs.writeFile(path.join(goDir, "env"), "GOPROXY=https://alice:secret@proxy.example\n");
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    using _tmpdir = homeOutsideWriteRoots();
    try {
      const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });

      expect(agentSandboxPolicyAllows(policy, path.join(goDir, "env"), "read")).toBe(false);
      expect(agentSandboxPolicyAllows(policy, path.join(goDir, "telemetry"), "read")).toBe(true);
    } finally {
      homedir.mockRestore();
    }
  });

  // GOENV=off turns Go's env file off; it is not a relative path.
  test("starts with GOENV=off", () => {
    const saved = process.env.GOENV;
    process.env.GOENV = "off";
    try {
      expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo })).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.GOENV;
      else process.env.GOENV = saved;
    }
  });

  // `/dev/null` turns the file off; hiding it would break every command that opens it.
  test.each(["NPM_CONFIG_USERCONFIG", "PIP_CONFIG_FILE"])(
    "keeps /dev/null open when the command's %s names it",
    (name) => {
      const policy = buildAgentSandboxPolicy(SETTINGS, {
        cwd: repo,
        env: { [name]: os.devNull },
      });

      expect(agentSandboxPolicyAllows(policy, os.devNull, "read")).toBe(true);
    }
  );

  // Seatbelt follows the link, so a scratch folder that is one would open where it points.
  test("fails closed when the scratch folder is a symlink", async () => {
    const elsewhere = path.join(root, "elsewhere");
    const scratch = path.join(root, "scratch");
    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, scratch);
    using _tmpdir = homeOutsideWriteRoots();

    expect(() => buildAgentSandboxPolicy(SETTINGS, { cwd: repo, scratchDir: scratch })).toThrow(
      AgentSandboxStartError
    );
  });

  // A command can replace the link in the workspace, and the next policy would follow it.
  test("does not open where a toolchain folder that links into a write root leads", async () => {
    const home = path.join(root, "home");
    const ssh = path.join(home, ".ssh");
    await fs.mkdir(path.join(home, ".local", "share"), { recursive: true });
    await fs.mkdir(ssh);
    await fs.symlink(ssh, path.join(repo, "uv-data"));
    await fs.symlink(path.join(repo, "uv-data"), path.join(home, ".local", "share", "uv"));
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    using _tmpdir = homeOutsideWriteRoots();
    try {
      const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });

      expect(agentSandboxPolicyAllows(policy, path.join(ssh, "id_ed25519"), "read")).toBe(false);
    } finally {
      homedir.mockRestore();
    }
  });

  // A default macOS volume opens `.XUM/MCP.JSONC` as `.xum/mcp.jsonc`.
  test("keeps protected paths read-only in any case", () => {
    const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });
    const writable = (...parts: string[]) =>
      agentSandboxPolicyAllows(policy, path.join(repo, ...parts), "write");

    expect(writable(".XUM", "MCP.JSONC")).toBe(false);
    expect(writable(".git", "hook\u017f", "pre-commit")).toBe(false);
    expect(writable(".git", "Hoo\u212As", "pre-commit")).toBe(false);
    expect(writable("NOTES.md")).toBe(true);
  });

  test("keeps the worktree config of a repository in the workspace read-only", () => {
    const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });

    expect(
      agentSandboxPolicyAllows(
        policy,
        path.join(commonDir, "worktrees", "wt", "config.worktree"),
        "write"
      )
    ).toBe(false);
  });
});

describe("buildAgentSandboxPolicy credential files", () => {
  // xumRoot is outside every write root, so only the nested deny can hide its files.
  test("stay hidden when extraReadPaths names them", () => {
    const secrets = path.join(xumRoot, "secrets.json");
    const policy = buildAgentSandboxPolicy(
      { ...SETTINGS, extraReadPaths: [secrets], extraWritePaths: [secrets] },
      { cwd: os.tmpdir() }
    );

    expect(agentSandboxPolicyAllows(policy, secrets, "read")).toBe(false);
    expect(agentSandboxPolicyAllows(policy, secrets, "write")).toBe(false);
  });

  // ~/.local/share/uv is open for reads, so only the nested deny hides the tokens in it.
  test("hide uv's login tokens in its open data folder", async () => {
    const uvData = path.join(await fs.realpath(os.homedir()), ".local", "share", "uv");
    const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: os.tmpdir() });

    expect(
      agentSandboxPolicyAllows(policy, path.join(uvData, "credentials", "credentials.toml"), "read")
    ).toBe(false);
    expect(agentSandboxPolicyAllows(policy, path.join(uvData, "python", "bin"), "read")).toBe(true);
  });

  // An SSH password that the user types into Xum passes through this folder.
  test("hide the answers to SSH prompts", () => {
    const answer = path.join(askpassSessionsRoot(), "mux-askpass-a", "response.1.txt");
    const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: os.tmpdir() });

    expect(agentSandboxPolicyAllows(policy, answer, "read")).toBe(false);
  });

  // Seatbelt applies a nested deny only strictly inside an open folder.
  test.each([
    { open: "the workspace", input: () => ({ cwd: askpassSessionsRoot() }) },
    {
      open: "the scratch folder",
      input: () => ({ cwd: os.tmpdir(), scratchDir: path.join(askpassSessionsRoot(), "s") }),
    },
  ])("fail closed when $open is in the SSH prompt folder", ({ input }) => {
    expect(() => buildAgentSandboxPolicy(SETTINGS, input())).toThrow(AgentSandboxStartError);
  });
});

// A command of a multi-project workspace can change every project's checkout.
describe("agentSandboxSettingsFor several projects", () => {
  let root: string;
  let cwd: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-projects-")));
    cwd = path.join(root, "repo");
    await fs.mkdir(cwd);
  });

  afterEach(async () => {
    setAgentSandboxTargets(null);
    await fs.rm(root, { recursive: true, force: true });
  });

  const policyFor = (projectPath: string, otherProjectPaths: string[]) => {
    const settings = agentSandboxSettingsFor(projectPath, otherProjectPaths);
    if (settings === null) throw new Error(`no sandbox for ${projectPath}`);
    // Outside the temp folders, so the test's folders are not write roots of every policy.
    using _tmpdir = homeOutsideWriteRoots();
    return buildStrictestAgentSandboxPolicy(settings, { cwd });
  };

  test("applies the sandbox when one project has it on, with what each such project allows", () => {
    const on = (overrides: Partial<ResolvedAgentSandboxSettings>) => ({
      ...SETTINGS,
      ...overrides,
    });
    const a = on({
      network: "allowlist",
      allowedHosts: ["x.dev", "y.dev"],
      extraWritePaths: [path.join(root, "gradle"), path.join(root, "m2")],
      extraReadPaths: [path.join(root, "npmrc")],
    });
    setAgentSandboxTargets({
      fallback: { ...SETTINGS, enabled: false },
      byProject: new Map([
        ["/a", a],
        // Host names match in any case.
        [
          "/b",
          on({
            network: "allowlist",
            allowedHosts: ["Y.dev"],
            extraWritePaths: [path.join(root, "m2")],
          }),
        ],
        [
          "/open",
          on({
            network: "open",
            extraWritePaths: [path.join(root, "m2"), path.join(root, "gradle")],
          }),
        ],
        ["/loopback", on({ network: "loopback" })],
      ]),
    });

    expect(agentSandboxSettingsFor("/off")).toBeNull();
    expect(agentSandboxSettingsFor("/off", ["/a"])).toEqual([a]);
    const policy = policyFor("/a", ["/off", "/b", "/open"]);
    expect(policy.network).toBe("allowlist");
    expect(policy.allowedHosts).toEqual(["y.dev"]);
    expect(policy.writeRoots).toContain(path.join(root, "m2"));
    expect(policy.writeRoots).not.toContain(path.join(root, "gradle"));
    expect(policy.allowRead).not.toContain(path.join(root, "npmrc"));
    expect(policyFor("/open", ["/loopback"]).network).toBe("loopback");
  });

  test("keeps a path that one project lists inside a folder that the other lists", () => {
    setAgentSandboxTargets({
      fallback: { ...SETTINGS, enabled: false },
      byProject: new Map([
        [
          "/a",
          {
            ...SETTINGS,
            extraWritePaths: [path.join(root, "shared")],
            extraReadPaths: [path.join(root, "tools", "x")],
          },
        ],
        [
          "/b",
          {
            ...SETTINGS,
            extraWritePaths: [path.join(root, "shared", "cache"), path.join(root, "other")],
            extraReadPaths: [path.join(root, "tools")],
          },
        ],
      ]),
    });

    const policy = policyFor("/a", ["/b"]);
    expect(policy.writeRoots).toContain(path.join(root, "shared", "cache"));
    expect(policy.writeRoots).not.toContain(path.join(root, "shared"));
    expect(policy.writeRoots).not.toContain(path.join(root, "other"));
    expect(policy.allowRead).toContain(path.join(root, "tools", "x"));
    expect(policy.allowRead).not.toContain(path.join(root, "tools"));
  });

  test("keeps a folder that two projects name through different symlinks", async () => {
    for (const folder of ["write", "read"]) {
      await fs.mkdir(path.join(root, folder));
      await fs.symlink(path.join(root, folder), path.join(root, `${folder}-a`));
      await fs.symlink(path.join(root, folder), path.join(root, `${folder}-b`));
    }
    const through = (link: string): ResolvedAgentSandboxSettings => ({
      ...SETTINGS,
      extraWritePaths: [path.join(root, `write-${link}`)],
      extraReadPaths: [path.join(root, `read-${link}`)],
    });
    setAgentSandboxTargets({
      fallback: { ...SETTINGS, enabled: false },
      byProject: new Map([
        ["/a", through("a")],
        ["/b", through("b")],
      ]),
    });

    const policy = policyFor("/a", ["/b"]);
    expect(policy.writeRoots).toContain(path.join(root, "write"));
    expect(policy.allowRead).toContain(path.join(root, "read"));
  });

  // The policy does not follow a link in a write root: a command could have put it there.
  test("does not open what a link in one project's write root points to", async () => {
    const home = path.join(root, "home");
    const secret = path.join(home, "secret");
    await fs.mkdir(secret, { recursive: true });
    await fs.mkdir(path.join(root, "cache"));
    await fs.symlink(secret, path.join(root, "cache", "link"));
    setAgentSandboxTargets({
      fallback: { ...SETTINGS, enabled: false },
      byProject: new Map([
        ["/a", { ...SETTINGS, extraReadPaths: [secret] }],
        [
          "/b",
          {
            ...SETTINGS,
            extraWritePaths: [path.join(root, "cache")],
            extraReadPaths: [path.join(root, "cache", "link")],
          },
        ],
      ]),
    });
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    try {
      const policy = policyFor("/a", ["/b"]);

      expect(agentSandboxPolicyAllows(policy, path.join(secret, "key"), "read")).toBe(false);
    } finally {
      homedir.mockRestore();
    }
  });
});
