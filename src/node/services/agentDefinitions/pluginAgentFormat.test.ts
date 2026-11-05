import { describe, expect, test } from "bun:test";
import { isToolEnabledByConfigs } from "@/common/utils/agentTools";
import { agentConsentFingerprint } from "@/node/services/agentPlugins/componentConsent";
import { parseAgentDefinitionMarkdown } from "./parseAgentDefinitionMarkdown";
import {
  ForeignPluginAgentToolsError,
  isReadonlyForeignPluginAgent,
  mapForeignPluginAgentFrontmatter,
} from "./pluginAgentFormat";

function parsePluginAgent(frontmatterYaml: string) {
  const content = `---\n${frontmatterYaml}---\nReview the diff and report findings.\n`;
  return parseAgentDefinitionMarkdown({
    content,
    byteSize: Buffer.byteLength(content, "utf8"),
    plugin: { agentId: "reviewer" },
  }).frontmatter;
}

function fingerprint(frontmatter: unknown) {
  return agentConsentFingerprint({ id: "reviewer", file: "reviewer.md", frontmatter });
}

describe("mapForeignPluginAgentFrontmatter readonly", () => {
  test("readonly: true runs on Explore with Explore's prompt before the agent's body", () => {
    const mapped = mapForeignPluginAgentFrontmatter(
      { name: "reviewer", description: "Reviews diffs", readonly: true },
      "reviewer"
    );
    expect(mapped.base).toBe("explore");
    expect(mapped.prompt).toEqual({ append: true });
  });

  test("an agent without readonly runs on Exec with its body as the whole prompt", () => {
    const mapped = mapForeignPluginAgentFrontmatter(
      { name: "reviewer", description: "Reviews diffs" },
      "reviewer"
    );
    expect(mapped.base).toBe("exec");
    expect(mapped.prompt).toEqual({ append: false });
  });

  test("readonly: false is the same as no readonly", () => {
    const mapped = mapForeignPluginAgentFrontmatter(
      { name: "reviewer", description: "Reviews diffs", readonly: false },
      "reviewer"
    );
    expect(mapped.base).toBe("exec");
    expect(mapped.prompt).toEqual({ append: false });
  });

  test("the parsed definition keeps the readonly mapping", () => {
    const readonly = parsePluginAgent("description: Reviews diffs\nreadonly: true\n");
    expect(readonly.base).toBe("explore");
    expect(readonly.prompt?.append).toBe(true);

    const writer = parsePluginAgent("description: Reviews diffs\n");
    expect(writer.base).toBe("exec");
    expect(writer.prompt?.append).toBe(false);
  });
});

describe("readonly agent consent fingerprint", () => {
  test("differs between a readonly agent and the same agent without readonly", () => {
    const readonly = parsePluginAgent("description: Reviews diffs\nreadonly: true\n");
    const writer = parsePluginAgent("description: Reviews diffs\n");
    expect(fingerprint(readonly)).not.toBe(fingerprint(writer));
  });

  // RFC section 7 (D13): a readonly agent approved under the old mapping (append: false) asks for
  // consent once after this update, so the fingerprint must cover prompt.append.
  test("a readonly agent approved before Explore's prompt was added no longer matches", () => {
    const current = parsePluginAgent("description: Reviews diffs\nreadonly: true\n");
    const approvedBeforeUpdate = { ...current, prompt: { ...current.prompt, append: false } };
    expect(fingerprint(current)).not.toBe(fingerprint(approvedBeforeUpdate));
  });

  test("is stable for the same readonly agent", () => {
    const first = parsePluginAgent("description: Reviews diffs\nreadonly: true\n");
    const second = parsePluginAgent("description: Reviews diffs\nreadonly: true\n");
    expect(fingerprint(first)).toBe(fingerprint(second));
  });
});

describe("Cursor model: fast and is_background", () => {
  test("model: fast resolves AI settings through Explore and keeps the Exec base", () => {
    const fast = parsePluginAgent("description: Watches CI\nmodel: fast\neffort: low\n");
    expect(fast.base).toBe("exec");
    expect(fast.ai).toEqual({ settingsBase: "explore", thinkingLevel: "low" });
  });

  test("is_background: true writes the background hint; background: true writes nothing", () => {
    expect(parsePluginAgent("description: Watches CI\nis_background: true\n").subagent).toEqual({
      runnable: true,
      background_hint: true,
    });
    expect(parsePluginAgent("description: Watches CI\nbackground: true\n").subagent).toEqual({
      runnable: true,
    });
  });

  test("each written field changes the consent fingerprint", () => {
    const plain = fingerprint(parsePluginAgent("description: Watches CI\n"));
    expect(fingerprint(parsePluginAgent("description: Watches CI\nmodel: fast\n"))).not.toBe(plain);
    expect(
      fingerprint(parsePluginAgent("description: Watches CI\nis_background: true\n"))
    ).not.toBe(plain);
    expect(fingerprint(parsePluginAgent("description: Watches CI\nbackground: true\n"))).toBe(
      plain
    );
  });
});

