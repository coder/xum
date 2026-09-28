import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Server, utils } from "ssh2";
import { SSH2ConnectionPool, getProxyShellArgs, spawnProxyCommand } from "./SSH2ConnectionPool";
import type { SSHConnectionConfig } from "./sshConnectionPool";

const PROXY_TOKENS = { host: "example.test", port: 2222, user: "alice" };

describe("getProxyShellArgs", () => {
  // Shape mux's SSH config writer emits: every argument double-quoted.
  const quotedCommand =
    '"C:\\Program Files\\coder\\coder.exe" "ssh" "--stdio" "--hostname-suffix" "mux--coder" "my-ws.mux--coder"';

  it("passes the command to cmd.exe verbatim so embedded quotes survive (win32)", () => {
    const spec = getProxyShellArgs(quotedCommand, "win32");

    // Node's default escaping rewrites embedded quotes as \" which cmd.exe
    // cannot parse; the proxy process then dies instantly (#3110).
    expect(spec.windowsVerbatimArguments).toBe(true);
    expect(spec.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);

    // cmd.exe /s strips the first and last quote of the /c payload; what
    // remains must be the original ProxyCommand byte-for-byte.
    const payload = spec.args[3];
    expect(payload.startsWith('"')).toBe(true);
    expect(payload.endsWith('"')).toBe(true);
    expect(payload.slice(1, -1)).toBe(quotedCommand);
  });

  it("runs the command through /bin/sh -c unchanged on POSIX", () => {
    const spec = getProxyShellArgs(quotedCommand, "linux");

    expect(spec.command).toBe("/bin/sh");
    expect(spec.args).toEqual(["-c", quotedCommand]);
    expect(spec.windowsVerbatimArguments).toBe(false);
  });
});

describe("spawnProxyCommand", () => {
  it("executes a ProxyCommand with a double-quoted binary path and substitutes tokens", async () => {
    // Quoted argv0 mirrors the ProxyCommand mux writes to ~/.ssh/config.
    const command =
      process.platform === "win32"
        ? String.raw`"C:\Windows\System32\cmd.exe" /d /c echo proxy-ok:%h:%p:%r`
        : '"/bin/echo" proxy-ok:%h:%p:%r';

    const proxy = spawnProxyCommand(command, PROXY_TOKENS);
    // stdin closes without finish when the child exits; swallow the resulting
    // premature-close error like the production stream handlers do.
    proxy.sock.on("error", () => undefined);

    let stdout = "";
    proxy.sock.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
    });
    await new Promise<void>((resolve) => proxy.process.once("close", () => resolve()));

    expect(stdout).toContain("proxy-ok:example.test:2222:alice");
    expect(proxy.process.exitCode).toBe(0);
  });

  it("describes exit status and stderr tail after the proxy dies", async () => {
    const command =
      process.platform === "win32" ? "echo oops 1>&2 & exit 7" : "echo oops >&2; exit 7";

    const proxy = spawnProxyCommand(command, PROXY_TOKENS);
    proxy.sock.on("error", () => undefined);

    // Still running: nothing to describe yet.
    expect(proxy.describeExit()).toBeUndefined();

    await new Promise<void>((resolve) => proxy.process.once("close", () => resolve()));

    const description = proxy.describeExit();
    expect(description).toContain("code 7");
    expect(description).toContain("oops");
  });
});

// #5063: the pool's wait loop must not re-authenticate through its backoff after a permanent
// failure (a rejected key). Every retry repeats a login that cannot succeed, and servers count
// failed logins. Transient failures (nothing listening) keep waiting.
// Skipped on Windows: the pool always adds Pageant there, and a runner without it fails with
// "Failed to retrieve identities from agent" before the server's rejection is seen.
describe.skipIf(process.platform === "win32")(
  "SSH2ConnectionPool wait loop vs permanent failures",
  () => {
    // Key-file authentication only: an ambient agent (working or broken) must not change the result.
    const originalAuthSock = process.env.SSH_AUTH_SOCK;
    beforeEach(() => {
      delete process.env.SSH_AUTH_SOCK;
    });
    let cleanup: (() => Promise<void>) | undefined;
    afterEach(async () => {
      if (originalAuthSock === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = originalAuthSock;
      await cleanup?.();
      cleanup = undefined;
    });

    // ECDSA keys: ssh2's ed25519 generator emits an unparseable key ~0.4% of the time under Bun.
    const newPrivateKey = () => utils.generateKeyPairSync("ecdsa", { bits: 256 }).private;

    async function startServer(onConnection: ConstructorParameters<typeof Server>[1]) {
      const server = new Server({ hostKeys: [newPrivateKey()] }, onConnection);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-ssh2-pool-"));
      const identityFile = path.join(dir, "id_ecdsa");
      await fs.writeFile(identityFile, newPrivateKey(), { mode: 0o600 });
      const config: SSHConnectionConfig = {
        host: "127.0.0.1",
        port: (server.address() as AddressInfo).port,
        identityFile,
      };
      const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
      cleanup = async () => {
        await close().catch(() => undefined);
        await fs.rm(dir, { recursive: true, force: true });
      };
      return { config, close };
    }

    function acquire(pool: SSH2ConnectionPool, config: SSHConnectionConfig, maxWaitMs: number) {
      const waits: number[] = [];
      const result = pool
        .acquireConnection(config, { maxWaitMs, onWait: (ms) => waits.push(ms) })
        .then(
          () => new Error("acquisition unexpectedly succeeded"),
          (error: unknown) => error
        );
      return { waits, result };
    }

    it("a rejected key fails at once instead of re-authenticating through the backoff", async () => {
      let connections = 0;
      const { config } = await startServer((conn) => {
        connections++;
        conn.on("authentication", (ctx) => ctx.reject());
        conn.on("error", () => undefined);
      });
      const pool = new SSH2ConnectionPool();

      const first = acquire(pool, config, 5_000);
      expect(String(await first.result)).toContain("All configured authentication methods failed");
      expect(first.waits).toEqual([]);
      expect(connections).toBe(1);

      // The pool still recorded the failure: the next caller waits out that backoff, then
      // makes one login of its own and stops on its failure. (The recorded last error alone
      // is not trusted: other writers report failures into it too.)
      const next = acquire(pool, config, 5_000);
      expect(String(await next.result)).toContain("All configured authentication methods failed");
      expect(next.waits.length).toBeGreaterThanOrEqual(1); // a sleep can wake just before the deadline
      expect(connections).toBe(2);
    });

    it("a refused connection still waits through the backoff", async () => {
      const { config, close } = await startServer((conn) => conn.on("error", () => undefined));
      await close(); // Nothing listens on the port any more: ECONNREFUSED.
      const pool = new SSH2ConnectionPool();

      const { waits, result } = acquire(pool, config, 2_500);
      expect(String(await result)).toContain("ECONNREFUSED");
      expect(waits.length).toBeGreaterThan(0);
    });
  }
);
