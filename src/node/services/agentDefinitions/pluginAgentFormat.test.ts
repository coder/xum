import { describe, expect, test } from "bun:test";
import { agentConsentFingerprint } from "@/node/services/agentPlugins/componentConsent";
import { parseAgentDefinitionMarkdown } from "./parseAgentDefinitionMarkdown";
import { mapForeignPluginAgentFrontmatter } from "./pluginAgentFormat";

/** A Cursor agent file as the runtime parses it: plugin format mapping, then the schema. */
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
