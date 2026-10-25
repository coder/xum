import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DaytonaCredentialsStore } from "@/node/config/daytonaCredentialsStore";
import { XUM_DAYTONA_SSH_BLOCK_START } from "@/common/constants/daytona";
import { DaytonaSshConfigWriter } from "@/node/runtime/daytonaSshConfig";
import { log } from "@/node/services/log";
import { ScriptedSandboxControlPlane } from "./daytona.testHarness";
import { DaytonaService } from "./daytonaService";
import type { DaytonaSshWriter } from "./daytonaSsh";

describe("DaytonaSsh", () => {
  let rootDir: string;
  let clock: number;
  let plane: ScriptedSandboxControlPlane;
  let service: DaytonaService;
  const sleeps: number[] = [];

  function makeService(
    env: NodeJS.ProcessEnv = { DAYTONA_API_KEY: "k" },
    sshConfigWriter?: DaytonaSshWriter
  ): DaytonaService {
    return new DaytonaService({
      credentialsStore: new DaytonaCredentialsStore(rootDir, env),
      rootDir,
      sshConfigWriter,
      fetch: plane.fetch,
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });
  }

  /** An include file kept as a map from sandbox id to token. */
  function mapWriter(includeFile: Map<string, string>): DaytonaSshWriter {
    const store = (input: { sandboxId: string; token: string }) => {
      includeFile.set(input.sandboxId, input.token);
      return Promise.resolve();
    };
    return {
      writeSandbox: store,
      ensureManagedBlock: () => Promise.resolve(),
      updateToken: store,
      removeSandbox: (sandboxId) => {
        includeFile.delete(sandboxId);
        return Promise.resolve();
      },
      readTokens: () =>
        Promise.resolve([...includeFile].map(([sandboxId, token]) => ({ sandboxId, token }))),
      repointGateway: () => Promise.resolve(),
    };
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

  it("removes the old account's aliases from the include file when the settings change", async () => {
    const includeFile = new Map<string, string>();
    const changing = makeService(undefined, mapWriter(includeFile));
    await changing.ssh.ensureSshAccess("sb-1");
    expect(includeFile.has("sb-1")).toBe(true);

    // A failed revoke would otherwise leave a working old-account token behind the alias.
    await changing.account.setConfig({ apiKey: "k" });
    expect(includeFile.has("sb-1")).toBe(false);
  });

  it("drops a token whose mint was still running when the settings changed", async () => {
    const includeFile = new Map<string, string>();
    const changing = makeService(undefined, mapWriter(includeFile));
    const mintRoute = "POST /sandbox/sb-1/ssh-access";
    let mintStarted!: () => void;
    const started = new Promise<void>((resolve) => (mintStarted = resolve));
    let finishMint!: () => void;
    plane.onRequest.set(mintRoute, () => {
      mintStarted();
      return new Promise<void>((resolve) => (finishMint = resolve));
    });
    const access = changing.ssh.ensureSshAccess("sb-1");
    await started;

    await changing.account.setConfig({ apiKey: "k2" });
    plane.onRequest.delete(mintRoute);
    finishMint();

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(access).rejects.toThrow("settings changed");
    // The token the old key minted is revoked with that key, and no alias holds it.
    expect(includeFile.has("sb-1")).toBe(false);
    expect(plane.revoked).toEqual(["tok1"]);
    expect(plane.authorizedCalls).toContain("DELETE /sandbox/sb-1/ssh-access Bearer k");
    await changing.ssh.ensureSshAccess("sb-1");
    expect(includeFile.get("sb-1")).toBe("tok2");
  });

  it("revokes the tokens an earlier process left in the include file once it replaces them", async () => {
    // The include file, shared by every Xum process (a restart is a new service).
    const includeFile = new Map([["sb-1", "earlier-process-token"]]);
    const writer = mapWriter(includeFile);
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
