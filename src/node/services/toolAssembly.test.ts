import { resolveToolPolicyForAgent } from "./agentDefinitions/resolveToolPolicy";
import { isSessionHistoryDisabled } from "@/common/utils/tools/toolPolicy";
import { resolveAgentFrontmatter } from "./agentDefinitions/agentDefinitionsService";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { ToolBridge } from "./ptc/toolBridge";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { Tool } from "ai";

import { applyToolPolicyAndExperiments, resolveBackendGatedPtcExperiments } from "./toolAssembly";
import { buildToolsetManifest } from "./turnEnvelope";
import { sandboxHostService } from "@/node/services/sandbox/sandboxHostService";
import { DisposableTempDir } from "@/node/services/tempDir";
import { appendRefinementEvent } from "@/node/services/refinement/refinementJournal";
import { listRefinements } from "@/node/services/refinement/refinementRollback";
import { createFileEditInsertTool } from "./tools/file_edit_insert";
import { createFileEditReplaceStringTool } from "./tools/file_edit_replace_string";
import { getTestDeps } from "./tools/testHelpers";

function executableTool(description: string): Tool {
  return {
    description,
    inputSchema: z.object({}),
    execute: () => Promise.resolve({ success: true }),
  } as unknown as Tool;
}

describe("applyToolPolicyAndExperiments", () => {
  test("PTC keeps literal file edits direct without duplicating them in the sandbox", async () => {
    using tmp = new DisposableTempDir("ptc-direct-file-edits");
    const deps = {
      ...getTestDeps(),
      cwd: tmp.path,
      runtime: new LocalRuntime(tmp.path),
      runtimeTempDir: tmp.path,
    };
    const tools = await applyToolPolicyAndExperiments({
      allTools: {
        file_edit_insert: createFileEditInsertTool(deps),
        file_edit_replace_string: createFileEditReplaceStringTool(deps),
        bash: executableTool("Run a command"),
      },
      effectiveToolPolicy: undefined,
      experiments: { programmaticToolCalling: true },
      emitNestedToolEvent: () => undefined,
    });
    expect(Object.keys(tools).sort()).toEqual([
      "code_execution",
      "file_edit_insert",
      "file_edit_replace_string",
    ]);

    // JSON, shell substitutions, and Markdown fences are literal document data,
    // not source to be repaired by a JavaScript parser.
    const content = [
      "# Handoff",
      'HTTP 200 `{"status":"ok"}`',
      '`${String(key)}:${version}` and "quoted" text',
      "```sh",
      "printf '%s\\n' \"${HOME}\"",
      "```",
      "",
    ].join("\n");
    const options = { toolCallId: "direct-edit", messages: [], context: undefined };
    const filePath = path.join(tmp.path, "handoff.md");
    expect(
      await tools.file_edit_insert.execute!({ path: filePath, content }, options)
    ).toMatchObject({ success: true });
    expect(await fsPromises.readFile(filePath, "utf8")).toBe(content);

    const oldString = '{"status":"ok"}';
    const newString = '{"status":"ready","note":"it\'s literal"}';
    expect(
      await tools.file_edit_replace_string.execute!(
        { path: filePath, old_string: oldString, new_string: newString },
        options
      )
    ).toMatchObject({ success: true });
    expect(await fsPromises.readFile(filePath, "utf8")).toBe(content.replace(oldString, newString));

    // A duplicate bridge would bypass request.assemble filters/wrappers.
    const evaluated: unknown = await tools.code_execution.execute!(
      {
        code: "return [typeof xum.file_edit_insert, typeof xum.file_edit_replace_string, typeof xum.bash];",
      },
      options
    );
    expect(evaluated).toMatchObject({
      success: true,
      result: ["undefined", "undefined", "function"],
    });
  });

  test.each(["policy", "grants"] as const)(
    "PTC direct file edits still obey %s",
    async (ceiling) => {
      const tools = await applyToolPolicyAndExperiments({
        allTools: {
          file_edit_insert: executableTool("Insert text"),
          file_edit_replace_string: executableTool("Replace text"),
          bash: executableTool("Run a command"),
        },
        effectiveToolPolicy:
          ceiling === "policy" ? [{ regex_match: "file_edit_.*", action: "disable" }] : undefined,
        capabilityGrants:
          ceiling === "grants"
            ? {
                version: 1,
                bridgeTools: { allow: ["bash"] },
                vars: false,
                hostEvents: false,
              }
            : undefined,
        experiments: { programmaticToolCalling: true },
        emitNestedToolEvent: () => undefined,
      });
      expect(Object.keys(tools)).toEqual(["code_execution"]);
      const evaluated: unknown = await tools.code_execution.execute!(
        { code: "return [typeof xum.file_edit_insert, typeof xum.file_edit_replace_string];" },
        { toolCallId: "denied-edit", messages: [], context: undefined }
      );
      expect(evaluated).toMatchObject({ success: true, result: ["undefined", "undefined"] });
    }
  );

  test("PTC keeps mcp_prompt_get directly visible", async () => {
    const result = await applyToolPolicyAndExperiments({
      allTools: {
        bash: executableTool("Run a command"),
        mcp_prompt_get: executableTool("Fetch a prompt\n\nAvailable MCP prompts:\n- mcp__s__p"),
      },
      effectiveToolPolicy: undefined,
      experiments: { programmaticToolCalling: true },
      emitNestedToolEvent: () => undefined,
    });

    const names = Object.keys(result);
    expect(names).toContain("code_execution");
    expect(names).not.toContain("bash");
    // Sandbox declarations keep only the first description line, which would
    // hide the prompt catalog.
    expect(names).toContain("mcp_prompt_get");
    expect(result.mcp_prompt_get.description).toContain("mcp__s__p");

    // Promoted tools must not ALSO stay bridged: request.assemble hooks see
    // only top-level tools, and a bridged duplicate would keep dispatching
    // the pre-hook implementation behind a hook's filter or wrapper.
    const evalResult = (await result.code_execution.execute!(
      { code: "return typeof mux.mcp_prompt_get;" },
      { toolCallId: "test-call-id", messages: [], context: undefined }
    )) as { success: boolean; result?: unknown };
    expect(evalResult.success).toBe(true);
    expect(evalResult.result).toBe("undefined");
  });

  test("context-coupled tools stay model-visible under PTC; media tools bridge", async () => {
    // memory/advisor: AIService keys system-prompt context (memory index /
    // hot set, advisor guidance) off their top-level presence. attach_file /
    // desktop_screenshot are bridgeable instead: the ToolBridge strips their
    // base64 from sandbox-visible values and the code_execution attachments
    // carrier delivers the real bytes to request-time extraction, so nested
    // media reaches the model without a top-level tool slot.
    const result = await applyToolPolicyAndExperiments({
      allTools: {
        bash: executableTool("Run a command"),
        memory: executableTool("Memory"),
        advisor: executableTool("Advisor"),
        attach_file: executableTool("Attach"),
        desktop_screenshot: executableTool("Screenshot"),
      },
      effectiveToolPolicy: undefined,
      experiments: { programmaticToolCalling: true },
      emitNestedToolEvent: () => undefined,
    });
    expect(Object.keys(result).sort()).toEqual(["advisor", "code_execution", "memory"]);

    // The media tools must actually be reachable inside the sandbox; hidden
    // from the model-visible set but not dropped.
    const evalResult = (await result.code_execution.execute!(
      { code: "return [typeof mux.attach_file, typeof mux.desktop_screenshot];" },
      { toolCallId: "test-call-id", messages: [], context: undefined }
    )) as { success: boolean; result?: unknown };
    expect(evalResult.success).toBe(true);
    expect(evalResult.result).toEqual(["function", "function"]);
  });

  test("a disable-all policy yields no tools at all (no code_execution)", async () => {
    // Auto-compaction inherits the original send's experiment flags and sets a
    // `.*` disable policy: that no-tools contract must win over the exclusive
    // posture's otherwise-mandatory code_execution.
    const result = await applyToolPolicyAndExperiments({
      allTools: { bash: executableTool("Run a command"), todo_write: executableTool("Todos") },
      effectiveToolPolicy: [{ regex_match: ".*", action: "disable" }],
      experiments: { programmaticToolCalling: true },
      emitNestedToolEvent: () => undefined,
    });
    expect(Object.keys(result)).toEqual([]);
  });

  test("an allowlist that re-enables code_execution keeps the exclusive entry point", async () => {
    // [disable .*, enable code_execution] empties the base-tool record, but
    // the last matching rule explicitly enables the synthesized entry point —
    // it must not be misread as a no-tools contract.
    const result = await applyToolPolicyAndExperiments({
      allTools: { bash: executableTool("Run a command") },
      effectiveToolPolicy: [
        { regex_match: ".*", action: "disable" },
        { regex_match: "code_execution", action: "enable" },
      ],
      experiments: { programmaticToolCalling: true },
      emitNestedToolEvent: () => undefined,
    });
    expect(Object.keys(result)).toEqual(["code_execution"]);
  });

  test("policy-required bridgeable tools stay model-visible in the exclusive set", async () => {
    // "require" gates run completion on a TOP-LEVEL toolResult for that name
    // (StreamManager.createStopWhenCondition); a nested xum.* call never
    // satisfies it, so the required tool must not be bridged away.
    const result = await applyToolPolicyAndExperiments({
      allTools: {
        bash: executableTool("Run a command"),
        file_read: executableTool("Read a file"),
      },
      effectiveToolPolicy: [{ regex_match: "bash", action: "require" }],
      experiments: { programmaticToolCalling: true },
      emitNestedToolEvent: () => undefined,
    });
    expect(Object.keys(result).sort()).toEqual(["bash", "code_execution"]);

    // The promoted tool leaves the bridge entirely (no duplicated dispatch
    // path that assemble hooks cannot see); other bridgeable tools remain.
    const evalResult = (await result.code_execution.execute!(
      { code: "return [typeof mux.bash, typeof mux.file_read];" },
      { toolCallId: "test-call-id", messages: [], context: undefined }
    )) as { success: boolean; result?: unknown };
    expect(evalResult.success).toBe(true);
    expect(evalResult.result).toEqual(["undefined", "function"]);
  });

  test("grant-denied tools are hidden from the model but stubbed in the sandbox", async () => {
    const result = await applyToolPolicyAndExperiments({
      allTools: {
        bash: executableTool("Run a command"),
        file_read: executableTool("Read a file"),
      },
      effectiveToolPolicy: undefined,
      experiments: { programmaticToolCalling: true },
      emitNestedToolEvent: () => undefined,
      capabilityGrants: {
        version: 1,
        bridgeTools: { allow: ["file_read"] },
        vars: false,
        hostEvents: false,
      },
    });

    // Grants are a ceiling on the model-visible set...
    expect(Object.keys(result)).not.toContain("bash");
    expect(Object.keys(result)).toContain("code_execution");

    // ...but the guest must still get the documented catchable stub error —
    // the bridge is built from the pre-grant set so denied tools are known,
    // not "mux.bash is not a function".
    const evalResult = (await result.code_execution.execute!(
      { code: "try { mux.bash({}); return 'no error'; } catch (e) { return e.message; }" },
      { toolCallId: "test-call-id", messages: [], context: undefined }
    )) as { success: boolean; result?: unknown };
    expect(evalResult.success).toBe(true);
    expect(evalResult.result).toBe("Capability denied: xum.bash is not granted for this sandbox");
  });
});

