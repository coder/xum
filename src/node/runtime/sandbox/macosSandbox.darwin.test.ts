import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ResolvedAgentSandboxSettings } from "@/common/config/schemas/agentSandbox";
import type { BashToolResult } from "@/common/types/tools";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { BackgroundHandle } from "@/node/runtime/Runtime";
import { spawnProcess } from "@/node/services/backgroundProcessExecutor";
import { createBashTool } from "@/node/services/tools/bash";
import { createTestToolConfig, mockToolCallOptions } from "@/node/services/tools/testHelpers";
import { execBuffered } from "@/node/utils/runtime/helpers";
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

    it("keeps a credential file in a write root unwritable, and its folder in place", async () => {
      const workspace = path.join(root, "ws");
      const xumRoot = path.join(workspace, "xum-home");
      await fs.mkdir(xumRoot, { recursive: true });
      await fs.writeFile(path.join(xumRoot, "secrets.json"), '{"key":"SECRET"}');
      const savedRoot = process.env.XUM_ROOT;
      process.env.XUM_ROOT = xumRoot;
      try {
        const result = await runSandboxed(
          buildAgentSandboxPolicy(BASE_SETTINGS, { cwd: workspace }),
          workspace,
          [
            `echo stolen > ${xumRoot}/secrets.json || echo WRITE_DENIED`,
            // A folder renamed out from under the deny, or a hard link, would expose the file at
            // a path the deny does not name.
            `mv ${xumRoot} ${workspace}/moved || echo MOVE_DENIED`,
            `cat ${workspace}/moved/secrets.json`,
            `ln ${xumRoot}/secrets.json ${workspace}/linked || echo LINK_DENIED`,
            `cat ${workspace}/linked`,
          ].join("; ")
        );

        expect(result.stdout).toContain("WRITE_DENIED");
        expect(result.stdout).toContain("MOVE_DENIED");
        expect(result.stdout).toContain("LINK_DENIED");
        expect(result.stdout).not.toContain("SECRET");
        expect(await fs.readFile(path.join(xumRoot, "secrets.json"), "utf8")).toBe(
          '{"key":"SECRET"}'
        );
      } finally {
        if (savedRoot === undefined) delete process.env.XUM_ROOT;
        else process.env.XUM_ROOT = savedRoot;
      }
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
