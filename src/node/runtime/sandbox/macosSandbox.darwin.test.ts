import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ResolvedAgentSandboxSettings } from "@/common/config/schemas/agentSandbox";
import type { BashToolResult } from "@/common/types/tools";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { WorktreeRuntime } from "@/node/runtime/WorktreeRuntime";
import type { BackgroundHandle } from "@/node/runtime/Runtime";
import { spawnProcess } from "@/node/services/backgroundProcessExecutor";
import { createBashTool } from "@/node/services/tools/bash";
import { createTestToolConfig, mockToolCallOptions } from "@/node/services/tools/testHelpers";
import * as bashPath from "@/node/utils/main/bashPath";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { syncLocalGitSubmodules } from "@/node/runtime/submoduleSync";
import {
  agentSandboxPolicyAllows,
  buildAgentSandboxPolicy,
  setAgentSandboxTargets,
  type AgentSandboxPolicy,
} from "./agentSandboxTargets";
import {
  agentSandboxDenialsAfterExit,
  isAgentSandboxSupported,
  resetAgentSandboxRuntime,
  SRT_RULES_TO_REMOVE,
  wrapWithPolicy,
} from "./macosSandbox";
import { isPathAtOrUnder } from "./sandboxPaths";

// These tests spawn the real /usr/bin/sandbox-exec. Each policy covers temp folders only, so the
// result does not depend on the developer's home. A macOS that drops sandbox-exec fails them.

const BASE_SETTINGS: ResolvedAgentSandboxSettings = {
  enabled: true,
  network: "loopback",
  allowedHosts: [],
  extraWritePaths: [],
  extraReadPaths: [],
};

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  commandId: string;
}

