import { describe, expect, test } from "bun:test";
import type { APIClient } from "@/browser/contexts/API";
import type { McpAppView } from "@/common/orpc/schemas/mcpApps";
import {
  mcpAppWidgetStateSeed,
  mcpAppWidgetStateTarget,
  saveMcpAppWidgetState,
} from "./mcpAppWidgetState";

/** A getView result of a view whose result record was created at `binding`. */
function loadedView(binding: number | null, widgetState: unknown = null): McpAppView {
  return {
    html: "<p/>",
    csp: {},
    prefersBorder: null,
    resultAvailable: true,
    result: null,
    widgetState,
    widgetStateBinding: binding,
    invocation: binding === null ? null : { serverName: "srv", toolName: "show", arguments: {} },
  };
}

/** An API whose setWidgetState calls wait until the test settles them. */
function deferredApi() {
  const writes: Array<{ state: unknown; binding: number; settle: (ok: boolean) => void }> = [];
  const api = {
    mcpApps: {
      setWidgetState: (input: { state: unknown; binding: number }) =>
        new Promise((resolve) =>
          writes.push({
            state: input.state,
            binding: input.binding,
            settle: (ok) =>
              resolve(ok ? { success: true, data: {} } : { success: false, error: "refused" }),
          })
        ),
    },
  } as unknown as APIClient;
  return { api, writes };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MCP App widget state", () => {
  test("writes reach the backend in order, and a newer pending write replaces an older one", async () => {
    const { api, writes } = deferredApi();
    const target = mcpAppWidgetStateTarget("ws-order", "c1", loadedView(10));
    saveMcpAppWidgetState(api, target, { n: 1 });
    saveMcpAppWidgetState(api, target, { n: 2 });
    saveMcpAppWidgetState(api, target, { n: 3 });
    await flush();
    // One write at a time: the first is in flight, the newest waits, { n: 2 } is never sent.
    expect(writes.map((w) => w.state)).toEqual([{ n: 1 }]);
    writes[0].settle(true);
    await flush();
    expect(writes.map((w) => w.state)).toEqual([{ n: 1 }, { n: 3 }]);
    expect(writes.every((w) => w.binding === 10)).toBe(true);
  });

  test("a new document starts with the latest state, even while its write is in flight", async () => {
    const { api, writes } = deferredApi();
    const target = mcpAppWidgetStateTarget("ws-remount", "c1", loadedView(10, { n: 0 }));
    saveMcpAppWidgetState(api, target, { n: 5 });
    await flush();
    // The frame unmounted and mounted again before the write landed: getView still has n: 0.
    const remounted = mcpAppWidgetStateTarget("ws-remount", "c1", loadedView(10, { n: 0 }));
    expect(mcpAppWidgetStateSeed({ nonce: "doc-2" }, remounted)).toEqual({ n: 5 });
    writes[0].settle(true);
  });

  test("a new record under a reused tool call ID gets only its own stored state", async () => {
    const { api } = deferredApi();
    saveMcpAppWidgetState(api, mcpAppWidgetStateTarget("ws-reuse", "c1", loadedView(10)), {
      secret: true,
    });
    const reused = mcpAppWidgetStateTarget("ws-reuse", "c1", loadedView(20));
    expect(mcpAppWidgetStateSeed({ nonce: "doc-reuse" }, reused)).toBeNull();
  });

  test("a document keeps the seed it was built with, so later writes do not reload it", async () => {
    const { api } = deferredApi();
    const target = mcpAppWidgetStateTarget("ws-doc", "c1", loadedView(10, { n: 1 }));
    expect(mcpAppWidgetStateSeed({ nonce: "doc-a" }, target)).toEqual({ n: 1 });
    saveMcpAppWidgetState(api, target, { n: 2 });
    expect(mcpAppWidgetStateSeed({ nonce: "doc-a" }, target)).toEqual({ n: 1 });
    expect(mcpAppWidgetStateSeed({ nonce: "doc-b" }, target)).toEqual({ n: 2 });
  });

  test("a view without a result record has no state to keep", () => {
    const { api, writes } = deferredApi();
    const target = mcpAppWidgetStateTarget("ws-none", "c1", loadedView(null));
    expect(target).toBeNull();
    saveMcpAppWidgetState(api, target, { n: 1 });
    expect(writes).toEqual([]);
    expect(mcpAppWidgetStateSeed({ nonce: "doc-none" }, target)).toBeNull();
  });
});
