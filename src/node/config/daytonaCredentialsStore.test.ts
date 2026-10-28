import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DAYTONA_DEFAULT_API_URL } from "@/common/constants/daytona";
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
    await store.update({ apiKey: KEY });

    const stat = await fs.stat(path.join(rootDir, "daytona.json"));
    expect(stat.mode & 0o777).toBe(0o600);

    const publicConfig = await store.getPublicConfig();
    expect(publicConfig).toEqual({ apiKeySet: true, apiKeySource: "settings" });
    expect(JSON.stringify(publicConfig)).not.toContain(KEY);
    expect((await store.resolve())?.apiKey).toBe(KEY);
  });

  it("leaves an omitted key alone and clears a key set to an empty string", async () => {
    const store = new DaytonaCredentialsStore(rootDir, {});
    await store.update({ apiKey: KEY });
    await store.update({});
    expect(await store.read()).toEqual({ apiKey: KEY });
    await store.update({ apiKey: "  " });
    expect(await store.getPublicConfig()).toEqual({ apiKeySet: false, apiKeySource: null });
  });

  it("takes the URL and target from the environment, and a key from settings wins over it", async () => {
    const env = {
      DAYTONA_API_KEY: "env-key",
      DAYTONA_API_URL: "https://env.example.com/api/",
      DAYTONA_TARGET: "eu",
    };
    const store = new DaytonaCredentialsStore(rootDir, env);
    expect(await store.resolve()).toEqual({
      apiKey: "env-key",
      apiKeySource: "env",
      apiUrl: "https://env.example.com/api",
      target: "eu",
    });

    await store.update({ apiKey: KEY });
    expect(await store.resolve()).toMatchObject({ apiKey: KEY, apiKeySource: "settings" });
    expect((await new DaytonaCredentialsStore(rootDir, {}).resolve())?.apiUrl).toBe(
      DAYTONA_DEFAULT_API_URL
    );
  });

  it("reads a corrupted file as empty so the user can re-enter the key", async () => {
    await fs.writeFile(path.join(rootDir, "daytona.json"), "{not json", "utf-8");
    const store = new DaytonaCredentialsStore(rootDir, {});
    expect(await store.resolve()).toBeNull();
    await store.update({ apiKey: KEY });
    expect((await store.resolve())?.apiKey).toBe(KEY);
  });

  it("refuses a DAYTONA_API_URL that is not https or a loopback http host", async () => {
    const resolveWith = (apiUrl: string) =>
      new DaytonaCredentialsStore(rootDir, {
        DAYTONA_API_KEY: KEY,
        DAYTONA_API_URL: apiUrl,
      }).resolve();
    for (const apiUrl of [
      "not a url",
      "ftp://byoc.example.com",
      "http://byoc.example.com/api",
      "http://10.0.0.5/api",
      "https://user:pw@example.com/api",
      // WHATWG URL parsing reads these as host "api".
      "http:///api",
      "https:api",
    ]) {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
      await expect(resolveWith(apiUrl)).rejects.toThrow(/DAYTONA_API_URL/);
    }
    for (const apiUrl of [
      "http://127.0.0.1:3000/api",
      "http://localhost/api",
      "http://[::1]:8080/api",
    ]) {
      expect((await resolveWith(apiUrl))?.apiUrl).toBe(apiUrl);
    }
  });
});