describe("one tool set across agent-mode switches (#5253)", () => {
  const planPolicy = [
    { regex_match: ".*", action: "disable" as const },
    { regex_match: "file_read", action: "enable" as const },
  ];
  const execPolicy = [
    { regex_match: ".*", action: "disable" as const },
    { regex_match: "file_read|mutate", action: "enable" as const },
  ];

  function toolsWithSideEffect() {
    const calls: unknown[] = [];
    const allTools: Record<string, Tool> = {
      mutate: {
        description: "Change something",
        inputSchema: z.object({}),
        execute: (input: unknown) => {
          calls.push(input);
          return Promise.resolve({ success: true });
        },
      } as unknown as Tool,
      file_read: executableTool("Read a file"),
      secret_admin: executableTool("Allowed by no switchable agent"),
    };
    return { allTools, calls };
  }

  const assemble = (
    allTools: Record<string, Tool>,
    active: typeof planPolicy,
    activeAgentId: string,
    programmaticToolCalling = false
  ) =>
    applyToolPolicyAndExperiments({
      allTools,
      effectiveToolPolicy: active,
      switchableAgentToolPolicies: [active, planPolicy, execPolicy],
      activeAgentId,
      experiments: { programmaticToolCalling },
      emitNestedToolEvent: () => undefined,
    });

  test("advertises the same tools in every mode and refuses the active mode's denied tools", async () => {
    const { allTools, calls } = toolsWithSideEffect();
    const inPlan = await assemble(allTools, planPolicy, "plan");
    const inExec = await assemble(allTools, execPolicy, "exec");

    const shape = (tools: Record<string, Tool>) =>
      JSON.stringify(Object.entries(tools).map(([name, tool]) => [name, tool.description]));
    expect(shape(inPlan)).toBe(shape(inExec));
    // Tools no switchable agent allows stay out, as before.
    expect(Object.keys(inPlan)).toEqual(["mutate", "file_read"]);

    const options = { toolCallId: "call-1", messages: [], context: undefined };
    expect(await inPlan.mutate.execute!({}, options)).toEqual({
      success: false,
      error: "Tool 'mutate' is not allowed in plan mode. Switch agents to use it.",
    });
    expect(calls).toEqual([]);
    expect(await inExec.mutate.execute!({}, options)).toEqual({ success: true });
    expect(calls).toHaveLength(1);
  });

  test("a denied provider-executed tool stays absent instead of getting a local refusal", async () => {
    const { allTools } = toolsWithSideEffect();
    // Provider-executed: the provider runs it server-side, never a local execute.
    allTools.native_search = { type: "provider", id: "test.search", args: {} } as unknown as Tool;
    const nativePolicy = [
      ...execPolicy,
      { regex_match: "native_search", action: "enable" as const },
    ];
    const tools = await applyToolPolicyAndExperiments({
      allTools,
      effectiveToolPolicy: planPolicy,
      switchableAgentToolPolicies: [planPolicy, nativePolicy],
      activeAgentId: "plan",
      emitNestedToolEvent: () => undefined,
    });
    expect(tools.native_search).toBeUndefined();
    expect(tools.mutate).toBeDefined();
  });

  test("an active deny-all policy gets no code_execution even if another mode allows tools", async () => {
    const { allTools } = toolsWithSideEffect();
    const denyAll = [{ regex_match: ".*", action: "disable" as const }];
    const tools = await applyToolPolicyAndExperiments({
      allTools,
      effectiveToolPolicy: denyAll,
      switchableAgentToolPolicies: [denyAll, execPolicy],
      activeAgentId: "quiet",
      experiments: { programmaticToolCalling: true },
      emitNestedToolEvent: () => undefined,
    });
    expect(tools.code_execution).toBeUndefined();
  });

  test("PTC promotes required tools the same way in every mode", async () => {
    const requirePlan = [...planPolicy, { regex_match: "mutate", action: "require" as const }];
    const shapes = await Promise.all(
      [requirePlan, execPolicy].map(async (active) => {
        const { allTools } = toolsWithSideEffect();
        const tools = await applyToolPolicyAndExperiments({
          allTools,
          effectiveToolPolicy: active,
          switchableAgentToolPolicies: [requirePlan, execPolicy],
          activeAgentId: "x",
          experiments: { programmaticToolCalling: true },
          emitNestedToolEvent: () => undefined,
        });
        return JSON.stringify(
          Object.entries(tools).map(([name, tool]) => [name, tool.description])
        );
      })
    );
    expect(shapes[1]).toBe(shapes[0]);
  });

  test("PTC code_execution gets the same refusal without the side effect", async () => {
    const { allTools, calls } = toolsWithSideEffect();
    const tools = await assemble(allTools, planPolicy, "plan", true);
    const evalResult = (await tools.code_execution.execute!(
      { code: "return mux.mutate({});" },
      { toolCallId: "test-call-id", messages: [], context: undefined }
    )) as { success: boolean; result?: unknown };
    expect(evalResult.result).toEqual({
      success: false,
      error: "Tool 'mutate' is not allowed in plan mode. Switch agents to use it.",
    });
    expect(calls).toEqual([]);
  });
});

