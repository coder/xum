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

type PlacedProblem = MCPConfigProblem & { offset: number };

export interface ParsedMcpServers {
  /** Name and raw value of each usable entry, in file order (a later duplicate wins). */
  entries: Array<[string, unknown]>;
  problems: MCPConfigProblem[];
}

const filled = (value: unknown) => typeof value === "string" && value.trim() !== "";

/** Why an entry is not a server, or null when it is one (a command string or an object). */
function entryProblem(entry: unknown): string | null {
  if (typeof entry === "string") return filled(entry) ? null : "the command is empty";
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return "must be a command string or an object";
  }
  const { command, url } = entry as Record<string, unknown>;
  return filled(url) || filled(command) ? null : "has no command or url";
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
): PlacedProblem {
  const before = raw.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - (before.lastIndexOf("\n") + 1) + 1;
  return { offset, line, column, server, message };
}

function propertyName(property: jsonc.Node): string | null {
  const key = property.children?.[0];
  return key?.type === "string" && typeof key.value === "string" ? key.value : null;
}

/**
 * The value of the last `servers` key: jsonc.parse kept the last of duplicate keys, so that is the
 * block in use. A save would drop the others, so each earlier duplicate is a problem too.
 */
function lastServersValue(
  raw: string,
  root: jsonc.Node,
  problems: PlacedProblem[]
): jsonc.Node | undefined {
  const blocks = (root.children ?? []).filter((property) => propertyName(property) === "servers");
  for (const duplicate of blocks.slice(1)) {
    problems.push(problemAt(raw, duplicate.offset, null, '"servers" appears more than once'));
  }
  return blocks.at(-1)?.children?.[1];
}

/** The property nodes of `servers`, or none when the file or `servers` has the wrong shape. */
function serverProperties(
  raw: string,
  root: jsonc.Node | undefined,
  problems: PlacedProblem[]
): jsonc.Node[] {
  if (root === undefined) return [];
  if (root.type !== "object") {
    problems.push(problemAt(raw, root.offset, null, "the file must hold a JSON object"));
    return [];
  }
  const servers = lastServersValue(raw, root, problems);
  if (servers !== undefined && servers.type !== "object") {
    problems.push(problemAt(raw, servers.offset, null, '"servers" must be an object'));
    return [];
  }
  return servers?.children ?? [];
}

/** Reports each syntax error; returns the entries it falls inside, which are skipped. */
function entriesBrokenBy(
  raw: string,
  errors: jsonc.ParseError[],
  properties: jsonc.Node[],
  problems: PlacedProblem[]
): Set<jsonc.Node> {
  const broken = new Set<jsonc.Node>();
  for (const error of errors) {
    const property = properties.find(
      (node) => error.offset >= node.offset && error.offset < node.offset + node.length
    );
    if (property !== undefined) broken.add(property);
    const server = property === undefined ? null : propertyName(property);
    problems.push(problemAt(raw, error.offset, server, describeParseError(error.error)));
  }
  return broken;
}

export function parseMcpConfigServers(raw: string): ParsedMcpServers {
  const errors: jsonc.ParseError[] = [];
  const root = jsonc.parseTree(raw, errors, PARSE_OPTIONS);
  const problems: PlacedProblem[] = [];
  const properties = serverProperties(raw, root, problems);
  // A syntax error inside an entry breaks that entry only: skip it and name it.
  const broken = entriesBrokenBy(raw, errors, properties, problems);

  const entries: Array<[string, unknown]> = [];
  for (const property of properties) {
    const name = propertyName(property);
    const valueNode = property.children?.[1];
    // A key without a value is a syntax error, already reported above.
    if (broken.has(property) || name === null || valueNode === undefined) continue;
    const value: unknown = jsonc.getNodeValue(valueNode);
    const problem = entryProblem(value);
    if (problem === null) entries.push([name, value]);
    else problems.push(problemAt(raw, property.offset, name, problem));
  }

  problems.sort((a, b) => a.offset - b.offset);
  return { entries, problems: problems.map(({ offset: _offset, ...problem }) => problem) };
}
