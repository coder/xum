import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Server, utils, type Connection } from "ssh2";

import type { SSHConnectionConfig } from "../sshConnectionPool";
import { SSH2Transport } from "./SSH2Transport";

// ECDSA keys: ssh2's ed25519 generator emits an unparseable key ~0.4% of the time under Bun.
const newPrivateKey = () => utils.generateKeyPairSync("ecdsa", { bits: 256 }).private;

interface Harness {
  config: SSHConnectionConfig;
  /** The server side of the latest SSH connection. */
  connection: () => Connection;
  forwards: Array<{ bindAddr: string; bindPort: number }>;
}

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
  cleanups = [];
});

/** An in-process sshd that accepts `tcpip-forward`, like a real host with forwarding on. */
async function startSshServer(options: { refuseForward?: boolean } = {}): Promise<Harness> {
  let latest: Connection | undefined;
  const open = new Set<Connection>();
  const allClosed = () =>
    Promise.all(
      [...open].map((conn) => new Promise<void>((resolve) => conn.once("close", () => resolve())))
    );
  const forwards: Harness["forwards"] = [];
  const server = new Server({ hostKeys: [newPrivateKey()] }, (conn) => {
    latest = conn;
    open.add(conn);
    conn.once("close", () => open.delete(conn));
    conn.on("error", () => undefined);
    conn.on("authentication", (ctx) => ctx.accept());
    conn.on("request", (accept, reject, name, info) => {
      const bind = info as { bindAddr: string; bindPort: number };
      if (name === "tcpip-forward") {
        if (options.refuseForward) {
          reject?.();
          return;
        }
        forwards.push({ bindAddr: bind.bindAddr, bindPort: bind.bindPort });
        accept?.();
      } else {
        reject?.();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-ssh2-rfwd-"));
  const identityFile = path.join(dir, "id_ecdsa");
  await fs.writeFile(identityFile, newPrivateKey(), { mode: 0o600 });
  cleanups.push(async () => {
    // End every server-side connection and wait for it: server.close() waits for them.
    // A client that just destroyed its socket closes the server side on its own; a server-side
    // end() that races that close stops ssh2 from ever emitting it. So wait first, then end
    // whatever is still open (a client that kept its connection).
    await Promise.race([allClosed(), Bun.sleep(1000)]);
    const closing = allClosed();
    for (const conn of open) conn.end();
    await closing;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    config: { host: "127.0.0.1", port: (server.address() as AddressInfo).port, identityFile },
    connection: () => {
      expect(latest).toBeDefined();
      return latest!;
    },
    forwards,
  };
}

/** A backend loopback service that answers each connection with "pong:<what it read>". */
async function startLocalService(): Promise<number> {
  const server = net.createServer((socket) => {
    socket.once("data", (data) => socket.end(`pong:${data.toString()}`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

/** What a process on the remote host sees when it connects to the forwarded port. */
function connectFromRemote(conn: Connection, bindPort: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.forwardOut("127.0.0.1", bindPort, "127.0.0.1", 40000, (err, channel) => {
      if (err) {
        reject(err);
        return;
      }
      // No half-close: an HTTP client writes its request and waits, like this.
      let reply = "";
      channel.on("data", (chunk: Buffer) => (reply += chunk.toString()));
      channel.on("close", () => resolve(reply));
      channel.write(payload);
    });
  });
}

describe("SSH2Transport.openReverseForward", () => {
  it("binds the remote loopback port and pipes its connections to the local port", async () => {
    const ssh = await startSshServer();
    const localPort = await startLocalService();
    const transport = new SSH2Transport(ssh.config);

    const forward = await transport.openReverseForward(24567, localPort);
    expect(ssh.forwards).toEqual([{ bindAddr: "127.0.0.1", bindPort: 24567 }]);

    expect(await connectFromRemote(ssh.connection(), 24567, "ping")).toBe("pong:ping");

    // The forward has its own connection, so close() ends that connection.
    forward.close();
    await forward.closed;
  });

  it("rejects when the host refuses remote forwarding", async () => {
    const ssh = await startSshServer({ refuseForward: true });
    const transport = new SSH2Transport(ssh.config);
    let failure: unknown;
    try {
      await transport.openReverseForward(24568, 1);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
  });

  it("settles closed when the SSH connection drops", async () => {
    const ssh = await startSshServer();
    const transport = new SSH2Transport(ssh.config);
    const forward = await transport.openReverseForward(24569, await startLocalService());
    ssh.connection().end();
    await forward.closed; // must settle, or the proxy never re-establishes the forward
  });
});
