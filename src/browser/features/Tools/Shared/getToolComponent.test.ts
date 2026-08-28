import { describe, expect, test } from "bun:test";

import { AgentReportToolCall } from "../AgentReportToolCall";
import { AgentSkillListToolCall } from "../AgentSkillListToolCall";
import { AgentSkillReadFileToolCall } from "../AgentSkillReadFileToolCall";
import { AgentSkillReadToolCall } from "../AgentSkillReadToolCall";
import { CompleteGoalToolCall } from "../CompleteGoalToolCall";
import { DesktopActionToolCall } from "../DesktopActionToolCall";
import { DesktopScreenshotToolCall } from "../DesktopScreenshotToolCall";
import { GenericToolCall } from "../GenericToolCall";
import { GoogleSearchToolCall } from "../GoogleSearchToolCall";
import { SetGoalToolCall } from "../SetGoalToolCall";
import { WorkflowResumeToolCall, WorkflowRunToolCall } from "../WorkflowRunToolCall";
import { GetGoalToolCall } from "../GetGoalToolCall";
import { HeartbeatToolCall } from "../HeartbeatToolCall";
import { TaskRemoveToolCall, TaskRetitleToolCall, TaskStopToolCall } from "../TaskToolCall";
import { ToolSearchToolCall } from "../ToolSearchToolCall";
import { getToolComponent } from "./getToolComponent";

