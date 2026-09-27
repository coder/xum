import { describe, expect, test } from "bun:test";

import {
  isAllowedOrpcPath,
  redactWebviewOrpcResult,
  sanitizeWebviewOrpcInput,
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
});

describe("policy (#4739)", () => {
  test("allows reading the effective policy and its change signal only", () => {
    expect(isAllowedOrpcPath(["policy", "get"])).toBe(true);
    expect(isAllowedOrpcPath(["policy", "onChanged"])).toBe(true);
    expect(isAllowedOrpcPath(["policy", "refresh"])).toBe(false);
  });

  test("strips provider forcedBaseUrl from policy.get and keeps everything else", () => {
    const response = {
      source: "governor",
      status: { state: "enforced" },
      policy: {
        policyFormatVersion: "0.1",
        providerAccess: [
          {
            id: "openai",
            forcedBaseUrl: "https://user:token@gateway.corp.example/v1",
            allowedModels: ["gpt-5.6-terra"],
          },
          { id: "anthropic", allowedModels: null },
        ],
        mcp: { allowUserDefined: { stdio: false, remote: true } },
        runtimes: ["worktree"],
      },
    };
    expect(redactWebviewOrpcResult(["policy", "get"], response)).toEqual({
      ...response,
      policy: {
        ...response.policy,
        providerAccess: [
          { id: "openai", allowedModels: ["gpt-5.6-terra"] },
          { id: "anthropic", allowedModels: null },
        ],
      },
    });
    // The input object is not mutated.
    expect(response.policy.providerAccess[0].forcedBaseUrl).toBeDefined();
  });

  test("passes other results and policy-less responses through unchanged", () => {
    const noPolicy = { source: "none", status: { state: "disabled" }, policy: null };
    expect(redactWebviewOrpcResult(["policy", "get"], noPolicy)).toEqual(noPolicy);
    const other = { forcedBaseUrl: "kept" };
    expect(redactWebviewOrpcResult(["providers", "getConfig"], other)).toBe(other);
  });
});
