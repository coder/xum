import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import type { ProjectsConfig } from "@/common/types/project";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  AgentDefinitionRequestCache,
  readAgentDefinition,
  resolveAgentBody,
} from "./agentDefinitions/agentDefinitionsService";
import { resolveAgentInheritanceChain } from "./agentDefinitions/resolveAgentInheritanceChain";
import { getLegacyModeForAgentMetadata, resolveAgentForStream } from "./agentResolution";
import { buildStreamSystemContext } from "./turnContextAssembler";

const PARENT_WORKSPACE_ID = "parent-workspace";
const CHILD_WORKSPACE_ID = "child-workspace";

function createSubagentMetadata(params: {
  projectPath: string;
  agentId: string;
  agentType?: string;
}): WorkspaceMetadata {
  return {
    id: CHILD_WORKSPACE_ID,
    name: CHILD_WORKSPACE_ID,
    projectName: path.basename(params.projectPath),
    projectPath: params.projectPath,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    parentWorkspaceId: PARENT_WORKSPACE_ID,
    agentId: params.agentId,
    agentType: params.agentType ?? params.agentId,
  };
}

async function resolvePolicyForAgent(params: {
  agentId: string;
  agentAiDefaults?: ProjectsConfig["agentAiDefaults"];
}) {
  using tempDir = new DisposableTempDir("agent-resolution-advisor-defaults");
  const projectPath = path.join(tempDir.path, "project");
  await fs.mkdir(projectPath, { recursive: true });

  const metadata = createSubagentMetadata({
    projectPath,
    agentId: params.agentId,
  });
  const cfg: ProjectsConfig = {
    projects: new Map([
      [
        projectPath,
        {
          trusted: true,
          workspaces: [
            { id: PARENT_WORKSPACE_ID, name: PARENT_WORKSPACE_ID, path: projectPath },
            {
              id: CHILD_WORKSPACE_ID,
              name: CHILD_WORKSPACE_ID,
              path: projectPath,
              parentWorkspaceId: PARENT_WORKSPACE_ID,
              agentId: params.agentId,
              agentType: params.agentId,
            },
          ],
        },
      ],
    ]),
    ...(params.agentAiDefaults ? { agentAiDefaults: params.agentAiDefaults } : {}),
  };

  const result = await resolveAgentForStream({
    workspaceId: CHILD_WORKSPACE_ID,
    metadata,
    runtime: new LocalRuntime(projectPath),
    workspacePath: projectPath,
    requestedAgentId: params.agentId,
    disableWorkspaceAgents: false,
    callerToolPolicy: undefined,
    cfg,
    emitError: () => undefined,
    isAdvisorExperimentEnabled: true,
  });

  if (!result.success) {
    throw new Error("Expected agent resolution to succeed");
  }
  return result.data.effectiveToolPolicy ?? [];
}

describe("getLegacyModeForAgentMetadata", () => {
  test("omits legacy mode metadata for custom or derived agents", () => {
    expect(getLegacyModeForAgentMetadata("explore", "exec")).toBeUndefined();
    expect(getLegacyModeForAgentMetadata("custom-plan", "plan")).toBeUndefined();
    expect(getLegacyModeForAgentMetadata("exec", "exec")).toBe("exec");
    expect(getLegacyModeForAgentMetadata("plan", "plan")).toBe("plan");
    expect(getLegacyModeForAgentMetadata("compact", "compact")).toBe("compact");
  });
});

