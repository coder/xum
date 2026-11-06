import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { readFileSync, renameSync, writeFileSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { ServerLockDataSchema, ServerLockfile, type ServerLockData } from "./serverLockfile";
import {
  identityOf,
  startFakeBackend,
  startUnrelatedProcess,
  unservedBaseUrl,
  type FakeBackend,
} from "./testXumBackend";
import { getSelfIdentity, setSelfIdentityForTests } from "../utils/concurrency/processLiveness";

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
  async function writeForeignLock(lock: {
    pid: number;
    baseUrl: string;
    token?: string;
    startedAt?: string;
    identity?: unknown;
  }) {
    const data = {
      token: "foreign-token",
      startedAt: new Date().toISOString(),
      ...lock,
    };
    await fs.writeFile(lockfile.getLockPath(), JSON.stringify(data), { mode: 0o600 });
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

  test("acquire records only the optional fields that are usable", async () => {
    const written = async (extra?: Parameters<ServerLockfile["acquire"]>[2]) => {
      await lockfile.acquire("http://localhost:12345", "test-token", extra);
      return ServerLockDataSchema.parse(
        JSON.parse(await fs.readFile(lockfile.getLockPath(), "utf-8"))
      );
    };
    const expectNoOptionalFields = (data: ServerLockData) => {
      expect(data.bindHost).toBeUndefined();
      expect(data.port).toBeUndefined();
      expect(data.networkBaseUrls).toBeUndefined();
    };

    expectNoOptionalFields(await written());
    expectNoOptionalFields(await written({}));
    expectNoOptionalFields(await written({ bindHost: "  ", networkBaseUrls: [] }));
    expect((await written({ bindHost: " 127.0.0.1 " })).bindHost).toBe("127.0.0.1");
    // The ends of the port range are ports; a port outside it, or a fraction, is dropped.
    expect((await written({ port: 0 })).port).toBe(0);
    expect((await written({ port: 65535 })).port).toBe(65535);
    for (const port of [-1, 65536, 1.5]) expect((await written({ port })).port).toBeUndefined();
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

  test("acquire records the process identity of this backend", async () => {
    await lockfile.acquire("http://localhost:12345", "test-token");

    const written = ServerLockDataSchema.parse(
      JSON.parse(await fs.readFile(lockfile.getLockPath(), "utf-8"))
    );
    expect(written.identity).toEqual({ ...getSelfIdentity() });
  });

  test("a lock with a malformed identity still reads as a lock", async () => {
    const live = await backend("xum");
    const foreign = unrelatedProcess();
    await writeForeignLock({ pid: foreign.pid, baseUrl: live.baseUrl, identity: "not an object" });

    // Read as a lock without an identity: the probe decides.
    expect((await lockfile.read())?.pid).toBe(foreign.pid);
    expect(live.requests).toHaveLength(1);
  });

  describe.skipIf(process.platform !== "linux")("a lock with a process identity (Linux)", () => {
    const stopped = (pid: number) => readFileSync(`/proc/${pid}/stat`, "utf-8").split(") ")[1][0];

    test("the backend's own process is live, with no network", async () => {
      const backendProcess = unrelatedProcess();
      const silent = await backend("hang");
      await writeForeignLock({
        pid: backendProcess.pid,
        baseUrl: silent.baseUrl,
        identity: identityOf(backendProcess.pid),
      });

      expect((await lockfile.read())?.pid).toBe(backendProcess.pid);
      expect(silent.requests).toEqual([]);
    });

    test("a frozen backend (SIGSTOP) is live until it continues, and is never asked", async () => {
      const backendProcess = unrelatedProcess();
      // Its listener takes connections and never answers, as a stopped process's does.
      const frozenListener = await backend("hang");
      await writeForeignLock({
        pid: backendProcess.pid,
        baseUrl: frozenListener.baseUrl,
        identity: identityOf(backendProcess.pid),
      });

      process.kill(backendProcess.pid, "SIGSTOP");
      try {
        expect(stopped(backendProcess.pid)).toBe("T");
        const started = Date.now();
        expect((await lockfile.read())?.pid).toBe(backendProcess.pid);
        expect(Date.now() - started).toBeLessThan(1_500); // a probe would wait 2 s
        expect(frozenListener.requests).toEqual([]);
      } finally {
        process.kill(backendProcess.pid, "SIGCONT");
      }
      expect((await lockfile.read())?.pid).toBe(backendProcess.pid);
    });

    test("another process on the dead backend's pid is stale, and a xum-shaped squatter on its port is never asked", async () => {
      const holder = unrelatedProcess();
      const squatter = await backend("xum");
      await writeForeignLock({
        pid: holder.pid,
        baseUrl: squatter.baseUrl,
        token: "old-token",
        // What the dead backend recorded: this host and boot, and a start time that is not the
        // holder's.
        identity: { ...identityOf(holder.pid), birth: "linux-ticks:1" },
      });

      expect(await lockfile.read()).toBeNull();
      expect(squatter.requests).toEqual([]);
    });

    test.each([
      ["another boot", { bootId: "00000000-0000-0000-0000-000000000000" }],
      ["another PID namespace", { pidNs: "pid:[4026539999]" }],
    ])("a lock of %s is stale without asking its baseUrl", async (_name, over) => {
      const holder = unrelatedProcess();
      const squatter = await backend("xum");
      await writeForeignLock({
        pid: holder.pid,
        baseUrl: squatter.baseUrl,
        identity: { ...identityOf(holder.pid), ...over },
      });

      expect(await lockfile.read()).toBeNull();
      expect(squatter.requests).toEqual([]);
    });

    test("a gone pid is stale without asking its baseUrl", async () => {
      const squatter = await backend("xum");
      await writeForeignLock({
        pid: 2 ** 30,
        baseUrl: squatter.baseUrl,
        identity: { ...getSelfIdentity(), birth: "linux-ticks:1" },
      });

      expect(await lockfile.read()).toBeNull();
      expect(squatter.requests).toEqual([]);
    });

    test("a recorded start time that is unknown leaves the decision to the probe", async () => {
      const holder = unrelatedProcess();
      const answering = await backend("xum");
      await writeForeignLock({
        pid: holder.pid,
        baseUrl: answering.baseUrl,
        identity: { ...identityOf(holder.pid), birth: null },
      });
      expect((await lockfile.read())?.pid).toBe(holder.pid);

      await writeForeignLock({
        pid: holder.pid,
        baseUrl: await unservedBaseUrl(),
        identity: { ...identityOf(holder.pid), birth: null },
      });
      expect(await lockfile.read()).toBeNull();
    });
  });

  describe("a lock whose identity cannot decide", () => {
    // macOS and Windows: judgeHolder can see only that the pid is alive.
    const NO_LINUX_DOMAIN = {
      birth: null,
      bootId: null,
      pidNs: null,
      machineId: null,
      platform: "darwin",
      hostname: null,
    };

    test("a backend that connects and does not answer is live, as before the probe", async () => {
      const holder = unrelatedProcess();
      const frozenListener = await backend("hang");
      await writeForeignLock({ pid: holder.pid, baseUrl: frozenListener.baseUrl });

      // A lock that an older build wrote has no identity.
      expect((await lockfile.read())?.pid).toBe(holder.pid);
      expect(frozenListener.requests).toHaveLength(1);
    });

    test("without Linux's PID domain, the probe decides what a live pid cannot", async () => {
      setSelfIdentityForTests(NO_LINUX_DOMAIN);
      try {
        const holder = unrelatedProcess();
        const answering = await backend("xum");
        const other = await backend("other");
        const lock = { pid: holder.pid, identity: NO_LINUX_DOMAIN };

        await writeForeignLock({ ...lock, baseUrl: answering.baseUrl });
        expect((await lockfile.read())?.pid).toBe(holder.pid);

        await writeForeignLock({ ...lock, baseUrl: other.baseUrl });
        expect(await lockfile.read()).toBeNull();

        await writeForeignLock({ ...lock, baseUrl: await unservedBaseUrl() });
        expect(await lockfile.read()).toBeNull();

        // A gone pid is stale without the network.
        await writeForeignLock({
          pid: 2 ** 30,
          identity: NO_LINUX_DOMAIN,
          baseUrl: answering.baseUrl,
        });
        const asked = answering.requests.length;
        expect(await lockfile.read()).toBeNull();
        expect(answering.requests).toHaveLength(asked);
      } finally {
        setSelfIdentityForTests(undefined);
      }
    });

    test("an older build's lock with a gone pid is stale without asking its baseUrl", async () => {
      const squatter = await backend("xum");
      await writeForeignLock({ pid: 2 ** 30, baseUrl: squatter.baseUrl });

      expect(await lockfile.read()).toBeNull();
      expect(squatter.requests).toEqual([]);
    });
  });

  describe("a lock of an older build (no process identity) whose pid is alive", () => {
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

    test("a lock that is replaced while its backend is asked is not handed out", async () => {
      // A restart: the successor's acquire() lands while the old backend's answer is pending.
      const foreign = unrelatedProcess();
      const successor = unrelatedProcess();
      const live = await backend("xum", {
        onRequest: async () => {
          await writeForeignLock({ pid: successor.pid, baseUrl: "http://127.0.0.1:2" });
        },
      });
      await writeForeignLock({ pid: foreign.pid, baseUrl: live.baseUrl, token: "old-token" });

      expect(await lockfile.read()).toBeNull();
      expect(live.requests).toHaveLength(1);
    });

    test("a lock that is removed or rewritten by the same pid while its backend is asked is not handed out", async () => {
      const foreign = unrelatedProcess();
      const startedAt = "2026-01-01T00:00:00.000Z";
      let whileAsked: () => Promise<void> = () => Promise.resolve();
      const live = await backend("xum", { onRequest: () => whileAsked() });
      const lock = { pid: foreign.pid, baseUrl: live.baseUrl, startedAt };

      // The backend stopped: release() removed the lock.
      await writeForeignLock(lock);
      whileAsked = () => fs.rm(lockfile.getLockPath());
      expect(await lockfile.read()).toBeNull();

      // The same process restarted its server: the new lock has its pid and a later startedAt.
      await writeForeignLock(lock);
      whileAsked = () =>
        writeForeignLock({ ...lock, startedAt: "2026-01-02T00:00:00.000Z" }).then(() => undefined);
      expect(await lockfile.read()).toBeNull();

      // Nothing changes: the same lock is handed out.
      await writeForeignLock(lock);
      whileAsked = () => Promise.resolve();
      expect((await lockfile.read())?.startedAt).toBe(startedAt);
    });

    test("a lock this process acquired is live without asking its baseUrl", async () => {
      await lockfile.acquire(await unservedBaseUrl(), "own-token");

      expect((await lockfile.read())?.token).toBe("own-token");
      // Another instance on the same path (another service of this process) sees it too.
      expect((await new ServerLockfile(tempDir).peek())?.token).toBe("own-token");
    });
  });

  describe("release", () => {
    /**
     * Makes a successor's lock land at the lock path after release() has read the lock and
     * before it renames it aside (the successor's acquire() between those two calls).
     */
    function successorLandsBeforeRename(lock: Parameters<typeof writeForeignLock>[0]) {
      const realRename = fs.rename;
      return spyOn(fs, "rename").mockImplementation(
        async (...args: Parameters<typeof realRename>) => {
          if (typeof args[1] === "string" && args[1].endsWith(".release"))
            await writeForeignLock(lock);
          return realRename(...args);
        }
      );
    }
    const asideName = () => `server.lock.${process.pid}.release`;

    test("leaves the lock of another backend that replaced this process's lock", async () => {
      // A starter judged this backend stale (it did not answer in time) and acquire()d over it.
      const foreign = unrelatedProcess();
      await lockfile.acquire("http://127.0.0.1:1", "own-token");
      const theirs = await writeForeignLock({ pid: foreign.pid, baseUrl: "http://127.0.0.1:2" });
      const before = await fs.stat(lockfile.getLockPath());

      await lockfile.release();

      expect(JSON.parse(await fs.readFile(lockfile.getLockPath(), "utf-8"))).toEqual(theirs);
      expect(await fs.readdir(tempDir)).toEqual(["server.lock"]);
      // The lock never left its path: it is the same file.
      expect((await fs.stat(lockfile.getLockPath())).ino).toBe(before.ino);
    });

    test("puts back a successor's lock that landed between the read and the rename", async () => {
      const foreign = unrelatedProcess();
      await lockfile.acquire("http://127.0.0.1:1", "own-token");
      const theirs = { pid: foreign.pid, baseUrl: "http://127.0.0.1:2", token: "their-token" };
      const rename = successorLandsBeforeRename(theirs);
      try {
        await lockfile.release();
      } finally {
        rename.mockRestore();
      }

      expect(JSON.parse(await fs.readFile(lockfile.getLockPath(), "utf-8"))).toMatchObject(theirs);
      expect(await fs.readdir(tempDir)).toEqual(["server.lock"]);
      // The restored lock holds a token: it keeps the owner-only mode that acquire() gives it.
      if (process.platform !== "win32") {
        expect((await fs.stat(lockfile.getLockPath())).mode & 0o777).toBe(0o600);
      }
    });

    test("keeps a newer lock that is written while the successor's lock is held aside", async () => {
      const foreign = unrelatedProcess();
      await lockfile.acquire("http://127.0.0.1:1", "own-token");
      const rename = successorLandsBeforeRename({
        pid: foreign.pid,
        baseUrl: "http://127.0.0.1:2",
      });
      const newer = {
        pid: foreign.pid,
        baseUrl: "http://127.0.0.1:3",
        token: "newer-token",
        startedAt: new Date().toISOString(),
      };
      // release() reads the lock it took aside: a third backend acquires right then.
      const realReadFile = fs.readFile;
      const read = spyOn(fs, "readFile").mockImplementation((async (
        ...args: Parameters<typeof realReadFile>
      ) => {
        const content = await realReadFile(...args);
        if (typeof args[0] === "string" && args[0].endsWith(".release")) {
          await fs.writeFile(lockfile.getLockPath(), JSON.stringify(newer));
        }
        return content;
      }) as typeof realReadFile);
      try {
        await lockfile.release();
      } finally {
        read.mockRestore();
        rename.mockRestore();
      }

      expect(JSON.parse(await fs.readFile(lockfile.getLockPath(), "utf-8"))).toEqual(newer);
      expect(await fs.readdir(tempDir)).toEqual(["server.lock"]);
    });

    test("keeps the successor's lock aside when it cannot be put back", async () => {
      const foreign = unrelatedProcess();
      await lockfile.acquire("http://127.0.0.1:1", "own-token");
      const theirs = { pid: foreign.pid, baseUrl: "http://127.0.0.1:2", token: "their-token" };
      const rename = successorLandsBeforeRename(theirs);
      const copy = spyOn(fs, "copyFile").mockImplementation(() =>
        Promise.reject(Object.assign(new Error("no space left"), { code: "ENOSPC" }))
      );
      try {
        await lockfile.release();
      } finally {
        copy.mockRestore();
        rename.mockRestore();
      }

      expect(await fs.readdir(tempDir)).toEqual([asideName()]);
      expect(JSON.parse(await fs.readFile(path.join(tempDir, asideName()), "utf-8"))).toMatchObject(
        theirs
      );
    });

    test("leaves a lock file that is not a valid lock", async () => {
      await lockfile.acquire("http://127.0.0.1:1", "own-token");
      await fs.writeFile(lockfile.getLockPath(), "not json");

      await lockfile.release();

      expect(await fs.readFile(lockfile.getLockPath(), "utf-8")).toBe("not json");
      expect(await fs.readdir(tempDir)).toEqual(["server.lock"]);
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
