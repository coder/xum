/**
 * Reads the `servers` of an mcp.jsonc file and reports what Xum cannot use (#2060).
 *
 * jsonc.parse is fault tolerant: without an error list, a syntax error inside one entry
 * silently dropped that entry's fields, so the server stayed listed with an empty command
 * and could never start, and nothing was logged. Here every syntax error and every entry
 * that is not a server becomes a problem with its line and column. The broken entry is
 * skipped and the valid entries stay usable.
 */
import * as jsonc from "jsonc-parser";
import type { MCPConfigProblem } from "@/common/types/mcp";

/** The documented example uses comments and trailing commas: both are valid here. */
const PARSE_OPTIONS: jsonc.ParseOptions = { allowTrailingComma: true, allowEmptyContent: true };

export interface ParsedMcpServers {
  /** Name and raw value of each usable entry, in file order (a later duplicate wins). */
  entries: Array<[string, unknown]>;
  problems: MCPConfigProblem[];
}

/** Why an entry is not a server, or null when it is one (a command string or an object). */
function entryProblem(entry: unknown): string | null {
  if (typeof entry === "string") return entry.trim() === "" ? "the command is empty" : null;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return "must be a command string or an object";
  }
  const { command, url } = entry as Record<string, unknown>;
  if (typeof url === "string" && url.trim() !== "") return null;
  if (typeof command === "string" && command.trim() !== "") return null;
  return "has no command or url";
}

/** "ColonExpected" -> "colon expected". */
function describeParseError(code: jsonc.ParseErrorCode): string {
  return jsonc
    .printParseErrorCode(code)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

function problemAt(
  raw: string,
  offset: number,
  server: string | null,
  message: string
): MCPConfigProblem & { offset: number } {
  const before = raw.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - (before.lastIndexOf("\n") + 1) + 1;
  return { offset, line, column, server, message };
}

function propertyName(property: jsonc.Node): string | null {
  const key = property.children?.[0];
  return key?.type === "string" && typeof key.value === "string" ? key.value : null;
}

export function parseMcpConfigServers(raw: string): ParsedMcpServers {
  const errors: jsonc.ParseError[] = [];
  const root = jsonc.parseTree(raw, errors, PARSE_OPTIONS);
  const problems: Array<MCPConfigProblem & { offset: number }> = [];

  let properties: jsonc.Node[] = [];
  if (root !== undefined && root.type !== "object") {
    problems.push(problemAt(raw, root.offset, null, "the file must hold a JSON object"));
  } else if (root !== undefined) {
    const servers = jsonc.findNodeAtLocation(root, ["servers"]);
    if (servers !== undefined && servers.type !== "object") {
      problems.push(problemAt(raw, servers.offset, null, '"servers" must be an object'));
    } else {
      properties = servers?.children ?? [];
    }
  }

  // A syntax error inside an entry breaks that entry only: skip it and name it.
  const broken = new Set<jsonc.Node>();
  for (const error of errors) {
    const property = properties.find(
      (node) => error.offset >= node.offset && error.offset < node.offset + node.length
    );
    if (property !== undefined) broken.add(property);
    const server = property === undefined ? null : propertyName(property);
    problems.push(problemAt(raw, error.offset, server, describeParseError(error.error)));
  }

  const entries: Array<[string, unknown]> = [];
  for (const property of properties) {
    if (broken.has(property)) continue;
    const name = propertyName(property);
    const valueNode = property.children?.[1];
    // A key without a value is a syntax error, already reported above.
    if (name === null || valueNode === undefined) continue;
    const value: unknown = jsonc.getNodeValue(valueNode);
    const problem = entryProblem(value);
    if (problem !== null) {
      problems.push(problemAt(raw, property.offset, name, problem));
      continue;
    }
    entries.push([name, value]);
  }

  problems.sort((a, b) => a.offset - b.offset);
  return { entries, problems: problems.map(({ offset: _offset, ...problem }) => problem) };
}