describe("getToolComponent", () => {
  test("falls back to generic rendering for removed workflow discovery tools", () => {
    expect(getToolComponent("workflow_list", {})).toBe(GenericToolCall);
    expect(getToolComponent("workflow_read", { name: "deep-research" })).toBe(GenericToolCall);
  });

  test("routes the simplified task lifecycle tools", () => {
    expect(getToolComponent("task_retitle", { task_id: "child", title: "Reviewer" })).toBe(
      TaskRetitleToolCall
    );
    expect(getToolComponent("task_stop", { task_ids: ["child"] })).toBe(TaskStopToolCall);
    expect(getToolComponent("task_remove", { task_ids: ["child"] })).toBe(TaskRemoveToolCall);
  });

  test("returns WorkflowRunToolCall for workflow_run", () => {
    const component = getToolComponent("workflow_run", {
      script_path: "skill://deep-research/workflow.js",
    });
    expect(component).toBe(WorkflowRunToolCall);
  });

  test("routes kernel-bounded workflow_run args to the workflow card", () => {
    // Kernel-nested calls with oversized launch args arrive as a marker; the
    // card renders from the attached durable run instead of raw JSON.
    const marker = { __kernelBounded: true, bytes: 18_457, preview: '{"script_path":"skill…' };
    expect(getToolComponent("workflow_run", marker)).toBe(WorkflowRunToolCall);
    expect(
      getToolComponent("workflow_run", { ...marker, script_path: "skill://demo/workflow.js" })
    ).toBe(WorkflowRunToolCall);
    // Other tools keep the generic fallback for bounded args.
    expect(getToolComponent("bash", marker)).toBe(GenericToolCall);
  });

  test("returns WorkflowResumeToolCall for workflow_resume", () => {
    const component = getToolComponent("workflow_resume", { run_id: "wfr_123" });
    expect(component).toBe(WorkflowResumeToolCall);
  });

  test("returns AgentReportToolCall for agent_report", () => {
    const component = getToolComponent("agent_report", { reportMarkdown: "# Hello" });
    expect(component).toBe(AgentReportToolCall);
  });

  test("returns AgentReportToolCall for legacy file-backed agent_report transcripts", () => {
    const component = getToolComponent("agent_report", {
      reportMarkdownPath: "report.md",
      structuredOutputPath: "structured-output.json",
      title: null,
    });
    expect(component).toBe(AgentReportToolCall);
  });

  test("returns AgentReportToolCall for empty legacy file-backed agent_report input", () => {
    expect(getToolComponent("agent_report", {})).toBe(AgentReportToolCall);
  });

  test("returns AgentSkillReadToolCall for agent_skill_read", () => {
    const component = getToolComponent("agent_skill_read", { name: "react-effects" });
    expect(component).toBe(AgentSkillReadToolCall);
  });

  test("returns AgentSkillReadFileToolCall for agent_skill_read_file", () => {
    const component = getToolComponent("agent_skill_read_file", {
      name: "react-effects",
      filePath: "references/README.md",
    });
    expect(component).toBe(AgentSkillReadFileToolCall);
  });

  test("returns AgentSkillListToolCall for agent_skill_list", () => {
    expect(getToolComponent("agent_skill_list", {})).toBe(AgentSkillListToolCall);
    expect(getToolComponent("agent_skill_list", { includeUnadvertised: true })).toBe(
      AgentSkillListToolCall
    );
  });

  test("agent_skill_list falls back to GenericToolCall when args don't conform", () => {
    // includeUnadvertised is boolean.nullish(); a string fails the schema.
    expect(getToolComponent("agent_skill_list", { includeUnadvertised: "yes" })).toBe(
      GenericToolCall
    );
  });

  test("returns DesktopScreenshotToolCall for desktop_screenshot", () => {
    const component = getToolComponent("desktop_screenshot", { scaledWidth: 640 });
    expect(component).toBe(DesktopScreenshotToolCall);
  });

  test("returns DesktopActionToolCall for desktop_click", () => {
    const component = getToolComponent("desktop_click", { x: 12, y: 34 });
    expect(component).toBe(DesktopActionToolCall);
  });

  test("returns SetGoalToolCall for set_goal", () => {
    const component = getToolComponent("set_goal", { objective: "Ship it" });
    expect(component).toBe(SetGoalToolCall);
  });

  test("returns GetGoalToolCall for get_goal", () => {
    const component = getToolComponent("get_goal", {});
    expect(component).toBe(GetGoalToolCall);
  });

  test("returns CompleteGoalToolCall for complete_goal", () => {
    const component = getToolComponent("complete_goal", { summary: "Done." });
    expect(component).toBe(CompleteGoalToolCall);
  });

  test("complete_goal falls back to GenericToolCall when summary is empty (zod min(1) fails)", () => {
    const component = getToolComponent("complete_goal", { summary: "" });
    expect(component).toBe(GenericToolCall);
  });

  test("returns HeartbeatToolCall for heartbeat", () => {
    expect(getToolComponent("heartbeat", { action: "get" })).toBe(HeartbeatToolCall);
    expect(getToolComponent("heartbeat", { action: "set", intervalMs: 30 * 60_000 })).toBe(
      HeartbeatToolCall
    );
  });

  test("heartbeat falls back to GenericToolCall when intervalMs is out of range", () => {
    // 30s is below HEARTBEAT_MIN_INTERVAL_MS (5min); the schema's .min() rejects it.
    expect(getToolComponent("heartbeat", { action: "set", intervalMs: 30_000 })).toBe(
      GenericToolCall
    );
  });

  test("falls back to GenericToolCall when args validation fails", () => {
    const component = getToolComponent("agent_report", { reportMarkdown: "" });
    expect(component).toBe(GenericToolCall);
  });

  test("returns GoogleSearchToolCall for server:GOOGLE_SEARCH_WEB", () => {
    expect(getToolComponent("server:GOOGLE_SEARCH_WEB", { queries: ["gemini 3 pricing"] })).toBe(
      GoogleSearchToolCall
    );
    // Streaming/pending args (not yet parsed) must not bounce to the generic renderer.
    expect(getToolComponent("server:GOOGLE_SEARCH_WEB", {})).toBe(GoogleSearchToolCall);
  });

  test("server:GOOGLE_SEARCH_WEB falls back to GenericToolCall when args don't conform", () => {
    const component = getToolComponent("server:GOOGLE_SEARCH_WEB", { queries: "not-an-array" });
    expect(component).toBe(GenericToolCall);
  });

  test("returns ToolSearchToolCall for tool_catalog_search with valid args", () => {
    expect(getToolComponent("tool_catalog_search", { query: "send slack message" })).toBe(
      ToolSearchToolCall
    );
    expect(getToolComponent("tool_catalog_search", { query: "send slack message", limit: 5 })).toBe(
      ToolSearchToolCall
    );
  });

  test("renders legacy tool_search transcript calls", () => {
    expect(getToolComponent("tool_search", { query: "send slack message" })).toBe(
      ToolSearchToolCall
    );
  });

  test("tool_catalog_search falls back to GenericToolCall when args don't conform", () => {
    expect(getToolComponent("tool_catalog_search", { query: 42 })).toBe(GenericToolCall);
  });

  test("Object.prototype member names fall back to GenericToolCall instead of throwing", () => {
    // toolName flows verbatim from persisted transcripts; inherited members of the
    // registry object must not be treated as entries (self-healing invariant).
    expect(getToolComponent("constructor", {})).toBe(GenericToolCall);
    expect(getToolComponent("__proto__", {})).toBe(GenericToolCall);
    expect(getToolComponent("toString", {})).toBe(GenericToolCall);
  });
});
