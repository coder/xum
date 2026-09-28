import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { ServerLockfile } from "./serverLockfile";

describe("ServerLockfile", () => {
  let tempDir: string;
  let lockfile: ServerLockfile;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-lock-test-"));
    lockfile = new ServerLockfile(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

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

  test("read returns null for stale lockfile (dead PID)", async () => {
    const lockPath = lockfile.getLockPath();

    // Write lockfile with fake dead PID
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: 999999999, // Very unlikely to be a real PID
        baseUrl: "http://localhost:12345",
        token: "test-token",
        startedAt: new Date().toISOString(),
      })
    );

    const data = await lockfile.read();
    expect(data).toBeNull();

    // Stale lockfile should be cleaned up
    let exists = true;
    try {
      await fs.access(lockPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test("read returns data for lockfile with current PID", async () => {
    await lockfile.acquire("http://127.0.0.1:54321", "valid-token");

    const data = await lockfile.read();
    expect(data).not.toBeNull();
    expect(data!.baseUrl).toBe("http://127.0.0.1:54321");
    expect(data!.token).toBe("valid-token");
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
