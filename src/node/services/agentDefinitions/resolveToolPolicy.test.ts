import { describe, expect, test } from "bun:test";

import type { AgentLikeForPolicy } from "./resolveToolPolicy";
import { resolveToolPolicyForAgent } from "./resolveToolPolicy";

const advisorDisabledRule = { regex_match: "advisor", action: "disable" } as const;

// Test helper: agents array is ordered child → base (as returned by resolveAgentInheritanceChain)
describe("resolveToolPolicyForAgent", () => {
  test("no tools means all tools disabled", () => {
    const agents: AgentLikeForPolicy[] = [{}];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([{ regex_match: ".*", action: "disable" }, advisorDisabledRule]);
  });

  test("tools.add enables specified patterns", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { add: ["file_read", "bash.*"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "bash.*", action: "enable" },
      advisorDisabledRule,
    ]);
  });

  test("agents can include propose_plan in tools", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { add: ["propose_plan", "file_read"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "propose_plan", action: "enable" },
      { regex_match: "file_read", action: "enable" },
      advisorDisabledRule,
    ]);
  });

  test("child tools.require overrides base tools.require", () => {
    // Chain: child → base
    const agents: AgentLikeForPolicy[] = [
      { tools: { require: ["agent_report"] } },
      { tools: { require: ["propose_plan"] } },
    ];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "agent_report", action: "require" },
      advisorDisabledRule,
    ]);
  });

  test("tools.require uses only the last entry in a layer", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { require: ["propose_plan", "agent_report"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "agent_report", action: "require" },
      advisorDisabledRule,
    ]);
  });

  test("regex-like tools.require entries are ignored", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { require: ["task_.*"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([{ regex_match: ".*", action: "disable" }, advisorDisabledRule]);
  });

  test("subagents skip require filters for hard-denied ask_user_question", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { require: ["ask_user_question"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: true,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "ask_user_question", action: "disable" },
      { regex_match: "propose_plan", action: "disable" },
      { regex_match: "agent_report", action: "enable" },
      advisorDisabledRule,
    ]);
  });

  test("non-plan subagents disable propose_plan and allow agent_report", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { add: ["task", "file_read"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: true,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "task", action: "enable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "ask_user_question", action: "disable" },
      { regex_match: "propose_plan", action: "disable" },
      { regex_match: "agent_report", action: "enable" },
      advisorDisabledRule,
    ]);
  });

  test("non-plan subagents drop inherited agent_report requirements", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { require: ["agent_report"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: true,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "ask_user_question", action: "disable" },
      { regex_match: "propose_plan", action: "disable" },
      { regex_match: "agent_report", action: "enable" },
      advisorDisabledRule,
    ]);
  });

  test("plan-like subagents enable propose_plan and disable agent_report", () => {
    const agents: AgentLikeForPolicy[] = [
      { tools: { add: ["propose_plan", "file_read", "agent_report"] } },
    ];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: true,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "propose_plan", action: "enable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "agent_report", action: "enable" },
      { regex_match: "ask_user_question", action: "disable" },
      { regex_match: "propose_plan", action: "require" },
      { regex_match: "agent_report", action: "disable" },
      advisorDisabledRule,
    ]);
  });

  test("depth limit hard-denies task tools", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { add: ["task", "file_read"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: true,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "task", action: "enable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "task", action: "disable" },
      { regex_match: "task_.*", action: "disable" },
      advisorDisabledRule,
    ]);
  });

  test("depth limit hard-denies task tools for subagents", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { add: ["task", "file_read"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: true,
      disableTaskToolsForDepth: true,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "task", action: "enable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "task", action: "disable" },
      { regex_match: "task_.*", action: "disable" },
      { regex_match: "ask_user_question", action: "disable" },
      { regex_match: "propose_plan", action: "disable" },
      { regex_match: "agent_report", action: "enable" },
      advisorDisabledRule,
    ]);
  });

  test("empty tools.add array means no tools", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { add: [] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([{ regex_match: ".*", action: "disable" }, advisorDisabledRule]);
  });

  test("whitespace in tool patterns is trimmed", () => {
    const agents: AgentLikeForPolicy[] = [{ tools: { add: ["  file_read  ", "  ", "bash"] } }];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "bash", action: "enable" },
      advisorDisabledRule,
    ]);
  });

  test("tools.remove disables specified patterns", () => {
    const agents: AgentLikeForPolicy[] = [
      { tools: { add: ["file_read", "bash", "task"], remove: ["task"] } },
    ];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "bash", action: "enable" },
      { regex_match: "task", action: "enable" },
      { regex_match: "task", action: "disable" },
      advisorDisabledRule,
    ]);
  });

  test("inherits tools from base agent", () => {
    // Chain: review → exec (ordered child → base as returned by resolveAgentInheritanceChain)
    const agents: AgentLikeForPolicy[] = [
      { tools: { remove: ["file_edit_.*"] } }, // review (child)
      { tools: { add: [".*"], remove: ["propose_plan"] } }, // exec (base)
    ];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    // exec: deny-all → enable .* → disable propose_plan
    // review: → disable file_edit_.*
    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: ".*", action: "enable" },
      { regex_match: "propose_plan", action: "disable" },
      { regex_match: "file_edit_.*", action: "disable" },
      advisorDisabledRule,
    ]);
  });

  test("multi-level inheritance", () => {
    // Chain: leaf → middle → base (ordered child → base)
    const agents: AgentLikeForPolicy[] = [
      { tools: { remove: ["task"] } }, // leaf (child)
      { tools: { add: ["task"], remove: ["bash"] } }, // middle
      { tools: { add: ["file_read", "bash"] } }, // base
    ];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    // base: deny-all → enable file_read → enable bash
    // middle: → enable task → disable bash
    // leaf: → disable task
    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "bash", action: "enable" },
      { regex_match: "task", action: "enable" },
      { regex_match: "bash", action: "disable" },
      { regex_match: "task", action: "disable" },
      advisorDisabledRule,
    ]);
  });

  test("child can add tools not in base", () => {
    // Chain: child → base (ordered child → base)
    const agents: AgentLikeForPolicy[] = [
      { tools: { add: ["bash"] } }, // child
      { tools: { add: ["file_read"] } }, // base
    ];
    const policy = resolveToolPolicyForAgent({
      agents,
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });

    expect(policy).toEqual([
      { regex_match: ".*", action: "disable" },
      { regex_match: "file_read", action: "enable" },
      { regex_match: "bash", action: "enable" },
      advisorDisabledRule,
    ]);
  });
});
