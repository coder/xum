import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ResolvedAgentSandboxSettings } from "@/common/config/schemas/agentSandbox";
import {
  AgentSandboxStartError,
  agentSandboxPolicyAllows,
  buildAgentSandboxPolicy,
} from "./agentSandboxTargets";
import { isPathAtOrUnder } from "./sandboxPaths";

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
    const plugins = path.join(root, "agent-plugins");
    await fs.mkdir(plugins);
    await fs.mkdir(path.join(home, ".agents"), { recursive: true });
    await fs.symlink(plugins, path.join(home, ".agents", "plugins"));
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    try {
      const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });

      expect(agentSandboxPolicyAllows(policy, path.join(plugins, "p", ".mcp.json"), "write")).toBe(
        false
      );
    } finally {
      homedir.mockRestore();
    }
  });

  // Xum starts MCP servers with npx and uvx outside the sandbox, and both run what they cache.
  test("keeps what npx and uvx run read-only, and the rest of their caches writable", async () => {
    const home = path.join(root, "home");
    const movedUvCache = path.join(root, "uv-cache");
    await fs.mkdir(path.join(home, ".npm", "_npx"), { recursive: true });
    const savedUvCacheDir = process.env.UV_CACHE_DIR;
    process.env.UV_CACHE_DIR = movedUvCache;
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    try {
      const policy = buildAgentSandboxPolicy(SETTINGS, { cwd: repo });
      const npm = path.join(home, ".npm");
      const cache = path.join(home, ".cache");

      for (const file of [
        path.join(npm, "_npx", "a", "cli.js"),
        path.join(cache, "uv", "environments-v2", "a", "bin", "tool"),
        path.join(movedUvCache, "archive-v0", "a", "tool.py"),
      ]) {
        expect(agentSandboxPolicyAllows(policy, file, "write")).toBe(false);
      }
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
      if (savedUvCacheDir === undefined) delete process.env.UV_CACHE_DIR;
      else process.env.UV_CACHE_DIR = savedUvCacheDir;
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
});
