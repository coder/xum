import { describe, expect, test } from "bun:test";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import {
  normalizeAgentId,
  resolvePersistedAgentId,
  resolvePersistedAgentIdCandidates,
  resolveRemovedBuiltinAgentId,
} from "./agentIds";

describe("resolvePersistedAgentId", () => {
  test("uses legacy agentType when modern agentId is blank", () => {
    expect(resolvePersistedAgentId({ agentId: "   ", agentType: " Explore " }, "exec")).toBe(
      "explore"
    );
  });

  test("uses legacy agentType when modern agentId is invalid", () => {
    expect(resolvePersistedAgentId({ agentId: "???", agentType: " Explore " }, "exec")).toBe(
      "explore"
    );
  });

  test("returns distinct valid candidates in persisted precedence order", () => {
    expect(
      resolvePersistedAgentIdCandidates({ agentId: " Missing-Agent ", agentType: " Explore " })
    ).toEqual(["missing-agent", "explore"]);
    expect(
      resolvePersistedAgentIdCandidates({ agentId: "explore", agentType: " Explore " })
    ).toEqual(["explore"]);
  });

  test("prefers legacy agentType for child task workspaces when fields disagree", () => {
    expect(
      resolvePersistedAgentIdCandidates({
        parentWorkspaceId: "parent-1",
        agentId: "exec",
        agentType: "explore",
      })
    ).toEqual(["explore", "exec"]);
    expect(
      resolvePersistedAgentId(
        { parentWorkspaceId: "parent-1", agentId: "exec", agentType: "explore" },
        "exec"
      )
    ).toBe("explore");
  });

  test("prefers non-empty agentId and falls back when neither field is set", () => {
    expect(resolvePersistedAgentId({ agentId: " Plan ", agentType: "explore" }, "exec")).toBe(
      "plan"
    );
    expect(resolvePersistedAgentId({ agentId: "", agentType: "" }, "exec")).toBe("exec");
    expect(resolvePersistedAgentId(undefined, "exec")).toBe("exec");
  });
});

describe("resolveRemovedBuiltinAgentId", () => {
  test("maps removed builtin agent ids to the workspace default when unavailable", () => {
    expect(resolveRemovedBuiltinAgentId("ask", ["exec", "plan"])).toBe(WORKSPACE_DEFAULTS.agentId);
    expect(resolveRemovedBuiltinAgentId("auto", ["exec", "plan"])).toBe(WORKSPACE_DEFAULTS.agentId);
    expect(resolveRemovedBuiltinAgentId("mux", ["exec", "plan"])).toBe(WORKSPACE_DEFAULTS.agentId);
  });

  test("preserves removed builtin agent ids that are still available", () => {
    expect(resolveRemovedBuiltinAgentId("mux", ["mux", "exec"])).toBe("mux");
  });

  test("normalizes case and whitespace before applying fallback remaps", () => {
    expect(resolveRemovedBuiltinAgentId("  MUX  ", ["exec", "plan"])).toBe(
      WORKSPACE_DEFAULTS.agentId
    );
    expect(normalizeAgentId("  Exec  ")).toBe("exec");
  });
});
