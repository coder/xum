import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { renameSync, writeFileSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { ServerLockDataSchema, ServerLockfile } from "./serverLockfile";
import {
  startFakeBackend,
  startUnrelatedProcess,
  unservedBaseUrl,
  type FakeBackend,
} from "./testXumBackend";

describe("ServerLockfile", () => {
  let tempDir: string;
  let lockfile: ServerLockfile;
  const cleanups: Array<() => void | Promise<void>> = [];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-lock-test-"));
    lockfile = new ServerLockfile(tempDir);
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function backend(...args: Parameters<typeof startFakeBackend>): Promise<FakeBackend> {
    const started = await startFakeBackend(...args);
    cleanups.push(started.close);
    return started;
  }

  function unrelatedProcess() {
    const started = startUnrelatedProcess();
    cleanups.push(started.kill);
    return started;
  }

  /** Writes a lock as another process would have: not through acquire(), so this process does not own it. */
  async function writeForeignLock(lock: { pid: number; baseUrl: string; token?: string }) {
    const data = {
      token: "foreign-token",
      startedAt: new Date().toISOString(),
      ...lock,
    };
    await fs.writeFile(lockfile.getLockPath(), JSON.stringify(data));
    return data;
  }

  test("acquire creates lockfile with correct data", async () => {
    await lockfile.acquire("http://localhost:12345", "test-token");

    const data = await lockfile.read();
    expect(data).not.toBeNull();
    expect(data!.baseUrl).toBe("http://localhost:12345");
    expect(data!.token).toBe("test-token");
    expect(data!.pid).toBe(process.pid);
    expect(data!.startedAt).toBeDefined();
  });

  test("acquire persists optional network metadata", async () => {
    await lockfile.acquire("http://localhost:12345", "test-token", {
      bindHost: "0.0.0.0",
      port: 12345,
      networkBaseUrls: ["http://192.168.1.10:12345"],
    });

    const data = await lockfile.read();
    expect(data).not.toBeNull();
    expect(data!.bindHost).toBe("0.0.0.0");
    expect(data!.port).toBe(12345);
    expect(data!.networkBaseUrls).toEqual(["http://192.168.1.10:12345"]);
  });

  test("peek returns a live lock without deleting anything", async () => {
    await lockfile.acquire("http://localhost:12345", "test-token");
    const data = await lockfile.peek();
    expect(data?.baseUrl).toBe("http://localhost:12345");
    expect(data?.token).toBe("test-token");
    await fs.access(lockfile.getLockPath());
  });

  test("peek ignores a stale lock but leaves it for its owner to clean up", async () => {
    // Discovery must never unlink a lock: a starting xum server may be replacing it.
    const lockPath = lockfile.getLockPath();
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: 999999999,
        baseUrl: "http://localhost:12345",
        token: "test-token",
        startedAt: new Date().toISOString(),
      })
    );
    expect(await lockfile.peek()).toBeNull();
    await fs.access(lockPath);
  });

  test("read returns null for non-existent lockfile", async () => {
    const data = await lockfile.read();
    expect(data).toBeNull();
  });

  test("read returns null for stale lockfile (dead PID) and leaves it in place", async () => {
    const lockPath = lockfile.getLockPath();

    // Write lockfile with fake dead PID
    const stale = JSON.stringify({
      pid: 999999999, // Very unlikely to be a real PID
      baseUrl: "http://localhost:12345",
      token: "test-token",
      startedAt: new Date().toISOString(),
    });
    await fs.writeFile(lockPath, stale);

    const data = await lockfile.read();
    expect(data).toBeNull();

    // A reader never deletes: the next acquire() replaces the stale lock.
    expect(await fs.readFile(lockPath, "utf-8")).toBe(stale);
  });

  test("a lock that a starting backend writes during the pid check survives read()", async () => {
    // The starting backend is another process: a live pid that is not this one, and a backend
    // that answers at its baseUrl.
    const starting = await backend("xum");
    const startingProcess = unrelatedProcess();
    // read() used to unlink a stale lock by path, so a backend that wrote its lock between the
    // pid check and the unlink lost it, and nothing wrote it again before the next restart. The
    // pid check is synchronous: acquire()'s two steps (a temp file, then a rename) run inside it.
    const DEAD_PID = 999999999;
    const lockPath = lockfile.getLockPath();
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: DEAD_PID,
        baseUrl: "http://localhost:11111",
        token: "stale-token",
        startedAt: new Date().toISOString(),
      })
    );

    const realKill = process.kill.bind(process);
    const kill = spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: string | number
    ) => {
      // Other code's kill() calls pass through: only the pid check of the stale lock lands the lock.
      if (pid === DEAD_PID && signal === 0) {
        const temp = `${lockPath}.${process.pid}.tmp`;
        writeFileSync(
          temp,
          JSON.stringify({
            pid: startingProcess.pid,
            baseUrl: starting.baseUrl,
            token: "fresh-token",
            startedAt: new Date().toISOString(),
          }),
          { mode: 0o600 }
        );
        renameSync(temp, lockPath);
      }
      return realKill(pid, signal as never);
    }) as typeof process.kill);
    try {
      // read() judged the lock it read: stale.
      expect(await lockfile.read()).toBeNull();
    } finally {
      kill.mockRestore();
    }

    const remaining = ServerLockDataSchema.parse(JSON.parse(await fs.readFile(lockPath, "utf-8")));
    expect(remaining.token).toBe("fresh-token");
    expect((await lockfile.read())?.baseUrl).toBe(starting.baseUrl);
  });

  test("acquire replaces a stale lock, so a restart needs no cleanup before it", async () => {
    await fs.writeFile(
      lockfile.getLockPath(),
      JSON.stringify({
        pid: 999999999,
        baseUrl: "http://localhost:11111",
        token: "stale-token",
        startedAt: new Date().toISOString(),
      })
    );
    expect(await lockfile.read()).toBeNull();

    await lockfile.acquire("http://localhost:22222", "fresh-token");

    const data = await lockfile.read();
    expect(data?.token).toBe("fresh-token");
    expect(data?.pid).toBe(process.pid);
  });

  test("read returns data for lockfile with current PID", async () => {
    await lockfile.acquire("http://127.0.0.1:54321", "valid-token");

    const data = await lockfile.read();
    expect(data).not.toBeNull();
    expect(data!.baseUrl).toBe("http://127.0.0.1:54321");
    expect(data!.token).toBe("valid-token");
  });

  describe("a lock whose pid is alive", () => {
    // The OS reuses pids: after a crash, any process can hold the dead backend's pid, and in a
    // container every run is pid 1.
    test("an unrelated process holds the pid and nothing serves the baseUrl: stale", async () => {
      const unrelated = unrelatedProcess();
      await writeForeignLock({ pid: unrelated.pid, baseUrl: await unservedBaseUrl() });

      expect(await lockfile.read()).toBeNull();
      expect(await lockfile.peek()).toBeNull();
      // A reader leaves the file: acquire() replaces it.
      await fs.access(lockfile.getLockPath());
    });

    test("another server answers at the baseUrl: stale, and nothing is sent to it", async () => {
      const unrelated = unrelatedProcess();
      const other = await backend("other");
      await writeForeignLock({ pid: unrelated.pid, baseUrl: other.baseUrl, token: "secret-token" });

      expect(await lockfile.read()).toBeNull();
      // Whoever listens there never sees the lock's token, in a header or in the URL.
      expect(JSON.stringify(other.requests)).not.toContain("secret-token");
    });

    test("a xum backend answers at the baseUrl: live, and the probe sends no token", async () => {
      const foreign = unrelatedProcess();
      const live = await backend("xum");
      await writeForeignLock({ pid: foreign.pid, baseUrl: live.baseUrl, token: "secret-token" });

      const data = await lockfile.read();
      expect(data?.pid).toBe(foreign.pid);
      expect(data?.token).toBe("secret-token");
      expect(JSON.stringify(live.requests)).not.toContain("secret-token");
    });

    test("a lock with this process's pid that this process did not write is stale", async () => {
      // A container restart gives the new run the old run's pid. A xum backend answering at the
      // baseUrl does not make the lock this process's: only its own acquire() does.
      const live = await backend("xum");
      await writeForeignLock({ pid: process.pid, baseUrl: live.baseUrl });

      expect(await lockfile.read()).toBeNull();
      expect(live.requests).toEqual([]);
    });

    test("a lock this process acquired is live without asking its baseUrl", async () => {
      await lockfile.acquire(await unservedBaseUrl(), "own-token");

      expect((await lockfile.read())?.token).toBe("own-token");
      // Another instance on the same path (another service of this process) sees it too.
      expect((await new ServerLockfile(tempDir).peek())?.token).toBe("own-token");
    });
  });

  describe("release", () => {
    test("leaves the lock of another backend that replaced this process's lock", async () => {
      // A starter judged this backend stale (it did not answer in time) and acquire()d over it.
      const foreign = unrelatedProcess();
      await lockfile.acquire("http://127.0.0.1:1", "own-token");
      const theirs = await writeForeignLock({ pid: foreign.pid, baseUrl: "http://127.0.0.1:2" });

      await lockfile.release();

      expect(JSON.parse(await fs.readFile(lockfile.getLockPath(), "utf-8"))).toEqual(theirs);
      const leftovers = (await fs.readdir(tempDir)).filter((name) => name !== "server.lock");
      expect(leftovers).toEqual([]);
    });

    test("does not delete a lock that this process never acquired", async () => {
      const foreign = unrelatedProcess();
      const theirs = await writeForeignLock({ pid: foreign.pid, baseUrl: "http://127.0.0.1:2" });

      await lockfile.release();

      expect(JSON.parse(await fs.readFile(lockfile.getLockPath(), "utf-8"))).toEqual(theirs);
    });

    test("a second release() after the first leaves a newer foreign lock alone", async () => {
      const foreign = unrelatedProcess();
      await lockfile.acquire("http://127.0.0.1:1", "own-token");
      await lockfile.release();
      const theirs = await writeForeignLock({ pid: foreign.pid, baseUrl: "http://127.0.0.1:2" });

      await lockfile.release();

      expect(JSON.parse(await fs.readFile(lockfile.getLockPath(), "utf-8"))).toEqual(theirs);
    });
  });

  test("release removes lockfile", async () => {
    await lockfile.acquire("http://localhost:12345", "test-token");
    const lockPath = lockfile.getLockPath();

    let exists = true;
    try {
      await fs.access(lockPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(true);

    await lockfile.release();

    try {
      await fs.access(lockPath);
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test("release is idempotent (no error if file doesn't exist)", async () => {
    // Should not throw
    await lockfile.release();
    await lockfile.release();
  });

  test("lockfile has restrictive permissions on unix", async () => {
    // Skip on Windows where file permissions work differently
    if (process.platform === "win32") {
      return;
    }

    await lockfile.acquire("http://localhost:12345", "test-token");
    const lockPath = lockfile.getLockPath();
    const stats = await fs.stat(lockPath);

    // 0o600 = owner read/write only
    expect(stats.mode & 0o777).toBe(0o600);
  });

  test("acquire overwrites existing lockfile", async () => {
    await lockfile.acquire("http://localhost:11111", "first-token");
    await lockfile.acquire("https://my.machine.local/mux", "second-token");

    const data = await lockfile.read();
    expect(data).not.toBeNull();
    expect(data!.baseUrl).toBe("https://my.machine.local/mux");
    expect(data!.token).toBe("second-token");
  });

  test("read handles corrupted lockfile gracefully", async () => {
    const lockPath = lockfile.getLockPath();
    await fs.writeFile(lockPath, "not valid json");

    const data = await lockfile.read();
    expect(data).toBeNull();
  });

  test("acquire creates parent directory if it doesn't exist", async () => {
    const nestedDir = path.join(tempDir, "nested", "dir");
    const nestedLockfile = new ServerLockfile(nestedDir);

    await nestedLockfile.acquire("http://localhost:12345", "test-token");

    const data = await nestedLockfile.read();
    expect(data).not.toBeNull();
    expect(data!.baseUrl).toBe("http://localhost:12345");
  });

  test("getLockPath returns correct path", () => {
    const expectedPath = path.join(tempDir, "server.lock");
    expect(lockfile.getLockPath()).toBe(expectedPath);
  });

  test("supports HTTPS URLs", async () => {
    await lockfile.acquire("https://secure.example.com:8443/api", "secure-token");

    const data = await lockfile.read();
    expect(data).not.toBeNull();
    expect(data!.baseUrl).toBe("https://secure.example.com:8443/api");
  });

  test("supports URLs with path prefixes", async () => {
    await lockfile.acquire("https://my.machine.local/mux/", "path-token");

    const data = await lockfile.read();
    expect(data).not.toBeNull();
    expect(data!.baseUrl).toBe("https://my.machine.local/mux/");
  });
});
