import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { BASH_AI_PROXY_STATE_FILE, ProxyStateStore } from "./proxyState";

describe("ProxyStateStore", () => {
  let rootDir: string;
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-ai-proxy-state-"));
  });
  afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  test("state persists across instances, owner-only", async () => {
    const first = new ProxyStateStore(rootDir);
    const { secret } = await first.load();
    await first.update((state) => {
      state.port = 21234;
      state.forwards["host-a"] = { remotePort: 25000, workspaceId: "ws-1", usedAt: 1 };
    });

    const reloaded = await new ProxyStateStore(rootDir).load();
    expect(reloaded).toEqual({
      version: 1,
      secret,
      port: 21234,
      forwards: { "host-a": { remotePort: 25000, workspaceId: "ws-1", usedAt: 1 } },
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

  test("a malformed file heals to a fresh secret instead of failing", async () => {
    const { secret } = await new ProxyStateStore(rootDir).load();
    await fsp.writeFile(path.join(rootDir, BASH_AI_PROXY_STATE_FILE), '{"version":1,"secret":"x"}');
    const healed = await new ProxyStateStore(rootDir).load();
    expect(healed.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(healed.secret).not.toBe(secret);
    expect((await new ProxyStateStore(rootDir).load()).secret).toBe(healed.secret);
  });
});
