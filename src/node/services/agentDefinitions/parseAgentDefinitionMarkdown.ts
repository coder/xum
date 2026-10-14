import { AgentDefinitionFrontmatterSchema } from "@/common/orpc/schemas";
import type { AgentDefinitionFrontmatter } from "@/common/types/agentDefinition";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";
import { formatZodIssues, normalizeNewlines, stripUtf8Bom } from "@/node/utils/markdownFrontmatter";
import YAML from "yaml";
import { getErrorMessage } from "@/common/utils/errors";
import { mapForeignPluginAgentFrontmatter } from "./pluginAgentFormat";

export class AgentDefinitionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDefinitionParseError";
  }
}

export interface ParsedAgentDefinitionMarkdown {
  frontmatter: AgentDefinitionFrontmatter;
  body: string;
}

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentDefinitionParseError(message);
  }
}

/**
 * Parse an agent definition markdown file into validated YAML frontmatter + markdown body.
 *
 * Defensive constraints:
 * - Enforces the shared 1MB max file size
 * - Requires YAML frontmatter delimited by `---` on its own line at the top
 *
 * `source: "plugin"` maps Claude Code / Cursor format agents to Xum fields
 * (see pluginAgentFormat.ts). Every plugin agent read must pass it, consent
 * fingerprints included, so they describe the policy that actually runs.
 */
export function parseAgentDefinitionMarkdown(input: {
  content: string;
  byteSize: number;
  source?: "plugin";
}): ParsedAgentDefinitionMarkdown {
  if (input.byteSize > MAX_FILE_SIZE) {
    const sizeMB = (input.byteSize / (1024 * 1024)).toFixed(2);
    const maxMB = (MAX_FILE_SIZE / (1024 * 1024)).toFixed(2);
    throw new AgentDefinitionParseError(
      `Agent definition is too large (${sizeMB}MB). Maximum supported size is ${maxMB}MB.`
    );
  }

  const content = normalizeNewlines(stripUtf8Bom(input.content));

  if (!content.startsWith("---")) {
    throw new AgentDefinitionParseError(
      "Agent definition must start with YAML frontmatter delimited by '---'."
    );
  }

  const lines = content.split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    throw new AgentDefinitionParseError(
      "Agent definition frontmatter start delimiter must be exactly '---'."
    );
  }

  const endIndex = lines.findIndex((line, idx) => idx > 0 && line.trim() === "---");
  if (endIndex === -1) {
    throw new AgentDefinitionParseError(
      "Agent definition frontmatter is missing the closing '---' delimiter."
    );
  }

  const yamlText = lines.slice(1, endIndex).join("\n");
  const body = lines.slice(endIndex + 1).join("\n");

  let raw: unknown;
  try {
    raw = YAML.parse(yamlText);
  } catch (err) {
    const message = getErrorMessage(err);
    throw new AgentDefinitionParseError(`Failed to parse YAML frontmatter: ${message}`);
  }

  assertObject(raw, "Agent definition YAML frontmatter must be a mapping/object.");

  if (input.source === "plugin") {
    try {
      raw = mapForeignPluginAgentFrontmatter(raw);
    } catch (err) {
      throw new AgentDefinitionParseError(getErrorMessage(err));
    }
  }

  const parsed = AgentDefinitionFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentDefinitionParseError(
      `Invalid agent definition frontmatter: ${formatZodIssues(parsed.error.issues)}`
    );
  }

  return { frontmatter: parsed.data, body };
}
