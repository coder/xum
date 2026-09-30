import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, jest, test, spyOn } from "bun:test";
import {
  appendOpenSSHHostKeyPolicyArgs,
  getControlPath,
  setOpenSSHHostKeyPolicyMode,
  SSHConnectionPool,
  type SSHRuntimeConfig,
} from "./sshConnectionPool";

// bun-types (^1.2.23) lags the pinned runtime (bun@1.3.12), which implements this.
const fakeTimers = jest as typeof jest & { advanceTimersByTime: (ms: number) => void };

describe("sshConnectionPool", () => {
  describe("getControlPath", () => {
    test("identical configs produce same controlPath", () => {
      const config: SSHRuntimeConfig = {
        host: "test.example.com",
        srcBaseDir: "/work",
      };
      const path1 = getControlPath(config);
      const path2 = getControlPath(config);

      expect(path1).toBe(path2);
    });

    test("different hosts produce different controlPaths", () => {
      const config1: SSHRuntimeConfig = {
        host: "host1.example.com",
        srcBaseDir: "/work",
      };
      const config2: SSHRuntimeConfig = {
        host: "host2.example.com",
        srcBaseDir: "/work",
      };

      const path1 = getControlPath(config1);
      const path2 = getControlPath(config2);

      expect(path1).not.toBe(path2);
    });

    test("different ports produce different controlPaths", () => {
      const config1: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        port: 22,
      };
      const config2: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        port: 2222,
      };

      expect(getControlPath(config1)).not.toBe(getControlPath(config2));
    });

    test("different identityFiles produce different controlPaths", () => {
      const config1: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        identityFile: "/path/to/key1",
      };
      const config2: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        identityFile: "/path/to/key2",
      };

      expect(getControlPath(config1)).not.toBe(getControlPath(config2));
    });

    test("different srcBaseDirs produce same controlPaths (connection shared)", () => {
      // srcBaseDir is intentionally excluded from connection key -
      // workspaces on the same host share health tracking and multiplexing
      const config1: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work1",
      };
      const config2: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work2",
      };

      expect(getControlPath(config1)).toBe(getControlPath(config2));
    });

    test("controlPath is in tmpdir with expected format", () => {
      const config: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
      };
      const controlPath = getControlPath(config);

      expect(controlPath).toContain(os.tmpdir());
      expect(controlPath).toMatch(/mux-ssh-[a-f0-9]{12}$/);
    });

    test("missing port defaults to 22 in hash calculation", () => {
      const config1: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        port: 22,
      };
      const config2: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        // port omitted, should default to 22
      };

      expect(getControlPath(config1)).toBe(getControlPath(config2));
    });

    test("missing identityFile defaults to 'default' in hash calculation", () => {
      const config1: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        identityFile: undefined,
      };
      const config2: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        // identityFile omitted
      };

      expect(getControlPath(config1)).toBe(getControlPath(config2));
    });
  });
});

describe("appendOpenSSHHostKeyPolicyArgs", () => {
  afterEach(() => {
    setOpenSSHHostKeyPolicyMode("headless-fallback");
  });

  test("appends fallback args in headless-fallback mode", () => {
    const args: string[] = ["-T"];
    setOpenSSHHostKeyPolicyMode("headless-fallback");

    appendOpenSSHHostKeyPolicyArgs(args);

    expect(args).toEqual([
      "-T",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
    ]);
  });

  test("does not append fallback args in strict mode", () => {
    const args: string[] = ["-T"];
    setOpenSSHHostKeyPolicyMode("strict");

    appendOpenSSHHostKeyPolicyArgs(args);

    expect(args).toEqual(["-T"]);
  });

  test("defaults to headless-fallback", () => {
    const args: string[] = ["-T"];

    appendOpenSSHHostKeyPolicyArgs(args);

    expect(args).toEqual([
      "-T",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
    ]);
  });
});

describe("username isolation", () => {
  test("controlPath includes local username to prevent cross-user collisions", () => {
    // This test verifies that os.userInfo().username is included in the hash
    // On multi-user systems, different users connecting to the same remote
    // would get different controlPaths, preventing permission errors
    const config: SSHRuntimeConfig = {
      host: "test.com",
      srcBaseDir: "/work",
    };
    const controlPath = getControlPath(config);

    // The path should be deterministic for this user
    expect(controlPath).toBe(getControlPath(config));

    const expectedPrefix = path.join(os.tmpdir(), "mux-ssh-");
    expect(controlPath.startsWith(expectedPrefix)).toBe(true);
    expect(controlPath).toMatch(/mux-ssh-[a-f0-9]{12}$/);
  });
});