describe("persistent kernel graduation (RLM mode)", () => {
  const originalEnv = process.env.MUX_SANDBOX_PERSISTENT_MOUNTS;

  beforeEach(() => {
    // Pin the env override off so each test controls persistence explicitly.
    delete process.env.MUX_SANDBOX_PERSISTENT_MOUNTS;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MUX_SANDBOX_PERSISTENT_MOUNTS;
    } else {
      process.env.MUX_SANDBOX_PERSISTENT_MOUNTS = originalEnv;
    }
  });

  async function assembleCodeExecution(opts: {
    rlm?: boolean;
    sandbox?: { workspaceId: string; sessionDir: string };
  }): Promise<Tool> {
    const tools = await applyToolPolicyAndExperiments({
      allTools: { file_read: executableTool("Read a file") },
      effectiveToolPolicy: undefined,
      experiments: { programmaticToolCalling: true, rlm: opts.rlm },
      emitNestedToolEvent: () => undefined,
      sandbox: opts.sandbox,
    });
    expect(tools.code_execution).toBeDefined();
    return tools.code_execution;
  }

  async function run(tool: Tool, code: string): Promise<{ success: boolean; result?: unknown }> {
    return (await tool.execute!(
      { code },
      { toolCallId: "test-call-id", messages: [], context: undefined }
    )) as { success: boolean; result?: unknown };
  }

  test("rlm on: persistent mount is used — vars survive across two invocations in one session", async () => {
    using tmp = new DisposableTempDir("tool-assembly-rlm-on");
    const scopeKey = "ws-tool-assembly-rlm-on";
    try {
      const codeExecution = await assembleCodeExecution({
        rlm: true,
        sandbox: { workspaceId: scopeKey, sessionDir: tmp.path },
      });
      expect(codeExecution.description).toContain("Persistent kernel");

      const first = await run(codeExecution, "vars.total = 40; return vars.total;");
      expect(first.success).toBe(true);
      expect(first.result).toBe(40);

      const second = await run(codeExecution, "vars.total += 2; return vars.total;");
      expect(second.success).toBe(true);
      expect(second.result).toBe(42);
    } finally {
      await sandboxHostService.disposeScope(scopeKey);
    }
  });

  test("rlm off: ephemeral per-call runtime and unchanged description", async () => {
    using tmp = new DisposableTempDir("tool-assembly-rlm-off");
    const withSandbox = await assembleCodeExecution({
      sandbox: { workspaceId: "ws-tool-assembly-rlm-off", sessionDir: tmp.path },
    });
    const withoutSandbox = await assembleCodeExecution({});

    // With the experiment off, sandbox context alone must not change the
    // model-visible description (byte-identical to today's ephemeral tool).
    expect(withSandbox.description).toBe(withoutSandbox.description);
    expect(withSandbox.description).not.toContain("Persistent kernel");

    // Ephemeral runtimes have no kernel `vars` namespace...
    const first = await run(withSandbox, "return typeof vars;");
    expect(first.success).toBe(true);
    expect(first.result).toBe("undefined");

    // ...and state set in one call does not leak into the next (fresh runtime).
    const second = await run(withSandbox, "globalThis.leak = 1; return globalThis.leak;");
    expect(second.success).toBe(true);
    expect(second.result).toBe(1);
    const third = await run(withSandbox, "return typeof globalThis.leak;");
    expect(third.success).toBe(true);
    expect(third.result).toBe("undefined");
  });

  test("refinement_rollback is exposed only with rlm on (and works end-to-end)", async () => {
    using tmp = new DisposableTempDir("tool-assembly-rlm-rollback");
    const scopeKey = "ws-tool-assembly-rlm-rollback";
    const sessionDir = path.join(tmp.path, "sessions", scopeKey);
    const assemble = (experiments: {
      programmaticToolCalling?: boolean;
      rlm?: boolean;
    }): Promise<Record<string, Tool>> =>
      applyToolPolicyAndExperiments({
        allTools: { file_read: executableTool("Read a file") },
        effectiveToolPolicy: undefined,
        experiments,
        emitNestedToolEvent: () => undefined,
        sandbox: { workspaceId: scopeKey, sessionDir },
      });
    try {
      // RLM off (PTC on): no rollback surface, byte-identical to today.
      const rlmOff = await assemble({ programmaticToolCalling: true });
      expect(rlmOff.refinement_rollback).toBeUndefined();

      // rlm flag without the PTC parent: no PTC branch, so no surface either.
      const ptcOff = await assemble({ rlm: true });
      expect(ptcOff.refinement_rollback).toBeUndefined();
      expect(ptcOff.code_execution).toBeUndefined();

      const rlmOn = await assemble({ programmaticToolCalling: true, rlm: true });
      expect(rlmOn.refinement_rollback).toBeDefined();

      // The wired tool rolls back a seeded skill-write row in the sandbox's
      // session dir and reports what changed.
      const skillFile = path.join(tmp.path, "checkout", ".mux", "skills", "s", "SKILL.md");
      await fsPromises.mkdir(path.dirname(skillFile), { recursive: true });
      await fsPromises.writeFile(skillFile, "body", "utf-8");
      await appendRefinementEvent({
        sessionDir,
        workspaceId: scopeKey,
        kind: "skill",
        action: { op: "write", skillName: "s", filePath: "SKILL.md" },
        inverse: { op: "delete-files", paths: [skillFile] },
        evidence: { toolName: "agent_skill_write" },
      });
      const rows = await listRefinements(sessionDir);
      const result = (await rlmOn.refinement_rollback.execute!(
        { id: rows[0].id, reason: "test rollback" },
        { toolCallId: "test-call-id", messages: [], context: undefined }
      )) as { success: boolean; rollbackOf?: string; deleted?: string[] };
      expect(result.success).toBe(true);
      expect(result.rollbackOf).toBe(rows[0].id);
      expect(result.deleted).toEqual([skillFile]);
      const stillExists = await fsPromises.access(skillFile).then(
        () => true,
        () => false
      );
      expect(stillExists).toBe(false);
    } finally {
      await sandboxHostService.disposeScope(scopeKey);
    }
  });

  test("MUX_SANDBOX_PERSISTENT_MOUNTS=1 still opts in without the rlm experiment", async () => {
    using tmp = new DisposableTempDir("tool-assembly-env-mounts");
    const scopeKey = "ws-tool-assembly-env-mounts";
    process.env.MUX_SANDBOX_PERSISTENT_MOUNTS = "1";
    try {
      const codeExecution = await assembleCodeExecution({
        sandbox: { workspaceId: scopeKey, sessionDir: tmp.path },
      });
      expect(codeExecution.description).toContain("Persistent kernel");

      const first = await run(codeExecution, "vars.count = 1; return vars.count;");
      expect(first.success).toBe(true);
      expect(first.result).toBe(1);

      const second = await run(codeExecution, "vars.count += 1; return vars.count;");
      expect(second.success).toBe(true);
      expect(second.result).toBe(2);
    } finally {
      await sandboxHostService.disposeScope(scopeKey);
    }
  });
});

