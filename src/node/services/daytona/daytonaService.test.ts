import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DaytonaCredentialsStore } from "@/node/config/daytonaCredentialsStore";
import { XUM_DAYTONA_SSH_BLOCK_START } from "@/common/constants/daytona";
import { DaytonaSshConfigWriter } from "@/node/runtime/daytonaSshConfig";
import { log } from "@/node/services/log";
import { DaytonaApiError } from "./daytonaClient";
import { FakeDaytonaControlPlane } from "./daytona.testHarness";
import {
  DAYTONA_BUSY_MESSAGE,
  DAYTONA_LABEL_INSTANCE,
  DAYTONA_LABEL_PROJECT,
  DaytonaService,
  mapDaytonaSandboxState,
} from "./daytonaService";

/** In-memory control plane: one sandbox whose `state` follows a script of observations. */
class FakeControlPlane {
  states: string[] = [];
  exists = true;
  errorReason?: string;
  /** A proxy that echoes the request URI and its Authorization header in a failed revoke. */
  revokeEchoesRequest = false;
  readonly calls: string[] = [];
  private tokenCounter = 0;
  readonly revoked: string[] = [];
  gatewayHost = "ssh.test";
  gatewayHostKeys = ["ssh-ed25519 AAAA"];

  constructor(private readonly now: () => number) {}

  readonly fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(this.handle(input, init))) as typeof fetch;

  private handle(input: string | URL | Request, init?: RequestInit): Response {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";
    const route = `${method} ${url.pathname.replace(/^\/api/, "")}`;
    this.calls.push(route);
    const json = (status: number, body?: unknown) =>
      new Response(body === undefined ? "" : JSON.stringify(body), { status });

    if (route === "GET /config") {
      return json(200, {
        sshGatewayHost: this.gatewayHost,
        sshGatewayHostKeys: this.gatewayHostKeys,
      });
    }
    if (route === "GET /sandbox") {
      if (init?.headers && (init.headers as Record<string, string>).Authorization !== "Bearer k") {
        return json(401, { statusCode: 401, message: "Invalid credentials" });
      }
      return json(200, { items: [], nextCursor: null });
    }
    if (!this.exists) return json(404, { statusCode: 404, message: "Sandbox not found" });
    if (route === "GET /sandbox/sb-1") {
      const state = this.states.length > 1 ? this.states.shift() : this.states[0];
      return json(200, { id: "sb-1", name: "sb-1", state, errorReason: this.errorReason });
    }
    if (route === "POST /sandbox/sb-1/start") return json(200, {});
    if (route === "POST /sandbox/sb-1/ssh-access") {
      this.tokenCounter += 1;
      const minutes = Number(url.searchParams.get("expiresInMinutes"));
      return json(200, {
        token: `tok${this.tokenCounter}`,
        expiresAt: new Date(this.now() + minutes * 60_000).toISOString(),
      });
    }
    if (route === "DELETE /sandbox/sb-1/ssh-access") {
      if (this.revokeEchoesRequest) {
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
        return json(500, { message: `Revoke failed for ${url.toString()} (${auth})` });
      }
      this.revoked.push(url.searchParams.get("token") ?? "");
      return json(200, {});
    }
    return json(500, { message: `unexpected ${route}` });
  }
}

