import { describe, expect, test } from "bun:test";
import { createHealthProbe, resolveHealthResponse } from "./healthProbe";

describe("createHealthProbe", () => {
  test("shares one in-flight fs probe across concurrent requests and starts a new one after it settles", async () => {
    let settle: (value: unknown) => void = () => undefined;
    let calls = 0;
    const probeHealth = createHealthProbe(() => {
      calls += 1;
      return new Promise((resolve) => {
        settle = resolve;
      });
    }, 20);

    const [first, second] = await Promise.all([probeHealth(), probeHealth()]);
    expect(first.statusCode).toBe(503);
    expect(second.statusCode).toBe(503);
    expect(calls).toBe(1);

    settle({});
    await Promise.resolve();
    const third = probeHealth();
    expect(calls).toBe(2);
    settle({});
    expect((await third).statusCode).toBe(200);
  });
});

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

  test("reports degraded with the errno code but not the probed path when the probe rejects", async () => {
    const error = Object.assign(
      new Error("ENOENT: no such file or directory, stat '/home/someone/.xum'"),
      {
        code: "ENOENT",
      }
    );
    const response = await resolveHealthResponse(Promise.reject(error), 1000);
    expect(response.statusCode).toBe(503);
    if (response.statusCode !== 503) return;
    expect(response.body.reason).toContain("ENOENT");
    expect(response.body.reason).not.toContain("/home/someone");
  });
});
