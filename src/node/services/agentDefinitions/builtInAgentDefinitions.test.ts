import { beforeEach, describe, expect, test } from "bun:test";

// Importing browser code from node tests is allowed (only browser->node value
// imports are banned); TasksSection.agents is a pure data module.
import { FALLBACK_AGENTS } from "@/browser/features/Settings/Sections/TasksSection.agents";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import { createDesktopTools } from "@/node/services/tools/desktopTools";
import { createTestToolConfig, TestTempDir } from "@/node/services/tools/testHelpers";
import { clearBuiltInAgentCache, getBuiltInAgentDefinitions } from "./builtInAgentDefinitions";

describe("built-in agent definitions", () => {
  beforeEach(() => {
    clearBuiltInAgentCache();
  });

  test("Settings fallback inventory mirrors built-ins, including hidden agents", () => {
    // FALLBACK_AGENTS must cover every built-in (hidden ones too) so saved
    // overrides are not mislabeled as unknown when discovery is unavailable.
    const builtInIds = getBuiltInAgentDefinitions()
      .map((pkg) => pkg.id)
      .sort();
    const fallbackIds = FALLBACK_AGENTS.map((agent) => agent.id).sort();

    expect(fallbackIds).toEqual(builtInIds);
  });

  test("does not include a built-in auto agent", () => {
    const pkgs = getBuiltInAgentDefinitions();
    const ids = pkgs.map((pkg) => pkg.id);

    expect(ids).not.toContain("auto");
    expect(ids).toContain("exec");
    expect(ids).toContain("plan");
  });

  test("intuition cannot run as an interactive agent or child workspace", () => {
    const intuition = getBuiltInAgentDefinitions().find((agent) => agent.id === "intuition");
    expect(intuition?.frontmatter.ui?.hidden).toBe(true);
    expect(intuition?.frontmatter.subagent?.runnable).toBe(false);
    expect(intuition?.frontmatter.subagent?.workflow_runnable).not.toBe(true);
    expect(intuition?.frontmatter.tools?.require).toEqual(["memory_read", "intuition_report"]);
  });

  test("desktop agent gets exactly the desktop tool registry and cannot spawn tasks", () => {
    using tempDir = new TestTempDir("builtin-desktop-agent");
    // Derive the expected set from the registry so a newly added desktop tool cannot silently
    // stay unavailable to the desktop agent. Tools are only built here, never executed, so the
    // session manager is never called.
    const registryNames = Object.keys(
      createDesktopTools(createTestToolConfig(tempDir.path), {} as DesktopSessionManager)
    ).sort();
    const desktop = getBuiltInAgentDefinitions().find((pkg) => pkg.id === "desktop");

    expect([...(desktop?.frontmatter.tools?.add ?? [])].sort()).toEqual(registryNames);
    // Safety: desktop sub-agents drive a shared GUI and must not fan out into further tasks.
    expect(desktop?.frontmatter.tools?.remove ?? []).toContain("task");
  });

  test("plan is workflow-runnable but not a general subagent", () => {
    const pkgs = getBuiltInAgentDefinitions();
    const byId = new Map(pkgs.map((pkg) => [pkg.id, pkg] as const));

    const plan = byId.get("plan");
    expect(plan).toBeTruthy();
    expect(plan?.frontmatter.subagent?.runnable).toBe(false);
    expect(plan?.frontmatter.subagent?.workflow_runnable).toBe(true);
  });

  test("explore agent allows skill tools", () => {
    const pkgs = getBuiltInAgentDefinitions();
    const byId = new Map(pkgs.map((pkg) => [pkg.id, pkg] as const));

    const explore = byId.get("explore");
    expect(explore).toBeTruthy();
    const removed = explore?.frontmatter.tools?.remove ?? [];
    expect(removed).not.toContain("agent_skill_read");
    expect(removed).not.toContain("agent_skill_read_file");
  });

  test("analytics_query remains unavailable in general-purpose built-in agents", () => {
    const pkgs = getBuiltInAgentDefinitions();
    const byId = new Map(pkgs.map((pkg) => [pkg.id, pkg] as const));

    const exec = byId.get("exec");
    expect(exec).toBeTruthy();
    expect(exec?.frontmatter.tools?.remove ?? []).toContain("analytics_query");

    const plan = byId.get("plan");
    expect(plan).toBeTruthy();
    expect(plan?.frontmatter.tools?.remove ?? []).toContain("analytics_query");
  });

  test("irreversible task removal is unavailable in plan mode", () => {
    const pkgs = getBuiltInAgentDefinitions();
    const byId = new Map(pkgs.map((pkg) => [pkg.id, pkg] as const));

    const exec = byId.get("exec");
    expect(exec).toBeTruthy();
    expect(exec?.frontmatter.tools?.remove ?? []).not.toContain("task_remove");

    const plan = byId.get("plan");
    expect(plan).toBeTruthy();
    expect(plan?.frontmatter.tools?.remove ?? []).toContain("task_remove");
  });

  test("task_apply_git_patch is restricted to exec", () => {
    const pkgs = getBuiltInAgentDefinitions();
    const byId = new Map(pkgs.map((pkg) => [pkg.id, pkg] as const));

    const exec = byId.get("exec");
    expect(exec).toBeTruthy();
    expect(exec?.frontmatter.tools?.remove ?? []).not.toContain("task_apply_git_patch");

    const plan = byId.get("plan");
    expect(plan).toBeTruthy();
    expect(plan?.frontmatter.tools?.remove ?? []).toContain("task_apply_git_patch");

    const explore = byId.get("explore");
    expect(explore).toBeTruthy();
    expect(explore?.frontmatter.tools?.remove ?? []).toContain("task_apply_git_patch");
  });
});
