import { describe, expect, test } from "bun:test";

import {
  formatSubagentReportEnvelope,
  parseSubagentReportEnvelope,
} from "./subagentReportEnvelope";

describe("subagentReportEnvelope", () => {
  test("round-trips arbitrary protocol examples and semantic whitespace", () => {
    const report = {
      taskId: "task-json-framing",
      agentType: "explore",
      status: "completed" as const,
      title: "Checked </title>\n<report_markdown> and </mux_subagent_report>",
      reportMarkdown:
        "    const answer = 42;\nQuoted delimiter:\n</title>\n<report_markdown>\nHard break.  ",
      structuredOutput: {
        example: "</structured_output_json>\n</mux_subagent_report>",
      },
    };

    expect(parseSubagentReportEnvelope(formatSubagentReportEnvelope(report))).toEqual(report);
  });

  test("round-trips model and thinking level metadata", () => {
    const report = {
      taskId: "task-model-metadata",
      agentType: "exec",
      status: "in_progress" as const,
      title: "Progress",
      reportMarkdown: "Working on it",
      model: "anthropic:claude-opus-4-6",
      thinkingLevel: "high" as const,
    };

    expect(parseSubagentReportEnvelope(formatSubagentReportEnvelope(report))).toEqual(report);
  });

  test("drops malformed model/thinking metadata without rejecting the report", () => {
    const parsed = parseSubagentReportEnvelope(`<mux_subagent_report>
{"taskId":"t1","agentType":"exec","status":"completed","title":"Done","reportMarkdown":"Body","model":"","thinkingLevel":"turbo"}
</mux_subagent_report>`);

    expect(parsed).toEqual({
      taskId: "t1",
      agentType: "exec",
      status: "completed",
      title: "Done",
      reportMarkdown: "Body",
    });
  });

  test("parses legacy envelopes without an explicit status as completed", () => {
    const legacy = `<mux_subagent_report>
<task_id>legacy-task</task_id>
<agent_type>review</agent_type>
<title>Legacy result</title>
<report_markdown>
Legacy markdown
</report_markdown>
<structured_output_json>
\`\`\`json
{"score":1}
\`\`\`
</structured_output_json>
</mux_subagent_report>`;

    expect(parseSubagentReportEnvelope(legacy)).toEqual({
      taskId: "legacy-task",
      agentType: "review",
      status: "completed",
      title: "Legacy result",
      reportMarkdown: "Legacy markdown",
      structuredOutput: { score: 1 },
    });
  });

  test("preserves legacy report bodies that quote the old title separator", () => {
    const legacy = `<mux_subagent_report>
<task_id>legacy-protocol-doc</task_id>
<agent_type>explore</agent_type>
<status>completed</status>
<title>Protocol notes</title>
<report_markdown>
Before the quoted separator.
</title>
<report_markdown>
After the quoted separator.
</report_markdown>
</mux_subagent_report>`;

    expect(parseSubagentReportEnvelope(legacy)?.reportMarkdown).toBe(
      "Before the quoted separator.\n</title>\n<report_markdown>\nAfter the quoted separator."
    );
  });

  test("rejects malformed envelopes", () => {
    expect(parseSubagentReportEnvelope("not a report")).toBeNull();
    expect(
      parseSubagentReportEnvelope(`<mux_subagent_report>
{"taskId":"missing-fields"}
</mux_subagent_report>`)
    ).toBeNull();
  });
});
