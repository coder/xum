import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { Config } from "@/node/config";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
import { WorkspaceMcpOverridesService } from "./workspaceMcpOverridesService";

/** Test mirror of the service's private PUBLICATION_TIMEOUT_MS (the plugin-prune budget). */
const PRUNE_BUDGET_MIRROR_MS = 30_000;

/**
 * The task-checkout preparation CLAIM (a durable nonce write into the fresh checkout's git admin
 * dir) runs inside prunePluginOverrideKeysForUnregisteredCheckout's held locks, BEFORE the prune.
 * Unlike the read-only sibling verdict (`shouldPrune`, which a deadline may leave detached), a
 * claim the deadline abandons must land (or fail) BEFORE the locks release: a late nonce write
 * landing after the locks were released could stamp a directory a successor owns by then.
 */
describe("WorkspaceMcpOverridesService: the preparation claim is joined before the locks release", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-mcp-claim-join-"));
    config = new Config(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** The checkout-lock keys one operation acquired, in acquisition order. */
  function recordCheckoutLockKeys(service: WorkspaceMcpOverridesService): string[] {
    const internals = service as unknown as {
      acquireCheckoutLock: (key: string, timeoutMs?: number) => Promise<() => Promise<void>>;
    };
    const real = internals.acquireCheckoutLock.bind(service);
    const keys: string[] = [];
    spyOn(internals, "acquireCheckoutLock").mockImplementation((key, timeoutMs) => {
      keys.push(key);
      return real(key, timeoutMs);
    });
    return keys;
  }

  it("a deadline that fires while the claim is in flight keeps the locks until the claim settles, and never launches the prune", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    const workspacePath = path.join(config.srcDir, "unregistered", "in-flight-claim");
    const filePath = path.join(workspacePath, ".xum", "mcp.local.jsonc");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const original = JSON.stringify({ enabledServers: ["plugin:0123456789abcdef:evil"] });
    await fs.writeFile(filePath, original, "utf-8");
    const target = {
      workspacePath,
      runtimeConfig: { type: "worktree" as const, srcBaseDir: config.srcDir },
    };
    const keys = recordCheckoutLockKeys(service);
    const internals = service as unknown as { pruneResolvedWorkspace: () => Promise<unknown> };
    const pruneSpy = spyOn(internals, "pruneResolvedWorkspace");
    const realNow = Date.now.bind(Date);
    let clockOffsetMs = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + clockOffsetMs);
    // The claim's write is held open by the test; the budget is consumed while it is pending
    // (the still-ticking clock jumps past the deadline), so the deadline provably fires with the
    // claim in flight.
    const gate = Promise.withResolvers<void>();
    let claimStarted = false;
    let claimSettled = false;
    let verdicts = 0;
    try {
      let settled: "resolved" | "rejected" | undefined;
      const pruning = service
        .prunePluginOverrideKeysForUnregisteredCheckout(target, "plugin:", {
          shouldPrune: () => {
            verdicts += 1;
            return Promise.resolve(true);
          },
          claimUnderLock: async () => {
            claimStarted = true;
            clockOffsetMs = PRUNE_BUDGET_MIRROR_MS + 1_000;
            await gate.promise;
            claimSettled = true;
          },
        })
        .then(
          () => {
            settled = "resolved";
          },
          (error: unknown) => {
            settled = "rejected";
            return error;
          }
        );
      const waitUntil = realNow() + 10_000;
      while (!claimStarted) {
        if (realNow() > waitUntil) throw new Error("expected the claim to start under the locks");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // Past the deadline (the timer is real; give it time to fire): nothing settled, every
      // checkout lock this operation took is still held, the prune was never launched.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(claimSettled).toBe(false);
      expect(settled).toBeUndefined();
      expect(verdicts).toBe(1);
      expect(pruneSpy).not.toHaveBeenCalled();
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
        await expect(
          acquireCrossProcessLock({
            lockPath: path.join(config.rootDir, "mcp-overrides-locks", `${key}.lock`),
            acquireTimeoutMs: 200,
            staleMs: 60_000,
            timeoutMessage: "checkout lock still held",
          })
        ).rejects.toThrow("checkout lock still held");
      }
      // Release the claim: the operation settles (rejected by its deadline) and only now do the
      // locks release — after the claim landed. The document was never pruned.
      gate.resolve();
      const error = await pruning;
      expect(settled).toBe("rejected");
      expect(claimSettled).toBe(true);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("exceeded the plugin-prune budget");
      expect(pruneSpy).not.toHaveBeenCalled();
      expect(await fs.readFile(filePath, "utf-8")).toBe(original);
      for (const key of keys) {
        const release = await acquireCrossProcessLock({
          lockPath: path.join(config.rootDir, "mcp-overrides-locks", `${key}.lock`),
          acquireTimeoutMs: 2_000,
          staleMs: 60_000,
          timeoutMessage: "checkout lock not released",
        });
        await release();
      }
    } finally {
      gate.resolve();
      clock.mockRestore();
      pruneSpy.mockRestore();
    }
  }, 20_000);
});
