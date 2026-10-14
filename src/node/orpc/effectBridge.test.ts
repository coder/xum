/**
 * Pins the `@orpc/experimental-effect` bridge behaviors that the production
 * router's `handlerGen` handlers rely on (router.ts): service injection through
 * the oRPC context's "effect/context" key, Effect Schema input validation,
 * Schema.TaggedError → defined oRPC error propagation, abort-driven fiber
 * interruption with scope finalizers, router-level auth middleware over Effect
 * handlers, and OpenAPI generation for Effect Schema inputs.
 *
 * The probe procedures below live in this test file on purpose: they are never
 * mounted on the production router, so keeping them out of production code
 * avoids shipping a test-only module.
 *
 * - `pinnedCount`: Effect service injection via the oRPC context's
 *   `"effect/context"` key + an Effect `Schema` input schema coexisting with
 *   Zod outputs in the same procedure.
 * - `setPinned`: `Schema.TaggedError` failures surfaced as *defined* oRPC
 *   errors (`.errors()` map) without any untyped catch block.
 * - `scopedHold`: scoped resource acquisition whose finalizers must run when
 *   the client aborts the request (AbortSignal → fiber interruption).
 *
 * `handlerGen` is used directly instead of the `.effect()` builder extension:
 * the extension patches `Builder.prototype` globally via a side-effect import,
 * while `handlerGen` is a plain function wrapper with zero global footprint.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ORPCError, createRouterClient, os as orpcBase } from "@orpc/server";
import { handlerGen, toStandardSchema } from "@orpc/experimental-effect";
import { Context, Effect, Schema } from "effect";
import { z } from "zod";
import { createAuthMiddleware } from "./authMiddleware";
import { createOpenAPIGenerator } from "./server";
import { MemoryMeta } from "@/node/services/di/tags";
import { MemoryMetaService } from "@/node/services/memoryMeta";
import type { ORPCContext } from "./context";

const t = orpcBase.$context<ORPCContext>();

/**
 * Observable side-channel for tests: proves that scope finalizers run exactly
 * once, including when the handler fiber is interrupted by a client abort.
 */
const scopeProbe = {
  acquired: 0,
  released: 0,
  reset(): void {
    this.acquired = 0;
    this.released = 0;
  },
};

const effectBridge = {
  /** Count pinned memory keys matching a prefix (service via Effect context). */
  pinnedCount: t
    .input(toStandardSchema(Schema.Struct({ prefix: Schema.String })))
    .output(z.object({ count: z.number() }))
    .handler(
      handlerGen(function* (_opts, input) {
        // Service resolution: the tag is itself an Effect; `handlerGen`
        // provides the "effect/context" services to everything yielded here.
        const memoryMeta = yield* MemoryMeta;
        const keys = yield* memoryMeta.effects.getPinnedKeys();
        let count = 0;
        for (const key of keys) if (key.startsWith(input.prefix)) count += 1;
        return { count };
      })
    ),

  /**
   * Pin/unpin by raw logical key. Demonstrates the typed error path:
   * MemoryMetaWriteError (Schema.TaggedError) → errors.MEMORY_META_WRITE_FAILED
   * (defined oRPC error with schema-validated payload). After `catchTag` the
   * only failure left in the E channel is the ORPCError itself.
   */
  setPinned: t
    .input(z.object({ logicalKey: z.string(), pinned: z.boolean() }))
    .errors({
      MEMORY_META_WRITE_FAILED: {
        message: "Failed to persist memory pin state",
        data: z.object({ metaPath: z.string(), reason: z.string() }),
      },
    })
    .output(z.object({ ok: z.literal(true) }))
    .handler(
      handlerGen(function* ({ errors }, input) {
        const memoryMeta = yield* MemoryMeta;
        yield* memoryMeta.effects.setPinned(input.logicalKey, input.pinned).pipe(
          Effect.catchTag("MemoryMetaWriteError", (error) =>
            Effect.fail(
              errors.MEMORY_META_WRITE_FAILED({
                data: { metaPath: error.metaPath, reason: error.reason },
              })
            )
          )
        );
        return { ok: true as const };
      })
    ),

  /**
   * Hold a scoped resource for `holdMs`. When the client aborts, oRPC's
   * AbortSignal interrupts the fiber and the scope's release finalizer must
   * still run (observable via scopeProbe).
   */
  scopedHold: t
    .input(z.object({ holdMs: z.number() }))
    .output(z.object({ held: z.boolean() }))
    .handler(
      handlerGen(function* (_opts, input) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                scopeProbe.acquired += 1;
              }),
              () =>
                Effect.sync(() => {
                  scopeProbe.released += 1;
                })
            );
            yield* Effect.sleep(input.holdMs);
          })
        );
        return { held: true };
      })
    ),

  /** Plain async no-op, used to prove router middleware wraps the namespace. */
  echoAsync: t
    .input(z.object({ n: z.number() }))
    .output(z.object({ n: z.number() }))
    .handler(({ input }) => ({ n: input.n })),
};

let tmpDir: string;
let memoryMetaService: MemoryMetaService;
let client: ReturnType<typeof createClient>;

