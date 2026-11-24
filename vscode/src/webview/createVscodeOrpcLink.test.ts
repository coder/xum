/* eslint-disable @typescript-eslint/await-thenable -- bun:test types `await expect(...).rejects.toThrow()` as void */
import { describe, expect, test } from "bun:test";

import { createVscodeOrpcLink } from "./createVscodeOrpcLink";
import type { WebviewToExtensionMessage } from "./protocol";
import type { VscodeBridge } from "./vscodeBridge";

class TestBridge implements VscodeBridge {
  traceId = "test";
  startedAtMs = 0;

  readonly sent: WebviewToExtensionMessage[] = [];
  throwOnPostMessage = false;

  private readonly listeners = new Set<(data: unknown) => void>();

  postMessage(payload: WebviewToExtensionMessage): void {
    this.sent.push(payload);

    if (this.throwOnPostMessage) {
      throw new Error("postMessage failed");
    }
  }

  onMessage(handler: (data: unknown) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  debugLog(_message: string, _data?: unknown): void {
    // no-op for tests
  }

  emit(data: unknown): void {
    for (const listener of this.listeners) {
      listener(data);
    }
  }
}

function getLastSent<Type extends WebviewToExtensionMessage["type"]>(
  bridge: TestBridge,
  type: Type
): Extract<WebviewToExtensionMessage, { type: Type }> {
  const msg = [...bridge.sent]
    .reverse()
    .find((m): m is Extract<WebviewToExtensionMessage, { type: Type }> => m.type === type);
  if (!msg) {
    throw new Error(`Expected a message of type ${type}`);
  }
  return msg;
}

describe("createVscodeOrpcLink", () => {
  test("resolves value responses", async () => {
    const bridge = new TestBridge();
    const link = createVscodeOrpcLink(bridge, { callTimeoutMs: 1_000 });

    const promise = link.call(
      ["workspace", "sendMessage"],
      { workspaceId: "w", message: "hi" },
      { context: {} }
    );

    const callMsg = getLastSent(bridge, "orpcCall");
    bridge.emit({
      type: "orpcResponse",
      requestId: callMsg.requestId,
      ok: true,
      kind: "value",
      value: { ok: true },
    });

    await expect(promise).resolves.toEqual({ ok: true });
  });

  test("sends orpcCancel when aborted", async () => {
    const bridge = new TestBridge();
    const link = createVscodeOrpcLink(bridge, { callTimeoutMs: 1_000 });

    const controller = new AbortController();
    const promise = link.call(["general", "ping"], "hi", {
      context: {},
      signal: controller.signal,
    });

    const callMsg = getLastSent(bridge, "orpcCall");
    controller.abort();

    await expect(promise).rejects.toThrow("aborted");

    const cancelMsg = getLastSent(bridge, "orpcCancel");
    expect(cancelMsg.requestId).toBe(callMsg.requestId);
  });

  test("times out and sends orpcCancel", async () => {
    const bridge = new TestBridge();
    const link = createVscodeOrpcLink(bridge, { callTimeoutMs: 10 });

    const promise = link.call(["general", "ping"], "hi", { context: {} });

    const callMsg = getLastSent(bridge, "orpcCall");

    await expect(promise).rejects.toThrow("timed out");

    const cancelMsg = getLastSent(bridge, "orpcCancel");
    expect(cancelMsg.requestId).toBe(callMsg.requestId);
  });

  test("handles stream responses", async () => {
    const bridge = new TestBridge();
    const link = createVscodeOrpcLink(bridge, { callTimeoutMs: 1_000 });

    const promise = link.call(["providers", "onConfigChanged"], undefined, { context: {} });

    const callMsg = getLastSent(bridge, "orpcCall");
    bridge.emit({
      type: "orpcResponse",
      requestId: callMsg.requestId,
      ok: true,
      kind: "stream",
      streamId: "s-1",
    });

    const iterable = (await promise) as AsyncIterable<unknown>;

    bridge.emit({ type: "orpcStreamData", streamId: "s-1", value: 1 });
    bridge.emit({ type: "orpcStreamData", streamId: "s-1", value: 2 });
    bridge.emit({ type: "orpcStreamEnd", streamId: "s-1" });

    const values: unknown[] = [];
    for await (const value of iterable) {
      values.push(value);
    }

    expect(values).toEqual([1, 2]);
  });

  test("cancels streams that overflow the buffer", async () => {
    const bridge = new TestBridge();
    const link = createVscodeOrpcLink(bridge, { callTimeoutMs: 1_000, maxBufferedStreamEvents: 1 });

    const promise = link.call(["providers", "onConfigChanged"], undefined, { context: {} });

    const callMsg = getLastSent(bridge, "orpcCall");
    bridge.emit({
      type: "orpcResponse",
      requestId: callMsg.requestId,
      ok: true,
      kind: "stream",
      streamId: "s-overflow",
    });

    const iterator = (await promise) as AsyncIterator<unknown>;

    // Push two events without pulling.
    bridge.emit({ type: "orpcStreamData", streamId: "s-overflow", value: 1 });
    bridge.emit({ type: "orpcStreamData", streamId: "s-overflow", value: 2 });

    await expect(iterator.next()).rejects.toThrow("buffer overflow");

    const cancelMsg = getLastSent(bridge, "orpcStreamCancel");
    expect(cancelMsg.streamId).toBe("s-overflow");
  });
});
