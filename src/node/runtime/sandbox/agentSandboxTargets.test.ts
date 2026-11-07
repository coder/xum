import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ResolvedAgentSandboxSettings } from "@/common/config/schemas/agentSandbox";
import { agentSandboxPolicyAllows, buildAgentSandboxPolicy } from "./agentSandboxTargets";

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
  const savedRoot = process.env.XUM_ROOT;
  // Outside every write root, so only the nested deny can hide its files. It need not exist.
  const xumRoot = path.join(path.parse(os.tmpdir()).root, `xum-sandbox-test-${process.pid}`);

  beforeEach(() => {
    process.env.XUM_ROOT = xumRoot;
  });

  afterEach(() => {
    if (savedRoot === undefined) delete process.env.XUM_ROOT;
    else process.env.XUM_ROOT = savedRoot;
  });

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
