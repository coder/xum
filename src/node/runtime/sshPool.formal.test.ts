import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { Server, utils, type Connection } from "ssh2";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { expectReproFailure } from "@/node/utils/formalRepro.testHarness";
import { isPermanentSSHFailure } from "./Runtime";
import { ssh2ConnectionPool } from "./SSH2ConnectionPool";
import { SSHRuntime } from "./SSHRuntime";
import { sshConnectionPool, type SSHRuntimeConfig } from "./sshConnectionPool";
import { createSSHTransport } from "./transports";

// Repros for the formal/ssh-pool models (SSH2Pool.tla, OpenSSHPool.tla). Each open finding
// test must still fail at its single target assertion (expectReproFailure); its control
// passes. Fixed findings (F3) are plain tests that guard the fix.
// No real network: an in-process ssh2 server on 127.0.0.1, or a PATH-shimmed `ssh`.

const IDLE_MS = 150;
const newPrivateKey = () => utils.generateKeyPairSync("ecdsa", { bits: 256 }).private;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `done()` or the deadline; the caller asserts the final state. */
async function waitUntil(done: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await sleep(10);
}

describe("SSH2 pool (SSH2Pool.tla)", () => {
  let server: Server;
  let config: SSHRuntimeConfig;
  let tempDir: string;
  let serverOpen: number;
  /** Every accepted connection, so teardown can close a leaked one (F1). */
  let serverConns: Set<Connection>;
  /** How long the server takes to open a session channel. */
  let sessionOpenDelayMs: number;

  beforeEach(async () => {
    serverOpen = 0;
    serverConns = new Set();
    sessionOpenDelayMs = 0;
    server = new Server({ hostKeys: [newPrivateKey()] }, (conn) => {
      serverOpen++;
      serverConns.add(conn);
      conn.on("close", () => {
        serverOpen--;
        serverConns.delete(conn);
      });
      conn.on("error", () => undefined);
      conn.on("authentication", (ctx) => ctx.accept());
      conn.on("ready", () => {
        conn.on("session", (acceptSession) => {
          setTimeout(() => {
            try {
              const session = acceptSession();
              session.on("exec", (acceptExec) => {
                const stream = acceptExec();
                stream.write("done\n");
                stream.exit(0);
                stream.end();
              });
            } catch {
              // The client went away while the open was pending.
            }
          }, sessionOpenDelayMs);
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-pool-formal-"));
    const identityFile = path.join(tempDir, "id_ecdsa");
    await fs.writeFile(identityFile, newPrivateKey(), { mode: 0o600 });
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
    // server.close() alone stops accepting but leaves open connections (F1 leaks one that the
    // pool no longer tracks): end them all and wait until the server has fully closed.
    for (const conn of serverConns) conn.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * F1 (MC_ssh2_faithful NoLeak): the pool idle-closes connection 1, a new acquire opens
   * connection 2, then connection 1's own "end"/"close" events arrive. Its onClose handler
   * deletes connections[key] without checking that the entry is still its own, so it drops
   * connection 2 from the map; closeIdleConnection then never closes connection 2.
   * `deferEnd` holds connection 1's end() back the way a slow close does (a dead TCP path,
   * a ProxyCommand slow to exit); the events themselves are real.
   */
  async function idleCloseThenReconnect(deferEnd: boolean): Promise<void> {
    const first = await ssh2ConnectionPool.acquireConnection(config);
    const client = first.client;
    const realEnd = client.end.bind(client);
    // Registered after the pool's own handlers, so it runs after its onClose.
    const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    let markIdleClosed!: () => void;
    const idleClosed = new Promise<void>((resolve) => (markIdleClosed = resolve));
    // The pool's idle close calls end(); deferEnd holds it back the way a slow close does.
    const endSpy = spyOn(client, "end").mockImplementation(() => {
      markIdleClosed();
      return deferEnd ? client : realEnd();
    });
    await idleClosed; // connection 1 was idle-closed
    if (!deferEnd) await closed; // control: its end/close events ran before the next acquire

    const second = await ssh2ConnectionPool.acquireConnection(config);
    expect(second === first).toBe(false);

    endSpy.mockRestore();
    if (deferEnd) {
      realEnd();
      await closed; // connection 1's late end/close events run now
    }
    // Connection 2's idle window (IDLE_MS) passes many times before the deadline.
    await waitUntil(() => serverOpen === 0, IDLE_MS * 10);
  }

  test("F1 control: an idle close whose events arrive at once leaves no connection open", async () => {
    await idleCloseThenReconnect(false);
    expect(serverOpen).toBe(0);
  });

  test("F1: a late close of an idle-closed client leaks the next connection", async () => {
    await expectReproFailure(
      async () => {
        await idleCloseThenReconnect(true);
        expect(serverOpen).toBe(0);
      },
      { matcher: "toBe", expected: "0", received: "1" }
    );
  });

  /**
   * F2 (MC_ssh2_fix_close NoUseAfterClose): acquire restarts the idle timer, but the exec
   * counts as an open channel only once ssh2's exec callback runs. A channel open slower
   * than the idle window (60 s in production) lets closeIdleConnection end the client
   * under the pending exec, which then fails as a transport error.
   */
  async function execWithSlowChannelOpen(idleMs: number): Promise<string> {
    ssh2ConnectionPool.setIdleTimeoutMsForTests(idleMs);
    sessionOpenDelayMs = IDLE_MS * 4;
    const runtime = new SSHRuntime(config, createSSHTransport(config, true));
    return await execBuffered(runtime, "echo done", { cwd: "/", timeout: 3 }).then(
      (result) => result.stdout.trim(),
      () => "transport error"
    );
  }

  test("F2 control: an exec whose channel opens within the idle window runs", async () => {
    expect(await execWithSlowChannelOpen(IDLE_MS * 20)).toBe("done");
  });

  test("F2: the idle timer closes a connection under an exec whose channel is opening", async () => {
    await expectReproFailure(
      async () => {
        expect(await execWithSlowChannelOpen(IDLE_MS)).toBe("done");
      },
      { matcher: "toBe", expected: '"done"', received: '"transport error"' }
    );
  });
});

// The fake `ssh` is a POSIX shell script; Windows process resolution cannot run it.
describe.skipIf(process.platform === "win32")("OpenSSH pool (OpenSSHPool.tla)", () => {
  let dir: string;
  let originalPath: string | undefined;
  let hostCounter = 0;

  beforeEach(async () => {
    // A fake `ssh`: the pool's probe (`echo ok`) succeeds, and the "remote" command decides
    // its own exit. NESTED_SSH_REFUSED stands for a user command that itself runs `ssh` to
    // another host and is refused: ssh passes that exit 255 and stderr through.
    // HOST_GOES_DOWN takes the host down during the command: from then on every ssh call,
    // the probe included, is refused with exit 255.
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "openssh-pool-formal-"));
    await fs.writeFile(
      path.join(dir, "ssh"),
      [
        "#!/bin/sh",
        `down=${JSON.stringify(path.join(dir, "host-down"))}`,
        "for a; do last=$a; done",
        'case "$last" in',
        '  *HOST_GOES_DOWN*) : > "$down" ;;',
        "esac",
        'if [ -e "$down" ]; then echo "ssh: connect to host formal-host port 22: Connection refused" >&2; exit 255; fi',
        'case "$last" in',
        "  *NESTED_SSH_REFUSED*) echo 'git@other-host: Permission denied (publickey).' >&2; exit 255 ;;",
        "  *USER_EXIT_1*) exit 1 ;;",
        "esac",
        "echo ok",
        "",
      ].join("\n"),
      { mode: 0o755 }
    );
    originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    sshConnectionPool.clearAllHealthForTests();
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Runs one user command over a fresh host key, then reports what the pool recorded. */
  async function runUserCommand(command: string) {
    const config: SSHRuntimeConfig = {
      host: `formal-host-${++hostCounter}`,
      srcBaseDir: "/remote/src",
    };
    const transport = createSSHTransport(config, false);
    const runtime = new SSHRuntime(config, transport);
    const result = await execBuffered(runtime, command, { cwd: "/", timeout: 10 });
    // What a terminal open does next (createPtySession: maxWaitMs 0).
    const nextAcquire = await transport.acquireConnection({ maxWaitMs: 0 }).then(
      () => null,
      (error: unknown) => error
    );
    return {
      exitCode: result.exitCode,
      status: sshConnectionPool.getConnectionHealth(config)?.status,
      nextAcquire,
    };
  }

  test("F3 control: a user command that exits 1 leaves the host healthy", async () => {
    const outcome = await runUserCommand("false # USER_EXIT_1");
    expect(outcome.exitCode).toBe(1);
    expect(outcome.status).toBe("healthy");
    expect(outcome.nextAcquire).toBeNull();
  });

  /**
   * F3 (MC_openssh_faithful NoFalseBackoff): OpenSSHTransport.onExit read every exit 255
   * as a connection failure, so a user command's own 255 put a reachable host into backoff.
   * Fixed (MC_openssh_fixed): an exec's 255 only forces a re-probe.
   */
  test("F3: a user command's own exit 255 marks a reachable host unhealthy", async () => {
    const outcome = await runUserCommand("ssh other-host # NESTED_SSH_REFUSED");
    expect(outcome.exitCode).toBe(255);
    expect(outcome.status).toBe("healthy");
  });

  test("F3 control: an exit 255 from a host that went down still backs off after the re-probe", async () => {
    const outcome = await runUserCommand("true # HOST_GOES_DOWN");
    expect(outcome.exitCode).toBe(255);
    expect(outcome.status).toBe("unhealthy");
    expect((outcome.nextAcquire as Error).message).toContain("Connection refused");
    expect(isPermanentSSHFailure(outcome.nextAcquire)).toBe(false);
  });

  /**
   * F3 (MC_openssh_faithful NoFalsePermanent): the backoff error repeated the user command's
   * stderr after "Last error:", and isPermanentSSHFailure matched "Permission denied (" in
   * it: the next acquire failed as a permanent auth failure (no retry) on a host whose keys
   * are fine. Fixed: the command's stderr is never recorded as the pool's last error.
   */
  test("F3: the next acquire reports the user command's stderr as a permanent SSH failure", async () => {
    const outcome = await runUserCommand("ssh other-host # NESTED_SSH_REFUSED");
    expect(isPermanentSSHFailure(outcome.nextAcquire)).toBe(false);
  });
});