describe("toolset composition (PTC × RLM)", () => {
  const originalEnv = process.env.MUX_SANDBOX_PERSISTENT_MOUNTS;

  beforeEach(() => {
    // Pin the env override off so RLM gating is exercised via the flag alone.
    delete process.env.MUX_SANDBOX_PERSISTENT_MOUNTS;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MUX_SANDBOX_PERSISTENT_MOUNTS;
    } else {
      process.env.MUX_SANDBOX_PERSISTENT_MOUNTS = originalEnv;
    }
  });

  // Bridgeable (bash/file_read/mcp_prompt_get) + non-bridgeable interaction
  // tools (excluded from the sandbox by ToolBridge, must stay top-level).
  const compositionTools = (): Record<string, Tool> => ({
    bash: executableTool("Run a command"),
    file_read: executableTool("Read a file"),
    ask_user_question: executableTool("Ask the user"),
    todo_write: executableTool("Write todos"),
    agent_report: executableTool("Report to parent — taskService reads args from history"),
    mcp_prompt_get: executableTool("Fetch a prompt"),
  });

  const assemble = (
    scopeKey: string,
    sessionDir: string,
    experiments: {
      programmaticToolCalling?: boolean;
      rlm?: boolean;
    },
    capabilityGrants?: Parameters<typeof applyToolPolicyAndExperiments>[0]["capabilityGrants"]
  ): Promise<Record<string, Tool>> =>
    applyToolPolicyAndExperiments({
      allTools: compositionTools(),
      effectiveToolPolicy: undefined,
      experiments,
      emitNestedToolEvent: () => undefined,
      sandbox: { workspaceId: scopeKey, sessionDir },
      capabilityGrants,
    });

  // Exclusive: bridgeable tools reachable only via code_execution; the
  // interaction tools and mcp_prompt_get stay model-visible.
  const EXCLUSIVE_NAMES = [
    "agent_report",
    "ask_user_question",
    "code_execution",
    "mcp_prompt_get",
    "todo_write",
  ];

  test("PTC only: exclusive narrowed set, no kernel surfaces", async () => {
    using tmp = new DisposableTempDir("compose-ptc");
    const tools = await assemble("ws-compose-ptc", tmp.path, { programmaticToolCalling: true });
    expect(Object.keys(tools).sort()).toEqual(EXCLUSIVE_NAMES);
    expect(tools.code_execution.description).not.toContain("Persistent kernel");
    expect(tools.code_execution.description).not.toContain("Kernel-first");
  });

  test("PTC + RLM: kernel-first narrowed set + rollback + kernel-first preamble", async () => {
    using tmp = new DisposableTempDir("compose-ptc-rlm");
    try {
      const tools = await assemble("ws-compose-ptc-rlm", tmp.path, {
        programmaticToolCalling: true,
        rlm: true,
      });
      expect(Object.keys(tools).sort()).toEqual([...EXCLUSIVE_NAMES, "refinement_rollback"].sort());
      // agent_report must stay top-level: taskService reads its args from history.
      expect(tools.agent_report).toBeDefined();
      const desc = (tools.code_execution as { description?: string }).description ?? "";
      expect(desc.startsWith("**Kernel-first workflow:**")).toBe(true);
      expect(desc).toContain("Persistent kernel");
    } finally {
      await sandboxHostService.disposeScope("ws-compose-ptc-rlm");
    }
  });

  test("PTC + RLM re-applies the grants ceiling to non-bridgeable tools and refinement_rollback", async () => {
    using tmp = new DisposableTempDir("compose-excl-rlm-grants");
    try {
      const tools = await assemble(
        "ws-compose-excl-rlm-grants",
        tmp.path,
        { programmaticToolCalling: true, rlm: true },
        {
          version: 1,
          bridgeTools: { allow: ["file_read"] },
          vars: false,
          hostEvents: false,
        }
      );
      // Grants are a ceiling over the WHOLE model-visible set: non-granted
      // interaction tools, mcp_prompt_get, and the synthesized
      // refinement_rollback are all hidden; code_execution stays (exclusive
      // mode's mandatory entry point — the bridge enforces grants inside).
      expect(Object.keys(tools).sort()).toEqual(["code_execution"]);
    } finally {
      await sandboxHostService.disposeScope("ws-compose-excl-rlm-grants");
    }
  });

  test("tool policy disables the synthesized refinement_rollback (exact and broad rules)", async () => {
    // refinement_rollback is synthesized AFTER the assembly-wide policy pass,
    // so the policy ceiling must be re-applied to it — otherwise even a
    // disable-everything policy would leave a model-facing tool that can
    // delete/restore memory and skill files.
    const assembleWithPolicy = (
      scopeKey: string,
      sessionDir: string,
      policy: Parameters<typeof applyToolPolicyAndExperiments>[0]["effectiveToolPolicy"]
    ) =>
      applyToolPolicyAndExperiments({
        allTools: compositionTools(),
        effectiveToolPolicy: policy,
        experiments: { programmaticToolCalling: true, rlm: true },
        emitNestedToolEvent: () => undefined,
        sandbox: { workspaceId: scopeKey, sessionDir },
      });

    using tmp = new DisposableTempDir("compose-rollback-policy");
    try {
      const exact = await assembleWithPolicy("ws-rollback-policy", tmp.path, [
        { regex_match: "refinement_rollback", action: "disable" },
      ]);
      expect(exact.refinement_rollback).toBeUndefined();
      // Only the targeted tool is removed.
      expect(exact.code_execution).toBeDefined();

      const broad = await assembleWithPolicy("ws-rollback-policy", tmp.path, [
        { regex_match: ".*", action: "disable" },
      ]);
      expect(broad.refinement_rollback).toBeUndefined();

      // Sanity: without a policy the tool is present (guards a silently
      // over-broad filter that would make the disable assertions vacuous).
      const none = await assembleWithPolicy("ws-rollback-policy", tmp.path, undefined);
      expect(none.refinement_rollback).toBeDefined();
    } finally {
      await sandboxHostService.disposeScope("ws-rollback-policy");
    }
  });

  test("turn-envelope manifest fingerprints the narrowed PTC + RLM toolset", async () => {
    using tmp = new DisposableTempDir("compose-envelope");
    try {
      const tools = await assemble("ws-compose-envelope", tmp.path, {
        programmaticToolCalling: true,
        rlm: true,
      });
      const manifest = buildToolsetManifest(tools);
      // The manifest must describe the actually-narrowed set: bridged-away
      // tools (bash/file_read) never appear, and entries come back sorted.
      expect(manifest.map((entry) => entry.name)).toEqual(
        [...EXCLUSIVE_NAMES, "refinement_rollback"].sort()
      );
      for (const entry of manifest) {
        expect(entry.schemaHash).toMatch(/^[0-9a-f]{64}$/);
      }
      // Hashes are schema-sensitive: identical empty-object fixture schemas
      // collapse to one hash while code_execution's real schema differs.
      const byName = new Map(manifest.map((entry) => [entry.name, entry.schemaHash]));
      expect(byName.get("agent_report")).toBe(byName.get("todo_write"));
      expect(byName.get("code_execution")).not.toBe(byName.get("agent_report"));
    } finally {
      await sandboxHostService.disposeScope("ws-compose-envelope");
    }
  });
});

