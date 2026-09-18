import { describe, expect, test } from "bun:test";
import { resolveHealthResponse } from "./healthProbe";

describe("resolveHealthResponse", () => {
  test("reports ok when the probe settles in time", async () => {
    const response = await resolveHealthResponse(Promise.resolve({}), 1000);
    expect(response).toEqual({ statusCode: 200, body: { status: "ok" } });
  });

  test("reports degraded instead of hanging when the probe never settles", async () => {
    const stalled = new Promise<never>(() => undefined);
    const response = await resolveHealthResponse(stalled, 20);
    expect(response.statusCode).toBe(503);
    expect(response.body.status).toBe("degraded");
  });

  test("reports degraded when the probe rejects", async () => {
    const response = await resolveHealthResponse(Promise.reject(new Error("ENOENT")), 1000);
    expect(response.statusCode).toBe(503);
    if (response.statusCode !== 503) return;
    expect(response.body.reason).toContain("ENOENT");
  });
});