describe("read-only search lists", () => {
  const BASH_TOOLS = ["bash", "bash_output", "bash_background_list"];
  const SAMPLE_TOOLS = [
    "file_read",
    "attach_file",
    ...BASH_TOOLS,
    "file_edit_insert",
    "task",
    "web_fetch",
  ];

  const map = (extra: Record<string, unknown>) =>
    mapForeignPluginAgentFrontmatter(
      { name: "reviewer", description: "Reviews designs", ...extra },
      "reviewer"
    );
  const toolsOf = (mapped: Record<string, unknown>) =>
    SAMPLE_TOOLS.filter((tool) =>
      isToolEnabledByConfigs(tool, [
        { add: [".*"] },
        ...(mapped.tools != null ? [mapped.tools as { remove: string[] }] : []),
      ])
    );
  const FILE_AND_BASH = ["file_read", "attach_file", ...BASH_TOOLS];

  test("egm's reviewer, [Read, Grep, Glob], runs on Explore with the file and bash tools", () => {
    const mapped = map({ tools: ["Read", "Grep", "Glob"], model: "inherit", color: "yellow" });
    expect(mapped.base).toBe("explore");
    expect(mapped.prompt).toEqual({ append: true });
    expect(toolsOf(mapped)).toEqual(FILE_AND_BASH);
    expect(isReadonlyForeignPluginAgent({ tools: ["Read", "Grep", "Glob"] })).toBe(true);
  });

  test("a comma-separated string and a list of any search names behave the same", () => {
    for (const tools of ["Read, Grep, Glob", ["Grep"], ["Glob", "Read"], "LS", ["Read", "LS"]]) {
      const mapped = map({ tools });
      expect(mapped.base).toBe("explore");
      expect(toolsOf(mapped)).toContain("bash");
    }
  });

  test("egm's synthesizer and bootstrap orchestrator keep their mapping", () => {
    const synthesizer = map({ tools: ["Agent", "Read", "Grep", "Glob", "Write"] });
    expect(synthesizer.base).toBe("exec");
    expect(synthesizer.prompt).toEqual({ append: false });
    expect(toolsOf(synthesizer)).toEqual(["file_read", "attach_file", "file_edit_insert", "task"]);

    const orchestrator = map({
      tools: ["Agent", "Bash", "Read", "Grep", "Glob", "Write", "Edit"],
    });
    expect(orchestrator.base).toBe("exec");
    expect(toolsOf(orchestrator)).toEqual([
      "file_read",
      "attach_file",
      ...BASH_TOOLS,
      "file_edit_insert",
      "task",
    ]);
  });

  test("[Read, Edit, Grep] and [WebFetch, Grep] keep the mapping they had", () => {
    const edit = map({ tools: ["Read", "Edit", "Grep"] });
    expect(edit.base).toBe("exec");
    expect(toolsOf(edit)).toEqual(["file_read", "attach_file"]);

    const web = map({ tools: ["WebFetch", "Grep"] });
    expect(web.base).toBe("exec");
    expect(toolsOf(web)).toEqual(["web_fetch"]);
  });

  test("[read, grep] still resolves to no Xum tool, because names match with case", () => {
    expect(() => map({ tools: ["read", "grep"] })).toThrow(ForeignPluginAgentToolsError);
    expect(isReadonlyForeignPluginAgent({ tools: ["read", "grep"] })).toBe(false);
  });

  test("a specifier or an MCP entry keeps a list out of the rule", () => {
    expect(() => map({ tools: ["Read", "Grep(*.ts)"] })).not.toThrow();
    expect(map({ tools: ["Read", "Grep(*.ts)"] }).base).toBe("exec");
    expect(toolsOf(map({ tools: ["Read", "Grep(*.ts)"] }))).toEqual(["file_read", "attach_file"]);
    const mcp = map({ tools: ["Read", "Grep", "mcp__github"] });
    expect(mcp.base).toBe("exec");
    expect(toolsOf(mcp)).toEqual(["file_read", "attach_file"]);
  });

  test("a list of Read alone is not a search list", () => {
    const mapped = map({ tools: ["Read"] });
    expect(mapped.base).toBe("exec");
    expect(toolsOf(mapped)).toEqual(["file_read", "attach_file"]);
  });

  test("Grep and Glob grant nothing next to Bash or any other tool", () => {
    const mapped = map({ tools: ["Read", "Grep", "Glob", "TodoWrite"] });
    expect(mapped.base).toBe("exec");
    expect(toolsOf(mapped)).not.toContain("bash");
  });

  test("disallowedTools: Bash removes the bash tools and keeps the Explore base", () => {
    const mapped = map({ tools: ["Read", "Grep", "Glob"], disallowedTools: ["Bash"] });
    expect(mapped.base).toBe("explore");
    expect(toolsOf(mapped)).toEqual(["file_read", "attach_file"]);
  });

  test.each([[["Grep", "Glob"]], [["grep", "glob"]], [["Grep(*.ts)", "Glob"]], ["Grep, Glob"]])(
    "disallowedTools %p leaves no search tool, so the list grants no bash",
    (disallowedTools) => {
      const mapped = map({ tools: ["Read", "Grep", "Glob"], disallowedTools });
      expect(mapped.base).toBe("exec");
      expect(mapped.prompt).toEqual({ append: false });
      expect(toolsOf(mapped)).toEqual(["file_read", "attach_file"]);
    }
  );

  test("one search tool left after the denylist is enough", () => {
    const mapped = map({ tools: ["Read", "Grep", "Glob"], disallowedTools: ["Grep"] });
    expect(mapped.base).toBe("explore");
    expect(toolsOf(mapped)).toEqual(FILE_AND_BASH);
  });

  test("the denylist also removes a tool from a list that then fits the rule", () => {
    const mapped = map({ tools: ["Read", "Grep", "Edit"], disallowedTools: ["Edit"] });
    expect(mapped.base).toBe("explore");
    expect(toolsOf(mapped)).toEqual(FILE_AND_BASH);
  });

  test("an entry Xum cannot read keeps a list out of the rule and grants nothing", () => {
    const mapped = map({ tools: ["Read", "Grep", "Bash (npm test)"] });
    expect(mapped.base).toBe("exec");
    expect(toolsOf(mapped)).toEqual(["file_read", "attach_file"]);
  });

  test("a one-letter entry is an unknown tool, and an empty entry is dropped", () => {
    expect(map({ tools: "Read, Grep, X" }).base).toBe("exec");
    expect(map({ tools: "Read, Grep, " }).base).toBe("explore");
  });

  test("an empty list names itself in the error", () => {
    expect(() => map({ tools: [] })).toThrow(/\(empty\)/);
  });

  test("a list with no tools left after the denylist still skips the agent", () => {
    expect(() => map({ tools: ["Grep"], disallowedTools: ["Bash"] })).toThrow(
      ForeignPluginAgentToolsError
    );
  });

  test("LS in disallowedTools does not skip the agent and removes nothing", () => {
    const mapped = map({ disallowedTools: ["LS"] });
    expect(mapped.base).toBe("exec");
    expect(mapped.tools).toBeUndefined();
    expect(() => map({ disallowedTools: ["ls", "Write"] })).not.toThrow();
  });

  test("a search list leaves an agent with readonly: true as it was", () => {
    expect(map({ readonly: true }).base).toBe("explore");
    expect(isReadonlyForeignPluginAgent({ readonly: true })).toBe(true);
    expect(isReadonlyForeignPluginAgent({ tools: ["Read"] })).toBe(false);
  });

  test("the predicate does not throw on a list the mapping refuses", () => {
    expect(isReadonlyForeignPluginAgent({ tools: 42 })).toBe(false);
    expect(isReadonlyForeignPluginAgent({ tools: ["Grep"], disallowedTools: [42] })).toBe(false);
  });

  test("a Xum-format agent never counts as a search list", () => {
    expect(isReadonlyForeignPluginAgent({ base: "exec", tools: ["Read", "Grep"] })).toBe(false);
    expect(isReadonlyForeignPluginAgent({ tools: { add: ["file_read"] } })).toBe(false);
  });

  test("the parsed definition lists a search agent as read-only for the install review", () => {
    const content = `---\ndescription: Reviews\ntools: [Read, Grep, Glob]\n---\nReview.\n`;
    const parsed = parseAgentDefinitionMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf8"),
      plugin: { agentId: "reviewer" },
    });
    expect(parsed.mappedReadonly).toBe(true);
    expect(parsed.frontmatter.base).toBe("explore");
  });

  test("a search agent's fingerprint differs from the same list before A3", () => {
    const before = {
      name: "Reviewer",
      description: "Reviews",
      base: "exec",
      ui: { hidden: true },
      prompt: { append: false },
      subagent: { runnable: true },
      tools: { remove: ["(?!(?:file_read|attach_file)$).*"] },
    };
    const after = parsePluginAgent("description: Reviews\ntools: [Read, Grep, Glob]\n");
    expect(fingerprint(after)).not.toBe(fingerprint(before));
  });
});

describe("mapForeignPluginAgentFrontmatter shape", () => {
  test("an agent with no list or model is hidden, runnable and has no AI defaults", () => {
    const mapped = mapForeignPluginAgentFrontmatter({ description: "Reviews" }, "reviewer");
    expect(mapped).toEqual({
      description: "Reviews",
      name: "reviewer",
      base: "exec",
      ui: { hidden: true },
      subagent: { runnable: true },
      prompt: { append: false },
    });
  });

  test("a name that is set stays, even when empty, so the schema refuses it", () => {
    expect(mapForeignPluginAgentFrontmatter({ name: "", description: "d" }, "reviewer").name).toBe(
      ""
    );
  });

  test("a Xum-format file passes through, and refuses a Claude list next to its fields", () => {
    const xum = { name: "a", base: "exec", description: "d" };
    expect(mapForeignPluginAgentFrontmatter(xum, "a")).toBe(xum);
    expect(() =>
      mapForeignPluginAgentFrontmatter({ ...xum, disallowedTools: ["Bash"] }, "a")
    ).toThrow(ForeignPluginAgentToolsError);
  });
});
