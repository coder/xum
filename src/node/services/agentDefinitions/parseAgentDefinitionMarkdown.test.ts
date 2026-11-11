import { describe, expect, test } from "bun:test";

import { isToolEnabledByConfigs } from "@/common/utils/agentTools";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";

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

  test("keeps ai.cacheTtl and rejects an unknown TTL like an unknown thinkingLevel", () => {
    const parse = (ai: string) => {
      const content = `---\nname: Cached\nai:\n${ai}\n---\nBody\n`;
      return parseAgentDefinitionMarkdown({ content, byteSize: Buffer.byteLength(content) });
    };

    expect(parse("  cacheTtl: 1h").frontmatter.ai).toEqual({ cacheTtl: "1h" });
    expect(() => parse("  cacheTtl: 2h")).toThrow(AgentDefinitionParseError);
    expect(() => parse("  thinkingLevel: turbo")).toThrow(AgentDefinitionParseError);
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

  test("keeps the body after the closing delimiter exactly", () => {
    const content = "---\nname: a\n---\nline one\nline two\n";
    const result = parseAgentDefinitionMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf-8"),
    });
    expect(result.body).toBe("line one\nline two\n");
  });

  test("accepts a file of exactly the size cap and rejects one byte more", () => {
    const content = "---\nname: a\n---\nBody\n";
    const parse = (byteSize: number) => parseAgentDefinitionMarkdown({ content, byteSize });
    expect(parse(MAX_FILE_SIZE).frontmatter.name).toBe("a");
    expect(() => parse(MAX_FILE_SIZE + 1)).toThrow(AgentDefinitionParseError);
  });

  test("a closing delimiter right after the opening one is an empty frontmatter, not a missing one", () => {
    const content = "---\n---\nBody\n";
    expect(() =>
      parseAgentDefinitionMarkdown({ content, byteSize: Buffer.byteLength(content, "utf-8") })
    ).toThrow("must be a mapping");
  });

  // Claude Code skips an agent file only for a missing name or description, a bad name or bad YAML,
  // so an agent with a long description loads there and must load here (the cap is Xum's own).
  describe("a description over the descriptor's cap", () => {
    const longText = (length: number) =>
      Array.from({ length }, (_, index) => String.fromCharCode(97 + (index % 26))).join("");

    function parseWithDescription(description: string, plugin?: { agentId: string }) {
      const content = `---\nname: Long\ndescription: ${description}\n---\nBody\n`;
      return parseAgentDefinitionMarkdown({
        content,
        byteSize: Buffer.byteLength(content, "utf-8"),
        ...(plugin != null ? { plugin } : {}),
      });
    }

    test("is cut to a 1024-character prefix instead of failing the agent", () => {
      const description = longText(1500);
      const cut = parseWithDescription(description).frontmatter.description;
      expect(cut).toHaveLength(1024);
      expect(description.startsWith(cut ?? "")).toBe(true);
    });

    test("is kept whole at the cap and one under it", () => {
      expect(parseWithDescription(longText(1024)).frontmatter.description).toBe(longText(1024));
      expect(parseWithDescription(longText(1023)).frontmatter.description).toBe(longText(1023));
    });

    test("is not cut through a surrogate pair", () => {
      // The pair's high half is the 1024th UTF-16 unit, so a plain slice would leave it alone.
      const description = `${"a".repeat(1023)}😀tail`;
      expect(parseWithDescription(description).frontmatter.description).toBe("a".repeat(1023));
    });

    test("is cut in a Claude Code plugin agent, which still maps to a hidden runnable agent", () => {
      const { frontmatter } = parseWithDescription(longText(2000), { agentId: "file-id" });
      expect(frontmatter.description).toHaveLength(1024);
      expect(frontmatter.base).toBe("exec");
      expect(frontmatter.subagent?.runnable).toBe(true);
    });

    test("is cut in a block scalar full of examples, the way Claude Code agents are written", () => {
      const example =
        "<example>\nuser: review this\nassistant: launching the reviewer\n</example>\n";
      const block = example.repeat(30).replaceAll(/^/gm, "  ");
      const content = `---\nname: Reviewer\ndescription: |\n${block}---\nBody\n`;
      const { frontmatter } = parseAgentDefinitionMarkdown({
        content,
        byteSize: Buffer.byteLength(content, "utf-8"),
      });
      expect(frontmatter.description).toHaveLength(1024);
      expect(frontmatter.description?.startsWith("<example>\nuser: review this")).toBe(true);
    });

    test("does not loosen another field: a name over its cap still fails the agent", () => {
      const content = `---\nname: ${"n".repeat(129)}\ndescription: ${longText(1500)}\n---\nBody\n`;
      expect(() =>
        parseAgentDefinitionMarkdown({ content, byteSize: Buffer.byteLength(content, "utf-8") })
      ).toThrow(AgentDefinitionParseError);
    });
  });

  describe("plugin source (Claude Code / Cursor format)", () => {
    function parse(frontmatter: string, source?: "plugin") {
      // The fixture file is agents/file-id.md.
      const content = `---\n${frontmatter}\n---\nBody\n`;
      return parseAgentDefinitionMarkdown({
        content,
        byteSize: Buffer.byteLength(content, "utf-8"),
        ...(source != null ? { plugin: { agentId: "file-id" } } : {}),
      }).frontmatter;
    }

    test("an agent with only foreign keys becomes a hidden runnable Exec sub-agent", () => {
      const frontmatter = parse(
        "name: poteto-agent\ndescription: Delegate\nis_background: true",
        "plugin"
      );
      expect(frontmatter).toEqual({
        name: "poteto-agent",
        description: "Delegate",
        base: "exec",
        ui: { hidden: true },
        subagent: { runnable: true, background_hint: true },
        prompt: { append: false },
      });
    });

    test("a plugin agent without name loads under its file's agent ID", () => {
      expect(parse("description: d", "plugin").name).toBe("file-id");
      expect(parse("name: Named\ndescription: d", "plugin").name).toBe("Named");
      // A Xum-format file still requires name.
      expect(() => parse("description: d\nbase: exec", "plugin")).toThrow(
        AgentDefinitionParseError
      );
    });

    test("maps model, effort and readonly", () => {
      const frontmatter = parse(
        "name: a\nmodel: claude-opus-5-5\neffort: high\nreadonly: true",
        "plugin"
      );
      expect(frontmatter.base).toBe("explore");
      expect(frontmatter.ai).toEqual({ model: "anthropic:claude-opus-5-5", thinkingLevel: "high" });

      expect(parse("name: a\nmodel: sonnet", "plugin").ai).toEqual({ model: "sonnet" });
      // inherit (and an unknown effort) leave the AI defaults to inheritance.
      expect(parse("name: a\nmodel: inherit\neffort: turbo", "plugin").ai).toBeUndefined();
      // A mistyped Claude ID or a Cursor ID is not a known model: inherit it.
      expect(parse("name: a\nmodel: claude-sonnet-typo", "plugin").ai).toBeUndefined();
      expect(parse("name: a\nmodel: composer-2", "plugin").ai).toBeUndefined();
    });

    test("Claude tools and disallowedTools lists narrow the base's tools", () => {
      // todo_sync and github_create_issue stand for MCP tools (`<server>_<tool>`), and so
      // can url_context: MCP naming reserves only Xum's own tool names.
      const sample = [
        "file_read",
        "attach_file",
        "file_edit_insert",
        "file_edit_replace_string",
        "bash",
        "bash_output",
        "task",
        "task_await",
        "task_remove",
        "workflow_run",
        "web_fetch",
        "url_context",
        "todo_write",
        "todo_read",
        "todo_sync",
        "memory",
        "github_create_issue",
        "artifact",
        "artifact_read",
      ];
      // Exec enables every tool; the mapped tools.remove patterns narrow it.
      const toolsOf = (frontmatter: string) => {
        const tools = parse(frontmatter, "plugin").tools;
        return sample.filter((tool) =>
          isToolEnabledByConfigs(tool, [{ add: [".*"] }, ...(tools != null ? [tools] : [])])
        );
      };
      // An allowlist grants only built-in tools, never an MCP tool sharing a prefix (todo_sync).
      // A specifier still removes the whole tool in disallowedTools, as in Claude Code.
      expect(
        toolsOf(
          "name: a\ntools: Read, Grep, Edit, Write, TodoWrite, Agent(worker), Bash\ndisallowedTools: [Bash(git push *)]"
        )
      ).toEqual([
        "file_read",
        "attach_file",
        "file_edit_insert",
        "file_edit_replace_string",
        "task",
        "task_await",
        "todo_write",
        "todo_read",
      ]);
      // Edit changes existing files only: file_edit_insert also creates files, as Write does.
      expect(toolsOf("name: a\ntools: Edit, Read")).toEqual([
        "file_read",
        "attach_file",
        "file_edit_replace_string",
      ]);
      // Outside the core tools a name grants nothing, because its Xum tools do more than
      // the Claude tool (Artifact would read pinned shelves, TaskCreate would replace the
      // whole checklist). Provider-native names are never granted (MCP can reuse them).
      expect(toolsOf("name: a\ntools: Artifact, TaskCreate, TaskList, WebSearch, Read")).toEqual([
        "file_read",
        "attach_file",
      ]);
      expect(toolsOf("name: a\ntools: WebFetch")).toEqual(["web_fetch"]);
      // TaskOutput read background output, as task_await and bash_output do.
      expect(toolsOf("name: a\ndisallowedTools: TaskOutput")).not.toContain("task_await");
      // A comma inside a specifier does not split the entry; Agent does not grant workflows.
      expect(toolsOf("name: a\ntools: Agent(worker, researcher), Read")).toEqual([
        "file_read",
        "attach_file",
        "task",
        "task_await",
      ]);
      // Denying Agent also removes workflows, which spawn sub-agents too.
      expect(toolsOf("name: a\ndisallowedTools: Agent, SendMessage")).not.toContain("workflow_run");
      expect(toolsOf("name: a\ndisallowedTools: Write, TodoWrite, WebFetch, bash")).toEqual([
        "file_read",
        "attach_file",
        "task",
        "task_await",
        "task_remove",
        "workflow_run",
        "todo_sync",
        "memory",
        "github_create_issue",
        "artifact",
        "artifact_read",
      ]);
      // A denylist of tools Xum does not have removes nothing: the agent keeps Exec's tools.
      expect(parse("name: a\ndisallowedTools: Grep", "plugin").tools).toBeUndefined();
      expect(parse("name: a\ndisallowedTools: LS", "plugin").tools).toBeUndefined();
    });

    test("Grep, Glob and LS grant the bash tools only in a read-only search list", () => {
      const sample = [
        "file_read",
        "attach_file",
        "bash",
        "bash_output",
        "file_edit_insert",
        "task",
      ];
      const toolsOf = (frontmatter: string) => {
        const { tools } = parse(frontmatter, "plugin");
        return sample.filter((tool) =>
          isToolEnabledByConfigs(tool, [{ add: [".*"] }, ...(tools != null ? [tools] : [])])
        );
      };
      expect(toolsOf("name: a\ntools: Read, Grep, Glob")).toEqual([
        "file_read",
        "attach_file",
        "bash",
        "bash_output",
      ]);
      expect(toolsOf("name: a\ntools: Grep")).toEqual(["bash", "bash_output"]);
      expect(toolsOf("name: a\ntools: LS")).toEqual(["bash", "bash_output"]);
      expect(toolsOf("name: a\ntools: Read, Grep, Edit")).toEqual(["file_read", "attach_file"]);
    });

    test("an allowlist that resolves to no Xum tool skips the agent", () => {
      for (const frontmatter of [
        // Grep and Glob grant the bash tools only in a search list, and Bash is denied here.
        "name: a\ntools: Grep, Glob\ndisallowedTools: Bash",
        "name: a\ntools: LSP, Monitor",
        "name: a\ntools: []",
        "name: a\ntools: Read\ndisallowedTools: Read",
        // Xum cannot narrow a tool to some of its calls, so it does not grant a specifier.
        "name: a\ntools: Bash(npm test)",
        // MCP entries are not translated yet: unresolved in tools, refused in disallowedTools.
        "name: a\ntools: mcp__github",
        "name: a\ndisallowedTools: mcp__github",
        "name: a\ntools: 42",
        // A denylist entry Xum cannot read must not be dropped: the agent would keep that tool.
        "name: a\ndisallowedTools: [Write, 42]",
        "name: a\ndisallowedTools: Bash (git push *)",
        // An unknown denylist name may be a tool Xum has: refuse instead of keeping it.
        "name: a\ndisallowedTools: FutureTool",
        // Claude Code never gives a sub-agent AskUserQuestion, so it does not resolve.
        "name: a\ntools: AskUserQuestion",
        // Xum's heartbeat tool also creates schedules, so CronList cannot grant it.
        "name: a\ntools: CronList",
        // NotebookEdit edits only notebook cells; Xum's edit tools change any file.
        "name: a\ntools: NotebookEdit",
        // task_send_message and task_list reach workspaces outside the agent tree.
        "name: a\ntools: SendMessage, ListAgents",
      ]) {
        expect(() => parse(frontmatter, "plugin")).toThrow(AgentDefinitionParseError);
      }
    });

    test("a Xum-format agent with a Claude tool list is skipped instead of ignoring the list", () => {
      for (const frontmatter of [
        "name: a\nbase: exec\ndisallowedTools: [Bash]",
        "name: a\ntools:\n  add: [file_read]\ndisallowedTools: Bash",
      ]) {
        expect(() => parse(frontmatter, "plugin")).toThrow(AgentDefinitionParseError);
      }
    });

    test("any Xum-only key keeps Xum semantics", () => {
      for (const frontmatter of [
        "name: a\nbase: plan",
        "name: a\ndisabled: true",
        "name: a\nai:\n  model: sonnet",
        "name: a\ntools:\n  add: [file_read]",
        "name: a\nsubagent:\n  runnable: false",
        "name: a\nui:\n  color: red",
        "name: a\nprompt:\n  append: true",
      ]) {
        expect(parse(frontmatter, "plugin")).toEqual(parse(frontmatter));
        expect(parse(frontmatter, "plugin").subagent?.runnable).not.toBe(true);
      }
    });

    test("non-plugin sources keep Xum defaults for foreign-format files", () => {
      expect(parse("name: a\ndescription: d\nis_background: true")).toEqual({
        name: "a",
        description: "d",
      });
    });

    describe("foreign flag", () => {
      const foreignOf = (frontmatter: string, source?: "plugin") => {
        const content = `---\n${frontmatter}\n---\nBody\n`;
        return parseAgentDefinitionMarkdown({
          content,
          byteSize: Buffer.byteLength(content, "utf-8"),
          ...(source != null ? { plugin: { agentId: "file-id" } } : {}),
        }).foreign;
      };

      test("is true for a Claude Code or Cursor format plugin agent", () => {
        expect(foreignOf("name: a\ntools: Read, Grep", "plugin")).toBe(true);
        expect(foreignOf("name: a\nreadonly: true", "plugin")).toBe(true);
        expect(foreignOf("description: only foreign keys", "plugin")).toBe(true);
      });

      test("is false for a Xum-format plugin agent", () => {
        expect(foreignOf("name: a\nbase: exec", "plugin")).toBe(false);
        expect(foreignOf("name: a\ntools:\n  add: [file_read]", "plugin")).toBe(false);
      });

      test("is false for a file that is not a plugin agent, whatever its keys", () => {
        expect(foreignOf("name: a\nreadonly: true")).toBe(false);
        expect(foreignOf("name: a\nis_background: true")).toBe(false);
      });

      test("mappedReadonly is false for a file that is not a plugin agent", () => {
        const content = "---\nname: a\nreadonly: true\n---\nBody\n";
        const parse = (plugin?: { agentId: string }) =>
          parseAgentDefinitionMarkdown({
            content,
            byteSize: Buffer.byteLength(content, "utf-8"),
            ...(plugin != null ? { plugin } : {}),
          }).mappedReadonly;
        expect(parse()).toBe(false);
        expect(parse({ agentId: "file-id" })).toBe(true);
      });
    });
  });
});
