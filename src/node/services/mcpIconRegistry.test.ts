import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { MCP_ICON_LIMITS } from "@/common/constants/mcpIcon";
import { MCP_IDENTITY_LIMITS } from "@/common/constants/mcpIdentity";
import type { MCPConnectionRef } from "@/common/types/mcp";
import type { IconCandidate } from "./mcpServerIdentity";
import { MCPIconRegistry } from "./mcpIconRegistry";

const binding: MCPConnectionRef = { key: "fixture", transport: "stdio" };
const candidates = [{ src: "data:image/png;base64,AA==" }];
const png = (color: string) =>
  sharp({ create: { width: 1, height: 1, channels: 4, background: color } })
    .png()
    .toBuffer()
    .then((bytes) => `data:image/png;base64,${bytes.toString("base64")}`);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("immutable MCP icon registry", () => {
  test("registers pending before publish, coalesces within one owner, and awaits resolution", async () => {
    const pending = deferred<string | null>();
    let calls = 0;
    const registry = new MCPIconRegistry(() => {
      calls++;
      return pending.promise;
    });
    const owner = {};
    const ref = registry.ensure(owner, candidates, binding)!;
    expect(ref).toMatch(/^[a-f0-9]{32}$/);
    expect(registry.ensure(owner, [...candidates], { ...binding })).toBe(ref);
    let settled = false;
    const lookup = registry.get(ref).then((icon) => {
      settled = true;
      return icon;
    });
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(settled).toBe(false);
    const red = await png("red");
    pending.resolve(red);
    expect(await lookup).toBe(red);
    expect(registry.ensure(owner, candidates, binding)).toBe(ref);
    expect(await registry.get(ref)).toBe(red);
    expect(calls).toBe(1);
  });

  test("new generations cannot relabel historical refs, including late completions", async () => {
    const old = deferred<string | null>();
    const red = await png("red");
    const blue = await png("blue");
    let calls = 0;
    const registry = new MCPIconRegistry(() =>
      ++calls === 1 ? old.promise : Promise.resolve(blue)
    );
    const oldRef = registry.ensure({}, candidates, binding)!;
    const newRef = registry.ensure({}, candidates, binding)!;
    expect(newRef).not.toBe(oldRef);
    expect(await registry.get(newRef)).toBe(blue);
    old.resolve(red);
    expect(await registry.get(oldRef)).toBe(red);
    expect(await registry.get(newRef)).toBe(blue);
  });

  test("negative-caches failures and rejects non-PNG resolver output without refetching on lookup", async () => {
    let calls = 0;
    const registry = new MCPIconRegistry(() => {
      calls++;
      return calls === 1
        ? Promise.reject(new Error("decode unavailable"))
        : Promise.resolve("https://example.com/icon.png");
    });
    expect(registry.ensure({}, [], binding)).toBeUndefined();
    expect(await registry.get("0".repeat(32))).toBeNull();
    expect(calls).toBe(0);
    const owner = {};
    const ref = registry.ensure(owner, candidates, binding)!;
    expect(await registry.get(ref)).toBeNull();
    expect(registry.ensure(owner, candidates, binding)).toBe(ref);
    expect(await registry.get(ref)).toBeNull();
    expect(calls).toBe(1);
    expect(await registry.get(registry.ensure({}, candidates, binding)!)).toBeNull();
    expect(calls).toBe(2);
  });

  test("copies resolver inputs and hashes both candidates and their transport binding", async () => {
    let received: { candidates: readonly IconCandidate[]; binding: MCPConnectionRef } | undefined;
    const registry = new MCPIconRegistry((value, connection) => {
      received = { candidates: value, binding: connection };
      return Promise.resolve(null);
    });
    const input = [{ src: candidates[0].src, sizes: ["32x32"] }];
    const connection = { ...binding };
    const owner = {};
    const ref = registry.ensure(owner, input, connection)!;
    input[0].src = "https://changed.example/icon.png";
    input[0].sizes[0] = "128x128";
    connection.key = "changed";
    await registry.get(ref);
    expect(received?.candidates).toEqual([{ src: candidates[0].src, sizes: ["32x32"] }]);
    expect(received?.binding).toEqual(binding);
    expect(
      registry.ensure(owner, candidates, {
        ...binding,
        origin: "https://example.com",
        transport: "http",
      })
    ).not.toBe(ref);
  });

  test("uses distinct success/failure TTLs and never resurrects expired refs", async () => {
    const red = await png("red");
    let now = 0;
    const registry = new MCPIconRegistry(
      (input) => Promise.resolve(input[0].src === "fail" ? null : red),
      () => now
    );
    const owner = {};
    const success = registry.ensure(owner, candidates, binding)!;
    const failure = registry.ensure(owner, [{ src: "fail" }], binding)!;
    await registry.get(success);
    await registry.get(failure);
    now += MCP_ICON_LIMITS.failureTtlMs;
    expect(registry.ensure(owner, [{ src: "fail" }], binding)).not.toBe(failure);
    expect(registry.ensure(owner, candidates, binding)).toBe(success);
    now = MCP_ICON_LIMITS.successTtlMs;
    expect(await registry.get(success)).toBeNull();
    const replacement = registry.ensure(owner, candidates, binding)!;
    expect(replacement).not.toBe(success);
    expect(await registry.get(replacement)).toBe(red);
    expect(await registry.get(success)).toBeNull();
  });

  test("caps entries with LRU touches and cannot revive evicted pending work", async () => {
    const pending = deferred<string | null>();
    const red = await png("red");
    let calls = 0;
    const registry = new MCPIconRegistry(() =>
      ++calls === 1 ? pending.promise : Promise.resolve(red)
    );
    const old = registry.ensure({}, candidates, binding)!;
    const waiting = registry.get(old);
    const recent = registry.ensure({}, candidates, binding)!;
    await registry.get(recent);
    for (let i = 0; i < MCP_ICON_LIMITS.registryMaxEntries; i++) {
      await registry.get(registry.ensure({}, candidates, binding)!);
      await registry.get(recent);
    }
    pending.resolve(red);
    expect(await waiting).toBeNull();
    expect(await registry.get(old)).toBeNull();
    expect(await registry.get(recent)).toBe(red);
  });

  test("an expired pending ref cannot replace the same owner's newer resolution", async () => {
    const pending = deferred<string | null>();
    const red = await png("red");
    const blue = await png("blue");
    let calls = 0;
    let now = 0;
    const registry = new MCPIconRegistry(
      () => (++calls === 1 ? pending.promise : Promise.resolve(blue)),
      () => now
    );
    const owner = {};
    const old = registry.ensure(owner, candidates, binding)!;
    const waiting = registry.get(old);
    await Promise.resolve();
    now += MCP_ICON_LIMITS.deadlineMs;
    expect(await registry.get(old)).toBeNull();
    const replacement = registry.ensure(owner, candidates, binding)!;
    expect(replacement).not.toBe(old);
    expect(await registry.get(replacement)).toBe(blue);
    pending.resolve(red);
    expect(await waiting).toBeNull();
    expect(registry.ensure(owner, candidates, binding)).toBe(replacement);
    expect(await registry.get(replacement)).toBe(blue);
  });

  test("caps cached image bytes independently of the entry limit", async () => {
    const pixels = Buffer.from(
      Array.from({ length: 64 * 64 * 4 }, (_, i) => ((i * 131 + (i >> 2) * 31) ^ (i >> 8)) & 255)
    );
    const bytes = await sharp(pixels, { raw: { width: 64, height: 64, channels: 4 } })
      .png({ compressionLevel: 0 })
      .toBuffer();
    const icon = `data:image/png;base64,${bytes.toString("base64")}`;
    const registry = new MCPIconRegistry(() => Promise.resolve(icon));
    const first = registry.ensure({}, candidates, binding)!;
    await registry.get(first);
    const count = Math.ceil(MCP_ICON_LIMITS.registryMaxBytes / icon.length) + 1;
    expect(count).toBeLessThan(MCP_ICON_LIMITS.registryMaxEntries);
    let last = first;
    for (let i = 0; i < count; i++) {
      last = registry.ensure({}, candidates, binding)!;
      expect(await registry.get(last)).toBe(icon);
    }
    expect(await registry.get(first)).toBeNull();
    expect(await registry.get(last)).toBe(icon);
  });

  test("refuses an over-budget candidate set before copying, serializing, or hashing it", async () => {
    let calls = 0;
    const registry = new MCPIconRegistry(() => {
      calls++;
      return Promise.resolve(null);
    });
    // One candidate at the single-source limit; the aggregate budget equals that limit.
    const src = `data:image/png;base64,${"A".repeat(MCP_IDENTITY_LIMITS.iconDataSrcMaxChars - 22)}`;
    expect(src.length).toBeLessThanOrEqual(MCP_ICON_LIMITS.candidateSrcTotalMaxChars);
    const reads: Array<Array<string | symbol>> = [];
    const enumerated: number[] = [];
    const candidates = Array.from({ length: MCP_IDENTITY_LIMITS.iconCandidatesMax }, (_, i) => {
      const keys: Array<string | symbol> = [];
      reads.push(keys);
      return new Proxy<IconCandidate>(
        { src, mimeType: "image/png", sizes: ["64x64"] },
        {
          get: (target, key): unknown => {
            keys.push(key);
            return Reflect.get(target, key);
          },
          ownKeys: (target) => {
            enumerated.push(i);
            return Reflect.ownKeys(target);
          },
        }
      );
    });
    expect(registry.ensure({}, candidates, binding)).toBeUndefined();
    await Promise.resolve();
    expect(calls).toBe(0);
    // Admission summed `src` lengths and stopped at the first overflow: nothing
    // was spread (no ownKeys) or serialized (no other field read), and the
    // remaining candidates were never touched.
    expect(enumerated).toEqual([]);
    expect(reads).toEqual([["src"], ["src"], [], [], [], [], [], []]);

    // The same single maximum-size source is still admitted and resolved.
    const ref = registry.ensure({}, [{ src }], binding);
    expect(ref).toMatch(/^[a-f0-9]{32}$/);
    await Promise.resolve();
    expect(calls).toBe(1);
  });
});