describe("resolveBackendGatedPtcExperiments", () => {
  const backendEnabled = new Set(["rlm-mode", "programmatic-tool-calling"]);
  const isEnabled = (id: string) => backendEnabled.has(id);

  test("backfills undefined flags from the backend override", () => {
    // A renderer with no origin-local override sends undefined; the persisted
    // backend override must win or tool assembly diverges from the effective
    // UI / refine gate.
    const resolved = resolveBackendGatedPtcExperiments(undefined, isEnabled);
    expect(resolved.rlm).toBe(true);
    expect(resolved.programmaticToolCalling).toBe(true);
  });

  test("explicit renderer values (true or false) win over the backend", () => {
    const resolved = resolveBackendGatedPtcExperiments({ rlm: false }, isEnabled);
    // Explicit false is NOT backfilled to the backend's true.
    expect(resolved.rlm).toBe(false);
    // Undefined still backfills.
    expect(resolved.programmaticToolCalling).toBe(true);

    // Explicit true wins over a backend-disabled flag.
    const explicitTrue = resolveBackendGatedPtcExperiments(
      { programmaticToolCalling: true },
      () => false
    );
    expect(explicitTrue.programmaticToolCalling).toBe(true);
  });

  test("preserves unrelated experiment flags untouched", () => {
    const resolved = resolveBackendGatedPtcExperiments({ memory: true }, isEnabled);
    expect(resolved.memory).toBe(true);
  });
});

