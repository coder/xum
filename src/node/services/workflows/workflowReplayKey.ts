import * as crypto from "node:crypto";

import assert from "@/common/utils/assert";

export function assertWorkflowStepId(stepId: string, primitiveName: string): void {
  assert(
    stepId.trim().length > 0,
    `${primitiveName} replay boundary requires a stable id so completed workflow work can be reused`
  );
}

export function hashWorkflowStepInput(stepId: string, input: unknown): string {
  assertWorkflowStepId(stepId, "workflow step");
  const canonical = JSON.stringify({ stepId, input: canonicalizeWorkflowInput(input) });
  return `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
}

export function canonicalizeWorkflowInput(input: unknown): unknown {
  if (input == null || typeof input === "string" || typeof input === "boolean") {
    return input;
  }

  if (typeof input === "number") {
    assert(Number.isFinite(input), "Workflow replay input numbers must be finite");
    return input;
  }

  if (Array.isArray(input)) {
    return input.map((value) => canonicalizeWorkflowInput(value));
  }

  if (typeof input === "object") {
    assert(
      Object.getPrototypeOf(input) === Object.prototype,
      "Workflow replay inputs must be plain JSON objects/arrays"
    );

    const record = input as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const value = record[key];
      assert(
        value !== undefined,
        "Workflow replay inputs must not contain non-JSON value undefined"
      );
      result[key] = canonicalizeWorkflowInput(value);
    }
    return result;
  }

  throw new Error(`Workflow replay inputs must be JSON values, got ${typeof input}`);
}
