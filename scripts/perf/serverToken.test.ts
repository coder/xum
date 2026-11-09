import { expect, test } from "bun:test";
import { resolveXumEnvironmentValue } from "../../src/common/compat/xumEnv";
import { newServerToken, serverTokenEnv, withServerToken } from "./serverToken";

test("every perf server gets its own random token", () => {
  const [a, b] = [newServerToken(), newServerToken()];
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(b).toMatch(/^[0-9a-f]{64}$/);
  expect(a).not.toBe(b);
});

// The app and the static views read `?token=` with URLSearchParams, so a token with URL metacharacters
// must come back byte for byte.
test("withServerToken puts the token in the query and keeps the path", () => {
  const url = new URL(withServerToken("http://127.0.0.1:4100/workspace/abc?x=1", "a+b#c d"));
  expect(url.pathname).toBe("/workspace/abc");
  expect(url.searchParams.get("x")).toBe("1");
  expect(url.searchParams.get("token")).toBe("a+b#c d");
  expect(url.hash).toBe("");
});

// A tree built before the MUX_ to XUM_ rename reads only the MUX_ name, and a current tree reads the
// XUM_ name first. Both must see the same token, or the benchmark's browser is refused.
test("serverTokenEnv gives current and pre-rename servers the same token", () => {
  const env = serverTokenEnv("t0k3n");
  expect(resolveXumEnvironmentValue("SERVER_AUTH_TOKEN", env)).toBe("t0k3n");
  expect(
    resolveXumEnvironmentValue("SERVER_AUTH_TOKEN", {
      MUX_SERVER_AUTH_TOKEN: env.MUX_SERVER_AUTH_TOKEN,
    })
  ).toBe("t0k3n");
});
