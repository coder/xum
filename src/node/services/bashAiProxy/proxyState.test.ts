import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as atomicWrite from "@/node/utils/writeFileAtomic";

import { BASH_AI_PROXY_STATE_FILE, ProxyStateStore } from "./proxyState";

describe("ProxyStateStore", () => {
  let rootDir: string;
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-ai-proxy-state-"));
  });
  afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  test("a read error other than a missing file keeps the saved secret", async () => {
    const { secret } = await new ProxyStateStore(rootDir).load();
    const eio = Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    const readFile = spyOn(fsp, "readFile").mockRejectedValueOnce(eio);
    const store = new ProxyStateStore(rootDir);
    try {
      const failure: unknown = await store.load().then(
        () => undefined,
        (error: unknown) => error
      );
      expect(failure).toBe(eio);
    } finally {
      readFile.mockRestore();
    }
    // The failed load wrote nothing, and the next load reads the original secret.
    expect((await store.load()).secret).toBe(secret);
  });

  test("state persists across instances, owner-only", async () => {
    const first = new ProxyStateStore(rootDir);
    const { secret } = await first.load();
    await first.update((state) => {
      state.port = 21234;
      state.forwards["host-a"] = { remotePort: 25000, workspaceIds: ["ws-1"], usedAt: 1 };
    });

    const reloaded = await new ProxyStateStore(rootDir).load();
    expect(reloaded).toEqual({
      version: 1,
      secret,
      port: 21234,
      forwards: { "host-a": { remotePort: 25000, workspaceIds: ["ws-1"], usedAt: 1 } },
    });
    const file = path.join(rootDir, BASH_AI_PROXY_STATE_FILE);
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
  });

  test("two backends starting together keep the port that was saved first", async () => {
    // Both start without a saved port and bind different candidates.
    const a = new ProxyStateStore(rootDir);
    const b = new ProxyStateStore(rootDir);
    await a.load();
    await b.load();
    await a.claimPort(21001);
    await b.claimPort(21002);
    expect((await new ProxyStateStore(rootDir).load()).port).toBe(21001);
  });

  test("backends that find a malformed file together adopt one new secret", async () => {
    const file = path.join(rootDir, BASH_AI_PROXY_STATE_FILE);
    await fsp.writeFile(file, "{not json");
    const loaded = await Promise.all(
      Array.from({ length: 4 }, () => new ProxyStateStore(rootDir).load())
    );
    const secrets = new Set(loaded.map((state) => state.secret));
    expect(secrets.size).toBe(1);
    expect((await new ProxyStateStore(rootDir).load()).secret).toBe([...secrets][0]);
  });

  test("a bad port is dropped, but the secret and its keys stay", async () => {
    const { secret } = await new ProxyStateStore(rootDir).load();
    const file = path.join(rootDir, BASH_AI_PROXY_STATE_FILE);
    await fsp.writeFile(file, JSON.stringify({ version: 1, secret, port: "21234" }));
    const healed = await new ProxyStateStore(rootDir).load();
    expect(healed).toEqual({ version: 1, secret, forwards: {} });
  });

  test("backends on one root keep each other's forwards", async () => {
    const a = new ProxyStateStore(rootDir);
    const b = new ProxyStateStore(rootDir);
    await a.load();
    await b.load(); // both hold a snapshot without forwards
    await a.update((state) => {
      state.forwards["host-a"] = { remotePort: 25000, workspaceIds: ["ws-a"], usedAt: 1 };
    });
    await b.update((state) => {
      state.forwards["host-b"] = { remotePort: 25001, workspaceIds: ["ws-b"], usedAt: 2 };
    });
    const { forwards } = await new ProxyStateStore(rootDir).load();
    expect(Object.keys(forwards).sort()).toEqual(["host-a", "host-b"]);
  });

  test("a bad forward entry is dropped, the others stay", async () => {
    const { secret } = await new ProxyStateStore(rootDir).load();
    const good = { remotePort: 25000, workspaceIds: ["ws-1"], usedAt: 1 };
    await fsp.writeFile(
      path.join(rootDir, BASH_AI_PROXY_STATE_FILE),
      JSON.stringify({ version: 1, secret, forwards: { good, bad: { remotePort: "x" } } })
    );
    expect(await new ProxyStateStore(rootDir).load()).toEqual({
      version: 1,
      secret,
      forwards: { good },
    });
  });

  test("state is written with the durable writer, owner-only", async () => {
    // writeFileAtomic fsyncs the file and its directory: keys are handed out right after.
    const spy = spyOn(atomicWrite, "default");
    try {
      await new ProxyStateStore(rootDir).load();
      expect(spy).toHaveBeenCalledWith(
        path.join(rootDir, BASH_AI_PROXY_STATE_FILE),
        expect.any(String),
        { mode: 0o600 }
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("a malformed file heals to a fresh secret instead of failing", async () => {
    const { secret } = await new ProxyStateStore(rootDir).load();
    await fsp.writeFile(path.join(rootDir, BASH_AI_PROXY_STATE_FILE), '{"version":1,"secret":"x"}');
    const healed = await new ProxyStateStore(rootDir).load();
    expect(healed.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(healed.secret).not.toBe(secret);
    expect((await new ProxyStateStore(rootDir).load()).secret).toBe(healed.secret);
  });
});
