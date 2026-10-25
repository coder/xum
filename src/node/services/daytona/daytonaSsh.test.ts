import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DaytonaCredentialsStore } from "@/node/config/daytonaCredentialsStore";
import { XUM_DAYTONA_SSH_BLOCK_START } from "@/common/constants/daytona";
import { DaytonaSshConfigWriter } from "@/node/runtime/daytonaSshConfig";
import { log } from "@/node/services/log";
import { ScriptedSandboxControlPlane } from "./daytona.testHarness";
import { DAYTONA_BUSY_MESSAGE } from "./daytonaAccount";
import { DaytonaService } from "./daytonaService";

describe("DaytonaSsh", () => {
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

  it("reuses an SSH token until it nears expiry, then swaps it before revoking the old one", async () => {
    const first = await service.ssh.getSshToken("sb-1");
    clock += 30 * 60_000;
    expect(await service.ssh.getSshToken("sb-1")).toEqual(first);

    // 50 minutes in, less than 15 minutes remain.
    clock += 20 * 60_000;
    const order: string[] = [];
    const second = await service.ssh.getSshToken("sb-1", {
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
    const [a, b] = await Promise.all([
      service.ssh.getSshToken("sb-1"),
      service.ssh.getSshToken("sb-1"),
    ]);
    expect(a).toEqual(b);
    expect(plane.calls.filter((call) => call === "POST /sandbox/sb-1/ssh-access")).toHaveLength(1);
  });

  it("revokes the SSH tokens it holds when the settings change", async () => {
    const held = await service.ssh.getSshToken("sb-1");
    await service.account.setConfig({ apiKey: "k" });
    expect(plane.revoked).toEqual([held.token]);
    // The next request mints a fresh token instead of reusing the revoked one.
    expect((await service.ssh.getSshToken("sb-1")).token).not.toBe(held.token);
  });

  it("logs a failed revoke without the token or the API key the response echoes", async () => {
    const held = await service.ssh.getSshToken("sb-1");
    plane.revokeEchoesRequest = true;
    const warn = spyOn(log, "warn");
    try {
      await service.account.setConfig({ apiKey: "k" });
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain("Failed to revoke a Daytona SSH token");
      expect(logged).not.toContain(held.token);
      expect(logged).not.toContain("Bearer k");
    } finally {
      warn.mockRestore();
    }
  });

  /** A service whose first token mint waits until `releaseMint`. */
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
    const store = (input: { token: string }) => {
      written.push(input.token);
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
        restoreGatewayPins: () => Promise.resolve(false),
        updateToken: store,
        repointGateway: () => Promise.resolve(),
        removeSandbox: () => Promise.resolve(),
        readTokens: () => Promise.resolve([]),
      },
    });
    return { service: heldService, started, releaseMint, written };
  }

  it("refuses a settings change while a token is minted, and takes it afterwards", async () => {
    const held = serviceWithHeldMint();

    const access = held.service.ssh.ensureSshAccess("sb-1");
    await held.started;
    const refusal = await held.service.account.setConfig({ apiKey: "k" }).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(String(refusal)).toContain(DAYTONA_BUSY_MESSAGE);
    held.releaseMint();
    await access;

    expect(held.written).toEqual(["tok1"]);
    expect((await held.service.account.setConfig({ apiKey: "k" })).apiKeySource).toBe("settings");
    // The change revokes the old settings' token.
    expect(plane.revoked).toEqual(["tok1"]);
  });

  /** A service whose ssh setup writes are recorded as `token@host keys`. */
  function serviceRecordingWrites(fetchImpl: typeof fetch = plane.fetch) {
    const writes: string[] = [];
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
        restoreGatewayPins: () => Promise.resolve(false),
        updateToken: record,
        removeSandbox: (sandboxId) => {
          includeFile.delete(sandboxId);
          return Promise.resolve();
        },
        repointGateway: () => Promise.resolve(),

        readTokens: () =>
          Promise.resolve([...includeFile].map(([sandboxId, token]) => ({ sandboxId, token }))),
      },
    });
    return { service: recording, writes };
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

    const access = racing.ssh.ensureSshAccess("sb-1");
    await fetched;
    const refusal = await racing.account.setConfig({ apiKey: "k" }).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(String(refusal)).toContain(DAYTONA_BUSY_MESSAGE);
    releaseGateway();
    await access;

    expect(writes).toEqual(["tok1@ssh.test ssh-ed25519 AAAA"]);
  });

  it("rewrites a sandbox's ssh setup once Daytona moves its gateway keys", async () => {
    const { service: watching, writes } = serviceRecordingWrites();
    const configFetches = () => plane.calls.filter((call) => call === "GET /config").length;

    await watching.ssh.ensureSshAccess("sb-1");
    clock += 4 * 60_000;
    await watching.ssh.ensureSshAccess("sb-1");
    expect(configFetches()).toBe(1);

    // Rotated (and listed in another order) while Xum runs.
    plane.gatewayHostKeys = ["ssh-rsa CCCC", "ssh-ed25519 BBBB"];
    clock += 2 * 60_000;
    await watching.ssh.ensureSshAccess("sb-1");
    expect(writes).toEqual([
      "tok1@ssh.test ssh-ed25519 AAAA",
      "tok2@ssh.test ssh-rsa CCCC,ssh-ed25519 BBBB",
    ]);
    expect(plane.revoked).toEqual(["tok1"]);

    // A refetch that finds the same gateway, keys reordered, rewrites nothing.
    plane.gatewayHostKeys = ["ssh-ed25519 BBBB", "ssh-rsa CCCC"];
    clock += 6 * 60_000;
    await watching.ssh.ensureSshAccess("sb-1");
    expect(configFetches()).toBe(3);
    expect(writes).toHaveLength(2);
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
    const { service: watching } = serviceRecordingWrites(fetchImpl);
    await watching.ssh.ensureSshAccess("sb-1");

    clock += 6 * 60_000;
    holdConfig = true;
    const lookups = Promise.all([watching.ssh.getGatewayConfig(), watching.ssh.getGatewayConfig()]);
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
    expect((await watching.ssh.getGatewayConfig()).sshGatewayHostKeys).toEqual(["ssh-ed25519 NEW"]);
  });

  it("removes the old account's aliases from the include file when the settings change", async () => {
    const includeFile = new Map<string, string>();
    const store = (input: { sandboxId: string; token: string }) => {
      includeFile.set(input.sandboxId, input.token);
      return Promise.resolve();
    };
    const changing = new DaytonaService({
      credentialsStore: new DaytonaCredentialsStore(rootDir, { DAYTONA_API_KEY: "k" }),
      rootDir,
      fetch: plane.fetch,
      now: () => clock,
      sshConfigWriter: {
        writeSandbox: store,
        ensureManagedBlock: () => Promise.resolve(),
        restoreGatewayPins: () => Promise.resolve(false),
        updateToken: store,
        removeSandbox: (sandboxId) => {
          includeFile.delete(sandboxId);
          return Promise.resolve();
        },
        readTokens: () => Promise.resolve([]),
        repointGateway: () => Promise.resolve(),
      },
    });
    await changing.ssh.ensureSshAccess("sb-1");
    expect(includeFile.has("sb-1")).toBe(true);

    // A failed revoke would otherwise leave a working old-account token behind the alias.
    await changing.account.setConfig({ apiKey: "k" });
    expect(includeFile.has("sb-1")).toBe(false);
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
      restoreGatewayPins: () => Promise.resolve(false),
      updateToken: store,
      removeSandbox: () => Promise.resolve(),

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
      await started.ssh.loadPersistedTokens();
      return started;
    };

    // The file has no expiry, so the first ssh access replaces the loaded token.
    await (await startProcess()).ssh.ensureSshAccess("sb-1");
    const minted = includeFile.get("sb-1");
    expect(minted).not.toBe("earlier-process-token");
    expect(plane.revoked).toEqual(["earlier-process-token"]);

    // After another restart, a settings change revokes what it loaded.
    await (await startProcess()).account.setConfig({ apiKey: "k" });
    expect(plane.revoked).toEqual(["earlier-process-token", minted ?? ""]);
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
    await service.ssh.ensureSshAccess("sb-1");
    expect(await fs.readFile(sshConfigPath, "utf8")).toContain(XUM_DAYTONA_SSH_BLOCK_START);
    // A dotfiles tool replaces the file: the include file and the cached token stay.
    await fs.writeFile(sshConfigPath, "Host work\n  User me\n", "utf8");

    await service.ssh.ensureSshAccess("sb-1");

    const restored = await fs.readFile(sshConfigPath, "utf8");
    expect(restored.startsWith(XUM_DAYTONA_SSH_BLOCK_START)).toBe(true);
    expect(restored).toContain("Host work\n  User me\n");
    expect(plane.calls.filter((call) => call === "POST /sandbox/sb-1/ssh-access")).toHaveLength(1);
  });
});