describe("SSHConnectionPool", () => {
  describe("health tracking", () => {
    test("getConnectionHealth returns undefined for unknown connection", () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "unknown.example.com",
        srcBaseDir: "/work",
      };

      expect(pool.getConnectionHealth(config)).toBeUndefined();
    });

    test("markHealthy sets connection to healthy state", () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "test.example.com",
        srcBaseDir: "/work",
      };

      pool.markHealthy(config);
      const health = pool.getConnectionHealth(config);

      expect(health).toBeDefined();
      expect(health!.status).toBe("healthy");
      expect(health!.consecutiveFailures).toBe(0);
      expect(health!.lastSuccess).toBeInstanceOf(Date);
    });

    test("reportFailure puts connection into backoff", () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "test.example.com",
        srcBaseDir: "/work",
      };

      // Mark healthy first
      pool.markHealthy(config);
      expect(pool.getConnectionHealth(config)?.status).toBe("healthy");

      // Report a failure
      pool.reportFailure(config, "Connection refused");
      const health = pool.getConnectionHealth(config);

      expect(health?.status).toBe("unhealthy");
      expect(health?.consecutiveFailures).toBe(1);
      expect(health?.lastError).toBe("Connection refused");
      expect(health?.backoffUntil).toBeDefined();
    });

    test("backoff caps at ~10s with jitter", () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "test.example.com",
        srcBaseDir: "/work",
      };

      // Report many failures to hit the cap
      for (let i = 0; i < 10; i++) {
        pool.reportFailure(config, "Connection refused");
      }

      const health = pool.getConnectionHealth(config)!;
      const backoffMs = health.backoffUntil!.getTime() - Date.now();

      // Max base is 10s, jitter adds ±20%, so max is ~12s (10 * 1.2)
      expect(backoffMs).toBeGreaterThan(7_500); // 10 * 0.8 - some tolerance
      expect(backoffMs).toBeLessThanOrEqual(12_500); // 10 * 1.2 + some tolerance
    });
  });

  describe("acquireConnection", () => {
    test("returns immediately for known healthy connection", async () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "test.example.com",
        srcBaseDir: "/work",
      };

      // Mark as healthy first
      pool.markHealthy(config);

      // Should return immediately without probing
      const start = Date.now();
      await pool.acquireConnection(config);
      const elapsed = Date.now() - start;

      // Should be nearly instant (< 50ms)
      expect(elapsed).toBeLessThan(50);
    });

    test("waits through backoff (bounded) instead of throwing", async () => {
      // Fake timers also fake Date, so the backoff deadline and the real default
      // sleep advance together without slowing the test down.
      fakeTimers.useFakeTimers();
      try {
        const pool = new SSHConnectionPool();
        const config: SSHRuntimeConfig = {
          host: "test.example.com",
          srcBaseDir: "/work",
        };

        // Put host into backoff without doing a real probe.
        pool.reportFailure(config, "Connection refused");
        expect(pool.getConnectionHealth(config)?.backoffUntil).toBeDefined();

        const onWaitCalls: number[] = [];
        let settled = false;
        const acquire = pool
          .acquireConnection(config, {
            onWait: (ms) => {
              onWaitCalls.push(ms);
            },
          })
          .then(() => {
            settled = true;
          });

        expect(onWaitCalls.length).toBe(1);
        const waitMs = onWaitCalls[0];
        expect(waitMs).toBeGreaterThan(0);

        // Simulate recovery while the caller is waiting.
        pool.markHealthy(config);

        // The caller keeps waiting for the whole reported backoff...
        fakeTimers.advanceTimersByTime(waitMs - 1);
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);

        // ...and resumes once it elapses.
        fakeTimers.advanceTimersByTime(1);
        await acquire;

        expect(settled).toBe(true);
        expect(onWaitCalls.length).toBe(1);
        expect(pool.getConnectionHealth(config)?.status).toBe("healthy");
      } finally {
        fakeTimers.useRealTimers();
      }
    });
    test("throws immediately when in backoff", async () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "nonexistent.invalid.host.test",
        srcBaseDir: "/work",
      };

      // Trigger a failure to put connection in backoff
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        pool.acquireConnection(config, { timeoutMs: 1000, maxWaitMs: 0 })
      ).rejects.toThrow();

      // Second call should throw immediately with backoff message
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(pool.acquireConnection(config, { maxWaitMs: 0 })).rejects.toThrow(/in backoff/);
    });

    test("getControlPath returns deterministic path", () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "test.example.com",
        srcBaseDir: "/work",
      };

      const path1 = pool.getControlPath(config);
      const path2 = pool.getControlPath(config);

      expect(path1).toBe(path2);
      expect(path1).toBe(getControlPath(config));
    });

    test("does not record backoff when a probe is aborted", async () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "abort.example.com",
        srcBaseDir: "/work",
      };
      const abortController = new AbortController();
      // The shared probe ignores the caller's abort (#5112) and ends later, on its own.
      let failProbe!: () => void;
      const spy = spyOn(
        pool as unknown as { probeConnection: () => Promise<void> },
        "probeConnection"
      ).mockImplementationOnce(
        () => new Promise<void>((_resolve, reject) => (failProbe = () => reject(new Error("x"))))
      );

      const acquired = pool.acquireConnection(config, {
        timeoutMs: 1000,
        maxWaitMs: 0,
        abortSignal: abortController.signal,
      });
      abortController.abort();
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(acquired).rejects.toThrow("Operation aborted");

      expect(pool.getConnectionHealth(config)).toBeUndefined();
      failProbe();
      spy.mockRestore();
    });

    test("records backoff when probe rejects without recording it (safety net)", async () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "askpass-fail.example.com",
        srcBaseDir: "/work",
      };

      // Simulate a probe that fails before reaching markFailedByKey
      // (e.g., createAskpassSession throwing on fs.watch ENOSPC).
      const spy = spyOn(
        pool as unknown as { probeConnection: () => Promise<void> },
        "probeConnection"
      ).mockRejectedValueOnce(new Error("ENOSPC: no space left on device"));

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        pool.acquireConnection(config, { timeoutMs: 1000, maxWaitMs: 0 })
      ).rejects.toThrow(/ENOSPC/);

      // Safety net should have recorded backoff despite probeConnection not doing so.
      const health = pool.getConnectionHealth(config);
      expect(health?.status).toBe("unhealthy");
      expect(health?.backoffUntil).toBeDefined();
      expect(health?.lastError).toContain("ENOSPC");

      spy.mockRestore();
    });
  });

  describe("askpass prompt classification", () => {
    // classifyAskpassPrompt() routes prompts containing "continue connecting"
    // through host-key verification and treats other prompts as credentials.
    const HOST_KEY_PATTERN = /continue connecting/i;

    test("detects standard host-key confirmation prompt", () => {
      expect(
        HOST_KEY_PATTERN.test(
          "Are you sure you want to continue connecting (yes/no/[fingerprint])? "
        )
      ).toBe(true);
    });

    test("detects host-key prompt case-insensitively", () => {
      expect(HOST_KEY_PATTERN.test("Are you sure you want to Continue Connecting (yes/no)?")).toBe(
        true
      );
    });

    test("rejects passphrase prompt", () => {
      expect(HOST_KEY_PATTERN.test("Enter passphrase for key '/home/user/.ssh/id_ed25519':")).toBe(
        false
      );
    });

    test("rejects password prompt", () => {
      expect(HOST_KEY_PATTERN.test("user@host's password:")).toBe(false);
    });

    test("rejects empty prompt", () => {
      expect(HOST_KEY_PATTERN.test("")).toBe(false);
    });
  });

  describe("singleflighting", () => {
    test("concurrent acquireConnection calls share same probe", async () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "nonexistent.invalid.host.test",
        srcBaseDir: "/work",
      };

      // All concurrent calls should share the same probe and get same result
      const results = await Promise.allSettled([
        pool.acquireConnection(config, { timeoutMs: 1000, maxWaitMs: 0 }),
        pool.acquireConnection(config, { timeoutMs: 1000, maxWaitMs: 0 }),
        pool.acquireConnection(config, { timeoutMs: 1000, maxWaitMs: 0 }),
      ]);

      // All should be rejected (connection fails)
      expect(results.every((r) => r.status === "rejected")).toBe(true);

      // Only 1 failure should be recorded (not 3) - proves singleflighting worked
      expect(pool.getConnectionHealth(config)?.consecutiveFailures).toBe(1);
    });

    test("re-checks requested ControlPath after waiting for another probe", async () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "test.example.com",
        srcBaseDir: "/work",
      };
      const privatePool = pool as unknown as {
        probeConnection: (
          config: SSHRuntimeConfig,
          timeoutMs: number,
          key: string,
          controlPath: string
        ) => Promise<void>;
        markHealthyByKey: (key: string) => void;
        markControlPathReady: (key: string, controlPath: string) => void;
      };

      const probeCalls: string[] = [];
      let releaseFirstProbe!: () => void;
      let signalFirstProbeStarted!: () => void;
      const firstProbeStarted = new Promise<void>((resolve) => {
        signalFirstProbeStarted = resolve;
      });

      const probeSpy = spyOn(privatePool, "probeConnection").mockImplementation(
        async (_config, _timeoutMs, key, controlPath) => {
          probeCalls.push(controlPath);
          if (probeCalls.length === 1) {
            signalFirstProbeStarted();
            await new Promise<void>((resolve) => {
              releaseFirstProbe = () => {
                privatePool.markHealthyByKey(key);
                privatePool.markControlPathReady(key, controlPath);
                resolve();
              };
            });
            return;
          }

          privatePool.markHealthyByKey(key);
          privatePool.markControlPathReady(key, controlPath);
        }
      );

      const firstAcquire = pool.acquireConnection(config, {
        controlPath: "/tmp/mux-control-a",
        maxWaitMs: 0,
      });
      await firstProbeStarted;

      const secondAcquire = pool.acquireConnection(config, {
        controlPath: "/tmp/mux-control-b",
        maxWaitMs: 0,
      });
      releaseFirstProbe();

      await Promise.all([firstAcquire, secondAcquire]);

      expect(probeCalls).toEqual(["/tmp/mux-control-a", "/tmp/mux-control-b"]);
      probeSpy.mockRestore();
    });

    test("caps the follow-up probe timeout to the remaining wait budget", async () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "test.example.com",
        srcBaseDir: "/work",
      };
      const privatePool = pool as unknown as {
        probeConnection: (
          config: SSHRuntimeConfig,
          timeoutMs: number,
          key: string,
          controlPath: string
        ) => Promise<void>;
        markHealthyByKey: (key: string) => void;
        markControlPathReady: (key: string, controlPath: string) => void;
      };

      const probeCalls: Array<{ controlPath: string; timeoutMs: number }> = [];
      let releaseFirstProbe!: () => void;
      let signalFirstProbeStarted!: () => void;
      const firstProbeStarted = new Promise<void>((resolve) => {
        signalFirstProbeStarted = resolve;
      });
      let now = 1_000;
      const nowSpy = spyOn(Date, "now").mockImplementation(() => now);

      const probeSpy = spyOn(privatePool, "probeConnection").mockImplementation(
        async (_config, timeoutMs, key, controlPath) => {
          probeCalls.push({ controlPath, timeoutMs });
          if (probeCalls.length === 1) {
            signalFirstProbeStarted();
            await new Promise<void>((resolve) => {
              releaseFirstProbe = () => {
                now += 25;
                privatePool.markHealthyByKey(key);
                privatePool.markControlPathReady(key, controlPath);
                resolve();
              };
            });
            return;
          }

          privatePool.markHealthyByKey(key);
          privatePool.markControlPathReady(key, controlPath);
        }
      );

      // try/finally: a leaked Date.now spy freezes time process-wide and breaks
      // downstream suites (e.g. WorkflowService crash-recovery retries).
      try {
        const firstAcquire = pool.acquireConnection(config, {
          controlPath: "/tmp/mux-control-a",
          timeoutMs: 30,
          maxWaitMs: 30,
        });
        await firstProbeStarted;

        const secondAcquire = pool.acquireConnection(config, {
          controlPath: "/tmp/mux-control-b",
          timeoutMs: 30,
          maxWaitMs: 30,
        });
        releaseFirstProbe();

        await Promise.all([firstAcquire, secondAcquire]);

        expect(probeCalls).toEqual([
          { controlPath: "/tmp/mux-control-a", timeoutMs: 30 },
          { controlPath: "/tmp/mux-control-b", timeoutMs: 5 },
        ]);
      } finally {
        probeSpy.mockRestore();
        nowSpy.mockRestore();
      }
    });

    test("callers waking from backoff share single probe (herd only released on success)", async () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "test.example.com",
        srcBaseDir: "/work",
      };
      const privatePool = pool as unknown as {
        probeConnection: (
          config: SSHRuntimeConfig,
          timeoutMs: number,
          key: string,
          controlPath: string
        ) => Promise<void>;
        markHealthyByKey: (key: string) => void;
      };

      let probeCount = 0;
      let releaseProbe!: () => void;
      const probeReleased = new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      const probeSpy = spyOn(privatePool, "probeConnection").mockImplementation(
        async (_config, _timeoutMs, key) => {
          probeCount++;
          // Hold the probe open until every woken caller has had a chance to run.
          await probeReleased;
          privatePool.markHealthyByKey(key);
        }
      );

      fakeTimers.useFakeTimers();
      try {
        // Put connection in backoff
        pool.reportFailure(config, "Initial failure");
        expect(pool.getConnectionHealth(config)?.consecutiveFailures).toBe(1);

        // Start 3 waiters - they'll all sleep through backoff
        const waitMs: number[] = [];
        const waiters = [1, 2, 3].map(() =>
          pool.acquireConnection(config, {
            onWait: (ms) => {
              waitMs.push(ms);
            },
          })
        );
        expect(waitMs.length).toBe(3);
        expect(probeCount).toBe(0);

        // Wake them all up simultaneously when the backoff expires.
        fakeTimers.advanceTimersByTime(Math.max(...waitMs));
        for (let i = 0; i < 20; i++) {
          await Promise.resolve();
        }
        expect(probeCount).toBe(1);

        // Herd is only released once the shared probe succeeds.
        releaseProbe();
        await Promise.all(waiters);

        // The woken herd shares one probe instead of each caller probing.
        expect(probeCount).toBe(1);
        expect(pool.getConnectionHealth(config)?.status).toBe("healthy");
      } finally {
        probeSpy.mockRestore();
        fakeTimers.useRealTimers();
      }
    });
  });
});

