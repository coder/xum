import { afterEach, describe, expect, jest, test } from "bun:test";
import * as net from "node:net";
import { connectToServer } from "./serverConnection";

describe("connectToServer", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("a handshake timeout rejects without an unhandled WebSocket error", async () => {
    // Accept the TCP connection but never answer the upgrade, so only the open timeout fires.
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address == null || typeof address === "string") throw new Error("expected a TCP address");

    try {
      jest.useFakeTimers();
      const connecting = connectToServer({ serverUrl: `http://127.0.0.1:${address.port}` });
      const outcome = connecting.then(
        () => new Error("expected the handshake to time out"),
        (error: unknown) => error
      );
      while (sockets.size === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      jest.advanceTimersByTime(10_000);
      jest.useRealTimers();

      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("WebSocket open timed out");
      // Give a re-emitted 'error' from terminate() a chance to surface as unhandled.
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
