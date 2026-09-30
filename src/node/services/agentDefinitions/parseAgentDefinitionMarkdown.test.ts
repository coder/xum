import { describe, expect, test } from "bun:test";

import {
  AgentDefinitionParseError,
  parseAgentDefinitionMarkdown,
} from "./parseAgentDefinitionMarkdown";

describe("parseAgentDefinitionMarkdown", () => {
  test("parses valid YAML frontmatter and body (ignores unknown keys)", () => {
    const content = `---
name: My Agent
description: Does stuff
base: exec
tools:
  add: ["file_read", "bash.*"]
unknownTopLevel: 123
ui:
  hidden: false
  color: "#ff00ff"
  unknownNested: 456
---
# Instructions
Do the thing.
`;

    const result = parseAgentDefinitionMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf-8"),
    });

    expect(result.frontmatter.name).toBe("My Agent");
    expect(result.frontmatter.description).toBe("Does stuff");
    expect(result.frontmatter.base).toBe("exec");
    expect(result.frontmatter.tools).toEqual({ add: ["file_read", "bash.*"] });
    expect(result.frontmatter.ui?.hidden).toBe(false);
    expect(result.frontmatter.ui?.color).toBe("#ff00ff");

    const frontmatterUnknown = result.frontmatter as unknown as Record<string, unknown>;
    expect(frontmatterUnknown.unknownTopLevel).toBeUndefined();

    if (!result.frontmatter.ui) {
      throw new Error("Expected ui to be present");
    }
    const uiUnknown = result.frontmatter.ui as unknown as Record<string, unknown>;
    expect(uiUnknown.unknownNested).toBeUndefined();

    expect(result.body).toContain("# Instructions");
  });

  test("parses subagent workflow-only runnability", () => {
    const content = `---
name: Workflow Runnable
subagent:
  runnable: false
  workflow_runnable: true
  skip_init_hook: true
---
Body
`;

    const result = parseAgentDefinitionMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf-8"),
    });

    expect(result.frontmatter.subagent?.runnable).toBe(false);
    expect(result.frontmatter.subagent?.workflow_runnable).toBe(true);
    expect(result.frontmatter.subagent?.skip_init_hook).toBe(true);
  });

  test("throws on missing frontmatter", () => {
    expect(() =>
      parseAgentDefinitionMarkdown({
        content: "# No frontmatter\n",
        byteSize: 14,
      })
    ).toThrow(AgentDefinitionParseError);
  });

  test("parses tools as add/remove/require patterns", () => {
    const content = `---
name: Regex Tools
tools:
  add:
    - file_read
    - "bash.*"
    - "task_.*"
  remove:
    - task
  require:
    - propose_plan
---
Body
`;

    const result = parseAgentDefinitionMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf-8"),
    });

    expect(result.frontmatter.tools).toEqual({
      add: ["file_read", "bash.*", "task_.*"],
      remove: ["task"],
      require: ["propose_plan"],
    });
  });
});
