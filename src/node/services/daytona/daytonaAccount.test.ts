import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DaytonaCredentialsStore } from "@/node/config/daytonaCredentialsStore";
import { ScriptedSandboxControlPlane } from "./daytona.testHarness";
import { DaytonaService } from "./daytonaService";

describe("DaytonaAccount", () => {
  let rootDir: string;
  let clock: number;
  let plane: ScriptedSandboxControlPlane;
  let service: DaytonaService;
  const sleeps: number[] = [];

  function makeService(env: NodeJS.ProcessEnv = { DAYTONA_API_KEY: "k" }): DaytonaService {
    return new DaytonaService({
      credentialsStore: new DaytonaCredentialsStore(rootDir, env),
      rootDir,
      fetch: plane.fetch,
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });
  }

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-daytona-service-"));
    clock = Date.parse("2026-01-01T00:00:00Z");
    plane = new ScriptedSandboxControlPlane(() => clock);
    sleeps.length = 0;
    service = makeService();
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("reports test-connection failures as typed results", async () => {
    expect(await service.account.testConnection()).toEqual({ ok: true });

    const wrongKey = makeService({ DAYTONA_API_KEY: "wrong" });
    expect(await wrongKey.account.testConnection()).toMatchObject({
      ok: false,
      kind: "unauthorized",
    });

    const unconfigured = makeService({});
    expect(await unconfigured.account.testConnection()).toMatchObject({
      ok: false,
      kind: "not_configured",
    });
    expect(await unconfigured.account.checkAvailability()).toMatchObject({ available: false });
  });

  it("never sends the key to a non-loopback http DAYTONA_API_URL", async () => {
    const insecure = makeService({ DAYTONA_API_KEY: "k", DAYTONA_API_URL: "http://byoc.test/api" });

    expect(await insecure.account.testConnection()).toMatchObject({
      ok: false,
      kind: "not_configured",
      error: expect.stringContaining("DAYTONA_API_URL") as unknown,
    });
    expect(await insecure.account.checkAvailability()).toMatchObject({
      available: false,
      reason: expect.stringContaining("https") as unknown,
    });
    expect(plane.calls).toEqual([]);
  });
});
