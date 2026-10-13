/**
 * The Anthropic cache wrapper records, per DevTools step, the facts the runtime prompt-cache
 * monitor keys and filters on (route, markers, dispatch outcome, observation time), so the
 * replay audit can apply the same rules to the recorded steps.
 */
import { describe, expect, it } from "bun:test";

import {
  closeCapturedRequestBody,
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
  signal?: AbortSignal;
  observeFinalBody?: () => void;
}): Promise<void> {
  const wrapped = wrapFetchWithAnthropicCacheControl(
    (() => params.respond()) as unknown as typeof fetch,
    "1h",
    {
      injectCacheControl: params.injectCacheControl ?? true,
      routeIdentity: "routeIdentity" in params ? params.routeIdentity : ROUTE,
      observeFinalBody: params.observeFinalBody,
    }
  );
  await wrapped("https://gateway.example/v1/messages?beta=true", {
    method: "POST",
    headers: params.stepId != null ? { [DEVTOOLS_STEP_ID_HEADER]: params.stepId } : {},
    body: BODY,
    signal: params.signal,
  }).catch(() => undefined);
}

describe("wrapFetchWithAnthropicCacheControl — DevTools prompt-cache wire facts", () => {
  it("records the route and the time an OK response arrived", async () => {
    const before = Date.now();
    await send({ stepId: "step-ok", respond: () => Promise.resolve(new Response("{}")) });
    const wire = consumePromptCacheWire("step-ok");
    expect(wire).toMatchObject({ ...ROUTE, cacheMarkersInjected: true, dispatched: true });
    // The endpoint is origin plus path; the query reaches it only as a hash (see requestEndpoint).
    expect(wire?.endpoint).toStartWith("https://gateway.example/v1/messages?sha256:");
    expect(wire?.endpoint).not.toContain("beta");
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
    const wire = consumePromptCacheWire("step-529");
    expect(wire?.endpoint).toMatch(/^https:\/\/gateway\.example\/v1\/messages\?sha256:/);
    expect({ ...wire, endpoint: undefined }).toEqual({
      ...ROUTE,
      endpoint: undefined,
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

  it("keeps facts recorded before an abort and rejects attempts after it", async () => {
    await send({ stepId: "step-abort", respond: () => Promise.resolve(new Response("{}")) });
    // Abort cleanup before the provider call settled: the OK response was already observed.
    closeCapturedRequestBody("step-abort");
    // A fetch that ignored the abort reaches the wrapper later: it must not be recorded, or
    // nothing would consume it (the abort's finalization already ran).
    await send({ stepId: "step-abort", respond: () => Promise.reject(new Error("late")) });
    expect(consumePromptCacheWire("step-abort")).toMatchObject({ dispatched: true });
    await send({ stepId: "step-abort", respond: () => Promise.resolve(new Response("{}")) });
    expect(consumePromptCacheWire("step-abort")).toBeUndefined();
  });

  it("does not observe an OK response that arrives after the request's abort", async () => {
    // A fetch that ignored the cancellation returns 2xx after the turn closed the step: the
    // audit gets no wire record, so the runtime monitor must not move its baseline either.
    const abort = new AbortController();
    const observed: string[] = [];
    await send({
      stepId: "step-late-ok",
      signal: abort.signal,
      observeFinalBody: () => observed.push("late"),
      respond: () => {
        abort.abort();
        closeCapturedRequestBody("step-late-ok");
        return Promise.resolve(new Response("{}"));
      },
    });
    expect(observed).toEqual([]);
    expect(consumePromptCacheWire("step-late-ok")).toBeUndefined();
    // Control: the same OK response without an abort is observed.
    await send({
      stepId: "step-in-time",
      signal: new AbortController().signal,
      observeFinalBody: () => observed.push("in time"),
      respond: () => Promise.resolve(new Response("{}")),
    });
    expect(observed).toEqual(["in time"]);
  });

  it("numbers observations so same-millisecond responses keep their order", async () => {
    await send({ stepId: "step-first", respond: () => Promise.resolve(new Response("{}")) });
    await send({ stepId: "step-second", respond: () => Promise.resolve(new Response("{}")) });
    const first = consumePromptCacheWire("step-first")?.observedSeq;
    const second = consumePromptCacheWire("step-second")?.observedSeq;
    expect(first).toBeNumber();
    expect(second).toBeGreaterThan(first ?? Infinity);
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
