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

/** A problem at a character offset; positions are computed once at the end (withPositions). */
interface PlacedProblem {
  offset: number;
  server: string | null;
  message: string;
}

export interface ParsedMcpServers {
  /** Name and raw value of each usable entry, in file order (a later duplicate wins). */
  entries: Array<[string, unknown]>;
  /** Names of the entries Xum skipped: a higher layer must still shadow these names. */
  skipped: string[];
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

/** 1-based line and column of every problem, in offset order, in one pass over the text. */
function withPositions(text: string, problems: PlacedProblem[]): MCPConfigProblem[] {
  const sorted = [...problems].sort((a, b) => a.offset - b.offset);
  let line = 1;
  let lineStart = 0;
  let scanned = 0;
  return sorted.map(({ offset, server, message }) => {
    for (; scanned < offset; scanned++) {
      if (text.charCodeAt(scanned) === 10) {
        line += 1;
        lineStart = scanned + 1;
      }
    }
    return { line, column: offset - lineStart + 1, server, message };
  });
}

function propertyName(property: jsonc.Node): string | null {
  const key = property.children?.[0];
  return key?.type === "string" && typeof key.value === "string" ? key.value : null;
}

/**
 * The value of the last `servers` key: jsonc.parse kept the last of duplicate keys, so that is the
 * block in use. A save would drop the others, so each earlier duplicate is a problem too.
 */
function lastServersValue(root: jsonc.Node, problems: PlacedProblem[]): jsonc.Node | undefined {
  const blocks = (root.children ?? []).filter((property) => propertyName(property) === "servers");
  for (const duplicate of blocks.slice(1)) {
    problems.push({
      offset: duplicate.offset,
      server: null,
      message: '"servers" appears more than once',
    });
  }
  return blocks.at(-1)?.children?.[1];
}

/** The property nodes of `servers`, or none when the file or `servers` has the wrong shape. */
function serverProperties(root: jsonc.Node | undefined, problems: PlacedProblem[]): jsonc.Node[] {
  if (root === undefined) return [];
  if (root.type !== "object") {
    problems.push({
      offset: root.offset,
      server: null,
      message: "the file must hold a JSON object",
    });
    return [];
  }
  const servers = lastServersValue(root, problems);
  if (servers !== undefined && servers.type !== "object") {
    problems.push({ offset: servers.offset, server: null, message: '"servers" must be an object' });
    return [];
  }
  return servers?.children ?? [];
}

/** Reports each syntax error; returns the entries it falls inside, which are skipped. */
function entriesBrokenBy(
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
    problems.push({ offset: error.offset, server, message: describeParseError(error.error) });
  }
  return broken;
}

export function parseMcpConfigServers(raw: string): ParsedMcpServers {
  // jsonc.parse ignored a leading UTF-8 BOM (common in files saved on Windows); parseTree
  // reports it as an invalid symbol.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const errors: jsonc.ParseError[] = [];
  const root = jsonc.parseTree(text, errors, PARSE_OPTIONS);
  const problems: PlacedProblem[] = [];
  const properties = serverProperties(root, problems);
  // A syntax error inside an entry breaks that entry only: skip it and name it.
  const broken = entriesBrokenBy(errors, properties, problems);

  const entries: Array<[string, unknown]> = [];
  const skipped: string[] = [];
  for (const property of properties) {
    const name = propertyName(property);
    const valueNode = property.children?.[1];
    if (name === null) continue;
    // A syntax error (reported above) or a key without a value: nothing usable.
    if (broken.has(property) || valueNode === undefined) {
      skipped.push(name);
      continue;
    }
    const value: unknown = jsonc.getNodeValue(valueNode);
    const problem = entryProblem(value);
    if (problem === null) {
      entries.push([name, value]);
      continue;
    }
    problems.push({ offset: property.offset, server: name, message: problem });
    skipped.push(name);
  }

  return { entries, skipped, problems: withPositions(text, problems) };
}
