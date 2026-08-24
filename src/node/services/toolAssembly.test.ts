import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { Tool } from "ai";

import {
  applyToolPolicyAndExperiments,
  reconcileHookReplacedCodeExecution,
  resolveBackendGatedPtcExperiments,
} from "./toolAssembly";
import { buildToolsetManifest } from "./turnEnvelope";
import { sandboxHostService } from "@/node/services/sandbox/sandboxHostService";
import { DisposableTempDir } from "@/node/services/tempDir";
import { appendRefinementEvent } from "@/node/services/refinement/refinementJournal";
import { listRefinements } from "@/node/services/refinement/refinementRollback";

function executableTool(description: string): Tool {
  return {
    description,
    inputSchema: z.object({}),
    execute: () => Promise.resolve({ success: true }),
  } as unknown as Tool;
}

describe("applyToolPolicyAndExperiments", () => {
  test("exclusive PTC mode keeps mcp_prompt_get directly visible", async () => {
    const result = await applyToolPolicyAndExperiments({
      allTools: {
        bash: executableTool("Run a command"),
        mcp_prompt_get: executableTool("Fetch a prompt\n\nAvailable MCP prompts:\n- mcp__s__p"),
      },
      effectiveToolPolicy: undefined,
      experiments: { programmaticToolCallingExclusive: true },
      emitNestedToolEvent: () => undefined,
    });

    const names = Object.keys(result);
    expect(names).toContain("code_execution");
    expect(names).not.toContain("bash");
    // Sandbox declarations keep only the first description line, which would
    // hide the prompt catalog.
    expect(names).toContain("mcp_prompt_get");
    expect(result.mcp_prompt_get.description).toContain("mcp__s__p");
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

describe("toolset composition (PTC × RLM × exclusive)", () => {
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
      programmaticToolCallingExclusive?: boolean;
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

  const SUPPLEMENT_NAMES = [
    "agent_report",
    "ask_user_question",
    "bash",
    "code_execution",
    "file_read",
    "mcp_prompt_get",
    "todo_write",
  ];
  // Exclusive: bridgeable tools reachable only via code_execution; the
  // interaction tools and mcp_prompt_get stay model-visible.
  const EXCLUSIVE_NAMES = [
    "agent_report",
    "ask_user_question",
    "code_execution",
    "mcp_prompt_get",
    "todo_write",
  ];

  test("PTC only: supplement set, no kernel surfaces", async () => {
    using tmp = new DisposableTempDir("compose-ptc");
    const tools = await assemble("ws-compose-ptc", tmp.path, { programmaticToolCalling: true });
    expect(Object.keys(tools).sort()).toEqual(SUPPLEMENT_NAMES);
    expect(tools.code_execution.description).not.toContain("Persistent kernel");
    expect(tools.code_execution.description).not.toContain("Kernel-first");
  });

  test("PTC + RLM: exclusive-only — RLM forces the kernel-first narrowed set", async () => {
    // RLM is exclusive-only: supplement-mode RLM measured ~2x flat tokens/cost
    // (flat schemas + kernel defs shipped while models took the flat path), so
    // the rlm flag implies the exclusive posture even without the exclusive
    // experiment. This pins the removal of supplement-mode RLM.
    using tmp = new DisposableTempDir("compose-ptc-rlm");
    try {
      const tools = await assemble("ws-compose-ptc-rlm", tmp.path, {
        programmaticToolCalling: true,
        rlm: true,
      });
      expect(Object.keys(tools).sort()).toEqual([...EXCLUSIVE_NAMES, "refinement_rollback"].sort());
      expect(tools.code_execution.description).toContain("Persistent kernel");
      expect(tools.code_execution.description).toContain("Kernel-first");
    } finally {
      await sandboxHostService.disposeScope("ws-compose-ptc-rlm");
    }
  });

  test("exclusive only: narrowed set, descriptions unchanged (no kernel surfaces)", async () => {
    using tmp = new DisposableTempDir("compose-excl");
    const tools = await assemble("ws-compose-excl", tmp.path, {
      programmaticToolCallingExclusive: true,
    });
    expect(Object.keys(tools).sort()).toEqual(EXCLUSIVE_NAMES);
    expect(tools.code_execution.description).not.toContain("Persistent kernel");
    expect(tools.code_execution.description).not.toContain("Kernel-first");
  });

  test("exclusive + RLM: single-kernel posture — narrowed set + rollback + kernel-first preamble", async () => {
    using tmp = new DisposableTempDir("compose-excl-rlm");
    try {
      const tools = await assemble("ws-compose-excl-rlm", tmp.path, {
        programmaticToolCallingExclusive: true,
        rlm: true,
      });
      expect(Object.keys(tools).sort()).toEqual([...EXCLUSIVE_NAMES, "refinement_rollback"].sort());
      // agent_report must stay top-level: taskService reads its args from history.
      expect(tools.agent_report).toBeDefined();
      const desc = (tools.code_execution as { description?: string }).description ?? "";
      expect(desc.startsWith("**Kernel-first workflow:**")).toBe(true);
      expect(desc).toContain("Persistent kernel");
    } finally {
      await sandboxHostService.disposeScope("ws-compose-excl-rlm");
    }
  });

  test("exclusive + RLM re-applies the grants ceiling to non-bridgeable tools and refinement_rollback", async () => {
    using tmp = new DisposableTempDir("compose-excl-rlm-grants");
    try {
      const tools = await assemble(
        "ws-compose-excl-rlm-grants",
        tmp.path,
        { programmaticToolCallingExclusive: true, rlm: true },
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

  test("turn-envelope manifest fingerprints the narrowed exclusive + RLM toolset", async () => {
    using tmp = new DisposableTempDir("compose-envelope");
    try {
      const tools = await assemble("ws-compose-envelope", tmp.path, {
        programmaticToolCallingExclusive: true,
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

describe("reconcileHookReplacedCodeExecution", () => {
  test("spread-style wrapper gets the rebuilt description but keeps its execute", () => {
    const preHook = executableTool("defs: function bash; function file_read");
    // Middleware wrapped by spreading the pre-hook tool: same description,
    // new execute.
    const wrappedExecute = () => Promise.resolve({ success: true, audited: true });
    const hookReplacement: Tool = { ...preHook, execute: wrappedExecute };
    const rebuilt = executableTool("defs: function file_read");

    const result = reconcileHookReplacedCodeExecution(preHook, hookReplacement, rebuilt);

    // Model-facing metadata follows the rebuilt toolset (bash removed)...
    expect(result.description).toBe("defs: function file_read");
    // ...while the middleware's execution wrapper is preserved.
    expect(result.execute).toBe(wrappedExecute);
  });

  test("middleware-authored description is preserved", () => {
    const preHook = executableTool("defs: function bash; function file_read");
    const hookReplacement = executableTool("audited code execution");
    const rebuilt = executableTool("defs: function file_read");

    const result = reconcileHookReplacedCodeExecution(preHook, hookReplacement, rebuilt);

    // Middleware took ownership of the model-facing contract; return it as-is.
    expect(result).toBe(hookReplacement);
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
    expect(resolved.programmaticToolCallingExclusive).toBe(false);
  });

  test("explicit renderer values (true or false) win over the backend", () => {
    const resolved = resolveBackendGatedPtcExperiments(
      { rlm: false, programmaticToolCallingExclusive: true },
      isEnabled
    );
    // Explicit false is NOT backfilled to the backend's true.
    expect(resolved.rlm).toBe(false);
    expect(resolved.programmaticToolCallingExclusive).toBe(true);
    // Undefined still backfills.
    expect(resolved.programmaticToolCalling).toBe(true);
  });

  test("preserves unrelated experiment flags untouched", () => {
    const resolved = resolveBackendGatedPtcExperiments({ memory: true }, isEnabled);
    expect(resolved.memory).toBe(true);
  });
});
