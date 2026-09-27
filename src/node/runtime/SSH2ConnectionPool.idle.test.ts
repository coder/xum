import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { Server, utils, type ServerChannel } from "ssh2";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { ssh2ConnectionPool } from "./SSH2ConnectionPool";
import { SSHRuntime } from "./SSHRuntime";
import type { SSHRuntimeConfig } from "./sshConnectionPool";
import { createSSHTransport } from "./transports";

// #4876: the pool idle-closed a connection IDLE_TIMEOUT after the last acquire
// even while a command or terminal still ran on it, so any SSH2 exec longer
// than the idle window was killed. Real ssh2 client and in-process ssh2 server;
// only the idle window is shortened.
const IDLE_MS = 150;
// ssh2's ed25519 generator emits an unparseable key ~0.4% of the time under
// Bun; ECDSA keys parse reliably.
const newPrivateKey = () => utils.generateKeyPairSync("ecdsa", { bits: 256 }).private;
const HOLD_MS = IDLE_MS * 4;

describe("SSH2 pool idle close with open channels (#4876)", () => {
  let server: Server;
  let config: SSHRuntimeConfig;
  let tempDir: string;
  let serverConnectionsClosed: number;

  beforeEach(async () => {
    serverConnectionsClosed = 0;
    server = new Server({ hostKeys: [newPrivateKey()] }, (conn) => {
      conn.on("authentication", (ctx) => ctx.accept());
      conn.on("close", () => serverConnectionsClosed++);
      conn.on("error", () => undefined);
      conn.on("ready", () => {
        conn.on("session", (acceptSession) => {
          const session = acceptSession();
          // A long-running command: answers only after several idle windows.
          session.on("exec", (acceptExec) => {
            const stream: ServerChannel = acceptExec();
            setTimeout(() => {
              stream.write("done\n");
              stream.exit(0);
              stream.end();
            }, HOLD_MS);
          });
          session.on("pty", (acceptPty) => acceptPty?.());
          // An echoing terminal the user leaves idle.
          session.on("shell", (acceptShell) => {
            const stream = acceptShell();
            stream.on("data", (data: Buffer) => stream.write(data));
          });
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ssh2-idle-"));
    const identityFile = path.join(tempDir, "id_ecdsa");
    await fs.writeFile(identityFile, newPrivateKey(), {
      mode: 0o600,
    });
    config = {
      host: "127.0.0.1",
      port: (server.address() as AddressInfo).port,
      identityFile,
      srcBaseDir: "/remote/src",
    };
    ssh2ConnectionPool.setIdleTimeoutMsForTests(IDLE_MS);
  });

  afterEach(async () => {
    ssh2ConnectionPool.setIdleTimeoutMsForTests(undefined);
    ssh2ConnectionPool.clearAllHealthForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("keeps the connection open while an exec runs, then idle-closes it", async () => {
    const runtime = new SSHRuntime(config, createSSHTransport(config, true));

    const result = await execBuffered(runtime, "long-running", { cwd: "/", timeout: 30 });
    expect(result).toMatchObject({ exitCode: 0, stdout: "done\n" });

    // Once the last channel closed, the idle window applies again.
    expect(serverConnectionsClosed).toBe(0);
    await new Promise((r) => setTimeout(r, IDLE_MS * 4));
    expect(serverConnectionsClosed).toBe(1);
  });

  it("keeps an idle terminal session alive past the idle window", async () => {
    const pty = await createSSHTransport(config, true).createPtySession({
      workspacePath: "/remote/src/project",
      cols: 80,
      rows: 24,
    });
    let output = "";
    pty.onData((data) => (output += data));

    await new Promise((r) => setTimeout(r, IDLE_MS * 4));
    pty.write("still-here\n");
    await new Promise((r) => setTimeout(r, 100));
    expect(serverConnectionsClosed).toBe(0);
    expect(output).toContain("still-here");

    pty.kill();
    await new Promise((r) => setTimeout(r, IDLE_MS * 4));
    expect(serverConnectionsClosed).toBe(1);
  });
});