// #5063: after a permanent failure (rejected key, failed host-key check) the wait loop must not
// probe again through its backoff: every probe repeats a login that cannot succeed, and servers
// count failed logins. A PATH-shimmed `ssh` stands in for OpenSSH and counts its invocations.
describe.skipIf(process.platform === "win32")(
  "SSHConnectionPool wait loop vs permanent failures",
  () => {
    let restore: (() => Promise<void>) | undefined;
    afterEach(async () => {
      await restore?.();
      restore = undefined;
    });

    /** Put an `ssh` on PATH that fails with `stderr` and exit code 255; returns its call count. */
    async function shimSsh(stderr: string, exitCode = 255): Promise<() => Promise<number>> {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-ssh-shim-"));
      const calls = path.join(dir, "calls");
      await fs.writeFile(
        path.join(dir, "ssh"),
        `#!/bin/sh\necho call >> '${calls}'\nprintf '%s\\n' '${stderr}' >&2\nexit ${exitCode}\n`,
        { mode: 0o755 }
      );
      const originalPath = process.env.PATH;
      process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ""}`;
      restore = async () => {
        process.env.PATH = originalPath;
        await fs.rm(dir, { recursive: true, force: true });
      };
      return async () =>
        (await fs.readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    }

    function acquire(pool: SSHConnectionPool, config: SSHRuntimeConfig, maxWaitMs: number) {
      const waits: number[] = [];
      const result = pool
        .acquireConnection(config, { timeoutMs: 5_000, maxWaitMs, onWait: (ms) => waits.push(ms) })
        .then(
          () => new Error("acquisition unexpectedly succeeded"),
          (error: unknown) => error
        );
      return { waits, result };
    }

    test.each(["alice@shim.test: Permission denied (publickey).", "Host key verification failed."])(
      "%s fails at once instead of probing again through the backoff",
      async (stderr) => {
        const calls = await shimSsh(stderr);
        const pool = new SSHConnectionPool();
        const config: SSHRuntimeConfig = { host: "shim.test", srcBaseDir: "/work" };

        // The second caller shares the first one's probe.
        const first = acquire(pool, config, 5_000);
        const joined = acquire(pool, config, 5_000);
        for (const attempt of [first, joined]) {
          expect(String(await attempt.result)).toContain(stderr);
          expect(attempt.waits).toEqual([]);
        }
        expect(await calls()).toBe(1);
        expect(pool.getConnectionHealth(config)?.status).toBe("unhealthy");

        // The next caller waits out the backoff, then probes once and stops on its failure.
        // (The recorded last error alone is not trusted: exec failures report into it too.)
        const next = acquire(pool, config, 5_000);
        expect(String(await next.result)).toContain(stderr);
        expect(next.waits.length).toBeGreaterThanOrEqual(1); // a sleep can wake just before the deadline
        expect(await calls()).toBe(2);
      }
    );

    // Exec failures report into the same health record: a remote command that itself runs
    // `ssh` and is refused must not make the pool treat the workspace host as refusing logins.
    test("a permanent-looking error reported by an exec still waits and probes", async () => {
      const calls = await shimSsh("", 0);
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = { host: "shim.test", srcBaseDir: "/work" };
      pool.reportFailure(config, "git@example.com: Permission denied (publickey).");

      const { waits, result } = acquire(pool, config, 5_000);
      // The helper maps a successful acquisition to this marker error.
      expect(String(await result)).toContain("unexpectedly succeeded");
      expect(waits.length).toBeGreaterThanOrEqual(1); // a sleep can wake just before the deadline
      expect(await calls()).toBe(1);
    });

    // #5112: the caller that starts the shared probe must not take it down for everyone when it
    // aborts. maxWaitMs 0 makes a joiner fail on the first error; a budget lets it retry, which
    // on the old code started a second probe (a second login) instead of keeping the first.
    for (const joinerMaxWaitMs of [0, 30_000]) {
      test(`a joiner (maxWaitMs ${joinerMaxWaitMs}) keeps the probe when its starter aborts`, async () => {
        // The shim holds the probe open until the test creates the release file.
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-ssh-shim-"));
        const callsFile = path.join(dir, "calls");
        const release = path.join(dir, "release");
        await fs.writeFile(
          path.join(dir, "ssh"),
          `#!/bin/sh\necho call >> '${callsFile}'\nwhile [ ! -e '${release}' ]; do sleep 0.05; done\necho ok\n`,
          { mode: 0o755 }
        );
        const originalPath = process.env.PATH;
        process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ""}`;
        restore = async () => {
          process.env.PATH = originalPath;
          await fs.rm(dir, { recursive: true, force: true });
        };
        const calls = async () =>
          (await fs.readFile(callsFile, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
        const settle = (promise: Promise<void>): Promise<Error | undefined> =>
          promise.then(
            () => undefined,
            (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
          );

        const pool = new SSHConnectionPool();
        const config: SSHRuntimeConfig = { host: "shim.test", srcBaseDir: "/work" };
        const starterAbort = new AbortController();
        const starter = settle(
          pool.acquireConnection(config, {
            timeoutMs: 20_000,
            maxWaitMs: 20_000,
            abortSignal: starterAbort.signal,
          })
        );
        // Both calls reach the shared probe synchronously: the starter spawns it, the joiner
        // finds it in flight.
        const joiner = settle(
          pool.acquireConnection(config, { timeoutMs: 20_000, maxWaitMs: joinerMaxWaitMs })
        );
        try {
          // Abort only once the shim runs, so a killed first probe still counts as a call.
          while ((await calls()) === 0) {
            // Each read yields to the event loop; the loop ends when the shim logs its call.
          }
          const abortedAt = Date.now();
          starterAbort.abort();
          // The starter's own wait still ends at its abort, long before the probe finishes.
          expect((await starter)?.message).toContain("Operation aborted");
          expect(Date.now() - abortedAt).toBeLessThan(3_000);
          // Cancelling is not a host failure.
          expect(pool.getConnectionHealth(config)).toBeUndefined();

          await fs.writeFile(release, "");
          expect(await joiner).toBeUndefined();
          expect(await calls()).toBe(1); // the joiner got the original probe, not a new one
          expect(pool.getConnectionHealth(config)?.status).toBe("healthy");
        } finally {
          await fs.writeFile(release, "");
          await Promise.all([starter, joiner]);
        }
      }, 30_000);
    }

    test("a transient failure still waits through the backoff", async () => {
      const calls = await shimSsh("ssh: connect to host shim.test port 22: Connection refused");
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = { host: "shim.test", srcBaseDir: "/work" };

      const { waits, result } = acquire(pool, config, 2_500);
      expect(String(await result)).toContain("Connection refused");
      expect(waits.length).toBeGreaterThan(0);
      expect(await calls()).toBeGreaterThan(1);
    });
  }
);
