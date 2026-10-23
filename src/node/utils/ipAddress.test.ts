import { describe, expect, test } from "bun:test";
import { isIP } from "./ipAddress";

describe("isIP", () => {
  // web_fetch.ts relies on these answers: 0 rejects a DNS answer, 6 brackets a
  // connect address, and a zone index (fe80::1%eth0) still counts as IPv6.
  test.each([
    ["127.0.0.1", 4],
    ["255.255.255.255", 4],
    ["::1", 6],
    ["2001:db8::1", 6],
    ["fe80::1%eth0", 6],
    ["::ffff:127.0.0.1", 6],
    ["example.com", 0],
    ["256.0.0.1", 0],
    ["[::1]", 0],
    ["", 0],
  ] as const)("%p is version %p", (input, version) => {
    expect(isIP(input)).toBe(version);
  });
});
