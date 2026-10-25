import type { DevToolsStep } from "@/common/types/devtools";

/** A stream step with every optional field empty; tests override only what they check. */
export function makeDevToolsStep(overrides: Partial<DevToolsStep> = {}): DevToolsStep {
  return {
    id: "step-1",
    runId: "run-1",
    stepNumber: 1,
    type: "stream",
    modelId: "claude-sonnet",
    provider: null,
    startedAt: "2026-10-13T00:00:00.000Z",
    durationMs: null,
    input: null,
    output: null,
    usage: null,
    error: null,
    rawRequest: null,
    requestHeaders: null,
    responseHeaders: null,
    rawResponse: null,
    rawChunks: null,
    inputTransformations: null,
    ...overrides,
  };
}
