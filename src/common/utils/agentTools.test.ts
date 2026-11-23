import { describe, expect, it } from "@jest/globals";
import {
  isExecLikeEditingCapableInResolvedChain,
  isToolEnabledByConfigs,
  isToolEnabledInResolvedChain,
  type ToolsConfig,
} from "./agentTools";

describe("isExecLikeEditingCapableInResolvedChain", () => {
  it("returns true when exec chain enables file_edit_insert", () => {
    const agents = [{ id: "exec", tools: { add: ["file_edit_insert"] } }];

    expect(isExecLikeEditingCapableInResolvedChain(agents)).toBe(true);
  });

  it("returns true when exec chain enables file_edit_replace_string", () => {
    const agents = [{ id: "exec", tools: { add: ["file_edit_replace_string"] } }];

    expect(isExecLikeEditingCapableInResolvedChain(agents)).toBe(true);
  });

  it("returns false when exec chain enables neither edit nor patch-apply tools", () => {
    const agents = [{ id: "exec", tools: { add: ["task"] } }];

    expect(isExecLikeEditingCapableInResolvedChain(agents)).toBe(false);
  });

  it("returns false when chain does not inherit exec", () => {
    const agents = [{ id: "reviewer", tools: { add: ["file_edit_insert"] } }];

    expect(isExecLikeEditingCapableInResolvedChain(agents)).toBe(false);
  });

  it("returns true for patch-applying chains that remove file_edit tools but keep patch apply", () => {
    const agents = [
      {
        id: "reviewer",
        tools: {
          add: ["ask_user_question"],
          remove: ["propose_plan", "file_edit_.*"],
        },
      },
      {
        id: "exec",
        tools: {
          add: [".*"],
          remove: ["propose_plan", "ask_user_question"],
        },
      },
    ];

    expect(isToolEnabledInResolvedChain("file_edit_insert", agents)).toBe(false);
    expect(isToolEnabledInResolvedChain("file_edit_replace_string", agents)).toBe(false);
    expect(isToolEnabledInResolvedChain("task_apply_git_patch", agents)).toBe(true);
    expect(isExecLikeEditingCapableInResolvedChain(agents)).toBe(true);
  });

  it("returns false when task_apply_git_patch is enabled without exec inheritance", () => {
    const agents = [{ id: "reviewer", tools: { add: ["task_apply_git_patch"] } }];

    expect(isExecLikeEditingCapableInResolvedChain(agents)).toBe(false);
  });
});

describe("isToolEnabledByConfigs", () => {
  it("applies add/remove in order", () => {
    const configs: ToolsConfig[] = [{ add: ["file_read", "task"], remove: ["task"] }];

    expect(isToolEnabledByConfigs("file_read", configs)).toBe(true);
    expect(isToolEnabledByConfigs("task", configs)).toBe(false);
  });

  it("tools.require uses last-layer-wins semantics", () => {
    const configs: ToolsConfig[] = [{ require: ["propose_plan"] }, { require: ["agent_report"] }];

    expect(isToolEnabledByConfigs("propose_plan", configs)).toBe(false);
    expect(isToolEnabledByConfigs("agent_report", configs)).toBe(true);
  });

  it("tools.require uses the last entry within a single layer", () => {
    const configs: ToolsConfig[] = [{ require: ["propose_plan", "agent_report"] }];

    expect(isToolEnabledByConfigs("propose_plan", configs)).toBe(false);
    expect(isToolEnabledByConfigs("agent_report", configs)).toBe(true);
  });

  it("regex-like require entries are ignored", () => {
    const configs: ToolsConfig[] = [{ add: ["file_read"], require: ["task_.*"] }];

    expect(isToolEnabledByConfigs("file_read", configs)).toBe(true);
  });

  it("base require remains effective when child omits tools.require", () => {
    const configs: ToolsConfig[] = [{ require: ["propose_plan"] }, { add: ["file_read"] }];

    expect(isToolEnabledByConfigs("propose_plan", configs)).toBe(true);
    expect(isToolEnabledByConfigs("file_read", configs)).toBe(false);
  });

  it("anchors alternation patterns as a whole instead of splitting ^ and $ across branches", () => {
    const configs: ToolsConfig[] = [{ add: ["file_read|bash"] }];

    expect(isToolEnabledByConfigs("file_read", configs)).toBe(true);
    expect(isToolEnabledByConfigs("bash", configs)).toBe(true);
    expect(isToolEnabledByConfigs("file_read_extra", configs)).toBe(false);
    expect(isToolEnabledByConfigs("my_bash", configs)).toBe(false);
  });
});
