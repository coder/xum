import { describe, expect, test } from "bun:test";

import { candidatePorts, deriveProxyKey, verifyProxyKey } from "./stableIdentity";

describe("stableIdentity", () => {
  test("candidate ports are stable per seed, distinct, and differ between seeds", () => {
    const a = candidatePorts("/home/a/.xum", 16);
    expect(candidatePorts("/home/a/.xum", 16)).toEqual(a);
    expect(new Set(a).size).toBe(16);
    expect(candidatePorts("/home/b/.xum", 16)[0]).not.toBe(a[0]);
  });

  test("keys verify for their workspace only, and not under another secret", () => {
    const secret = "a".repeat(64);
    const key = deriveProxyKey(secret, "ws-with-dash");
    expect(verifyProxyKey(secret, key)).toBe("ws-with-dash");

    const forged = key.replace("ws-with-dash", "ws-other");
    expect(verifyProxyKey(secret, forged)).toBeUndefined();
    expect(verifyProxyKey("0".repeat(64), key)).toBeUndefined();
    expect(verifyProxyKey(secret, "xum-proxy-bad")).toBeUndefined();
    expect(verifyProxyKey(secret, "sk-ant-real")).toBeUndefined();
    // A non-hex MAC of the right length is refused, not thrown on.
    expect(verifyProxyKey(secret, `xum-proxy-ws-${"é".repeat(64)}`)).toBeUndefined();
  });
});