describe("resolveAgentForStream agent identity", () => {
  test("preserves legacy child agentType when persisted agentId is blank", async () => {
    using tempDir = new DisposableTempDir("agent-resolution-legacy-agent-type");
    const projectPath = path.join(tempDir.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    const metadata = createSubagentMetadata({
      projectPath,
      agentId: "",
      agentType: "explore",
    });
    const cfg: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            trusted: true,
            workspaces: [
              { id: PARENT_WORKSPACE_ID, name: PARENT_WORKSPACE_ID, path: projectPath },
              {
                id: CHILD_WORKSPACE_ID,
                name: CHILD_WORKSPACE_ID,
                path: projectPath,
                parentWorkspaceId: PARENT_WORKSPACE_ID,
                agentId: "",
                agentType: "explore",
              },
            ],
          },
        ],
      ]),
    };

    const result = await resolveAgentForStream({
      workspaceId: CHILD_WORKSPACE_ID,
      metadata,
      runtime: new LocalRuntime(projectPath),
      workspacePath: projectPath,
      requestedAgentId: "exec",
      disableWorkspaceAgents: false,
      callerToolPolicy: undefined,
      cfg,
      emitError: () => undefined,
      isAdvisorExperimentEnabled: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.effectiveAgentId).toBe("explore");
  });

  test("resolves parent-only project agents for child workspaces", async () => {
    using tempDir = new DisposableTempDir("agent-resolution-parent-only-agent");
    const projectPath = path.join(tempDir.path, "project");
    const parentPath = path.join(projectPath, "parent");
    const childPath = path.join(projectPath, "child");
    const customAgentId = "custom-plan-runner";
    await fs.mkdir(path.join(parentPath, ".mux", "agents"), { recursive: true });
    await fs.mkdir(childPath, { recursive: true });
    await fs.writeFile(
      path.join(parentPath, ".mux", "agents", `${customAgentId}.md`),
      [
        "---",
        "name: Custom Plan Runner",
        "base: plan",
        "subagent:",
        "  runnable: true",
        "---",
        "Parent-only plan-like agent.",
        "",
      ].join("\n")
    );

    const metadata = createSubagentMetadata({
      projectPath,
      agentId: "",
      agentType: customAgentId,
    });
    const cfg: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            trusted: true,
            workspaces: [
              { id: PARENT_WORKSPACE_ID, name: PARENT_WORKSPACE_ID, path: parentPath },
              {
                id: CHILD_WORKSPACE_ID,
                name: CHILD_WORKSPACE_ID,
                path: childPath,
                parentWorkspaceId: PARENT_WORKSPACE_ID,
                agentId: "",
                agentType: customAgentId,
              },
            ],
          },
        ],
      ]),
    };

    const result = await resolveAgentForStream({
      workspaceId: CHILD_WORKSPACE_ID,
      metadata,
      runtime: new LocalRuntime(childPath),
      workspacePath: childPath,
      requestedAgentId: "exec",
      disableWorkspaceAgents: false,
      callerToolPolicy: undefined,
      cfg,
      emitError: () => undefined,
      isAdvisorExperimentEnabled: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agentDiscoveryPath).toBe(parentPath);
    expect(result.data.effectiveAgentId).toBe(customAgentId);
    expect(result.data.agentIsPlanLike).toBe(true);
    expect(result.data.effectiveMode).toBe("plan");
  });

  test("tries legacy project agentType before stale built-in agentId fallback", async () => {
    using tempDir = new DisposableTempDir("agent-resolution-stale-built-in-agent-id");
    const projectPath = path.join(tempDir.path, "project");
    const parentPath = path.join(projectPath, "parent");
    const childPath = path.join(projectPath, "child");
    const customAgentId = "parent-only-reviewer";
    await fs.mkdir(path.join(parentPath, ".mux", "agents"), { recursive: true });
    await fs.mkdir(childPath, { recursive: true });
    await fs.writeFile(
      path.join(parentPath, ".mux", "agents", `${customAgentId}.md`),
      [
        "---",
        "name: Parent Only Reviewer",
        "base: plan",
        "subagent:",
        "  runnable: true",
        "---",
        "Parent-only reviewer agent.",
        "",
      ].join("\n")
    );

    const metadata = createSubagentMetadata({
      projectPath,
      agentId: "exec",
      agentType: customAgentId,
    });
    const cfg: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            trusted: true,
            workspaces: [
              { id: PARENT_WORKSPACE_ID, name: PARENT_WORKSPACE_ID, path: parentPath },
              {
                id: CHILD_WORKSPACE_ID,
                name: CHILD_WORKSPACE_ID,
                path: childPath,
                parentWorkspaceId: PARENT_WORKSPACE_ID,
                agentId: "exec",
                agentType: customAgentId,
              },
            ],
          },
        ],
      ]),
    };

    const result = await resolveAgentForStream({
      workspaceId: CHILD_WORKSPACE_ID,
      metadata,
      runtime: new LocalRuntime(childPath),
      workspacePath: childPath,
      requestedAgentId: "exec",
      disableWorkspaceAgents: false,
      callerToolPolicy: undefined,
      cfg,
      emitError: () => undefined,
      isAdvisorExperimentEnabled: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.effectiveAgentId).toBe(customAgentId);
    expect(result.data.agentDiscoveryPath).toBe(parentPath);
    expect(result.data.effectiveMode).toBe("plan");
  });

  test("keeps canonical legacy agentType when stale agentId has a project override", async () => {
    using tempDir = new DisposableTempDir("agent-resolution-stale-project-agent-id");
    const projectPath = path.join(tempDir.path, "project");
    const parentPath = path.join(projectPath, "parent");
    const childPath = path.join(projectPath, "child");
    await fs.mkdir(path.join(childPath, ".mux", "agents"), { recursive: true });
    await fs.mkdir(parentPath, { recursive: true });
    await fs.writeFile(
      path.join(childPath, ".mux", "agents", "exec.md"),
      [
        "---",
        "name: Stale Exec Override",
        "base: plan",
        "subagent:",
        "  runnable: true",
        "---",
        "This stale project exec override must not beat the task's legacy Explore identity.",
        "",
      ].join("\n")
    );

    const metadata = createSubagentMetadata({
      projectPath,
      agentId: "exec",
      agentType: "explore",
    });
    const cfg: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            trusted: true,
            workspaces: [
              { id: PARENT_WORKSPACE_ID, name: PARENT_WORKSPACE_ID, path: parentPath },
              {
                id: CHILD_WORKSPACE_ID,
                name: CHILD_WORKSPACE_ID,
                path: childPath,
                parentWorkspaceId: PARENT_WORKSPACE_ID,
                agentId: "exec",
                agentType: "explore",
              },
            ],
          },
        ],
      ]),
    };

    const result = await resolveAgentForStream({
      workspaceId: CHILD_WORKSPACE_ID,
      metadata,
      runtime: new LocalRuntime(childPath),
      workspacePath: childPath,
      requestedAgentId: "exec",
      disableWorkspaceAgents: false,
      callerToolPolicy: undefined,
      cfg,
      emitError: () => undefined,
      isAdvisorExperimentEnabled: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.effectiveAgentId).toBe("explore");
    expect(result.data.agentDefinition.scope).toBe("built-in");
    expect(result.data.effectiveMode).toBe("exec");
  });

  test("tries legacy agentType when modern agentId is valid but unavailable", async () => {
    using tempDir = new DisposableTempDir("agent-resolution-stale-agent-id");
    const projectPath = path.join(tempDir.path, "project");
    const parentPath = path.join(projectPath, "parent");
    const childPath = path.join(projectPath, "child");
    await fs.mkdir(childPath, { recursive: true });

    const metadata = createSubagentMetadata({
      projectPath,
      agentId: "missing-agent",
      agentType: "explore",
    });
    const cfg: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            trusted: true,
            workspaces: [
              { id: PARENT_WORKSPACE_ID, name: PARENT_WORKSPACE_ID, path: parentPath },
              {
                id: CHILD_WORKSPACE_ID,
                name: CHILD_WORKSPACE_ID,
                path: childPath,
                parentWorkspaceId: PARENT_WORKSPACE_ID,
                agentId: "missing-agent",
                agentType: "explore",
              },
            ],
          },
        ],
      ]),
    };

    const result = await resolveAgentForStream({
      workspaceId: CHILD_WORKSPACE_ID,
      metadata,
      runtime: new LocalRuntime(childPath),
      workspacePath: childPath,
      requestedAgentId: "exec",
      disableWorkspaceAgents: false,
      callerToolPolicy: undefined,
      cfg,
      emitError: () => undefined,
      isAdvisorExperimentEnabled: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.effectiveAgentId).toBe("explore");
  });

  test("prefers child project overrides before parent built-in fallback", async () => {
    using tempDir = new DisposableTempDir("agent-resolution-child-project-override");
    const projectPath = path.join(tempDir.path, "project");
    const parentPath = path.join(projectPath, "parent");
    const childPath = path.join(projectPath, "child");
    await fs.mkdir(path.join(childPath, ".mux", "agents"), { recursive: true });
    await fs.mkdir(parentPath, { recursive: true });
    await fs.writeFile(
      path.join(childPath, ".mux", "agents", "exec.md"),
      [
        "---",
        "name: Child Exec Override",
        "base: plan",
        "subagent:",
        "  runnable: true",
        "---",
        "Child project override for Exec.",
        "",
      ].join("\n")
    );

    const metadata = createSubagentMetadata({
      projectPath,
      agentId: "exec",
    });
    const cfg: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            trusted: true,
            workspaces: [
              { id: PARENT_WORKSPACE_ID, name: PARENT_WORKSPACE_ID, path: parentPath },
              {
                id: CHILD_WORKSPACE_ID,
                name: CHILD_WORKSPACE_ID,
                path: childPath,
                parentWorkspaceId: PARENT_WORKSPACE_ID,
                agentId: "exec",
                agentType: "exec",
              },
            ],
          },
        ],
      ]),
    };

    const result = await resolveAgentForStream({
      workspaceId: CHILD_WORKSPACE_ID,
      metadata,
      runtime: new LocalRuntime(childPath),
      workspacePath: childPath,
      requestedAgentId: "exec",
      disableWorkspaceAgents: false,
      callerToolPolicy: undefined,
      cfg,
      emitError: () => undefined,
      isAdvisorExperimentEnabled: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agentDefinition.scope).toBe("project");
    expect(result.data.agentDefinition.frontmatter.name).toBe("Child Exec Override");
    expect(result.data.effectiveMode).toBe("plan");
  });
});

