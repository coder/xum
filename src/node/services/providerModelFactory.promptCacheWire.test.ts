/**
 * The Anthropic cache wrapper records, per DevTools step, the facts the runtime prompt-cache
 * monitor keys and filters on (route, markers, dispatch outcome, observation time), so the
 * replay audit can apply the same rules to the recorded steps.
 */
import { describe, expect, it } from "bun:test";

import {
  consumePromptCacheWire,
  DEVTOOLS_STEP_ID_HEADER,
} from "@/node/services/devToolsHeaderCapture";
import { wrapFetchWithAnthropicCacheControl } from "./providerModelFactory";

const ROUTE = { route: "coder:dogfood", modelString: "coder:dogfood/claude-opus-5-5" };
const BODY = JSON.stringify({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
});

async function send(params: {
  stepId?: string;
  respond: () => Promise<Response>;
  injectCacheControl?: boolean;
  routeIdentity?: typeof ROUTE;
}): Promise<void> {
  const wrapped = wrapFetchWithAnthropicCacheControl(
    (() => params.respond()) as unknown as typeof fetch,
    "1h",
    {
      injectCacheControl: params.injectCacheControl ?? true,
      routeIdentity: "routeIdentity" in params ? params.routeIdentity : ROUTE,
    }
  );
  await wrapped("https://gateway.example/v1/messages", {
    method: "POST",
    headers: params.stepId != null ? { [DEVTOOLS_STEP_ID_HEADER]: params.stepId } : {},
    body: BODY,
  }).catch(() => undefined);
}

describe("wrapFetchWithAnthropicCacheControl — DevTools prompt-cache wire facts", () => {
  it("records the route and the time an OK response arrived", async () => {
    const before = Date.now();
    await send({ stepId: "step-ok", respond: () => Promise.resolve(new Response("{}")) });
    const wire = consumePromptCacheWire("step-ok");
    expect(wire).toMatchObject({ ...ROUTE, cacheMarkersInjected: true, dispatched: true });
    const observedAt = Date.parse(wire?.observedAt ?? "");
    expect(observedAt).toBeGreaterThanOrEqual(before);
    expect(observedAt).toBeLessThanOrEqual(Date.now());
    // Consumed once: the step's finalization owns it.
    expect(consumePromptCacheWire("step-ok")).toBeUndefined();
  });

  it("records an error status as dispatched without an observation", async () => {
    await send({
      stepId: "step-529",
      respond: () => Promise.resolve(new Response("overloaded", { status: 529 })),
    });
    expect(consumePromptCacheWire("step-529")).toEqual({
      ...ROUTE,
      cacheMarkersInjected: true,
      dispatched: true,
    });
  });

  it("records a failed fetch as not dispatched", async () => {
    await send({ stepId: "step-down", respond: () => Promise.reject(new Error("ECONNRESET")) });
    expect(consumePromptCacheWire("step-down")).toMatchObject({ dispatched: false });
  });

  it("keeps the last attempt of a retried step", async () => {
    await send({
      stepId: "step-retry",
      respond: () => Promise.resolve(new Response("busy", { status: 429 })),
    });
    await send({ stepId: "step-retry", respond: () => Promise.resolve(new Response("{}")) });
    expect(consumePromptCacheWire("step-retry")?.observedAt).toBeString();
  });

  it("records stripped cache markers", async () => {
    await send({
      stepId: "step-zdr",
      injectCacheControl: false,
      respond: () => Promise.resolve(new Response("{}")),
    });
    expect(consumePromptCacheWire("step-zdr")).toMatchObject({ cacheMarkersInjected: false });
  });

  it("records nothing without a DevTools step or a route identity", async () => {
    await send({ respond: () => Promise.resolve(new Response("{}")) });
    await send({
      stepId: "step-unrouted",
      routeIdentity: undefined,
      respond: () => Promise.resolve(new Response("{}")),
    });
    expect(consumePromptCacheWire("step-unrouted")).toBeUndefined();
  });
});
