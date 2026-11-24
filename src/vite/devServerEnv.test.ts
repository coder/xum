import { describe, expect, test } from "bun:test";
import { isDevServerHostAllowed, resolveViteDevServerEnv } from "./devServerEnv";

describe("resolveViteDevServerEnv", () => {
  test("prefers canonical XUM values when legacy aliases are also set", () => {
    const env = resolveViteDevServerEnv({
      XUM_VITE_HOST: "10.0.0.8",
      MUX_VITE_HOST: "10.0.0.9",
      XUM_VITE_PORT: "5180",
      MUX_VITE_PORT: "5181",
      XUM_BACKEND_HOST: "10.1.0.8",
      MUX_BACKEND_HOST: "10.1.0.9",
      XUM_BACKEND_PORT: "3100",
      MUX_BACKEND_PORT: "3101",
      XUM_ENABLE_TUTORIALS_IN_SANDBOX: "1",
      MUX_ENABLE_TUTORIALS_IN_SANDBOX: "0",
    });

    expect(env.host).toBe("10.0.0.8");
    expect(env.port).toBe(5180);
    expect(env.backendHost).toBe("10.1.0.8");
    expect(env.backendPort).toBe(3100);
    expect(env.enableTutorialsInSandbox).toBe("1");
  });

  test("uses the backend socket only when one is set", () => {
    expect(resolveViteDevServerEnv({}).backendSocket).toBeUndefined();
    // An empty value (a recipe that exports it blank) must not become a socket path.
    expect(resolveViteDevServerEnv({ XUM_BACKEND_SOCKET: "  " }).backendSocket).toBeUndefined();
    expect(resolveViteDevServerEnv({ XUM_BACKEND_SOCKET: "/run/x/b.sock" }).backendSocket).toBe(
      "/run/x/b.sock"
    );
    // The backend gets the value byte for byte from make, so a path that ends in a space is a
    // different path from the one without it.
    expect(resolveViteDevServerEnv({ XUM_BACKEND_SOCKET: " /run/x/b.sock " }).backendSocket).toBe(
      " /run/x/b.sock "
    );
  });

  test("falls back to leftover MUX values when XUM is unset", () => {
    const env = resolveViteDevServerEnv({
      MUX_VITE_HOST: "10.0.0.9",
      MUX_VITE_PORT: "5181",
      MUX_VITE_ALLOWED_HOSTS: "example.test",
      MUX_BACKEND_PORT: "3101",
    });

    expect(env.host).toBe("10.0.0.9");
    expect(env.port).toBe(5181);
    expect(env.allowedHosts).toEqual(["example.test"]);
    expect(env.backendPort).toBe(3101);
  });
});

describe("isDevServerHostAllowed", () => {
  const loopbackOnly = ["localhost", "127.0.0.1"];

  test.each([
    "localhost",
    "localhost:5173",
    "app.localhost:5173",
    "127.0.0.1:5173",
    "10.1.2.3",
    "[::1]:5173",
    "[fe80::1]",
  ])("accepts %s without a list entry", (host) => {
    expect(isDevServerHostAllowed(host, [])).toBe(true);
  });

  test.each(["evil.example", "evil.example:5173", "localhost.evil.example", "[evil]", "[::1"])(
    "refuses %s",
    (host) => {
      expect(isDevServerHostAllowed(host, loopbackOnly)).toBe(false);
    }
  );

  test("accepts a listed host, and a dot entry for its subdomains", () => {
    expect(isDevServerHostAllowed("a.example:5173", ["a.example"])).toBe(true);
    expect(isDevServerHostAllowed("b.example", ["a.example"])).toBe(false);
    expect(isDevServerHostAllowed("x.a.example", ["a.example"])).toBe(false);
    expect(isDevServerHostAllowed("x.a.example", [".a.example"])).toBe(true);
    expect(isDevServerHostAllowed("a.example", [".a.example"])).toBe(true);
    expect(isDevServerHostAllowed("nota.example", [".a.example"])).toBe(false);
  });

  test("accepts any host when every host is allowed, as Vite does", () => {
    expect(isDevServerHostAllowed("evil.example", true)).toBe(true);
    expect(isDevServerHostAllowed(undefined, true)).toBe(true);
  });

  test("refuses a missing Host header, which Vite itself lets through", () => {
    expect(isDevServerHostAllowed(undefined, loopbackOnly)).toBe(false);
  });
});
