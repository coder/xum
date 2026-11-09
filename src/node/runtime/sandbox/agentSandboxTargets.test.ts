import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ResolvedAgentSandboxSettings } from "@/common/config/schemas/agentSandbox";
import {
  AgentSandboxStartError,
  agentSandboxPolicyAllows,
  agentSandboxSettingsFor,
  buildAgentSandboxPolicy,
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

  // An open git folder is writable, so a sandboxed command can rewrite its commondir file.
  test("a rewritten commondir file does not move the git folder it opens", async () => {
    const elsewhere = path.join(root, "elsewhere");
    await fs.mkdir(elsewhere);
    await fs.writeFile(path.join(commonDir, "worktrees", "wt", "commondir"), `${elsewhere}\n`);

    expect(buildAgentSandboxPolicy(SETTINGS, { cwd: worktree }).gitCommonDirs).toEqual([commonDir]);
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

  test("keeps a protected file that is a symlink read-only where it points", async () => {
    const actual = path.join(commonDir, "config.actual");
    await fs.rename(path.join(commonDir, "config"), actual);
    await fs.symlink("config.actual", path.join(commonDir, "config"));

    expect(
      agentSandboxPolicyAllows(buildAgentSandboxPolicy(SETTINGS, { cwd: repo }), actual, "write")
    ).toBe(false);
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
    await fs.symlink(home, path.join(home, ".npm"));
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    using _tmpdir = homeOutsideWriteRoots();
    try {
      expect(buildAgentSandboxPolicy(SETTINGS, { cwd: repo }).writeRoots).not.toContain(home);
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

  // Xum and its git use these as spelled, outside the sandbox, so a command could replace the link.
  test.each([
    // Any existing folder and file outside the write roots and the home folder.
    { name: "XUM_ROOT", target: "/usr" },
    { name: "GIT_CONFIG_GLOBAL", target: "/etc/hosts" },
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

  // An SSH password that the user types into Xum passes through this folder.
  test("hide the answers to SSH prompts", () => {
    const answer = path.join(askpassSessionsRoot(), "mux-askpass-a", "response.1.txt");
    const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: os.tmpdir() });

    expect(agentSandboxPolicyAllows(policy, answer, "read")).toBe(false);
  });
});

// A command of a multi-project workspace can change every project's checkout.
describe("agentSandboxSettingsFor several projects", () => {
  afterEach(() => setAgentSandboxTargets(null));

  test("applies the sandbox when one project has it on, with what each such project allows", () => {
    const on = (overrides: Partial<ResolvedAgentSandboxSettings>) => ({
      ...SETTINGS,
      ...overrides,
    });
    const a = on({
      network: "allowlist",
      allowedHosts: ["x.dev", "y.dev"],
      extraWritePaths: ["~/.gradle", "~/.m2"],
      extraReadPaths: ["~/.npmrc"],
    });
    setAgentSandboxTargets({
      fallback: { ...SETTINGS, enabled: false },
      byProject: new Map([
        ["/a", a],
        ["/b", on({ network: "allowlist", allowedHosts: ["y.dev"], extraWritePaths: ["~/.m2"] })],
        ["/open", on({ network: "open", extraWritePaths: ["~/.m2", "~/.gradle"] })],
        ["/loopback", on({ network: "loopback" })],
      ]),
    });

    expect(agentSandboxSettingsFor("/off")).toBeNull();
    expect(agentSandboxSettingsFor("/off", ["/a"])).toEqual(a);
    expect(agentSandboxSettingsFor("/a", ["/off", "/b", "/open"])).toEqual({
      enabled: true,
      network: "allowlist",
      allowedHosts: ["y.dev"],
      extraWritePaths: ["~/.m2"],
      extraReadPaths: [],
    });
    expect(agentSandboxSettingsFor("/open", ["/loopback"])?.network).toBe("loopback");
  });
});
