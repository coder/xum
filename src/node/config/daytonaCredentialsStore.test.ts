import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DAYTONA_DEFAULT_API_URL } from "@/common/constants/daytona";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
import { DaytonaCredentialsStore } from "./daytonaCredentialsStore";

const KEY = "test-key-not-real";

describe("DaytonaCredentialsStore", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-daytona-creds-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("stores the key in a 0600 file and never exposes it through the public config", async () => {
    const store = new DaytonaCredentialsStore(rootDir, {});
    await store.update({ apiKey: KEY, apiUrl: "https://byoc.example.com/api/", target: "eu" });

    const stat = await fs.stat(path.join(rootDir, "daytona.json"));
    expect(stat.mode & 0o777).toBe(0o600);

    const publicConfig = await store.getPublicConfig();
    expect(publicConfig).toEqual({
      apiKeySet: true,
      apiKeySource: "settings",
      apiUrl: "https://byoc.example.com/api",
      target: "eu",
    });
    expect(JSON.stringify(publicConfig)).not.toContain(KEY);
    expect((await store.resolve())?.apiKey).toBe(KEY);
  });

  // Two backends on one Xum root (a desktop app next to `xum server`) each have their own store.
  it("keeps both of two backends' concurrent saves", async () => {
    const desktop = new DaytonaCredentialsStore(rootDir, {});
    const server = new DaytonaCredentialsStore(rootDir, {});
    await desktop.update({ apiKey: "old-key", apiUrl: "https://old.example.com/api" });

    await Promise.all([
      desktop.update({ apiKey: KEY }),
      server.update({ apiUrl: "https://new.example.com/api" }),
    ]);

    expect(await desktop.read()).toEqual({ apiKey: KEY, apiUrl: "https://new.example.com/api" });
  });

  it("waits for another process's save before reading the file", async () => {
    // Held by this process, the file lock looks to the store like another backend mid-save.
    const release = await acquireCrossProcessLock({
      lockPath: path.join(rootDir, "daytona.json.lock"),
      acquireTimeoutMs: 1_000,
      staleMs: 60_000,
      timeoutMessage: "test holder",
    });
    const store = new DaytonaCredentialsStore(rootDir, {});
    let settled = false;
    const saving = store.update({ apiKey: KEY }).finally(() => {
      settled = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);
      expect(await store.read()).toEqual({});
    } finally {
      await release();
    }
    await saving;
    expect(await store.read()).toEqual({ apiKey: KEY });
  });

  it("leaves omitted fields alone and clears fields set to an empty string", async () => {
    const store = new DaytonaCredentialsStore(rootDir, {});
    await store.update({ apiKey: KEY, target: "us" });
    await store.update({ target: "" });
    expect(await store.read()).toEqual({ apiKey: KEY });
    await store.update({ apiKey: "  " });
    expect(await store.getPublicConfig()).toEqual({
      apiKeySet: false,
      apiKeySource: null,
      apiUrl: DAYTONA_DEFAULT_API_URL,
      target: null,
    });
  });

  it("falls back to the server environment, and a key from settings wins over it", async () => {
    const env = { DAYTONA_API_KEY: "env-key", DAYTONA_API_URL: "https://env.example.com/api" };
    const store = new DaytonaCredentialsStore(rootDir, env);
    expect(await store.resolve()).toEqual({
      apiKey: "env-key",
      apiKeySource: "env",
      apiUrl: "https://env.example.com/api",
    });

    await store.update({ apiKey: KEY });
    expect(await store.resolve()).toMatchObject({ apiKey: KEY, apiKeySource: "settings" });
  });

  it("reads a corrupted file as empty so the user can re-enter the key", async () => {
    await fs.writeFile(path.join(rootDir, "daytona.json"), "{not json", "utf-8");
    const store = new DaytonaCredentialsStore(rootDir, {});
    expect(await store.resolve()).toBeNull();
    await store.update({ apiKey: KEY });
    expect((await store.resolve())?.apiKey).toBe(KEY);
  });

  it("keeps the saved settings when the file cannot be read for an update", async () => {
    const store = new DaytonaCredentialsStore(rootDir, {});
    await store.update({ apiKey: KEY, apiUrl: "https://byoc.example.com/api", target: "eu" });
    const file = path.join(rootDir, "daytona.json");

    // A read that fails for another reason than absence (here: a permission problem).
    await fs.chmod(file, 0o000);
    let refusal: unknown;
    try {
      await store.update({ target: "us" });
    } catch (error) {
      refusal = error;
    } finally {
      await fs.chmod(file, 0o600);
    }

    expect(refusal).toBeInstanceOf(Error);
    expect(await store.resolve()).toMatchObject({
      apiKey: KEY,
      apiUrl: "https://byoc.example.com/api",
      target: "eu",
    });
  });

  it("refuses a stored API URL that does not validate instead of sending the key elsewhere", async () => {
    for (const apiUrl of ["not a url", "http://byoc.example.com/api"]) {
      await fs.writeFile(
        path.join(rootDir, "daytona.json"),
        JSON.stringify({ apiKey: KEY, apiUrl }),
        "utf-8"
      );
      for (const env of [{}, { DAYTONA_API_URL: "https://env.example.com/api" }]) {
        const store = new DaytonaCredentialsStore(rootDir, env);
        // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
        await expect(store.resolve()).rejects.toThrow(/saved in Settings/);
        // Shown as written, so the user sees what to fix.
        expect((await store.getPublicConfig()).apiUrl).toBe(apiUrl);
      }
    }

    // Clearing it is the user's choice of the default deployment.
    const store = new DaytonaCredentialsStore(rootDir, {});
    await store.update({ apiUrl: "" });
    expect((await store.resolve())?.apiUrl).toBe(DAYTONA_DEFAULT_API_URL);
  });

  it("accepts plain http only for a loopback host, where no network sees the key", async () => {
    const store = new DaytonaCredentialsStore(rootDir, {});
    for (const apiUrl of ["http://byoc.example.com/api", "http://10.0.0.5/api"]) {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
      await expect(store.update({ apiUrl })).rejects.toThrow(/https/);
    }
    for (const apiUrl of [
      "http://127.0.0.1:3000/api",
      "http://localhost/api",
      "http://[::1]:8080/api",
    ]) {
      await store.update({ apiUrl });
      expect((await store.read()).apiUrl).toBe(apiUrl);
    }
  });

  it("refuses every DAYTONA_API_URL that does not validate instead of using the default", async () => {
    await fs.writeFile(
      path.join(rootDir, "daytona.json"),
      JSON.stringify({ apiKey: KEY }),
      "utf-8"
    );
    // The environment names the deployment, so another one must not get the key instead.
    for (const envUrl of ["http://byoc.example.com/api", "not a url", "ftp://byoc.example.com"]) {
      const fromEnv = new DaytonaCredentialsStore(rootDir, { DAYTONA_API_URL: envUrl });
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
      await expect(fromEnv.resolve()).rejects.toThrow(/DAYTONA_API_URL/);
      expect((await fromEnv.getPublicConfig()).apiUrl).toBe(envUrl);
    }
  });

  it("rejects an API URL that is not plain http(s)", async () => {
    const store = new DaytonaCredentialsStore(rootDir, {});
    for (const apiUrl of [
      "not a url",
      "file:///etc/passwd",
      "https://user:pw@example.com/api",
      // WHATWG URL parsing reads these as host "api".
      "http:///api",
      "https:api",
    ]) {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
      await expect(store.update({ apiUrl })).rejects.toThrow(/Daytona API URL/);
    }
    expect(await store.read()).toEqual({});
  });
});
