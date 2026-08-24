import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import type { ProjectsConfig } from "@/common/types/project";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { buildStreamSystemContext } from "./streamContextBuilder";
import { getLegacyModeForAgentMetadata, resolveAgentForStream } from "./agentResolution";

class CountingRuntime extends LocalRuntime {
  readonly agentReads = new Map<string, number>();

  override readFile(filePath: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
    if (filePath.endsWith(".md") && filePath.includes(`${path.sep}agents${path.sep}`)) {
      this.agentReads.set(filePath, (this.agentReads.get(filePath) ?? 0) + 1);
    }
    return super.readFile(filePath, abortSignal);
  }
}

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

describe("resolveAgentForStream discovery reuse", () => {
  test("reuses request-scoped definitions for available-subagent discovery", async () => {
    using tempDir = new DisposableTempDir("agent-resolution-discovery-reuse");
    const projectPath = path.join(tempDir.path, "project");
    const xumHome = path.join(tempDir.path, "xum-home");
    const previousXumRoot = process.env.XUM_ROOT;
    process.env.XUM_ROOT = xumHome;
    using _xumRoot = {
      [Symbol.dispose]() {
        if (previousXumRoot === undefined) {
          delete process.env.XUM_ROOT;
        } else {
          process.env.XUM_ROOT = previousXumRoot;
        }
      },
    };
    const canonicalProjectAgents = path.join(projectPath, ".xum", "agents");
    const projectAgents = path.join(projectPath, ".mux", "agents");
    const globalAgents = path.join(xumHome, "agents");
    await fs.mkdir(canonicalProjectAgents, { recursive: true });
    await fs.mkdir(projectAgents, { recursive: true });
    await fs.mkdir(globalAgents, { recursive: true });

    // An invalid canonical definition must not become the cached winner over the
    // valid legacy-root definition at the same project scope.
    await fs.writeFile(path.join(canonicalProjectAgents, "selected.md"), "invalid", "utf-8");
    await fs.writeFile(
      path.join(projectAgents, "selected.md"),
      `---\nname: Selected Project Agent\nbase: shared\nsubagent:\n  runnable: true\ntools:\n  add:\n    - bash\n---\nSelected body\n`,
      "utf-8"
    );
    await fs.writeFile(
      path.join(projectAgents, "disabled.md"),
      `---\nname: Disabled Agent\ndisabled: true\nsubagent:\n  runnable: true\n---\nDisabled body\n`,
      "utf-8"
    );
    await fs.writeFile(
      path.join(globalAgents, "selected.md"),
      `---\nname: Shadowed Global Agent\nsubagent:\n  runnable: true\n---\nShadowed body\n`,
      "utf-8"
    );
    await fs.writeFile(
      path.join(globalAgents, "shared.md"),
      `---\nname: Shared Base\nbase: exec\nsubagent:\n  runnable: true\n---\nShared body\n`,
      "utf-8"
    );

    const runtime = new CountingRuntime(projectPath);
    const metadata: WorkspaceMetadata = {
      id: "workspace",
      name: "workspace",
      projectName: "project",
      projectPath,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };
    const cfg: ProjectsConfig = {
      projects: new Map([
        [projectPath, { trusted: true, workspaces: [{ id: "workspace", name: "workspace" }] }],
      ]),
      agentAiDefaults: {
        disabled: { enabled: false },
      },
    };

    const baselineRuntime = new CountingRuntime(projectPath);
    const baselineResult = await resolveAgentForStream({
      workspaceId: metadata.id,
      metadata,
      runtime: baselineRuntime,
      workspacePath: projectPath,
      requestedAgentId: "selected",
      disableWorkspaceAgents: false,
      callerToolPolicy: undefined,
      cfg,
      emitError: () => undefined,
      isAdvisorExperimentEnabled: false,
    });
    if (!baselineResult.success) {
      throw new Error("Expected baseline agent resolution to succeed");
    }
    await buildStreamSystemContext({
      runtime: baselineRuntime,
      metadata,
      workspacePath: projectPath,
      workspaceId: metadata.id,
      agentDefinition: baselineResult.data.agentDefinition,
      effectiveMode: "exec",
      agentDiscoveryRuntime: baselineResult.data.agentDiscoveryRuntime,
      agentDiscoveryPath: baselineResult.data.agentDiscoveryPath,
      isSubagentWorkspace: false,
      effectiveAdditionalInstructions: undefined,
      modelString: "openai:gpt-5.2",
      cfg,
      providersConfig: null,
      mcpServers: {},
      loadDesktopCapability: () =>
        Promise.resolve({ available: false as const, reason: "unsupported_runtime" as const }),
    });
    expect(baselineRuntime.agentReads.get(path.join(projectAgents, "selected.md"))).toBe(4);

    const result = await resolveAgentForStream({
      workspaceId: metadata.id,
      metadata,
      runtime,
      workspacePath: projectPath,
      requestedAgentId: "selected",
      disableWorkspaceAgents: false,
      callerToolPolicy: undefined,
      cfg,
      emitError: () => undefined,
      isAdvisorExperimentEnabled: false,
    });
    if (!result.success) {
      throw new Error("Expected agent resolution to succeed");
    }

    const context = await buildStreamSystemContext({
      runtime,
      metadata,
      workspacePath: projectPath,
      workspaceId: metadata.id,
      agentDefinitionCache: result.data.agentDefinitionCache,
      agentDefinition: result.data.agentDefinition,
      effectiveMode: "exec",
      agentDiscoveryRuntime: result.data.agentDiscoveryRuntime,
      agentDiscoveryPath: result.data.agentDiscoveryPath,
      isSubagentWorkspace: false,
      effectiveAdditionalInstructions: undefined,
      modelString: "openai:gpt-5.2",
      cfg,
      providersConfig: null,
      mcpServers: {},
      loadDesktopCapability: () =>
        Promise.resolve({ available: false as const, reason: "unsupported_runtime" as const }),
    });
    const available = context.agentDefinitions ?? [];

    expect(context.agentSystemPromptSections[0]).toContain("Selected body");
    expect(context.agentSystemPromptSections[0]).toContain("Shared body");
    expect(result.data.effectiveAgentId).toBe("selected");
    expect(result.data.agentDefinition.scope).toBe("project");
    expect(result.data.agentInheritanceChain.map((agent) => agent.id)).toEqual([
      "selected",
      "shared",
      "exec",
    ]);
    expect(result.data.effectiveToolPolicy).toContainEqual({
      regex_match: "bash",
      action: "enable",
    });
    expect(available.find((agent) => agent.id === "selected")?.name).toBe("Selected Project Agent");
    expect(available.find((agent) => agent.id === "selected")?.scope).toBe("project");
    expect(available.find((agent) => agent.id === "selected")?.subagentRunnable).toBe(true);
    expect(available.some((agent) => agent.id === "disabled")).toBe(false);
    expect(available.some((agent) => agent.id === "desktop")).toBe(false);

    expect(runtime.agentReads.get(path.join(projectAgents, "selected.md"))).toBe(1);
    expect(runtime.agentReads.get(path.join(globalAgents, "selected.md")) ?? 0).toBe(0);
    expect(runtime.agentReads.get(path.join(globalAgents, "shared.md"))).toBe(1);
  });
});

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
