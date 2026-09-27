import { describe, expect, test } from "bun:test";

import {
  isAllowedOrpcPath,
  sanitizeWebviewOrpcInput,
  webviewKnownWorkspaceIds,
} from "./orpcAllowlist";

describe("isAllowedOrpcPath", () => {
  test("allows known procedures", () => {
    expect(isAllowedOrpcPath(["general", "ping"]))
      .toBe(true);
    expect(isAllowedOrpcPath(["workspace", "sendMessage"]))
      .toBe(true);
    expect(isAllowedOrpcPath(["providers", "getConfig"]))
      .toBe(true);
  });

  test("rejects unknown roots and procedures", () => {
    expect(isAllowedOrpcPath(["server", "getApiServerStatus"]))
      .toBe(false);
    expect(isAllowedOrpcPath(["workspace", "create"]))
      .toBe(false);
    expect(isAllowedOrpcPath(["providers", "setProviderConfig"]))
      .toBe(false);
  });

  test("rejects nested routers", () => {
    expect(isAllowedOrpcPath(["workspace", "backgroundBashes", "subscribe"]))
      .toBe(false);
  });

  test("rejects invalid segments", () => {
    expect(isAllowedOrpcPath([])).toBe(false);
    expect(isAllowedOrpcPath(["workspace", "__proto__"]))
      .toBe(false);
    expect(isAllowedOrpcPath(["workspace", "send-message"]))
      .toBe(false);
  });
});

describe("agents.list (#4751)", () => {
  test("allows listing agent descriptors but not reading agent packages", () => {
    expect(isAllowedOrpcPath(["agents", "list"])).toBe(true);
    // agents.get returns full prompt bodies; it stays blocked.
    expect(isAllowedOrpcPath(["agents", "get"])).toBe(false);
  });

  const known = new Set(["ws-1"]);

  test("forwards only a known workspaceId and the disable flag", () => {
    expect(
      sanitizeWebviewOrpcInput(
        ["agents", "list"],
        {
          workspaceId: "ws-1",
          disableWorkspaceAgents: true,
          projectPath: "/etc",
          includeDisabled: true,
        },
        known
      )
    ).toEqual({ ok: true, input: { workspaceId: "ws-1", disableWorkspaceAgents: true } });
  });

  test("rejects unknown workspaces, free-form project paths and malformed input", () => {
    for (const input of [
      { workspaceId: "ws-other" },
      { projectPath: "/home/alice/secret-project" },
      {},
      null,
      "ws-1",
    ]) {
      expect(sanitizeWebviewOrpcInput(["agents", "list"], input, known).ok).toBe(false);
    }
  });

  test("leaves other procedures' input unchanged", () => {
    const input = { workspaceId: "anything", message: "hi" };
    expect(sanitizeWebviewOrpcInput(["workspace", "sendMessage"], input, known)).toEqual({
      ok: true,
      input,
    });
  });

  test("accepts the restored selection before the workspace list has loaded", () => {
    // On a fresh extension host the selected workspace is posted to the webview before the list
    // refresh finishes, and the webview asks for its agents right away.
    const knownBeforeRefresh = webviewKnownWorkspaceIds([], "ws-restored");
    expect(
      sanitizeWebviewOrpcInput(["agents", "list"], { workspaceId: "ws-restored" }, knownBeforeRefresh)
        .ok
    ).toBe(true);
    expect(webviewKnownWorkspaceIds(["ws-1"], null)).toEqual(new Set(["ws-1"]));
  });
});
