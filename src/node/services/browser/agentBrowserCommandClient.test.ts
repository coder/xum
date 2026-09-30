import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  resolveAgentBrowserDaemonEndpoint,
  sendAgentBrowserDaemonCommand,
} from "./agentBrowserCommandClient";
import {
  getAgentBrowserPortForSession,
  getAgentBrowserSocketDir,
  getAgentBrowserSocketPath,
} from "./agentBrowserSocketPaths";

describe("agent-browser socket paths", () => {
  test("resolves socket directory using the agent-browser priority order", () => {
    expect(
      getAgentBrowserSocketDir({
        AGENT_BROWSER_SOCKET_DIR: "/custom/socket",
        XDG_RUNTIME_DIR: "/run/user/1000",
        HOME: "/home/alice",
        TMPDIR: "/tmp/custom",
      })
    ).toBe("/custom/socket");
    expect(
      getAgentBrowserSocketDir({
        AGENT_BROWSER_SOCKET_DIR: "",
        XDG_RUNTIME_DIR: "/run/user/1000",
        HOME: "/home/alice",
        TMPDIR: "/tmp/custom",
      })
    ).toBe(path.join("/run/user/1000", "agent-browser"));
    expect(
      getAgentBrowserSocketDir({
        AGENT_BROWSER_SOCKET_DIR: "",
        XDG_RUNTIME_DIR: "",
        HOME: "/home/alice",
        TMPDIR: "/tmp/custom",
      })
    ).toBe(path.join("/home/alice", ".agent-browser"));
    expect(
      getAgentBrowserSocketDir({
        AGENT_BROWSER_SOCKET_DIR: "",
        XDG_RUNTIME_DIR: "",
        HOME: "",
        TMPDIR: "/tmp/custom",
      })
    ).toBe(path.join("/tmp/custom", "agent-browser"));
  });

  test("matches agent-browser's Windows fallback port hash", () => {
    expect(getAgentBrowserPortForSession("default")).toBe(50838);
    expect(getAgentBrowserPortForSession("my-session")).toBe(63105);
    expect(getAgentBrowserPortForSession("work")).toBe(51184);
    expect(getAgentBrowserPortForSession("")).toBe(49152);
  });
});

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error != null) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function listenOnUnixSocket(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

describe("sendAgentBrowserDaemonCommand", () => {
  test("retries transient daemon transport failures", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mux-agent-browser-command-retry-"));
    const socketPath = path.join(tempDir, "default.sock");
    const receivedCommands: unknown[] = [];
    let connectionCount = 0;
    const server = net.createServer((socket) => {
      connectionCount += 1;
      if (connectionCount === 1) {
        socket.end();
        return;
      }

      let requestBuffer = "";
      socket.on("data", (chunk: Buffer | string) => {
        requestBuffer += chunk.toString();
        const newlineIndex = requestBuffer.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }

        receivedCommands.push(JSON.parse(requestBuffer.slice(0, newlineIndex)));
        socket.write(`${JSON.stringify({ success: true })}\n`);
      });
    });

    try {
      await listenOnUnixSocket(server, socketPath);

      expect(
        await sendAgentBrowserDaemonCommand({
          env: { AGENT_BROWSER_SOCKET_DIR: tempDir },
          sessionName: "default",
          command: {
            id: "cmd-1",
            action: "navigate",
            url: "file:///tmp/report.html",
          },
          timeoutMs: 1_000,
          retryDelayMs: 1,
        })
      ).toEqual({ success: true });

      expect(connectionCount).toBe(2);
      expect(receivedCommands).toEqual([
        { id: "cmd-1", action: "navigate", url: "file:///tmp/report.html" },
      ]);
    } finally {
      await closeServer(server);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("resolveAgentBrowserDaemonEndpoint", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "mux-agent-browser-command-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("uses Unix sockets outside Windows", async () => {
    expect(
      await resolveAgentBrowserDaemonEndpoint({
        env: { AGENT_BROWSER_SOCKET_DIR: tempDir },
        sessionName: "default",
        platform: "linux",
      })
    ).toEqual({
      kind: "unix",
      socketPath: getAgentBrowserSocketPath({ AGENT_BROWSER_SOCKET_DIR: tempDir }, "default"),
    });
  });

  test("uses the Windows port sidecar when present", async () => {
    await writeFile(path.join(tempDir, "default.port"), "60000\n", "utf8");

    expect(
      await resolveAgentBrowserDaemonEndpoint({
        env: { AGENT_BROWSER_SOCKET_DIR: tempDir },
        sessionName: "default",
        platform: "win32",
      })
    ).toEqual({ kind: "tcp", host: "127.0.0.1", port: 60000 });
  });

  test("falls back to the Windows hash-derived port when the sidecar is missing", async () => {
    expect(
      await resolveAgentBrowserDaemonEndpoint({
        env: { AGENT_BROWSER_SOCKET_DIR: tempDir },
        sessionName: "default",
        platform: "win32",
      })
    ).toEqual({ kind: "tcp", host: "127.0.0.1", port: 50838 });
  });
});
