import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DaytonaCredentialsStore } from "@/node/config/daytonaCredentialsStore";
import { DaytonaApiError } from "./daytonaClient";
import {
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
  readonly calls: string[] = [];
  private tokenCounter = 0;
  readonly revoked: string[] = [];

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
      return json(200, { sshGatewayHost: "ssh.test", sshGatewayHostKeys: ["ssh-ed25519 AAAA"] });
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

  it("reuses one token while the user fixes an ssh config that shadows it", async () => {
    let shadowed = true;
    const writer = {
      writeSandbox: () => Promise.resolve(),
      updateToken: () => Promise.resolve(),
      removeSandbox: () => Promise.resolve(),
      readTokens: () => Promise.resolve([]),
      verifyResolvedConfig: () =>
        shadowed ? Promise.reject(new Error("ssh config shadows User")) : Promise.resolve(),
    };
    const withWriter = new DaytonaService({
      credentialsStore: new DaytonaCredentialsStore(rootDir, { DAYTONA_API_KEY: "k" }),
      rootDir,
      fetch: plane.fetch,
      now: () => clock,
      sshConfigWriter: writer,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await withWriter.ensureSshAccess("sb-1").catch((e: unknown) => e)).toBeInstanceOf(
        Error
      );
    }
    shadowed = false;
    await withWriter.ensureSshAccess("sb-1");
    expect(plane.calls.filter((call) => call === "POST /sandbox/sb-1/ssh-access")).toHaveLength(1);
    expect(plane.revoked).toEqual([]);
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
      updateToken: store,
      removeSandbox: () => Promise.resolve(),
      readTokens: () =>
        Promise.resolve([...includeFile].map(([sandboxId, token]) => ({ sandboxId, token }))),
      verifyResolvedConfig: () => Promise.resolve(),
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
});
