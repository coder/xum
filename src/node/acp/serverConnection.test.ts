import { describe, expect, test } from "bun:test";
import * as net from "node:net";
import { connectToServer } from "./serverConnection";

describe("connectToServer", () => {
  test("a refused connection rejects without an unhandled WebSocket error", async () => {
    // Reserve a port, then close it so the connection is refused.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (address == null || typeof address === "string") throw new Error("expected a TCP address");
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    let error: unknown = null;
    try {
      await connectToServer({ serverUrl: `http://127.0.0.1:${address.port}` });
    } catch (caught) {
      error = caught;
    }
    expect(error).not.toBeNull();
    // Give a second 'error' emission a chance to surface as unhandled.
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
});