describe("DaytonaService", () => {
  let rootDir: string;
  let clock: number;
  let plane: FakeControlPlane;
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
    plane = new FakeControlPlane(() => clock);
    sleeps.length = 0;
    service = makeService();
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("collapses Daytona states to the ones Xum acts on", () => {
    const expected: Record<string, string> = {
      creating: "starting",
      resuming: "starting",
      stopping: "starting",
      archiving: "starting",
      started: "started",
      stopped: "stopped",
      paused: "stopped",
      archived: "archived",
      build_failed: "error",
      destroyed: "error",
      some_future_state: "error",
    };
    for (const [raw, state] of Object.entries(expected)) {
      expect(`${raw} -> ${mapDaytonaSandboxState(raw)}`).toBe(`${raw} -> ${state}`);
    }
  });

  it("starts a stopped sandbox once and waits until it reports started", async () => {
    plane.states = ["stopped", "stopped", "starting", "started"];
    let startingEvents = 0;
    const sandbox = await service.startAndWait("sb-1", clock + 60_000, {
      onStarting: () => startingEvents++,
    });
    expect(sandbox.state).toBe("started");
    expect(startingEvents).toBe(1);
    expect(plane.calls.filter((call) => call === "POST /sandbox/sb-1/start")).toHaveLength(1);
  });

  it("gives up at the deadline with a timeout error", async () => {
    plane.states = ["starting"];
    const deadline = clock + 7_000;
    const error = await service.startAndWait("sb-1", deadline).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaytonaApiError);
    expect((error as DaytonaApiError).kind).toBe("timeout");
    expect(clock).toBe(deadline);
  });

  it("fails fast on a missing sandbox or an error state instead of polling", async () => {
    plane.exists = false;
    const missing = await service.startAndWait("sb-1", clock + 60_000).catch((e: unknown) => e);
    expect((missing as DaytonaApiError).kind).toBe("not_found");
    expect(await service.getSandboxState("sb-1")).toEqual({ state: "missing" });

    plane.exists = true;
    plane.states = ["build_failed"];
    plane.errorReason = "Dockerfile step 3 failed";
    const failed = await service.startAndWait("sb-1", clock + 60_000).catch((e: unknown) => e);
    expect((failed as Error).message).toContain("Dockerfile step 3 failed");
    expect(sleeps).toEqual([]);
  });

  it("reuses an SSH token until it nears expiry, then swaps it before revoking the old one", async () => {
    const first = await service.getSshToken("sb-1");
    clock += 30 * 60_000;
    expect(await service.getSshToken("sb-1")).toEqual(first);

    // 50 minutes in, less than 15 minutes remain.
    clock += 20 * 60_000;
    const order: string[] = [];
    const second = await service.getSshToken("sb-1", {
      onNewToken: (access) => {
        order.push(`installed ${access.token}, revoked so far: ${plane.revoked.join(",")}`);
        return Promise.resolve();
      },
    });
    expect(second.token).not.toBe(first.token);
    expect(order).toEqual([`installed ${second.token}, revoked so far: `]);
    expect(plane.revoked).toEqual([first.token]);
  });

  it("shares one mint between concurrent token requests", async () => {
    const [a, b] = await Promise.all([service.getSshToken("sb-1"), service.getSshToken("sb-1")]);
    expect(a).toEqual(b);
    expect(plane.calls.filter((call) => call === "POST /sandbox/sb-1/ssh-access")).toHaveLength(1);
  });

  it("revokes the SSH tokens it holds when the settings change", async () => {
    const held = await service.getSshToken("sb-1");
    await service.setConfig({ target: "eu" });
    expect(plane.revoked).toEqual([held.token]);
    // The next request mints a fresh token instead of reusing the revoked one.
    expect((await service.getSshToken("sb-1")).token).not.toBe(held.token);
  });

  it("logs a failed revoke without the token or the API key the response echoes", async () => {
    const held = await service.getSshToken("sb-1");
    plane.revokeEchoesRequest = true;
    const warn = spyOn(log, "warn");
    try {
      await service.setConfig({ target: "eu" });
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain("Failed to revoke a Daytona SSH token");
      expect(logged).not.toContain(held.token);
      expect(logged).not.toContain("Bearer k");
    } finally {
      warn.mockRestore();
    }
  });

  it("mints under credentials another Xum process saved, and not after its own change", async () => {
    const mintKeys: string[] = [];
    service = new DaytonaService({
      credentialsStore: new DaytonaCredentialsStore(rootDir, { DAYTONA_API_KEY: "k" }),
      rootDir,
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (init?.method === "POST" && url.includes("/ssh-access")) {
          mintKeys.push((init.headers as Record<string, string>).Authorization);
        }
        return plane.fetch(input, init);
      }) as typeof fetch,
      now: () => clock,
    });
    const before = await service.getAccount();
    const held = await service.getSshToken("sb-1");

    // Another backend sharing this root saves another key.
    await new DaytonaCredentialsStore(rootDir, {}).update({ apiKey: "other" });

    expect((await service.getSshToken("sb-1")).token).not.toBe(held.token);
    expect(mintKeys).toEqual(["Bearer k", "Bearer other"]);
    expect(service.isAccountCurrent(before)).toBe(false);

    // This process's own change is not taken for another one.
    await service.setConfig({ apiKey: "third" });
    const after = await service.getAccount();
    await service.getSshToken("sb-1");
    expect(service.isAccountCurrent(after)).toBe(true);
    expect(mintKeys).toEqual(["Bearer k", "Bearer other", "Bearer third"]);
  });

  it("keeps a lease on its account when another process saves another key", async () => {
    const lookupKeys: string[] = [];
    service = new DaytonaService({
      credentialsStore: new DaytonaCredentialsStore(rootDir, { DAYTONA_API_KEY: "k" }),
      rootDir,
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        if ((init?.method ?? "GET") === "GET" && url.endsWith("/sandbox/sb-1")) {
          lookupKeys.push((init?.headers as Record<string, string>).Authorization);
        }
        return plane.fetch(input, init);
      }) as typeof fetch,
      now: () => clock,
    });
    const generation = async () => (await service.getAccount()).generation;
    await service.getSshToken("sb-1");
    const before = await generation();

    await service.withAccountLease(async () => {
      await service.getSandboxState("sb-1");
      await new DaytonaCredentialsStore(rootDir, {}).update({ apiKey: "other" });
      await service.getSandboxState("sb-1");
      expect(await generation()).toBe(before);
    });
    expect(lookupKeys).toEqual(["Bearer k", "Bearer k"]);

    // The first resolve after the lease takes the new account and retires the old one once.
    await service.getSandboxState("sb-1");
    await service.getSandboxState("sb-1");
    expect(lookupKeys.slice(2)).toEqual(["Bearer other", "Bearer other"]);
    expect(await generation()).toBe(before + 1);
  });

  it("takes the account another process saved while idle from a lease's first call", async () => {
    const lookupKeys: string[] = [];
    service = new DaytonaService({
      credentialsStore: new DaytonaCredentialsStore(rootDir, { DAYTONA_API_KEY: "k" }),
      rootDir,
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        if ((init?.method ?? "GET") === "GET" && url.endsWith("/sandbox/sb-1")) {
          lookupKeys.push((init?.headers as Record<string, string>).Authorization);
        }
        return plane.fetch(input, init);
      }) as typeof fetch,
      now: () => clock,
    });
    plane.states = ["started"];
    await service.getSandboxState("sb-1");
    const before = (await service.getAccount()).generation;

    // Another backend sharing this root saves another key while no lease runs here.
    await new DaytonaCredentialsStore(rootDir, {}).update({ apiKey: "other" });
    await service.withAccountLease(() => service.getSandboxState("sb-1"));

    expect(lookupKeys).toEqual(["Bearer k", "Bearer other"]);
    await service.getSandboxState("sb-1");
    expect((await service.getAccount()).generation).toBe(before + 1);
  });

  it("fails a lease whose settings another process made unusable while idle", async () => {
    plane.states = ["started"];
    await service.getSandboxState("sb-1");
    const requests = plane.calls.length;

    // A hand edit (or another backend) saves an API URL that must not get the key.
    await fs.writeFile(
      path.join(rootDir, "daytona.json"),
      JSON.stringify({ apiKey: "k", apiUrl: "http://remote.example.com/api" })
    );
    const failure = await service
      .withAccountLease(() => service.getSandboxState("sb-1"))
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(failure).toBeInstanceOf(DaytonaApiError);
    expect((failure as DaytonaApiError).kind).toBe("not_configured");
    expect(plane.calls.length).toBe(requests);
  });

  it("leaves a resolve during its own settings save to that save", async () => {
    const revokeKeys: string[] = [];
    const store = new DaytonaCredentialsStore(rootDir, { DAYTONA_API_KEY: "k" });
    service = new DaytonaService({
      credentialsStore: store,
      rootDir,
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (init?.method === "DELETE" && url.includes("/ssh-access")) {
          revokeKeys.push((init.headers as Record<string, string>).Authorization);
        }
        return plane.fetch(input, init);
      }) as typeof fetch,
      now: () => clock,
    });
    const held = await service.getSshToken("sb-1");
    const before = (await service.getAccount()).generation;
    // Hold the save after the new key is on disk, before setConfig goes on.
    let releaseSave = () => undefined as void;
    const saveGate = new Promise<void>((resolve) => (releaseSave = resolve));
    let saved = () => undefined as void;
    const savedOnDisk = new Promise<void>((resolve) => (saved = resolve));
    const realUpdate = store.update.bind(store);
    spyOn(store, "update").mockImplementation(async (patch) => {
      const result = await realUpdate(patch);
      saved();
      await saveGate;
      return result;
    });

    const change = service.setConfig({ apiKey: "new-key" });
    await savedOnDisk;
    const token = service.getSshToken("sb-1");
    await service.checkAvailability();
    releaseSave();
    await change;
    await token;

    expect(plane.revoked).toEqual([held.token]);
    expect(revokeKeys).toEqual(["Bearer k"]);
    expect((await service.getAccount()).generation).toBe(before + 1);
  });

  /** A service whose first token mint waits until `releaseMint`; `includeFile` is its writer. */
  function serviceWithHeldMint() {
    let mintStarted!: () => void;
    const started = new Promise<void>((resolve) => (mintStarted = resolve));
    let releaseMint!: () => void;
    const released = new Promise<void>((resolve) => (releaseMint = resolve));
    let held = false;
    const fetchHoldingFirstMint = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!held && init?.method === "POST" && url.includes("/ssh-access")) {
        held = true;
        mintStarted();
        await released;
      }
      return plane.fetch(input, init);
    }) as typeof fetch;
    const written: string[] = [];
    const includeFile = new Map<string, string>();
    const store = (input: { sandboxId: string; token: string }) => {
      written.push(input.token);
      includeFile.set(input.sandboxId, input.token);
      return Promise.resolve();
    };
    const heldService = new DaytonaService({
      credentialsStore: new DaytonaCredentialsStore(rootDir, { DAYTONA_API_KEY: "k" }),
      rootDir,
      fetch: fetchHoldingFirstMint,
      now: () => clock,
      sshConfigWriter: {
        writeSandbox: store,
        ensureManagedBlock: () => Promise.resolve(),
        updateToken: store,
        repointGateway: () => Promise.resolve(),
        removeSandbox: (sandboxId: string) => {
          includeFile.delete(sandboxId);
          return Promise.resolve();
        },
        removeSandboxTokens: () => Promise.resolve(),

        readTokens: () => Promise.resolve([]),
      },
    });
    return { service: heldService, started, releaseMint, written, includeFile };
  }

  it("refuses a settings change while a token is minted, and takes it afterwards", async () => {
    const held = serviceWithHeldMint();

    const access = held.service.ensureSshAccess("sb-1");
    await held.started;
    const refusal = await held.service.setConfig({ target: "eu" }).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(String(refusal)).toContain(DAYTONA_BUSY_MESSAGE);
    held.releaseMint();
    await access;

    expect(held.written).toEqual(["tok1"]);
    expect((await held.service.setConfig({ target: "eu" })).target).toBe("eu");
    // The change revokes the old settings' token.
    expect(plane.revoked).toEqual(["tok1"]);
  });

  /** A service whose ssh setup writes are recorded as `token@host keys`. */
  function serviceRecordingWrites(fetchImpl: typeof fetch = plane.fetch) {
    const writes: string[] = [];
    /** Sandboxes whose pooled ssh connections were retired. */
    const retired: string[] = [];
    /** Include block removals, gateway repoints and retirements, in order. */
    const order: string[] = [];
    /** Per retirement: whether the sandbox's next ssh access would set it up again. */
    const staleAtRetire: boolean[] = [];
    /** The include file: what ensureSshAccess reads back before it trusts its cache. */
    const includeFile = new Map<string, string>();
    const record = (input: {
      sandboxId: string;
      token: string;
      gateway: { host: string; hostKeys: string[] };
    }) => {
      includeFile.set(input.sandboxId, input.token);
      writes.push(`${input.token}@${input.gateway.host} ${input.gateway.hostKeys.join(",")}`);
      return Promise.resolve();
    };
    const recording = new DaytonaService({
      credentialsStore: new DaytonaCredentialsStore(rootDir, { DAYTONA_API_KEY: "k" }),
      rootDir,
      fetch: fetchImpl,
      now: () => clock,
      sshConfigWriter: {
        writeSandbox: record,
        ensureManagedBlock: () => Promise.resolve(),
        updateToken: record,
        removeSandbox: (sandboxId) => {
          includeFile.delete(sandboxId);
          order.push(`remove ${sandboxId}`);
          return Promise.resolve();
        },
        repointGateway: (gateway) => {
          order.push(`repoint ${gateway.host} ${gateway.hostKeys.join(",")}`);
          return Promise.resolve();
        },
        removeSandboxTokens: () => Promise.resolve(),

        readTokens: () =>
          Promise.resolve([...includeFile].map(([sandboxId, token]) => ({ sandboxId, token }))),
      },
      retireSshConnections: (sandboxId) => {
        retired.push(sandboxId);
        order.push(`retire ${sandboxId}`);
        staleAtRetire.push(recording.tokenNeedsRefresh(sandboxId));
        return Promise.resolve();
      },
    });
    return { service: recording, writes, retired, order, staleAtRetire };
  }

  it("refuses a settings change while it looks up the gateway for a token", async () => {
    let gatewayFetched!: () => void;
    const fetched = new Promise<void>((resolve) => (gatewayFetched = resolve));
    let releaseGateway!: () => void;
    const released = new Promise<void>((resolve) => (releaseGateway = resolve));
    let held = false;
    // The first /config answer is delivered late, while the user saves new settings.
    const fetchHoldingFirstConfig = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await plane.fetch(input, init);
      const url = input instanceof Request ? input.url : input.toString();
      if (!held && url.endsWith("/config")) {
        held = true;
        gatewayFetched();
        await released;
      }
      return response;
    }) as typeof fetch;
    const { service: racing, writes } = serviceRecordingWrites(fetchHoldingFirstConfig);

    const access = racing.ensureSshAccess("sb-1");
    await fetched;
    const refusal = await racing.setConfig({ target: "eu" }).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(String(refusal)).toContain(DAYTONA_BUSY_MESSAGE);
    releaseGateway();
    await access;

    expect(writes).toEqual(["tok1@ssh.test ssh-ed25519 AAAA"]);
  });

  it("rewrites a sandbox's ssh setup once Daytona moves its gateway keys", async () => {
    const { service: watching, writes, retired } = serviceRecordingWrites();
    const configFetches = () => plane.calls.filter((call) => call === "GET /config").length;

    await watching.ensureSshAccess("sb-1");
    clock += 4 * 60_000;
    await watching.ensureSshAccess("sb-1");
    expect(configFetches()).toBe(1);

    // Rotated (and listed in another order) while Xum runs.
    plane.gatewayHostKeys = ["ssh-rsa CCCC", "ssh-ed25519 BBBB"];
    clock += 2 * 60_000;
    await watching.ensureSshAccess("sb-1");
    expect(writes).toEqual([
      "tok1@ssh.test ssh-ed25519 AAAA",
      "tok2@ssh.test ssh-rsa CCCC,ssh-ed25519 BBBB",
    ]);
    expect(plane.revoked).toEqual(["tok1"]);
    // A pooled connection to the old gateway must not carry later commands.
    expect(retired).toEqual(["sb-1"]);

    // A refetch that finds the same gateway, keys reordered, rewrites nothing.
    plane.gatewayHostKeys = ["ssh-ed25519 BBBB", "ssh-rsa CCCC"];
    clock += 6 * 60_000;
    await watching.ensureSshAccess("sb-1");
    expect(configFetches()).toBe(3);
    expect(writes).toHaveLength(2);
    expect(retired).toEqual(["sb-1"]);
  });

  it("shares one gateway refresh between concurrent lookups, so a stale reply cannot win", async () => {
    const held: Array<{ run: () => Promise<Response>; resolve: (response: Response) => void }> = [];
    let holdConfig = false;
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!holdConfig || !url.endsWith("/config")) return plane.fetch(input, init);
      return new Promise<Response>((resolve) => {
        held.push({ run: () => plane.fetch(input, init), resolve });
      });
    }) as typeof fetch;
    const { service: watching, retired } = serviceRecordingWrites(fetchImpl);
    await watching.ensureSshAccess("sb-1");

    clock += 6 * 60_000;
    holdConfig = true;
    const lookups = Promise.all([watching.getGatewayConfig(), watching.getGatewayConfig()]);
    while (held.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // During a rollout the last request answers first with the new gateway; earlier ones late.
    for (let i = held.length - 1; i >= 0; i--) {
      plane.gatewayHostKeys = i === held.length - 1 ? ["ssh-ed25519 NEW"] : ["ssh-ed25519 AAAA"];
      held[i].resolve(await held[i].run());
    }
    const results = await lookups;
    holdConfig = false;

    expect(held).toHaveLength(1);
    expect(results.map((config) => config.sshGatewayHostKeys)).toEqual([
      ["ssh-ed25519 NEW"],
      ["ssh-ed25519 NEW"],
    ]);
    expect((await watching.getGatewayConfig()).sshGatewayHostKeys).toEqual(["ssh-ed25519 NEW"]);
    expect(retired).toEqual(["sb-1"]);
  });

  it("installs a moved gateway before retiring the connections to the old one", async () => {
    const { service: watching, order, staleAtRetire } = serviceRecordingWrites();
    await watching.ensureSshAccess("sb-1");

    plane.gatewayHostKeys = ["ssh-ed25519 BBBB"];
    clock += 6 * 60_000;
    await watching.getGatewayConfig();

    // A connection opened while the old ones are retired reads the new files, and the next
    // access sets the sandbox up again: nothing reaches the old gateway afterwards.
    expect(order).toEqual(["repoint ssh.test ssh-ed25519 BBBB", "retire sb-1"]);
    expect(staleAtRetire).toEqual([true]);
  });

  it("retires the pooled ssh connections of its sandboxes on a settings change", async () => {
    const { service: changing, retired } = serviceRecordingWrites();
    await changing.ensureSshAccess("sb-1");

    await changing.setConfig({ target: "eu" });

    expect(retired).toEqual(["sb-1"]);
  });

  it("retires a released sandbox's ssh connections once its include block is gone", async () => {
    const { service: releasing, order } = serviceRecordingWrites();
    await releasing.ensureSshAccess("sb-1");

    await releasing.releaseSshAccess("sb-1");

    // Pooled sessions and reverse forwards stay authenticated after the token is revoked; a
    // retirement before the block is gone could reconnect from it.
    expect(order).toEqual(["remove sb-1", "retire sb-1"]);
  });

  it("revokes a token minted across a release, keeping the access released", async () => {
    const held = serviceWithHeldMint();

    const access = held.service.ensureSshAccess("sb-1").catch((error: unknown) => error);
    await held.started;
    await held.service.releaseSshAccess("sb-1");
    held.releaseMint();

    // The caller asked for access the release took away: it fails instead of minting again.
    expect(String(await access)).toContain("released");
    expect(plane.revoked).toEqual(["tok1"]);
    expect(held.includeFile.has("sb-1")).toBe(false);
    expect(held.service.hasExpiringSshToken("sb-1")).toBe(false);
    expect(plane.calls.filter((call) => call === "POST /sandbox/sb-1/ssh-access")).toHaveLength(1);
  });

  it("revokes the tokens an earlier process left in the include file once it replaces them", async () => {
    // The include file, shared by every Xum process (a restart is a new service).
    const includeFile = new Map([["sb-1", "earlier-process-token"]]);
    const store = (input: { sandboxId: string; token: string }) => {
      includeFile.set(input.sandboxId, input.token);
      return Promise.resolve();
    };
    const writer = {
      writeSandbox: store,
      ensureManagedBlock: () => Promise.resolve(),
      updateToken: store,
      removeSandbox: () => Promise.resolve(),
      removeSandboxTokens: () => Promise.resolve(),

      readTokens: () =>
        Promise.resolve([...includeFile].map(([sandboxId, token]) => ({ sandboxId, token }))),
      repointGateway: () => Promise.resolve(),
    };
    const startProcess = async () => {
      const started = new DaytonaService({
        credentialsStore: new DaytonaCredentialsStore(rootDir, { DAYTONA_API_KEY: "k" }),
        rootDir,
        fetch: plane.fetch,
        now: () => clock,
        sshConfigWriter: writer,
      });
      await started.loadPersistedTokens();
      return started;
    };

    // The file has no expiry, so the first ssh access replaces the loaded token.
    await (await startProcess()).ensureSshAccess("sb-1");
    const minted = includeFile.get("sb-1");
    expect(minted).not.toBe("earlier-process-token");
    expect(plane.revoked).toEqual(["earlier-process-token"]);

    // After another restart, a settings change revokes what it loaded.
    await (await startProcess()).setConfig({ target: "eu" });
    expect(plane.revoked).toEqual(["earlier-process-token", minted ?? ""]);
  });

  it("loads the include file's tokens before ssh access when the startup load failed", async () => {
    let failedReads = 1;
    const writer = {
      writeSandbox: () => Promise.resolve(),
      ensureManagedBlock: () => Promise.resolve(),
      updateToken: () => Promise.resolve(),
      removeSandbox: () => Promise.resolve(),
      removeSandboxTokens: () => Promise.resolve(),

      readTokens: () =>
        failedReads-- > 0
          ? Promise.reject(new Error("EIO: i/o error, read"))
          : Promise.resolve([{ sandboxId: "sb-1", token: "earlier-process-token" }]),
      repointGateway: () => Promise.resolve(),
    };
    service = new DaytonaService({
      credentialsStore: new DaytonaCredentialsStore(rootDir, { DAYTONA_API_KEY: "k" }),
      rootDir,
      fetch: plane.fetch,
      now: () => clock,
      sshConfigWriter: writer,
    });
    expect(
      await service.loadPersistedTokens().then(
        () => "loaded",
        () => "failed"
      )
    ).toBe("failed");

    // The retry knows the earlier token, so the new one replaces and revokes it.
    await service.ensureSshAccess("sb-1");
    expect(plane.revoked).toEqual(["earlier-process-token"]);
  });

  it("puts back a removed ~/.ssh/config block on ssh access while the cached token is fresh", async () => {
    const sshConfigPath = path.join(rootDir, "home", ".ssh", "config");
    service = new DaytonaService({
      credentialsStore: new DaytonaCredentialsStore(rootDir, { DAYTONA_API_KEY: "k" }),
      rootDir,
      fetch: plane.fetch,
      now: () => clock,
      sshConfigWriter: new DaytonaSshConfigWriter({ xumHome: rootDir, sshConfigPath }),
    });
    await service.ensureSshAccess("sb-1");
    expect(await fs.readFile(sshConfigPath, "utf8")).toContain(XUM_DAYTONA_SSH_BLOCK_START);
    // A dotfiles tool replaces the file: the include file and the cached token stay.
    await fs.writeFile(sshConfigPath, "Host work\n  User me\n", "utf8");

    await service.ensureSshAccess("sb-1");

    const restored = await fs.readFile(sshConfigPath, "utf8");
    expect(restored.startsWith(XUM_DAYTONA_SSH_BLOCK_START)).toBe(true);
    expect(restored).toContain("Host work\n  User me\n");
    expect(plane.calls.filter((call) => call === "POST /sandbox/sb-1/ssh-access")).toHaveLength(1);
  });

  it("reports test-connection failures as typed results", async () => {
    expect(await service.testConnection()).toEqual({ ok: true });

    const wrongKey = makeService({ DAYTONA_API_KEY: "wrong" });
    expect(await wrongKey.testConnection()).toMatchObject({ ok: false, kind: "unauthorized" });

    const unconfigured = makeService({});
    expect(await unconfigured.testConnection()).toMatchObject({
      ok: false,
      kind: "not_configured",
    });
    expect(await unconfigured.checkAvailability()).toMatchObject({ available: false });
  });

  it("never sends the key to a non-loopback http DAYTONA_API_URL", async () => {
    const insecure = makeService({ DAYTONA_API_KEY: "k", DAYTONA_API_URL: "http://byoc.test/api" });

    expect(await insecure.testConnection()).toMatchObject({
      ok: false,
      kind: "not_configured",
      error: expect.stringContaining("DAYTONA_API_URL") as unknown,
    });
    expect(await insecure.checkAvailability()).toMatchObject({
      available: false,
      reason: expect.stringContaining("https") as unknown,
    });
    expect(plane.calls).toEqual([]);
  });

  it("labels sandboxes with an instance id that is stable across service instances", async () => {
    const labels = await service.buildLabels({
      workspaceId: "ws-1",
      projectPath: "/home/me/secret-dir/my-project",
    });
    const again = await makeService().buildLabels({
      workspaceId: "ws-2",
      projectPath: "/x/other",
    });
    expect(labels[DAYTONA_LABEL_INSTANCE]).toBe(again[DAYTONA_LABEL_INSTANCE]);
    expect(labels[DAYTONA_LABEL_PROJECT]).toBe("my-project");
  });

  // Another backend on this root switched accounts: this one cannot revoke the old tokens, so
  // their aliases must leave the shared include file before it retires the connections, or a
  // fresh ssh from an alias would keep reaching the old account's sandbox.
  it("drops the old account's aliases from the include file when another process switches", async () => {
    const planes = new Map([
      ["Bearer key-a", new FakeDaytonaControlPlane(() => clock)],
      ["Bearer key-b", new FakeDaytonaControlPlane(() => clock)],
    ]);
    for (const [auth, accountPlane] of planes) {
      accountPlane.tokenPrefix = `${auth.slice(-1)}-tok`;
      for (const id of ["sb-1", "sb-2", "sb-3"]) accountPlane.addSandbox({ id, state: "started" });
    }
    const sshConfigPath = path.join(rootDir, "home", ".ssh", "config");
    const backend = () =>
      new DaytonaService({
        credentialsStore: new DaytonaCredentialsStore(rootDir, { DAYTONA_API_KEY: "key-a" }),
        rootDir,
        sshConfigWriter: new DaytonaSshConfigWriter({ xumHome: rootDir, sshConfigPath }),
        fetch: ((input: string | URL | Request, init?: RequestInit) => {
          const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
          // GET /config is public: both accounts share one deployment.
          return (planes.get(auth) ?? planes.get("Bearer key-a"))!.fetch(input, init);
        }) as typeof fetch,
        now: () => clock,
      });
    const desktop = backend();
    const server = backend();
    const tokenOf = async (sandboxId: string): Promise<string> => {
      const tokens = await new DaytonaSshConfigWriter({
        xumHome: rootDir,
        sshConfigPath,
      }).readTokens();
      const token = tokens.find((entry) => entry.sandboxId === sandboxId)?.token;
      if (token === undefined) throw new Error(`No include block for ${sandboxId}`);
      return token;
    };
    await desktop.ensureSshAccess("sb-1");
    await desktop.ensureSshAccess("sb-3");
    await tokenOf("sb-3");

    await server.setConfig({ apiKey: "key-b" });
    await server.ensureSshAccess("sb-1");
    await server.ensureSshAccess("sb-2");
    const serverTokens: Record<string, string> = {
      "sb-1": await tokenOf("sb-1"),
      "sb-2": await tokenOf("sb-2"),
    };

    // A status probe is enough for the desktop to notice.
    await desktop.getSandboxState("sb-2");

    const remaining = await new DaytonaSshConfigWriter({
      xumHome: rootDir,
      sshConfigPath,
    }).readTokens();
    expect(Object.fromEntries(remaining.map((entry) => [entry.sandboxId, entry.token]))).toEqual(
      serverTokens
    );
  });
});