describe("token budget history policy", () => {
  test.each([
    { add: [], allowed: false },
    { add: ["file_read"], allowed: false },
    { add: ["session_history"], allowed: true },
    { add: ["session_.*"], allowed: true },
    { add: [".*"], allowed: true },
  ])("recovery follows the agent allowlist: $add", async ({ add, allowed }) => {
    const policy = resolveToolPolicyForAgent({
      agents: [{ tools: { add } }],
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });
    expect(isSessionHistoryDisabled(policy)).toBe(!allowed);
    const history = executableTool("History");
    const result = await applyToolPolicyAndExperiments({
      allTools: { session_history: history, file_read: executableTool("Read") },
      effectiveToolPolicy: policy,
      experiments: { tokenBudget: true },
      emitNestedToolEvent: () => undefined,
    });
    if (allowed) {
      expect(result.session_history).toBe(history);
    } else {
      expect(result.session_history).toBeUndefined();
    }
  });

  test.each(["exec", "plan", "explore"])(
    "%s retains recovery through its built-in inherited policy",
    async (agentId) => {
      using tempDir = new DisposableTempDir("history-policy");
      const agent = await resolveAgentFrontmatter(
        new LocalRuntime(tempDir.path),
        tempDir.path,
        agentId
      );
      const policy = resolveToolPolicyForAgent({
        agents: [agent],
        isSubagent: agentId === "explore",
        disableTaskToolsForDepth: false,
      });
      const history = executableTool("History");
      const result = await applyToolPolicyAndExperiments({
        allTools: { session_history: history },
        effectiveToolPolicy: policy,
        experiments: { tokenBudget: true },
        emitNestedToolEvent: () => undefined,
      });
      expect(isSessionHistoryDisabled(policy)).toBe(false);
      expect(result.session_history).toBe(history);
    }
  );

  test.each(["session_history", "^session_history$", "session_.*", ".*"])(
    "explicit %s disable blocks assembly and rollover gate",
    async (name) => {
      const policy = resolveToolPolicyForAgent({
        agents: [{ tools: { remove: [name] } }, { tools: { add: [".*"] } }],
        isSubagent: false,
        disableTaskToolsForDepth: false,
      });
      expect(isSessionHistoryDisabled(policy)).toBe(true);
      const result = await applyToolPolicyAndExperiments({
        allTools: { session_history: executableTool("History") },
        effectiveToolPolicy: policy,
        experiments: { tokenBudget: true },
        emitNestedToolEvent: () => undefined,
      });
      expect(result.session_history).toBeUndefined();
    }
  );

  test("the last matching regex rule controls history access", async () => {
    const policy = [
      { regex_match: "session_history", action: "disable" as const },
      { regex_match: ".*", action: "enable" as const },
    ];
    const assemble = (effectiveToolPolicy: typeof policy) =>
      applyToolPolicyAndExperiments({
        allTools: { session_history: executableTool("History") },
        effectiveToolPolicy,
        experiments: { tokenBudget: true },
        emitNestedToolEvent: () => undefined,
      });
    expect(isSessionHistoryDisabled(policy)).toBe(false);
    expect((await assemble(policy)).session_history).toBeDefined();
    const disabledAgain = [...policy, { regex_match: "session_.*", action: "disable" as const }];
    expect(isSessionHistoryDisabled(disabledAgain)).toBe(true);
    expect((await assemble(disabledAgain)).session_history).toBeUndefined();
  });

  test("PTC leaves recovery direct and does not offer it inside the sandbox", async () => {
    const history = executableTool("History");
    const bridge = new ToolBridge({ session_history: history });
    expect(bridge.getNonBridgeableTools().session_history).toBe(history);
    const result = await applyToolPolicyAndExperiments({
      allTools: { session_history: history, file_read: executableTool("Read") },
      effectiveToolPolicy: [
        { regex_match: ".*", action: "disable" },
        { regex_match: "file_read", action: "enable" },
        { regex_match: "session_history", action: "enable" },
      ],
      experiments: { tokenBudget: true, programmaticToolCalling: true },
      emitNestedToolEvent: () => undefined,
    });
    expect(result.session_history).toBe(history);
    const execution = (await result.code_execution.execute!(
      { code: "return typeof mux.session_history;" },
      { toolCallId: "history-ptc", messages: [], context: undefined }
    )) as { success: boolean; result?: unknown };
    expect(execution).toMatchObject({ success: true, result: "undefined" });
  });

  test("token budget honors renderer overrides before backend defaults and needs memory", () => {
    const tokenBudget = (
      experiments: Parameters<typeof resolveBackendGatedPtcExperiments>[0],
      enabled: boolean
    ) => resolveBackendGatedPtcExperiments(experiments, () => enabled).tokenBudget;
    expect(tokenBudget(undefined, true)).toBe(true);
    expect(tokenBudget({ tokenBudget: false }, true)).toBe(false);
    expect(tokenBudget({ tokenBudget: true, memory: true }, false)).toBe(true);
    expect(tokenBudget({ tokenBudget: true, memory: false }, true)).toBe(false);
  });
});

