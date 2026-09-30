import { describe, expect, test } from "bun:test";
import {
  assertWorkflowStepId,
  canonicalizeWorkflowInput,
  hashWorkflowStepInput,
} from "./workflowReplayKey";

describe("workflow replay keys", () => {
  test("hashes semantically identical object inputs the same regardless of key order", () => {
    const first = hashWorkflowStepInput("source-read", {
      query: "mux workflows",
      limits: { maxSources: 5, languages: ["ts", "tsx"] },
    });
    const second = hashWorkflowStepInput("source-read", {
      limits: { languages: ["ts", "tsx"], maxSources: 5 },
      query: "mux workflows",
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:/);
  });

  test("keeps array order significant", () => {
    expect(hashWorkflowStepInput("fanout", ["a", "b"])).not.toBe(
      hashWorkflowStepInput("fanout", ["b", "a"])
    );
  });

  test("rejects nondeterministic or non-JSON input values instead of silently hashing them", () => {
    expect(() => canonicalizeWorkflowInput({ now: new Date("2026-05-29T00:00:00.000Z") })).toThrow(
      /plain JSON/
    );
    expect(() => canonicalizeWorkflowInput({ missing: undefined })).toThrow(/JSON value/);
    expect(() => canonicalizeWorkflowInput({ bad: Number.NaN })).toThrow(/finite/);
  });

  test("requires stable non-empty step ids for replay-boundary primitives", () => {
    expect(() => assertWorkflowStepId("", "agent")).toThrow(/stable id/);
    expect(() => assertWorkflowStepId("read-sources", "agent")).not.toThrow();
  });
});