describe("resolveAgentForStream strict resolution", () => {
  function createTopLevelMetadata(projectPath: string): WorkspaceMetadata {
    return {
      id: PARENT_WORKSPACE_ID,
      name: PARENT_WORKSPACE_ID,
      projectName: path.basename(projectPath),
      projectPath,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };
  }

  async function resolveTopLevel(params: {
    projectPath: string;
    agentId: string;
    strictAgentResolution:
      | boolean
      | {
          expectedScope: "project" | "global" | "built-in";
          expectedSource?: string;
          expectedChain?: Array<{
            id: string;
            scope: "project" | "global" | "built-in";
            source?: string;
          }>;
        };
    agentAiDefaults?: ProjectsConfig["agentAiDefaults"];
    onError?: (event: { errorType?: string }) => void;
  }) {
    const cfg: ProjectsConfig = {
      projects: new Map([
        [
          params.projectPath,
          {
            trusted: true,
            workspaces: [
              { id: PARENT_WORKSPACE_ID, name: PARENT_WORKSPACE_ID, path: params.projectPath },
            ],
          },
        ],
      ]),
      ...(params.agentAiDefaults ? { agentAiDefaults: params.agentAiDefaults } : {}),
    };
    return await resolveAgentForStream({
      workspaceId: PARENT_WORKSPACE_ID,
      metadata: createTopLevelMetadata(params.projectPath),
      runtime: new LocalRuntime(params.projectPath),
      workspacePath: params.projectPath,
      requestedAgentId: params.agentId,
      disableWorkspaceAgents: false,
      strictAgentResolution: params.strictAgentResolution,
      callerToolPolicy: undefined,
      cfg,
      emitError: (event) => params.onError?.(event),
      isAdvisorExperimentEnabled: false,
    });
  }

  test("unresolvable explicit agent fails loudly instead of falling back to exec", async () => {
    using tempDir = new DisposableTempDir("agent-resolution-strict-unknown");
    const projectPath = path.join(tempDir.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    // Default behavior: silent exec fallback keeps ordinary sends usable.
    const lenient = await resolveTopLevel({
      projectPath,
      agentId: "doesnotexist",
      strictAgentResolution: false,
    });
    expect(lenient.success).toBe(true);
    if (lenient.success) expect(lenient.data.effectiveAgentId).toBe("exec");

    // Strict mode (explicit workspace-turn overrides): running a different agent
    // than requested must fail the stream, not silently swap in exec — and the
    // failure is deterministic, so it must be classified non-retryable
    // (agent_resolution) instead of the retryable catch-all.
    const emittedErrorTypes: Array<string | undefined> = [];
    const strict = await resolveTopLevel({
      projectPath,
      agentId: "doesnotexist",
      strictAgentResolution: true,
      onError: (event) => emittedErrorTypes.push(event.errorType),
    });
    expect(strict.success).toBe(false);
    if (!strict.success && strict.error.type === "unknown") {
      expect(strict.error.raw).toContain("could not be resolved");
    } else {
      expect(strict.success === false && strict.error.type).toBe("unknown");
    }
    expect(emittedErrorTypes).toEqual(["agent_resolution"]);
  });

  test("hidden explicit agent fails loudly in strict mode for top-level workspaces", async () => {
    using tempDir = new DisposableTempDir("agent-resolution-strict-hidden");
    const projectPath = path.join(tempDir.path, "project");
    const agentsDir = path.join(projectPath, ".mux", "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    // A definition hidden between launch-time validation and streaming (init hook or
    // concurrent edit): strict sends must uphold the workspace-task contract that
    // internal agents are ineligible instead of running the hidden policy.
    await fs.writeFile(
      path.join(agentsDir, "custom.md"),
      ["---", "name: Custom", "base: exec", "ui:", "  hidden: true", "---", "Hidden agent."].join(
        "\n"
      )
    );

    const strict = await resolveTopLevel({
      projectPath,
      agentId: "custom",
      strictAgentResolution: true,
    });
    expect(strict.success).toBe(false);
    if (!strict.success && strict.error.type === "unknown") {
      expect(strict.error.raw).toContain("not selectable");
    } else {
      expect(strict.success === false && strict.error.type).toBe("unknown");
    }

    // Lenient top-level sends keep today's behavior (no visibility gate).
    const lenient = await resolveTopLevel({
      projectPath,
      agentId: "custom",
      strictAgentResolution: false,
    });
    expect(lenient.success).toBe(true);
    if (lenient.success) expect(lenient.data.effectiveAgentId).toBe("custom");
  });

  test("hidden exec shadow fails loudly in strict mode instead of running the shadow", async () => {
    using tempDir = new DisposableTempDir("agent-resolution-strict-exec-shadow");
    const projectPath = path.join(tempDir.path, "project");
    const agentsDir = path.join(projectPath, ".mux", "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    // Discovery prefers a project exec shadow over the built-in; strict sends must gate
    // exec like any other id instead of skipping the eligibility block for it.
    await fs.writeFile(
      path.join(agentsDir, "exec.md"),
      ["---", "name: Exec", "ui:", "  hidden: true", "---", "Hidden exec shadow."].join("\n")
    );

    const strict = await resolveTopLevel({
      projectPath,
      agentId: "exec",
      strictAgentResolution: true,
    });
    expect(strict.success).toBe(false);
    if (!strict.success && strict.error.type === "unknown") {
      expect(strict.error.raw).toContain("not selectable");
    } else {
      expect(strict.success === false && strict.error.type).toBe("unknown");
    }
  });

  test("strict mode rejects a definition resolving from a different scope than validated", async () => {
    using tempDir = new DisposableTempDir("agent-resolution-strict-provenance");
    const projectPath = path.join(tempDir.path, "project");
    await fs.mkdir(projectPath, { recursive: true });

    // Launch validation saw a project shadow that has since vanished (init hook or
    // concurrent edit): the same id now resolves from the built-in scope. The strict
    // provenance pin must fail the send instead of running the different definition.
    const strict = await resolveTopLevel({
      projectPath,
      agentId: "plan",
      strictAgentResolution: { expectedScope: "project" },
    });
    expect(strict.success).toBe(false);
    if (!strict.success && strict.error.type === "unknown") {
      expect(strict.error.raw).toContain("different definition");
    } else {
      expect(strict.success === false && strict.error.type).toBe("unknown");
    }

    // Scope alone is not a provenance identifier (project files and project plugins
    // both report "project"): a same-scope pin with a different exact source must
    // also fail.
    const sameScopeDifferentSource = await resolveTopLevel({
      projectPath,
      agentId: "plan",
      strictAgentResolution: { expectedScope: "built-in", expectedSource: ".xum/agents" },
    });
    expect(sameScopeDifferentSource.success).toBe(false);
    if (!sameScopeDifferentSource.success && sameScopeDifferentSource.error.type === "unknown") {
      expect(sameScopeDifferentSource.error.raw).toContain("different definition");
    } else {
      expect(
        sameScopeDifferentSource.success === false && sameScopeDifferentSource.error.type
      ).toBe("unknown");
    }

    // A matching scope + source streams normally.
    const matching = await resolveTopLevel({
      projectPath,
      agentId: "plan",
      strictAgentResolution: { expectedScope: "built-in", expectedSource: "built-in" },
    });
    expect(matching.success).toBe(true);
    if (matching.success) expect(matching.data.effectiveAgentId).toBe("plan");
  });

  test("strict mode rejects a base chain resolving differently than validated", async () => {
    using tempDir = new DisposableTempDir("agent-resolution-strict-chain");
    const projectPath = path.join(tempDir.path, "project");
    const agentsDir = path.join(projectPath, ".mux", "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(
      path.join(agentsDir, "custom.md"),
      ["---", "name: Custom", "base: plan", "---", "Custom agent."].join("\n")
    );

    // Launch validation saw the custom agent inheriting a project plan shadow that has
    // since been removed: the leaf provenance is unchanged, but the built-in plan now
    // takes over the base hop — the strict chain pin must fail the send.
    const staleChain = await resolveTopLevel({
      projectPath,
      agentId: "custom",
      strictAgentResolution: {
        expectedScope: "project",
        expectedChain: [
          { id: "custom", scope: "project" },
          { id: "plan", scope: "project" },
        ],
      },
    });
    expect(staleChain.success).toBe(false);
    if (!staleChain.success && staleChain.error.type === "unknown") {
      expect(staleChain.error.raw).toContain("base chain");
    } else {
      expect(staleChain.success === false && staleChain.error.type).toBe("unknown");
    }

    // The chain as it actually resolves streams normally.
    const matching = await resolveTopLevel({
      projectPath,
      agentId: "custom",
      strictAgentResolution: {
        expectedScope: "project",
        expectedChain: [
          { id: "custom", scope: "project" },
          { id: "plan", scope: "built-in", source: "built-in" },
        ],
      },
    });
    expect(matching.success).toBe(true);
    if (matching.success) expect(matching.data.effectiveAgentId).toBe("custom");
  });

  test("strict mode fails closed when eligibility resolution throws", async () => {
    using tempDir = new DisposableTempDir("agent-resolution-strict-broken-base");
    const projectPath = path.join(tempDir.path, "project");
    const agentsDir = path.join(projectPath, ".mux", "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    // A base pointing at a missing definition makes frontmatter resolution throw;
    // strict sends must not stream a partially resolved prompt/tool policy.
    await fs.writeFile(
      path.join(agentsDir, "custom.md"),
      ["---", "name: Custom", "base: missing-base", "---", "Broken chain."].join("\n")
    );

    const strict = await resolveTopLevel({
      projectPath,
      agentId: "custom",
      strictAgentResolution: true,
    });
    expect(strict.success).toBe(false);
    if (!strict.success && strict.error.type === "unknown") {
      expect(strict.error.raw).toContain("could not be");
    } else {
      expect(strict.success === false && strict.error.type).toBe("unknown");
    }

    // Lenient sends keep the best-effort behavior.
    const lenient = await resolveTopLevel({
      projectPath,
      agentId: "custom",
      strictAgentResolution: false,
    });
    expect(lenient.success).toBe(true);
  });

  test("disabled explicit agent fails loudly in strict mode for top-level workspaces", async () => {
    using tempDir = new DisposableTempDir("agent-resolution-strict-disabled");
    const projectPath = path.join(tempDir.path, "project");
    const agentsDir = path.join(projectPath, ".mux", "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(
      path.join(agentsDir, "custom.md"),
      ["---", "name: Custom", "base: exec", "---", "Custom agent."].join("\n")
    );
    const agentAiDefaults = { custom: { enabled: false } };

    const lenient = await resolveTopLevel({
      projectPath,
      agentId: "custom",
      strictAgentResolution: false,
      agentAiDefaults,
    });
    expect(lenient.success).toBe(true);
    if (lenient.success) expect(lenient.data.effectiveAgentId).toBe("exec");

    const strict = await resolveTopLevel({
      projectPath,
      agentId: "custom",
      strictAgentResolution: true,
      agentAiDefaults,
    });
    expect(strict.success).toBe(false);
    if (!strict.success && strict.error.type === "unknown") {
      expect(strict.error.raw).toContain("disabled");
    } else {
      expect(strict.success === false && strict.error.type).toBe("unknown");
    }
  });
});

describe("resolveAgentForStream advisor defaults", () => {
  test("enables advisor by default for Exec and Plan sub-agents when the experiment is enabled", async () => {
    const [execPolicy, planPolicy] = await Promise.all([
      resolvePolicyForAgent({ agentId: "exec" }),
      resolvePolicyForAgent({ agentId: "plan" }),
    ]);

    expect(execPolicy).toContainEqual({ regex_match: "advisor", action: "enable" });
    expect(planPolicy).toContainEqual({ regex_match: "advisor", action: "enable" });
  });

  test("keeps explicit advisor disable overrides authoritative for default-enabled agents", async () => {
    const policy = await resolvePolicyForAgent({
      agentId: "exec",
      agentAiDefaults: { exec: { advisorEnabled: false } },
    });

    expect(policy).toContainEqual({ regex_match: "advisor", action: "disable" });
    expect(policy).not.toContainEqual({ regex_match: "advisor", action: "enable" });
  });
});

describe("resolveAgentForStream per-request agent definition cache", () => {
  /** Counts agent definition file reads (`<root>/agents/<id>.md`) by path. */
  class CountingRuntime extends LocalRuntime {
    readonly definitionReads = new Map<string, number>();

    override readFile(filePath: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
      if (path.basename(path.dirname(filePath)) === "agents" && filePath.endsWith(".md")) {
        this.definitionReads.set(filePath, (this.definitionReads.get(filePath) ?? 0) + 1);
      }
      return super.readFile(filePath, abortSignal);
    }
  }

  async function writeAgent(root: string, id: string, lines: string[]): Promise<void> {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, `${id}.md`), lines.join("\n"));
  }

  /**
   * One stream turn as TurnRequestBuilder runs it: agent resolution, then
   * system-context assembly (body, frontmatter, sub-agent discovery), both
   * sharing the request's cache when one is given.
   */
  async function runTurn(params: {
    projectPath: string;
    cfg: ProjectsConfig;
    cache: AgentDefinitionRequestCache | undefined;
  }) {
    const runtime = new CountingRuntime(params.projectPath);
    const metadata: WorkspaceMetadata = {
      id: "cache-ws",
      name: "cache-ws",
      projectName: "project",
      projectPath: params.projectPath,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };
    const resolved = await resolveAgentForStream({
      workspaceId: metadata.id,
      metadata,
      runtime,
      workspacePath: params.projectPath,
      requestedAgentId: "reviewer",
      disableWorkspaceAgents: false,
      callerToolPolicy: undefined,
      cfg: params.cfg,
      emitError: () => undefined,
      agentDefinitionCache: params.cache,
    });
    if (!resolved.success) throw new Error("Expected agent resolution to succeed");
    const agent = resolved.data;
    const context = await buildStreamSystemContext({
      runtime,
      metadata,
      workspacePath: params.projectPath,
      workspaceId: metadata.id,
      agentDefinition: agent.agentDefinition,
      effectiveMode: agent.effectiveMode,
      agentDiscoveryRuntime: agent.agentDiscoveryRuntime,
      agentDiscoveryPath: agent.agentDiscoveryPath,
      isSubagentWorkspace: false,
      effectiveAdditionalInstructions: undefined,
      modelString: "openai:gpt-5.2",
      cfg: params.cfg,
      providersConfig: null,
      mcpServers: {},
      agentDefinitionCache: params.cache,
    });
    const totalReads = [...runtime.definitionReads.values()].reduce((sum, n) => sum + n, 0);
    return { agent, context, metadata, reads: runtime.definitionReads, totalReads };
  }

  test("cuts per-turn definition reads, keeps precedence and inheritance, and re-reads next turn", async () => {
    using tempDir = new DisposableTempDir("agent-resolution-request-cache");
    const projectPath = path.join(tempDir.path, "project");
    const xumHome = path.join(tempDir.path, "xum-home");
    const projectAgents = path.join(projectPath, ".xum", "agents");
    const globalAgents = path.join(xumHome, "agents");
    // project reviewer → global exec → built-in exec; the global reviewer is shadowed.
    await writeAgent(projectAgents, "reviewer", [
      "---",
      "name: Reviewer",
      "base: exec",
      "subagent:",
      "  runnable: true",
      "tools:",
      "  remove:",
      "    - file_edit_.*",
      "---",
      "Project reviewer v1.",
    ]);
    await writeAgent(globalAgents, "reviewer", [
      "---",
      "name: Shadowed",
      "---",
      "Global reviewer.",
    ]);
    await writeAgent(globalAgents, "exec", [
      "---",
      "name: Exec",
      "base: exec",
      "---",
      "Global exec.",
    ]);
    const cfg: ProjectsConfig = {
      projects: new Map([[projectPath, { trusted: true, workspaces: [] }]]),
    };

    const previousRoot = process.env.XUM_ROOT;
    process.env.XUM_ROOT = xumHome;
    try {
      const uncached = await runTurn({ projectPath, cfg, cache: undefined });
      const cached = await runTurn({ projectPath, cfg, cache: new AgentDefinitionRequestCache() });

      // Same resolution with and without the cache.
      for (const turn of [uncached, cached]) {
        expect(turn.agent.agentDefinition.scope).toBe("project");
        expect(turn.agent.agentInheritanceChain.map((hop) => hop.scope)).toEqual([
          "project",
          "global",
          "built-in",
        ]);
        const body = turn.context.agentSystemPromptSections[0];
        expect(body).toContain("Project reviewer v1.");
        expect(body).not.toContain("Global reviewer.");
        expect(body.indexOf("Global exec.")).toBeLessThan(body.indexOf("Project reviewer v1."));
        expect(turn.context.agentDefinitions?.find((a) => a.id === "reviewer")?.scope).toBe(
          "project"
        );
      }
      expect(cached.agent.effectiveToolPolicy).toEqual(uncached.agent.effectiveToolPolicy);
      expect(cached.context.systemMessage).toBe(uncached.context.systemMessage);

      // Without the cache one turn re-reads the selected definition and its
      // bases for every lookup; with it the per-turn read count must drop.
      // (Sub-agent discovery still lists each file once to build descriptors.)
      const reviewerPath = path.join(projectAgents, "reviewer.md");
      const globalExecPath = path.join(globalAgents, "exec.md");
      expect(cached.totalReads).toBeLessThan(uncached.totalReads);
      expect(cached.reads.get(reviewerPath) ?? 0).toBeLessThan(
        uncached.reads.get(reviewerPath) ?? 0
      );
      expect(cached.reads.get(globalExecPath) ?? 0).toBeLessThan(
        uncached.reads.get(globalExecPath) ?? 0
      );
      // Repeating lookups later in the same request is served from the cache.
      const cache = new AgentDefinitionRequestCache();
      const again = await runTurn({ projectPath, cfg, cache });
      const repeatRuntime = again.agent.agentDiscoveryRuntime as CountingRuntime;
      const readsAfterTurn = new Map(repeatRuntime.definitionReads);
      const repeatedBody = await resolveAgentBody(repeatRuntime, projectPath, "reviewer", {
        cache,
      });
      await resolveAgentInheritanceChain({
        runtime: repeatRuntime,
        workspacePath: projectPath,
        agentId: "reviewer",
        agentDefinition: again.agent.agentDefinition,
        workspaceId: again.metadata.id,
        cache,
      });
      expect(repeatedBody).toBe(again.context.agentSystemPromptSections[0]);
      expect(repeatRuntime.definitionReads).toEqual(readsAfterTurn);

      // A new request gets a new cache: edits between turns are picked up.
      await writeAgent(projectAgents, "reviewer", [
        "---",
        "name: Reviewer",
        "base: exec",
        "---",
        "Project reviewer v2.",
      ]);
      const nextTurn = await runTurn({
        projectPath,
        cfg,
        cache: new AgentDefinitionRequestCache(),
      });
      expect(nextTurn.context.agentSystemPromptSections[0]).toContain("Project reviewer v2.");
    } finally {
      if (previousRoot === undefined) delete process.env.XUM_ROOT;
      else process.env.XUM_ROOT = previousRoot;
    }
  });

  test("keys cached lookups by skipped scopes so base resolution still skips the override", async () => {
    using tempDir = new DisposableTempDir("agent-resolution-request-cache-scopes");
    const projectPath = path.join(tempDir.path, "project");
    await writeAgent(path.join(projectPath, ".xum", "agents"), "exec", [
      "---",
      "name: Exec override",
      "base: exec",
      "---",
      "Project exec.",
    ]);
    const runtime = new LocalRuntime(projectPath);
    const cache = new AgentDefinitionRequestCache();

    const override = await readAgentDefinition(runtime, projectPath, "exec", { cache });
    const base = await readAgentDefinition(runtime, projectPath, "exec", {
      cache,
      skipScopesAbove: "project",
    });

    expect(override.scope).toBe("project");
    expect(base.scope).not.toBe("project");
    // Repeated lookups in the same request return the memoized winner.
    expect(await readAgentDefinition(runtime, projectPath, "exec", { cache })).toBe(override);
  });
});
