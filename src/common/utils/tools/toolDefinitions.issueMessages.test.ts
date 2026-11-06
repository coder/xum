import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { formatToolInputIssues } from "./formatToolInputIssues";
import { TOOL_DEFINITIONS } from "./toolDefinitions";

// Rejection text reaches the model and the shared log, so no issue message may
// quote a submitted value. Inputs come from each schema's JSON Schema with a
// numbered canary in every string position, alone and behind each prefix a
// refinement tests for, so a refinement that interpolates a value fails here.
const CANARY = /canaryZzQ7vL\d+/;
const NUMBER_CANARY = 7031;
const REFINEMENT_SOURCES = ["toolDefinitions.ts", "askUserQuestionSchemas.ts"];

const prefixes = new Set([""]);
for (const file of REFINEMENT_SOURCES) {
  const source = readFileSync(join(import.meta.dir, file), "utf8");
  for (const match of source.matchAll(/(?:startsWith|endsWith|includes)\("([^"\\]*)"\)/g)) {
    prefixes.add(match[1]);
  }
}

let sequence = 0;
const canary = () => `canaryZzQ7vL${sequence++}`;
// Keys reach the label and the received list by design, so they carry a marker
// the assertion does not look for.
const keyMarker = () => `keyMarker${sequence++}`;

type JsonSchema = Record<string, unknown> & {
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  type?: string | string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  minimum?: number;
  maximum?: number;
};

const MAX_DEPTH = 6;
const MAX_CANDIDATES_PER_PROPERTY = 12;

function candidates(node: JsonSchema, depth: number): unknown[] {
  if (depth > MAX_DEPTH) return [canary()];
  const values: unknown[] = [];
  for (const branch of node.anyOf ?? node.oneOf ?? [])
    values.push(...candidates(branch, depth + 1));
  if (node.const !== undefined || node.enum !== undefined) {
    values.push(...(node.enum ?? [node.const]), canary());
  }
  const declared = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  const types =
    declared.length > 0 || values.length > 0
      ? declared
      : ["string", "number", "boolean", "object", "array", "null"];
  for (const type of types) values.push(...typeCandidates(node, type, depth));
  return values;
}

function typeCandidates(node: JsonSchema, type: string, depth: number): unknown[] {
  switch (type) {
    case "string":
      return [...prefixes].map((prefix) => `${prefix}${canary()}`);
    case "number":
    case "integer":
      return [0, 1, 2, -1, 1.5, NUMBER_CANARY, node.minimum, node.maximum].filter(
        (value) => value !== undefined
      );
    case "boolean":
      return [true, false];
    case "null":
      return [null];
    case "array": {
      const items = candidates(node.items ?? {}, depth + 1).slice(0, 6);
      const arrays: unknown[][] = [[], [items[0], items[0]]];
      for (const item of items) arrays.push([item], [items[0], item]);
      return arrays;
    }
    case "object":
      return objectCandidates(node, depth);
    default:
      return [];
  }
}

// A few full objects, then every property varied alone, and at the top level
// every pair varied together, since refinements compare sibling arguments.
function objectCandidates(node: JsonSchema, depth: number): unknown[] {
  const properties = node.properties ?? {};
  const keys = Object.keys(properties);
  const options = Object.fromEntries(
    keys.map((key) => [
      key,
      candidates(properties[key], depth + 1).slice(0, MAX_CANDIDATES_PER_PROPERTY),
    ])
  );
  const pick = (index: number) =>
    Object.fromEntries(
      keys.map((key) => [key, options[key][Math.min(index, options[key].length - 1)]])
    );
  const requiredOnly = (value: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => node.required?.includes(key)));
  const base = pick(0);
  const objects: unknown[] = [];
  for (const index of [0, 1, 2]) objects.push(pick(index), requiredOnly(pick(index)));
  for (const key of keys) {
    for (const value of options[key]) {
      objects.push({ ...base, [key]: value }, { ...requiredOnly(base), [key]: value });
      if (depth > 0) continue;
      for (const other of keys.filter((candidate) => candidate > key)) {
        for (const otherValue of options[other]) {
          objects.push({ ...base, [key]: value, [other]: otherValue });
        }
      }
    }
  }
  if (typeof node.additionalProperties === "object") {
    for (const value of candidates(node.additionalProperties, depth + 1).slice(0, 4)) {
      objects.push({ [keyMarker()]: value });
    }
  }
  objects.push({ ...base, [keyMarker()]: canary() });
  return objects;
}

test("no tool schema's rejection text quotes a submitted value", () => {
  const echoes = new Set<string>();
  let rejections = 0;
  for (const [name, { schema }] of Object.entries(TOOL_DEFINITIONS)) {
    const jsonSchema = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
    const inputs = [...candidates(jsonSchema as JsonSchema, 0), undefined, null, canary()];
    for (const input of inputs) {
      const result = schema.safeParse(input);
      if (result.success) continue;
      rejections += 1;
      const text = formatToolInputIssues(result.error.issues, input);
      if (CANARY.test(text) || text.includes(String(NUMBER_CANARY))) {
        echoes.add(`${name}: ${text.replace(new RegExp(CANARY, "g"), "<canary>")}`);
      }
    }
  }

  expect(rejections).toBeGreaterThan(20_000);
  expect([...echoes]).toEqual([]);
});
