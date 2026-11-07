import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ResolvedAgentSandboxSettings } from "@/common/config/schemas/agentSandbox";
import type { BashToolResult } from "@/common/types/tools";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { spawnProcess } from "@/node/services/backgroundProcessExecutor";
import { createBashTool } from "@/node/services/tools/bash";
import { createTestToolConfig, mockToolCallOptions } from "@/node/services/tools/testHelpers";
import { execBuffered } from "@/node/utils/runtime/helpers";
import {
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
function homeProbePath(): string {
  return path.join(fs.realpathSync(os.homedir()), `.xum-sandbox-test-${process.pid}-${Date.now()}`);
}

const GIT_IDENTITY = "-c user.name=sandbox -c user.email=sandbox@example.com";

describe.skipIf(process.platform !== "darwin" || !isAgentSandboxSupported())(
  "macOS agent sandbox",
  () => {
    let root: string;

    beforeEach(() => {
      // Real path: Seatbelt matches real paths only, and os.tmpdir() is under the /var symlink.
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xum-sandbox-test-")));
    });

    afterEach(() => {
      setAgentSandboxTargets(null);
      fs.rmSync(root, { recursive: true, force: true });
    });

    afterAll(async () => {
      await resetAgentSandboxRuntime();
    });

    it("writes only inside the write roots", async () => {
      const workspace = path.join(root, "ws");
      const outside = path.join(root, "outside");
      fs.mkdirSync(workspace);
      fs.mkdirSync(outside);

      const result = await runSandboxed(
        explicitPolicy(workspace),
        workspace,
        `echo in > inside.txt; echo out > ${outside}/escaped.txt || echo WRITE_DENIED`
      );

      expect(result.stdout).toContain("WRITE_DENIED");
      expect(fs.readFileSync(path.join(workspace, "inside.txt"), "utf8")).toBe("in\n");
      expect(fs.existsSync(path.join(outside, "escaped.txt"))).toBe(false);
    });

    it("closes a denied root, reopens a carve-out and closes a nested deny again", async () => {
      const workspace = path.join(root, "ws");
      const home = path.join(root, "home");
      const carveOut = path.join(home, "tools");
      fs.mkdirSync(workspace);
      fs.mkdirSync(carveOut, { recursive: true });
      fs.writeFileSync(path.join(home, "private.txt"), "private");
      fs.writeFileSync(path.join(carveOut, "tool.txt"), "tool");
      fs.writeFileSync(path.join(carveOut, "token"), "token");

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
      fs.mkdirSync(repo);
      git(repo, "init", "-q");
      git(repo, ...GIT_IDENTITY.split(" "), "commit", "-q", "--allow-empty", "-m", "init");
      git(repo, "worktree", "add", "-q", worktree);
      const commonDir = path.join(repo, ".git");

      const result = await runSandboxed(
        buildAgentSandboxPolicy(BASE_SETTINGS, { cwd: worktree, pathEnv: process.env.PATH }),
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
      expect(fs.existsSync(path.join(commonDir, "hooks", "pre-commit"))).toBe(false);
      expect(fs.readFileSync(path.join(commonDir, "config"), "utf8")).not.toContain("evil");
    });

    it("keeps .git/hooks and .git/config of a repository in the workspace read-only", async () => {
      const repo = path.join(root, "repo");
      fs.mkdirSync(repo);
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
      expect(fs.existsSync(path.join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
      expect(fs.readFileSync(path.join(repo, ".git", "config"), "utf8")).not.toContain("hooksPath");
    });

    it("runs the toolchains that work outside it", async () => {
      const workspace = path.join(root, "ws");
      fs.mkdirSync(workspace);
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

    it("cuts the keychain rules out of the profile and blocks the keychain", async () => {
      const workspace = path.join(root, "ws");
      fs.mkdirSync(workspace);
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

    describe("network", () => {
      let server: http.Server;
      let port: number;

      beforeEach(async () => {
        server = http.createServer((_req, res) => res.end("loopback-ok"));
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        port = (server.address() as net.AddressInfo).port;
      });

      afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });

      it("refuses an unlisted host and a Unix socket, and reaches loopback", async () => {
        const workspace = path.join(root, "ws");
        fs.mkdirSync(workspace);
        const socketPath = path.join(root, "s.sock");
        const socketServer = net.createServer((socket) => socket.end("socket-ok"));
        await new Promise<void>((resolve) => socketServer.listen(socketPath, resolve));
        try {
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
        } finally {
          await new Promise<void>((resolve) => socketServer.close(() => resolve()));
        }
      });
    });

    it("hides the server token from sandboxed commands only", async () => {
      const workspace = path.join(root, "ws");
      fs.mkdirSync(workspace);
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

    it("runs background bash in the sandbox", async () => {
      const workspace = path.join(root, "ws");
      fs.mkdirSync(workspace);
      const escaped = homeProbePath();
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
        let exitCode: number | null = null;
        for (let attempt = 0; attempt < 100 && exitCode === null; attempt++) {
          exitCode = await result.handle.getExitCode();
          if (exitCode === null) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(exitCode).toBe(0);
        expect(fs.readFileSync(path.join(workspace, "bg.txt"), "utf8")).toBe("bg\n");
        expect(fs.existsSync(escaped)).toBe(false);
        expect(fs.readFileSync(path.join(result.outputDir, "output.log"), "utf8")).toContain(
          "WRITE_DENIED"
        );
      } finally {
        await result.handle.dispose();
        fs.rmSync(result.outputDir, { recursive: true, force: true });
        fs.rmSync(escaped, { force: true });
      }
    });

    it("reports what it blocked in the bash result", async () => {
      const workspace = path.join(root, "ws");
      fs.mkdirSync(workspace);
      const escaped = homeProbePath();
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
        fs.rmSync(escaped, { force: true });
      }

      expect(result.success).toBe(false);
      expect("sandboxDenials" in result ? result.sandboxDenials : []).toContain(`write ${escaped}`);
    });

    it("waits for the log only when the command failed", async () => {
      const workspace = path.join(root, "ws");
      fs.mkdirSync(workspace);
      const result = await runSandboxed(explicitPolicy(workspace), workspace, "true");
      const started = Date.now();
      expect(await agentSandboxDenialsAfterExit(result.commandId, false)).toEqual([]);
      expect(Date.now() - started).toBeLessThan(100);
    });
  }
);
