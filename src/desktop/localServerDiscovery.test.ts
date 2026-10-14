import { describe, expect, test } from "bun:test";
import type { ServerLockData } from "@/node/services/serverLockfile";
import { getLocalServerLoadUrl } from "./localServerDiscovery";

const SELF_PID = 1000;

function lock(overrides: Partial<ServerLockData> = {}): ServerLockData {
  return {
    pid: 2000,
    baseUrl: "http://localhost:3000",
    token: "lock-token",
    startedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("getLocalServerLoadUrl", () => {
  test("returns null without a lock or when the lock belongs to this desktop", () => {
    expect(getLocalServerLoadUrl(null, SELF_PID)).toBeNull();
    // The desktop's own API server is not "a running xum server" to open.
    expect(getLocalServerLoadUrl(lock({ pid: SELF_PID }), SELF_PID)).toBeNull();
  });

  test("uses the lock's base URL verbatim and passes its token as the browser token parameter", () => {
    const url = new URL(getLocalServerLoadUrl(lock(), SELF_PID)!);
    expect(url.origin).toBe("http://localhost:3000");
    expect(url.searchParams.get("token")).toBe("lock-token");
  });

  test("omits the token parameter for servers started with --no-auth", () => {
    expect(getLocalServerLoadUrl(lock({ token: "" }), SELF_PID)).toBe("http://localhost:3000/");
  });

  test("keeps an app-proxy path from the lock", () => {
    const url = new URL(
      getLocalServerLoadUrl(lock({ baseUrl: "https://box.example.com/xum" }), SELF_PID)!
    );
    expect(url.pathname).toBe("/xum");
    expect(url.searchParams.get("token")).toBe("lock-token");
  });

  test.each(["file:///tmp/server", "http://user:secret@localhost:3000", "not a url"])(
    "rejects a lock base URL that is not a credential-free HTTP(S) URL: %s",
    (baseUrl) => {
      expect(getLocalServerLoadUrl(lock({ baseUrl }), SELF_PID)).toBeNull();
    }
  );
});