describe("models_list exposure", () => {
  // Built-in agents use `tools.add: [".*"]` with explicit removes, so the read-only
  // catalog must survive every built-in policy, the sub-agent hard-deny and the
  // depth-limit denial (which covers task* only).
  test.each([
    { agentId: "exec", isSubagent: false, disableTaskToolsForDepth: false },
    { agentId: "plan", isSubagent: false, disableTaskToolsForDepth: false },
    { agentId: "explore", isSubagent: true, disableTaskToolsForDepth: false },
    { agentId: "explore", isSubagent: true, disableTaskToolsForDepth: true },
  ])(
    "$agentId (subagent=$isSubagent, depthDenied=$disableTaskToolsForDepth) keeps models_list",
    async ({ agentId, isSubagent, disableTaskToolsForDepth }) => {
      using tempDir = new DisposableTempDir("models-list-policy");
      const agent = await resolveAgentFrontmatter(
        new LocalRuntime(tempDir.path),
        tempDir.path,
        agentId
      );
      const policy = resolveToolPolicyForAgent({
        agents: [agent],
        isSubagent,
        disableTaskToolsForDepth,
      });
      const modelsList = executableTool("List models");
      const result = await applyToolPolicyAndExperiments({
        allTools: { models_list: modelsList, ask_user_question: executableTool("Ask") },
        effectiveToolPolicy: policy,
        experiments: {},
        emitNestedToolEvent: () => undefined,
      });
      expect(result.models_list).toBe(modelsList);
      // Sanity: the sub-agent hard-deny is active in the sub-agent rows (exec removes
      // ask_user_question through its own definition, so only assert where the deny applies).
      if (isSubagent) {
        expect(result.ask_user_question).toBeUndefined();
      }
    }
  );
});