function makeContext(service: MemoryMetaService): ORPCContext {
  // Bridge probe procedures only consume Effect services; the remaining ~60 context
  // fields are irrelevant here (same partial-context pattern as router.test.ts).
  return {
    "effect/context": Context.make(MemoryMeta, service),
  } as unknown as ORPCContext;
}

function createClient(service: MemoryMetaService) {
  return createRouterClient(effectBridge, { context: makeContext(service) });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "effect-bridge-"));
  memoryMetaService = new MemoryMetaService(tmpDir);
  client = createClient(memoryMetaService);
  scopeProbe.reset();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("effect/context service injection", () => {
  test("handler resolves MemoryMeta service and reads real disk state", async () => {
    await memoryMetaService.setPinned("global:prefs.md", true);
    await memoryMetaService.setPinned("workspace:ws1:notes.md", true);

    const result = await client.pinnedCount({ prefix: "global:" });
    expect(result).toEqual({ count: 1 });
  });

  test("Effect Schema input schema validates like any standard schema", async () => {
    try {
      await client.pinnedCount({ prefix: 42 as unknown as string });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ORPCError);
      expect((error as ORPCError<string, unknown>).code).toBe("BAD_REQUEST");
    }
  });
});

describe("Schema.TaggedError → defined oRPC error", () => {
  test("success path round-trips", async () => {
    const result = await client.setPinned({ logicalKey: "global:a.md", pinned: true });
    expect(result).toEqual({ ok: true });
    expect(await memoryMetaService.getPinnedKeys()).toEqual(new Set(["global:a.md"]));
  });

  test("write failure surfaces as typed error with schema-validated data", async () => {
    // Make the sidecar unwritable: a directory occupies its path, so
    // write-file-atomic's rename step fails deterministically.
    await fs.mkdir(path.join(tmpDir, "memory-meta.json"));

    try {
      await client.setPinned({ logicalKey: "global:a.md", pinned: true });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ORPCError);
      const orpcError = error as ORPCError<string, { metaPath: string; reason: string }>;
      expect(orpcError.code).toBe("MEMORY_META_WRITE_FAILED");
      // `defined: true` = matched the procedure's .errors() map (not a fallback).
      expect(orpcError.defined).toBe(true);
      expect(orpcError.data.metaPath).toContain("memory-meta.json");
      expect(orpcError.data.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("cancellation + resource scoping", () => {
  test("client abort interrupts the fiber and still runs scope finalizers", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();

    const pending = client.scopedHold({ holdMs: 60_000 }, { signal: controller.signal });
    // Swallow the expected rejection so bun's unhandled-rejection detection
    // stays quiet between abort() and the assertion below.
    const settled = pending.then(
      () => ({ rejected: false as const, error: undefined as unknown }),
      (error: unknown) => ({ rejected: true as const, error })
    );

    await waitFor(() => scopeProbe.acquired === 1);
    controller.abort();

    const outcome = await settled;
    expect(outcome.rejected).toBe(true);

    // Interruption must be prompt (not the 60s hold) and release exactly once.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await waitFor(() => scopeProbe.released === 1);
    expect(scopeProbe.acquired).toBe(1);
    expect(scopeProbe.released).toBe(1);
  });

  test("uncancelled hold completes and releases normally", async () => {
    const result = await client.scopedHold({ holdMs: 10 });
    expect(result).toEqual({ held: true });
    expect(scopeProbe.acquired).toBe(1);
    expect(scopeProbe.released).toBe(1);
  });
});

describe("router-level middleware over Effect handlers", () => {
  test("auth middleware applies to handlerGen procedures mounted under it", async () => {
    // The effectBridge namespace is deliberately NOT part of the production router
    // (codex review on #4022); compose it the same way router() composes its
    // procedures to prove middleware still wraps Effect handlers.
    const authedRouter = orpcBase
      .$context<ORPCContext>()
      .use(createAuthMiddleware("secret-token"))
      .router({ effectBridge });
    const unauthedClient = createRouterClient(authedRouter, {
      context: { headers: {} } as unknown as ORPCContext,
    });

    try {
      await unauthedClient.effectBridge.echoAsync({ n: 1 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ORPCError);
      expect((error as ORPCError<string, unknown>).code).toBe("UNAUTHORIZED");
    }
  });
});

describe("OpenAPI generation for Effect Schema inputs", () => {
  test("production converter set emits request bodies for Effect Schema inputs", async () => {
    // Regression (codex P1 on #4022): without EffectSchemaToJsonSchemaConverter
    // the generator silently drops the requestBody for Effect Schema inputs,
    // shipping a lossy spec (fields missing from /api/docs and generated clients).
    const spec = await createOpenAPIGenerator().generate(
      orpcBase.$context<ORPCContext>().router({ effectBridge }),
      { base: { info: { title: "effect-bridge", version: "0" } } }
    );
    const paths = (spec.paths ?? {}) as Record<
      string,
      { post?: { requestBody?: { content?: Record<string, unknown> } } }
    >;
    const operation = paths["/effectBridge/pinnedCount"]?.post;
    expect(operation).toBeDefined();
    const requestSchema = JSON.stringify(operation?.requestBody?.content ?? {});
    expect(requestSchema).toContain('"prefix"');
  });
});