async function runSandboxed(
  policy: AgentSandboxPolicy,
  cwd: string,
  script: string
): Promise<RunResult> {
  const wrap = await wrapWithPolicy(policy, script, { bashPath: "/bin/bash" });
  try {
    // Async spawn only: srt's proxy runs in this process, so spawnSync would block it.
    return await new Promise((resolve, reject) => {
      const child = spawn(wrap.command, wrap.args, {
        cwd,
        env: { ...process.env, ...wrap.env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (exitCode) =>
        resolve({ exitCode, stdout, stderr, commandId: wrap.commandId })
      );
    });
  } finally {
    wrap.dispose();
  }
}

/** A policy that opens `workspace` for writes and otherwise only what the test lists. */
function explicitPolicy(
  workspace: string,
  overrides: Partial<AgentSandboxPolicy> = {}
): AgentSandboxPolicy {
  return {
    writeRoots: [workspace],
    gitCommonDirs: [],
    denyWrite: [],
    denyRead: [],
    allowRead: [workspace],
    network: "loopback",
    allowedHosts: [],
    allowLocalBinding: true,
    ...overrides,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * A file directly in ~, which the built policy never opens for writes (temp folders are write
 * roots, so they cannot show a denied write). The tests remove it if the sandbox lets it through.
 */
async function homeProbePath(): Promise<string> {
  return path.join(
    await fs.realpath(os.homedir()),
    `.xum-sandbox-test-${process.pid}-${Date.now()}`
  );
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false
  );
}

/** The background process's exit code, or null when it is still running after 10 seconds. */
async function waitForExitCode(handle: BackgroundHandle): Promise<number | null> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const exitCode = await handle.getExitCode();
    if (exitCode !== null) return exitCode;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

const GIT_IDENTITY = "-c user.name=sandbox -c user.email=sandbox@example.com";

describe.skipIf(process.platform !== "darwin" || !isAgentSandboxSupported())(
  "macOS agent sandbox",
  () => {
    let root: string;

    beforeEach(async () => {
      // Real path: Seatbelt matches real paths only, and os.tmpdir() is under the /var symlink.
      root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "xum-sandbox-test-")));
    });

    afterEach(async () => {
      setAgentSandboxTargets(null);
      await fs.rm(root, { recursive: true, force: true });
    });

    afterAll(async () => {
      await resetAgentSandboxRuntime();
    });

    it("writes only inside the write roots", async () => {
      const workspace = path.join(root, "ws");
      const outside = path.join(root, "outside");
      await fs.mkdir(workspace);
      await fs.mkdir(outside);

      const result = await runSandboxed(
        explicitPolicy(workspace),
        workspace,
        `echo in > inside.txt; echo out > ${outside}/escaped.txt || echo WRITE_DENIED`
      );

      expect(result.stdout).toContain("WRITE_DENIED");
      expect(await fs.readFile(path.join(workspace, "inside.txt"), "utf8")).toBe("in\n");
      expect(await exists(path.join(outside, "escaped.txt"))).toBe(false);
    });

    it("closes a denied root, reopens a carve-out and closes a nested deny again", async () => {
      const workspace = path.join(root, "ws");
      const home = path.join(root, "home");
      const carveOut = path.join(home, "tools");
      await fs.mkdir(workspace);
      await fs.mkdir(carveOut, { recursive: true });
      await fs.writeFile(path.join(home, "private.txt"), "private");
      await fs.writeFile(path.join(carveOut, "tool.txt"), "tool");
      await fs.writeFile(path.join(carveOut, "token"), "token");

      const result = await runSandboxed(
        explicitPolicy(workspace, {
          denyRead: [home, path.join(carveOut, "token")],
          allowRead: [workspace, carveOut],
        }),
        workspace,
        [
          `cat ${home}/private.txt || echo DENIED_ROOT`,
          `cat ${carveOut}/tool.txt`,
          `cat ${carveOut}/token || echo DENIED_NESTED`,
        ].join("; ")
      );

      expect(result.stdout).toContain("DENIED_ROOT");
      expect(result.stdout).toContain("tool");
      expect(result.stdout).toContain("DENIED_NESTED");
      expect(result.stdout).not.toContain("private");
      expect(result.stdout).not.toMatch(/^token$/m);
    });

    it("lets git commit in a worktree but not write hooks or config", async () => {
      const repo = path.join(root, "repo");
      const worktree = path.join(root, "wt");
      await fs.mkdir(repo);
      git(repo, "init", "-q");
      git(repo, ...GIT_IDENTITY.split(" "), "commit", "-q", "--allow-empty", "-m", "init");
      git(repo, "worktree", "add", "-q", worktree);
      const commonDir = path.join(repo, ".git");
      const policy = buildAgentSandboxPolicy(BASE_SETTINGS, {
        cwd: worktree,
        pathEnv: process.env.PATH,
      });
      expect(policy.gitCommonDirs).toEqual([commonDir]);

      const result = await runSandboxed(
        // The temp folder is a write root and holds the main repository too. Close it, so only
        // gitCommonDirs lets the commit write the main .git.
        {
          ...policy,
          writeRoots: policy.writeRoots.filter((dir) => !isPathAtOrUnder(commonDir, dir)),
        },
        worktree,
        [
          `echo change > file.txt && git add file.txt && git ${GIT_IDENTITY} commit -q -m change && echo COMMITTED`,
          `echo evil > ${commonDir}/hooks/pre-commit || echo HOOK_DENIED`,
          `echo evil >> ${commonDir}/config || echo CONFIG_DENIED`,
        ].join("; ")
      );

      expect(result.stdout).toContain("COMMITTED");
      expect(git(worktree, "log", "-1", "--format=%s")).toBe("change");
      expect(result.stdout).toContain("HOOK_DENIED");
      expect(result.stdout).toContain("CONFIG_DENIED");
      expect(await exists(path.join(commonDir, "hooks", "pre-commit"))).toBe(false);
      expect(await fs.readFile(path.join(commonDir, "config"), "utf8")).not.toContain("evil");
    });

    /** `repo` with a submodule, and a new worktree of it whose submodule is not checked out. */
    async function worktreeWithSubmodule(): Promise<{ repo: string; worktree: string }> {
      const sub = path.join(root, "sub");
      const repo = path.join(root, "repo");
      const worktree = path.join(root, "wt");
      for (const dir of [sub, repo]) {
        await fs.mkdir(dir);
        git(dir, "init", "-q", "-b", "main");
      }
      await fs.writeFile(path.join(sub, "SKILL.md"), "payload\n");
      git(sub, "add", ".");
      git(sub, ...GIT_IDENTITY.split(" "), "commit", "-q", "-m", "init");
      git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor");
      git(repo, ...GIT_IDENTITY.split(" "), "commit", "-q", "-m", "add submodule");
      git(repo, "worktree", "add", "-q", "-b", "feature", worktree, "main");
      return { repo, worktree };
    }

    function syncSubmodules(worktree: string, env: Record<string, string> = {}): Promise<void> {
      return syncLocalGitSubmodules({
        workspacePath: worktree,
        initLogger: {
          logStep: () => undefined,
          logStdout: () => undefined,
          logStderr: () => undefined,
          logComplete: () => undefined,
        },
        env: { GIT_ALLOW_PROTOCOL: "file", ...env },
        trusted: true,
      });
    }

    // Xum's own checkout, like `git worktree add`: under the sandbox, `git submodule sync` and
    // `update --init` could not write .git/config and .git/modules.
    it("materializes the submodules of a new worktree while the sandbox is on", async () => {
      const { worktree } = await worktreeWithSubmodule();
      setAgentSandboxTargets({ fallback: BASE_SETTINGS, byProject: new Map() });

      await syncSubmodules(worktree);

      expect(await fs.readFile(path.join(worktree, "vendor", "SKILL.md"), "utf8")).toBe(
        "payload\n"
      );
    });

    // A sandboxed command can change the file that BASH_ENV names. The checkout's runtime is keyed
    // by the new worktree's path, which no project's setting names.
    it("does not source BASH_ENV in the submodule checkout of a project with the sandbox on", async () => {
      const { repo, worktree } = await worktreeWithSubmodule();
      const marker = path.join(root, "sourced");
      const startup = path.join(root, "startup.sh");
      await fs.writeFile(startup, `echo sourced >> ${marker}\n`);
      setAgentSandboxTargets({
        fallback: { ...BASE_SETTINGS, enabled: false },
        byProject: new Map([[repo, BASE_SETTINGS]]),
      });

      await syncSubmodules(worktree, { BASH_ENV: startup });

      expect(await exists(path.join(worktree, "vendor", "SKILL.md"))).toBe(true);
      expect(await exists(marker)).toBe(false);
      // Without the sandbox the checkout keeps the user's BASH_ENV.
      setAgentSandboxTargets(null);
      await syncSubmodules(worktree, { BASH_ENV: startup });
      expect(await exists(marker)).toBe(true);
    });

    it("keeps .git/hooks and .git/config of a repository in the workspace read-only", async () => {
      const repo = path.join(root, "repo");
      await fs.mkdir(repo);
      git(repo, "init", "-q");

      const result = await runSandboxed(
        buildAgentSandboxPolicy(BASE_SETTINGS, { cwd: repo, pathEnv: process.env.PATH }),
        repo,
        [
          `echo evil > .git/hooks/pre-commit || echo HOOK_DENIED`,
          `git config core.hooksPath /tmp || echo CONFIG_DENIED`,
          `echo ok > notes.txt && echo WROTE`,
        ].join("; ")
      );

      expect(result.stdout).toContain("HOOK_DENIED");
      expect(result.stdout).toContain("CONFIG_DENIED");
      expect(result.stdout).toContain("WROTE");
      expect(await exists(path.join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
      expect(await fs.readFile(path.join(repo, ".git", "config"), "utf8")).not.toContain(
        "hooksPath"
      );
    });

    // Git outside the sandbox follows both to the config and hooks of the folder they name.
    it("lets no command make a .git file or a commondir file", async () => {
      const repo = path.join(root, "repo");
      const plain = path.join(root, "plain");
      await fs.mkdir(repo);
      await fs.mkdir(plain);
      git(repo, "init", "-q");
      const pointTo = `gitdir: ${root}`;

      const result = await runSandboxed(
        buildAgentSandboxPolicy(BASE_SETTINGS, {
          cwd: plain,
          workspaceRoots: [repo],
          pathEnv: process.env.PATH,
        }),
        plain,
        [
          `echo ${JSON.stringify(pointTo)} > .git || echo GITFILE_DENIED`,
          `echo ${root} > ${repo}/.git/commondir || echo COMMONDIR_DENIED`,
        ].join("; ")
      );

      expect(result.stdout).toContain("GITFILE_DENIED");
      expect(result.stdout).toContain("COMMONDIR_DENIED");
      expect(await exists(path.join(plain, ".git"))).toBe(false);
      expect(await exists(path.join(repo, ".git", "commondir"))).toBe(false);
    });

    it("keeps a symlinked .git/config read-only where it points", async () => {
      const repo = path.join(root, "repo");
      await fs.mkdir(repo);
      git(repo, "init", "-q");
      await fs.rename(path.join(repo, ".git", "config"), path.join(repo, ".git", "config.actual"));
      await fs.symlink("config.actual", path.join(repo, ".git", "config"));

      const result = await runSandboxed(
        buildAgentSandboxPolicy(BASE_SETTINGS, { cwd: repo, pathEnv: process.env.PATH }),
        repo,
        `git config core.hooksPath /tmp || echo CONFIG_DENIED`
      );

      expect(result.stdout).toContain("CONFIG_DENIED");
      expect(await fs.readFile(path.join(repo, ".git", "config.actual"), "utf8")).not.toContain(
        "hooksPath"
      );
    });

    it("refuses to make a missing protected folder by link or move", async () => {
      const workspace = path.join(root, "ws");
      await fs.mkdir(path.join(workspace, "payload"), { recursive: true });
      await fs.writeFile(path.join(workspace, "payload", "mcp.jsonc"), "{}");

      // MCP discovery would follow .xum to payload/mcp.jsonc and start its server outside the
      // sandbox, though the deny names only .xum/mcp.jsonc.
      const result = await runSandboxed(
        buildAgentSandboxPolicy(BASE_SETTINGS, { cwd: workspace }),
        workspace,
        ["ln -s payload .xum || echo LINK_DENIED", "mv payload .mux || echo MOVE_DENIED"].join("; ")
      );

      expect(result.stdout).toContain("LINK_DENIED");
      expect(result.stdout).toContain("MOVE_DENIED");
      expect(await exists(path.join(workspace, ".xum"))).toBe(false);
      expect(await exists(path.join(workspace, ".mux"))).toBe(false);
    });

    it("keeps the MCP overrides, plugin folders and worktree commondir read-only", async () => {
      const repo = path.join(root, "repo");
      const worktree = path.join(root, "wt");
      await fs.mkdir(repo);
      git(repo, "init", "-q");
      git(repo, ...GIT_IDENTITY.split(" "), "commit", "-q", "--allow-empty", "-m", "init");
      git(repo, "worktree", "add", "-q", worktree);
      const commondir = path.join(repo, ".git", "worktrees", "wt", "commondir");
      const before = await fs.readFile(commondir, "utf8");
      // A checkout with its own .xum folder: Seatbelt refuses to make a missing one.
      await fs.mkdir(path.join(worktree, ".xum"));

      const result = await runSandboxed(
        buildAgentSandboxPolicy(BASE_SETTINGS, { cwd: worktree, pathEnv: process.env.PATH }),
        worktree,
        [
          "echo '{}' > .xum/mcp.local.jsonc || echo MCP_DENIED",
          "mkdir -p .agents/plugins/p || echo PLUGIN_DENIED",
          `echo ${root} > ${commondir} || echo COMMONDIR_DENIED`,
        ].join("; ")
      );

      expect(result.stdout).toContain("MCP_DENIED");
      expect(result.stdout).toContain("PLUGIN_DENIED");
      expect(result.stdout).toContain("COMMONDIR_DENIED");
      expect(await exists(path.join(worktree, ".xum", "mcp.local.jsonc"))).toBe(false);
      expect(await exists(path.join(worktree, ".agents", "plugins"))).toBe(false);
      expect(await fs.readFile(commondir, "utf8")).toBe(before);
    });

    // The next command's policy opens their real paths, so a link in their place would open its
    // target. The protected paths under each keep it in place.
    it("keeps the workspace, scratch and extra write folders in place", async () => {
      const workspace = path.join(root, "ws");
      const extra = path.join(workspace, "output");
      const scratch = path.join(root, "scratch");
      const elsewhere = path.join(root, "elsewhere");
      for (const dir of [workspace, extra, scratch, elsewhere]) await fs.mkdir(dir);

      const result = await runSandboxed(
        buildAgentSandboxPolicy(
          { ...BASE_SETTINGS, extraWritePaths: [extra] },
          { cwd: workspace, scratchDir: scratch }
        ),
        root,
        [
          `rm -rf ${extra} && ln -s ${elsewhere} ${extra} || echo EXTRA_KEPT`,
          `rm -rf ${scratch} && ln -s ${elsewhere} ${scratch} || echo SCRATCH_KEPT`,
          `rm -rf ${workspace} && ln -s ${elsewhere} ${workspace} || echo WORKSPACE_KEPT`,
        ].join("; ")
      );

      expect(result.stdout).toContain("EXTRA_KEPT");
      expect(result.stdout).toContain("SCRATCH_KEPT");
      expect(result.stdout).toContain("WORKSPACE_KEPT");
      for (const dir of [extra, scratch, workspace]) {
        expect((await fs.lstat(dir)).isDirectory()).toBe(true);
      }
    });

    it("opens the whole checkout of a workspace that works in a sub-project", async () => {
      // In ~, outside every write root, so only the checkout root can open it.
      const checkout = await homeProbePath();
      const subProject = path.join(checkout, "packages", "app");
      await fs.mkdir(subProject, { recursive: true });
      setAgentSandboxTargets({ fallback: BASE_SETTINGS, byProject: new Map() });
      const runtimes = {
        local: new LocalRuntime(checkout),
        worktree: new WorktreeRuntime(root, {
          projectPath: path.join(root, "project"),
          workspaceName: "ws",
          workspacePath: checkout,
        }),
      };
      try {
        for (const [name, runtime] of Object.entries(runtimes)) {
          const result = await execBuffered(runtime, `echo ok > ../../${name}.txt`, {
            cwd: subProject,
            timeout: 10,
          });

          expect(result.exitCode).toBe(0);
          expect(await fs.readFile(path.join(checkout, `${name}.txt`), "utf8")).toBe("ok\n");
        }
      } finally {
        await fs.rm(checkout, { recursive: true, force: true });
      }
    });

    // A project secret can set TMPDIR to a folder that is not a write root.
    it("points TMPDIR at a temp folder it can write, whatever the caller set", async () => {
      const workspace = path.join(root, "ws");
      await fs.mkdir(workspace);
      const elsewhere = await homeProbePath();
      setAgentSandboxTargets({ fallback: BASE_SETTINGS, byProject: new Map() });
      try {
        const result = await execBuffered(
          new LocalRuntime(workspace),
          'mkdir -p "$TMPDIR/probe" && rmdir "$TMPDIR/probe" && echo ok',
          { cwd: workspace, timeout: 10, env: { TMPDIR: elsewhere } }
        );

        expect({ exitCode: result.exitCode, stdout: result.stdout.trim() }).toEqual({
          exitCode: 0,
          stdout: "ok",
        });
      } finally {
        await fs.rm(elsewhere, { recursive: true, force: true });
      }
    });

    it("keeps a credential file in a write root unwritable, and its folder in place", async () => {
      const workspace = path.join(root, "ws");
      // ~/.cache is a write root, and ~/.cache/huggingface/token a credential file in it.
      const home = path.join(root, "home");
      const tokenDir = path.join(home, ".cache", "huggingface");
      await fs.mkdir(workspace);
      await fs.mkdir(tokenDir, { recursive: true });
      await fs.writeFile(path.join(tokenDir, "token"), "SECRET");
      const savedRoot = process.env.XUM_ROOT;
      // Outside every write root, unlike <home>/.xum, where the policy fails closed.
      process.env.XUM_ROOT = path.join("/", `xum-sandbox-test-${process.pid}`);
      const homedir = spyOn(os, "homedir").mockReturnValue(home);
      let policy: AgentSandboxPolicy;
      try {
        policy = buildAgentSandboxPolicy(BASE_SETTINGS, { cwd: workspace });
      } finally {
        homedir.mockRestore();
        if (savedRoot === undefined) delete process.env.XUM_ROOT;
        else process.env.XUM_ROOT = savedRoot;
      }

      const result = await runSandboxed(
        policy,
        workspace,
        [
          `echo stolen > ${tokenDir}/token || echo WRITE_DENIED`,
          // A folder renamed out from under the deny, or a hard link, would expose the file at
          // a path the deny does not name.
          `mv ${tokenDir} ${workspace}/moved || echo MOVE_DENIED`,
          `cat ${workspace}/moved/token`,
          `ln ${tokenDir}/token ${workspace}/linked || echo LINK_DENIED`,
          `cat ${workspace}/linked`,
        ].join("; ")
      );

      expect(result.stdout).toContain("WRITE_DENIED");
      expect(result.stdout).toContain("MOVE_DENIED");
      expect(result.stdout).toContain("LINK_DENIED");
      expect(result.stdout).not.toContain("SECRET");
      expect(await fs.readFile(path.join(tokenDir, "token"), "utf8")).toBe("SECRET");
    });

    it("runs the toolchains that work outside it", async () => {
      const workspace = path.join(root, "ws");
      await fs.mkdir(workspace);
      // git and bun (this test's runner) must work; the others only when installed here.
      const candidates = ["node", "go", "python3", "uv"].filter((tool) => {
        try {
          execFileSync(tool, [tool === "go" ? "version" : "--version"], { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      });
      const commands = [
        "git --version",
        `${JSON.stringify(process.execPath)} --version`,
        ...candidates.map((tool) => `${tool} ${tool === "go" ? "version" : "--version"}`),
      ];

      for (const command of commands) {
        const result = await runSandboxed(
          buildAgentSandboxPolicy(BASE_SETTINGS, { cwd: workspace, pathEnv: process.env.PATH }),
          workspace,
          command
        );
        expect({ command, exitCode: result.exitCode, stderr: result.stderr }).toEqual({
          command,
          exitCode: 0,
          stderr: "",
        });
      }
    });

    // The shared uv and Bun caches are read-only (uvx and bunx outside the sandbox run what they
    // hold), so uv and Bun in the sandbox must get caches that they can write.
    it("gives uv and Bun caches of their own that they can write", async () => {
      const workspace = path.join(root, "ws");
      await fs.mkdir(workspace);
      const probe = `xum-sandbox-test-${process.pid}`;
      const names = ["UV_CACHE_DIR", "BUN_INSTALL_CACHE_DIR", "BUN_RUNTIME_TRANSPILER_CACHE_PATH"];

      const result = await runSandboxed(
        buildAgentSandboxPolicy(BASE_SETTINGS, { cwd: workspace }),
        workspace,
        names.map((name) => `mkdir -p "$${name}/${probe}" && echo "$${name}"`).join(" && ")
      );

      const ownCaches = result.stdout.trim().split("\n");
      for (const cache of ownCaches.filter((dir) => path.isAbsolute(dir))) {
        await fs.rm(path.join(cache, probe), { recursive: true, force: true });
      }
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(ownCaches).toHaveLength(names.length);
      const shared = [".cache/uv", ".bun/install/cache", "Library/Caches/bun"];
      for (const cache of ownCaches) {
        expect(shared.some((dir) => isPathAtOrUnder(cache, path.join(os.homedir(), dir)))).toBe(
          false
        );
      }
    });

    // Bun 1.4.3 and older keep what bunx runs in /private/tmp/bunx-<uid>-<package>, a write root.
    it("keeps the bunx folders in the temp folders read-only", async () => {
      const workspace = path.join(root, "ws");
      await fs.mkdir(workspace);
      const bunxFolder = path.join(
        "/private/tmp",
        `bunx-${process.getuid?.() ?? 0}-xum-sandbox-test-${process.pid}@latest`
      );
      try {
        const result = await runSandboxed(
          buildAgentSandboxPolicy(BASE_SETTINGS, { cwd: workspace }),
          workspace,
          `mkdir ${JSON.stringify(bunxFolder)} || echo BUNX_DENIED; echo ok > notes.txt && echo WROTE`
        );

        expect(result.stdout).toContain("BUNX_DENIED");
        expect(result.stdout).toContain("WROTE");
        expect(await exists(bunxFolder)).toBe(false);
      } finally {
        await fs.rm(bunxFolder, { recursive: true, force: true });
      }
    });

    it("cuts the keychain rules out of the profile and blocks the keychain", async () => {
      const workspace = path.join(root, "ws");
      await fs.mkdir(workspace);
      const policy = explicitPolicy(workspace);
      const wrap = await wrapWithPolicy(policy, "true", { bashPath: "/bin/bash" });
      wrap.dispose();
      const profile = wrap.args[wrap.args.indexOf("-p") + 1];
      for (const rule of SRT_RULES_TO_REMOVE) {
        expect(profile).not.toContain(rule.trim());
      }

      // Precondition: outside the sandbox the keychain answers.
      execFileSync("security", ["list-keychains"], { stdio: "ignore" });
      const result = await runSandboxed(policy, workspace, "security list-keychains");
      expect(result.exitCode).not.toBe(0);
    });

    // An app that LaunchServices starts runs outside the sandbox, with the user's full access. It
    // fails once the profile has srt's allowAppleEvents rules (`lsopen` and coreservicesd).
    it("does not let open start an app in the workspace", async () => {
      const workspace = path.join(root, "ws");
      const outside = path.join(root, "outside");
      await fs.mkdir(workspace);
      await fs.mkdir(outside);
      const marker = path.join(outside, "marker");
      const policy = explicitPolicy(workspace);
      const plantApp = async (dir: string, id: string) => {
        const app = path.join(dir, "Planted.app");
        await fs.mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
        await fs.writeFile(
          path.join(app, "Contents", "Info.plist"),
          '<?xml version="1.0"?><plist version="1.0"><dict>' +
            "<key>CFBundleExecutable</key><string>Planted</string>" +
            `<key>CFBundleIdentifier</key><string>com.xum.sandbox-test.${id}</string>` +
            "<key>CFBundlePackageType</key><string>APPL</string>" +
            "<key>LSBackgroundOnly</key><true/></dict></plist>"
        );
        const program = path.join(app, "Contents", "MacOS", "Planted");
        await fs.writeFile(program, `#!/bin/sh\necho started > '${marker}'\n`, { mode: 0o755 });
        return app;
      };

      // Precondition: outside the sandbox, open starts such an app, which writes the marker.
      const control = await plantApp(outside, `control-${process.pid}`);
      execFileSync("/usr/bin/open", ["-W", "-g", "-j", control], { stdio: "ignore" });
      expect(await exists(marker)).toBe(true);
      await fs.rm(marker);

      const planted = await plantApp(workspace, `planted-${process.pid}`);
      const direct = await runSandboxed(policy, workspace, `echo x > '${marker}'`);
      expect(direct.exitCode).not.toBe(0);
      const opened = await runSandboxed(policy, workspace, `/usr/bin/open -W -g -j '${planted}'`);
      expect(opened.exitCode).not.toBe(0);
      expect(await exists(marker)).toBe(false);
      // LaunchServices registers each new app first, which took over 5 s on a CI runner.
    }, 30_000);

    describe("network", () => {
      let server: http.Server;
      let port: number;
      let socketServer: net.Server;
      let socketPath: string;
      const socketClients = new Set<net.Socket>();

      beforeEach(async () => {
        server = http.createServer((_req, res) => res.end("loopback-ok"));
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        port = (server.address() as net.AddressInfo).port;
        socketPath = path.join(root, "s.sock");
        // A whole HTTP reply, so curl succeeds when it reaches the socket and fails only when
        // the sandbox refuses it.
        socketServer = net.createServer((socket) => {
          socketClients.add(socket);
          socket.end("HTTP/1.0 200 OK\r\nContent-Length: 9\r\n\r\nsocket-ok");
        });
        await new Promise<void>((resolve) => socketServer.listen(socketPath, resolve));
      });

      afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        // A reached socket (the failure the tests look for) must not hang the close.
        for (const client of socketClients) client.destroy();
        socketClients.clear();
        await new Promise<void>((resolve) => socketServer.close(() => resolve()));
      });

      it("refuses an unlisted host and a Unix socket, and reaches loopback", async () => {
        const workspace = path.join(root, "ws");
        await fs.mkdir(workspace);
        const result = await runSandboxed(
          explicitPolicy(workspace, { network: "allowlist", allowedHosts: ["github.com"] }),
          workspace,
          [
            // The proxy refuses the name itself with a 403, so this needs no internet.
            `curl -sS -m 5 -o /dev/null -w 'UNLISTED=%{http_code}\\n' http://example.com/`,
            `curl -sS -m 5 --unix-socket ${socketPath} http://x/ && echo SOCKET_REACHED || echo SOCKET_REFUSED`,
            `curl -sS -m 5 --noproxy '*' http://127.0.0.1:${port}/`,
          ].join("; ")
        );

        expect(result.stdout).toContain("UNLISTED=403");
        expect(result.stdout).toContain("SOCKET_REFUSED");
        expect(result.stdout).toContain("loopback-ok");
      });

      it("opens any host by name in the open mode but keeps Unix sockets closed", async () => {
        const workspace = path.join(root, "ws");
        await fs.mkdir(workspace);
        const result = await runSandboxed(
          explicitPolicy(workspace, { network: "open" }),
          workspace,
          [
            `curl -sS -m 5 --unix-socket ${socketPath} http://x/ && echo SOCKET_REACHED || echo SOCKET_REFUSED`,
            // With no proxy, the command resolves host names through mDNSResponder's socket.
            `perl -MIO::Socket::UNIX -e 'print IO::Socket::UNIX->new(Peer => "/private/var/run/mDNSResponder") ? "DNS_OPEN\\n" : "DNS_CLOSED\\n"'`,
            `curl -sS -m 5 http://localhost:${port}/`,
          ].join("; ")
        );

        expect(result.stdout).toContain("SOCKET_REFUSED");
        expect(result.stdout).toContain("DNS_OPEN");
        expect(result.stdout).toContain("loopback-ok");
      });

      it("keeps the host allow list of background bash after its spawn shell exits", async () => {
        const workspace = path.join(root, "ws");
        await fs.mkdir(workspace);
        setAgentSandboxTargets({
          fallback: {
            ...BASE_SETTINGS,
            network: "allowlist",
            allowedHosts: ["xum-allowed.invalid"],
          },
          byProject: new Map(),
        });

        // The command waits for `go`, which the test writes only after spawnProcess returns, so it
        // reaches the proxy after its spawn shell has exited. The proxy answers a listed name it
        // cannot resolve with a 502 and refuses an unlisted one with a 403, so this needs no
        // internet.
        const result = await spawnProcess(
          new LocalRuntime(workspace),
          [
            "while [ ! -e go ]; do sleep 0.05; done",
            "curl -sS -m 5 -o /dev/null -w 'LISTED=%{http_code}\\n' http://xum-allowed.invalid/",
            "curl -sS -m 5 -o /dev/null -w 'UNLISTED=%{http_code}\\n' http://xum-unlisted.invalid/",
          ].join("; "),
          { cwd: workspace, workspaceId: `sandbox-test-${path.basename(root)}`, processId: "bg" }
        );
        expect(result.success).toBe(true);
        if (!result.success) return;
        try {
          await fs.writeFile(path.join(workspace, "go"), "");
          expect(await waitForExitCode(result.handle)).toBe(0);
          const output = await fs.readFile(path.join(result.outputDir, "output.log"), "utf8");
          expect(output).toContain("LISTED=502");
          expect(output).toContain("UNLISTED=403");
        } finally {
          await result.handle.terminate();
          await result.handle.dispose();
          await fs.rm(result.outputDir, { recursive: true, force: true });
        }
      });
    });

    it("lets commands read the global tool hooks but not the secrets next to them", async () => {
      const workspace = path.join(root, "ws");
      await fs.mkdir(workspace);
      const previousRoot = process.env.XUM_ROOT;
      // A Xum home under ~ (never created): ~ is a denied root, so only the carve-outs open.
      const xumHome = path.join(
        await fs.realpath(os.homedir()),
        `.xum-sandbox-test-${process.pid}`
      );
      process.env.XUM_ROOT = xumHome;
      try {
        const policy = buildAgentSandboxPolicy(BASE_SETTINGS, { cwd: workspace });
        const reads = (name: string) =>
          agentSandboxPolicyAllows(policy, path.join(xumHome, name), "read");

        expect(["tool_env", "tool_hook", "tool_pre", "tool_post"].map(reads)).toEqual([
          true,
          true,
          true,
          true,
        ]);
        expect(["config.json", "providers.jsonc", "server.lock"].map(reads)).toEqual([
          false,
          false,
          false,
        ]);
      } finally {
        if (previousRoot === undefined) delete process.env.XUM_ROOT;
        else process.env.XUM_ROOT = previousRoot;
      }
    });

    it("hides the server token from sandboxed commands only", async () => {
      const workspace = path.join(root, "ws");
      await fs.mkdir(workspace);
      setAgentSandboxTargets({ fallback: BASE_SETTINGS, byProject: new Map() });
      const runtime = new LocalRuntime(workspace);
      const tokenSeen = async (sandbox: "off" | undefined) => {
        const result = await execBuffered(runtime, 'printf "%s" "$XUM_SERVER_AUTH_TOKEN"', {
          cwd: workspace,
          env: { XUM_SERVER_AUTH_TOKEN: "test-token" },
          timeout: 10,
          sandbox,
        });
        return result.stdout;
      };

      expect(await tokenSeen(undefined)).toBe("");
      expect(await tokenSeen("off")).toBe("test-token");
    });

    // Bash overlays the project's secrets onto the command's environment.
    it("hides a token file that the command's environment names", async () => {
      const workspace = path.join(root, "ws");
      await fs.mkdir(workspace);
      await fs.writeFile(path.join(workspace, "hf-token"), "hf_secret");
      setAgentSandboxTargets({ fallback: BASE_SETTINGS, byProject: new Map() });

      const result = await execBuffered(
        new LocalRuntime(workspace),
        'cat "$HF_TOKEN_PATH" || echo READ_DENIED',
        { cwd: workspace, env: { HF_TOKEN_PATH: path.join(workspace, "hf-token") }, timeout: 10 }
      );

      expect(result.stdout).not.toContain("hf_secret");
      expect(result.stdout).toContain("READ_DENIED");
    });

    it("hides a token file that a background command's environment names", async () => {
      const workspace = path.join(root, "ws");
      await fs.mkdir(workspace);
      await fs.writeFile(path.join(workspace, "hf-token"), "hf_secret");
      setAgentSandboxTargets({ fallback: BASE_SETTINGS, byProject: new Map() });

      const result = await spawnProcess(
        new LocalRuntime(workspace),
        'cat "$HF_TOKEN_PATH" || echo READ_DENIED',
        {
          cwd: workspace,
          workspaceId: `sandbox-test-${path.basename(root)}`,
          processId: "bg-token",
          env: { HF_TOKEN_PATH: path.join(workspace, "hf-token") },
        }
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      try {
        await waitForExitCode(result.handle);
        const output = await fs.readFile(path.join(result.outputDir, "output.log"), "utf8");
        expect(output).not.toContain("hf_secret");
        expect(output).toContain("READ_DENIED");
      } finally {
        await result.handle.dispose();
        await fs.rm(result.outputDir, { recursive: true, force: true });
      }
    });

    // An approved background call runs outside the sandbox, and a sandboxed command can write the
    // file that BASH_ENV names and a PATH folder in the workspace (an activated .venv/bin).
    it("starts an approved background call without BASH_ENV or a launcher from the PATH", async () => {
      const workspace = path.join(root, "ws");
      const plantDir = path.join(workspace, ".venv", "bin");
      const marker = path.join(root, "planted");
      const startup = path.join(workspace, "startup.sh");
      await fs.mkdir(plantDir, { recursive: true });
      await fs.writeFile(startup, `echo BASH_ENV >> '${marker}'\n`);
      for (const [name, real] of [
        ["nohup", "/usr/bin/nohup"],
        ["bash", "/bin/bash"],
      ]) {
        await fs.writeFile(
          path.join(plantDir, name),
          `#!/bin/sh\necho ${name} >> '${marker}'\nexec ${real} "$@"\n`,
          { mode: 0o755 }
        );
      }
      // getBashPath() takes the first bash on Xum's PATH, which can be that folder too. Sandboxed
      // commands run it as well, so the marker is hidden: only a launcher outside can write it.
      setAgentSandboxTargets({
        fallback: BASE_SETTINGS,
        byProject: new Map(),
        hiddenFiles: [marker],
      });
      const xumBash = spyOn(bashPath, "getBashPath").mockReturnValue(path.join(plantDir, "bash"));

      const result = await spawnProcess(new LocalRuntime(workspace), "echo approved", {
        cwd: workspace,
        workspaceId: `sandbox-test-${path.basename(root)}`,
        processId: "bg-approved",
        env: { BASH_ENV: startup, PATH: `${plantDir}:${process.env.PATH ?? ""}` },
        sandbox: "off",
      });
      xumBash.mockRestore();
      expect(result.success).toBe(true);
      if (!result.success) return;
      try {
        await waitForExitCode(result.handle);
        const output = await fs.readFile(path.join(result.outputDir, "output.log"), "utf8");
        expect(output).toContain("approved");
        expect((await exists(marker)) ? await fs.readFile(marker, "utf8") : "").toBe("");
      } finally {
        await result.handle.dispose();
        await fs.rm(result.outputDir, { recursive: true, force: true });
      }
    });

    // `xum run` keeps its copy of the keys in the temp folder, a write root.
    it("hides and protects the hidden files, and the siblings a trailing * names", async () => {
      const workspace = path.join(root, "ws");
      const runRoot = path.join(root, "run");
      await fs.mkdir(workspace);
      await fs.mkdir(runRoot);
      await fs.writeFile(path.join(runRoot, "secrets.json"), "plain_secret");
      await fs.writeFile(path.join(runRoot, "secrets.json.0123456789ab"), "temp_secret");
      const secrets = path.join(runRoot, "secrets.json");
      setAgentSandboxTargets({
        fallback: BASE_SETTINGS,
        byProject: new Map(),
        hiddenFiles: [secrets, `${secrets}.*`],
      });

      const result = await execBuffered(
        new LocalRuntime(workspace),
        `cat "${secrets}" "${secrets}.0123456789ab"; echo x > "${secrets}.new" || echo WRITE_DENIED; ` +
          // Under another name, the files would not be hidden.
          `mv "${runRoot}" "${root}/moved" || echo MOVE_DENIED`,
        { cwd: workspace, timeout: 10 }
      );

      expect(result.stdout).not.toContain("_secret");
      expect(result.stdout).toContain("WRITE_DENIED");
      expect(result.stdout).toContain("MOVE_DENIED");
      expect(await exists(`${secrets}.new`)).toBe(false);
      expect(await exists(secrets)).toBe(true);
    });

    it("runs background bash in the sandbox", async () => {
      const workspace = path.join(root, "ws");
      await fs.mkdir(workspace);
      const escaped = await homeProbePath();
      setAgentSandboxTargets({ fallback: BASE_SETTINGS, byProject: new Map() });
      const runtime = new LocalRuntime(workspace);

      const result = await spawnProcess(
        runtime,
        `echo bg > bg.txt; echo out > ${escaped} || echo WRITE_DENIED`,
        { cwd: workspace, workspaceId: `sandbox-test-${path.basename(root)}`, processId: "bg" }
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      try {
        expect(await waitForExitCode(result.handle)).toBe(0);
        expect(await fs.readFile(path.join(workspace, "bg.txt"), "utf8")).toBe("bg\n");
        expect(await exists(escaped)).toBe(false);
        expect(await fs.readFile(path.join(result.outputDir, "output.log"), "utf8")).toContain(
          "WRITE_DENIED"
        );
      } finally {
        await result.handle.dispose();
        await fs.rm(result.outputDir, { recursive: true, force: true });
        await fs.rm(escaped, { force: true });
      }
    });

    // /tmp, where the records are, is a write root, so a sandboxed command can swap a record for
    // a symlink; Xum reads and writes records with full access.
    it("does not read or write through a symlink a background command puts in its record", async () => {
      const workspace = path.join(root, "ws");
      await fs.mkdir(workspace);
      const secret = await homeProbePath();
      const victim = `${secret}-victim`;
      await fs.writeFile(secret, "SECRET\n");
      await fs.writeFile(victim, "VICTIM\n");
      setAgentSandboxTargets({ fallback: BASE_SETTINGS, byProject: new Map() });
      const runtime = new LocalRuntime(workspace);
      const workspaceId = `sandbox-test-${path.basename(root)}`;
      const recordDir = `/tmp/mux-bashes/${workspaceId}/bg`;

      const result = await spawnProcess(
        runtime,
        `ln -sf ${secret} ${recordDir}/output.log && ln -sf ${victim} ${recordDir}/meta.json && echo SWAPPED`,
        { cwd: workspace, workspaceId, processId: "bg" }
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      try {
        expect(await waitForExitCode(result.handle)).toBe(0);
        expect((await fs.lstat(path.join(result.outputDir, "output.log"))).isSymbolicLink()).toBe(
          true
        );

        expect((await result.handle.readOutput(0)).content).not.toContain("SECRET");
        // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test async matcher
        await expect(result.handle.writeMeta('{"status":"exited"}')).rejects.toThrow();
        expect(await fs.readFile(victim, "utf8")).toBe("VICTIM\n");
      } finally {
        await result.handle.dispose();
        await fs.rm(result.outputDir, { recursive: true, force: true });
        await fs.rm(secret, { force: true });
        await fs.rm(victim, { force: true });
      }
    });

    it("does not delete through a link a command puts in place of the record folder", async () => {
      const workspace = path.join(root, "ws");
      await fs.mkdir(workspace);
      // In ~, outside every write root.
      const victim = await homeProbePath();
      await fs.mkdir(path.join(victim, "bg"), { recursive: true });
      await fs.writeFile(path.join(victim, "bg", "keep.txt"), "keep");
      setAgentSandboxTargets({ fallback: BASE_SETTINGS, byProject: new Map() });
      const runtime = new LocalRuntime(workspace);
      const workspaceId = `sandbox-test-${path.basename(root)}`;
      const recordRoot = `/tmp/mux-bashes/${workspaceId}`;
      await fs.mkdir(path.dirname(recordRoot), { recursive: true });
      await fs.symlink(victim, recordRoot);
      try {
        // A spawn that fails after claiming its record folder removes that folder.
        const result = await spawnProcess(runtime, "true", {
          cwd: path.join(root, "missing"),
          workspaceId,
          processId: "bg",
          recordDirClaimed: true,
        });

        expect(result.success).toBe(false);
        expect(await fs.readFile(path.join(victim, "bg", "keep.txt"), "utf8")).toBe("keep");
      } finally {
        await fs.rm(recordRoot, { force: true });
        await fs.rm(victim, { recursive: true, force: true });
      }
    });

    it("does not create a record folder through a link in place of its parent", async () => {
      const workspace = path.join(root, "ws");
      await fs.mkdir(workspace);
      const victim = await homeProbePath();
      await fs.mkdir(victim);
      setAgentSandboxTargets({ fallback: BASE_SETTINGS, byProject: new Map() });
      const runtime = new LocalRuntime(workspace);
      const workspaceId = `sandbox-test-${path.basename(root)}`;
      const recordRoot = `/tmp/mux-bashes/${workspaceId}`;
      await fs.mkdir(path.dirname(recordRoot), { recursive: true });
      await fs.symlink(victim, recordRoot);
      try {
        const result = await spawnProcess(runtime, "true", {
          cwd: workspace,
          workspaceId,
          processId: "bg",
        });

        expect(result.success).toBe(false);
        expect(await fs.readdir(victim)).toEqual([]);
      } finally {
        await fs.rm(recordRoot, { force: true });
        await fs.rm(victim, { recursive: true, force: true });
      }
    });

    it("does not write a stop's exit code through a link in place of the record folder", async () => {
      const workspace = path.join(root, "ws");
      await fs.mkdir(workspace);
      const victim = await homeProbePath();
      await fs.mkdir(victim);
      setAgentSandboxTargets({ fallback: BASE_SETTINGS, byProject: new Map() });
      const runtime = new LocalRuntime(workspace);
      const workspaceId = `sandbox-test-${path.basename(root)}`;
      const recordDir = `/tmp/mux-bashes/${workspaceId}/bg`;

      const result = await spawnProcess(
        runtime,
        `rm -rf ${recordDir} && ln -s ${victim} ${recordDir} && exec sleep 30`,
        { cwd: workspace, workspaceId, processId: "bg" }
      );
      expect(result.success).toBe(true);
      if (!result.success) return;
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((await fs.lstat(recordDir).catch(() => null))?.isSymbolicLink()) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect((await fs.lstat(recordDir)).isSymbolicLink()).toBe(true);

        await result.handle.terminate();
        expect(await fs.readdir(victim)).toEqual([]);
      } finally {
        await result.handle.dispose();
        await fs.rm(recordDir, { force: true });
        await fs.rm(victim, { recursive: true, force: true });
      }
    }, 15_000);

    it("reports what it blocked in the bash result", async () => {
      const workspace = path.join(root, "ws");
      await fs.mkdir(workspace);
      const escaped = await homeProbePath();
      setAgentSandboxTargets({ fallback: BASE_SETTINGS, byProject: new Map() });
      const tool = createBashTool(createTestToolConfig(workspace));

      let result: BashToolResult;
      try {
        result = (await tool.execute!(
          {
            script: `echo out > ${escaped}`,
            timeout_secs: 10,
            run_in_background: false,
            display_name: "escape",
          },
          mockToolCallOptions
        )) as BashToolResult;
      } finally {
        await fs.rm(escaped, { force: true });
      }

      expect(result.success).toBe(false);
      expect("sandboxDenials" in result ? result.sandboxDenials : []).toContain(`write ${escaped}`);
    });

    it("waits for the log only when the command failed", async () => {
      const workspace = path.join(root, "ws");
      await fs.mkdir(workspace);
      const result = await runSandboxed(explicitPolicy(workspace), workspace, "true");
      const started = Date.now();
      expect(await agentSandboxDenialsAfterExit(result.commandId, false)).toEqual([]);
      expect(Date.now() - started).toBeLessThan(100);
    });
  }
);
