import { describe, expect, test } from "bun:test";

import { sessionHeaderNameError } from "./sessionHeader";

describe("sessionHeaderNameError", () => {
  test("accepts RFC 7230 token names", () => {
    for (const name of ["x-opencode-session", "X-Session-Id", "session_id", "a!#$%&'*+.^`|~9"]) {
      expect(sessionHeaderNameError(name)).toBeNull();
    }
  });

  test("rejects names that are not RFC 7230 tokens", () => {
    for (const name of ["", " x-session", "x session", "x-session:", "x-séance", "x\nfoo"]) {
      expect(sessionHeaderNameError(name)).not.toBeNull();
    }
  });

  // The header value is the workspace id, so a reserved name would replace
  // credentials or a header Xum already sets on every request.
  test("rejects auth and Xum-owned headers in any case", () => {
    for (const name of ["Authorization", "x-api-key", "X-Goog-Api-Key", "x-mux-workspace-id"]) {
      expect(sessionHeaderNameError(name)).not.toBeNull();
    }
  });
});
