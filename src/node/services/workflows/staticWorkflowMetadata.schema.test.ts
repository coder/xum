import { describe, expect, test } from "bun:test";
import { parseStaticWorkflowMetadataLiteral } from "./staticWorkflowMetadata";

// Characterization tests for the JSON Schema that `mux.schema.union(...)` and
// `mux.schema.nullable(...)` produce in a static workflow `meta` literal. Workflow
// args are validated against these schemas, so the `type` lists decide which
// argument values a workflow accepts.

/** Parses `export const meta = { arg: <schemaSource> }` and returns the arg's schema. */
function schemaOf(schemaSource: string): unknown {
  const metadata = parseStaticWorkflowMetadataLiteral(
    `export const meta = { arg: ${schemaSource} };`
  ) as { arg: unknown };
  return metadata.arg;
}

describe("mux.schema.union", () => {
  test("lists each member type once, in first-seen order", () => {
    expect(
      schemaOf("mux.schema.union([mux.schema.string(), mux.schema.number(), mux.schema.string()])")
    ).toEqual({ type: ["string", "number"] });
  });

  test("flattens members that already allow several types", () => {
    expect(
      schemaOf(
        "mux.schema.union([mux.schema.nullable(mux.schema.integer()), mux.schema.boolean(), mux.schema.nullable(mux.schema.string())])"
      )
    ).toEqual({ type: ["integer", "null", "boolean", "string"] });
  });

  test("keeps only string entries of a member's type list", () => {
    expect(schemaOf('mux.schema.union([{ type: ["string", 1, "number"] }])')).toEqual({
      type: ["string", "number"],
    });
  });

  test("an empty union allows no type", () => {
    expect(schemaOf("mux.schema.union([])")).toEqual({ type: [] });
  });

  test("rejects a member without a type, a non-object member, and a non-array argument", () => {
    expect(() => schemaOf('mux.schema.union([{ enum: ["a"] }])')).toThrow();
    expect(() => schemaOf('mux.schema.union(["string"])')).toThrow();
    expect(() => schemaOf("mux.schema.union(mux.schema.string())")).toThrow();
  });
});

describe("mux.schema.nullable", () => {
  test("adds null to a single type and keeps the other schema fields", () => {
    expect(schemaOf("mux.schema.nullable(mux.schema.number({ minimum: 1 }))")).toEqual({
      type: ["number", "null"],
      minimum: 1,
    });
  });

  test("does not repeat null", () => {
    expect(schemaOf('mux.schema.nullable({ type: "null" })')).toEqual({ type: ["null"] });
    expect(schemaOf("mux.schema.nullable(mux.schema.nullable(mux.schema.string()))")).toEqual({
      type: ["string", "null"],
    });
  });

  test("appends null to a type list and drops its non-string entries", () => {
    expect(
      schemaOf("mux.schema.nullable(mux.schema.union([mux.schema.string(), mux.schema.integer()]))")
    ).toEqual({ type: ["string", "integer", "null"] });
    expect(schemaOf('mux.schema.nullable({ type: ["boolean", 2] })')).toEqual({
      type: ["boolean", "null"],
    });
  });

  test("a schema without a type allows only null", () => {
    expect(schemaOf("mux.schema.nullable({ description: 'x' })")).toEqual({
      description: "x",
      type: ["null"],
    });
  });

  test("adds null to an enum once", () => {
    expect(schemaOf('mux.schema.nullable(mux.schema.enum(["a", "b"]))')).toEqual({
      type: ["string", "null"],
      enum: ["a", "b", null],
    });
    expect(schemaOf('mux.schema.nullable({ type: "string", enum: ["a", null] })')).toEqual({
      type: ["string", "null"],
      enum: ["a", null],
    });
  });

  test("rejects a non-object argument", () => {
    expect(() => schemaOf('mux.schema.nullable("string")')).toThrow();
  });
});
