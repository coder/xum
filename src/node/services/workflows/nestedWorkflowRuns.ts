import * as crypto from "node:crypto";

import { WorkflowRunIdSchema } from "@/common/orpc/schemas";
import assert from "@/common/utils/assert";

export const MAX_NESTED_WORKFLOW_DEPTH = 8;

export function deriveChildWorkflowRunId(input: {
  parentRunId: string;
  stepId: string;
  inputHash: string;
}): string {
  assert(input.parentRunId.length > 0, "deriveChildWorkflowRunId: parentRunId is required");
  assert(input.stepId.length > 0, "deriveChildWorkflowRunId: stepId is required");
  assert(input.inputHash.length > 0, "deriveChildWorkflowRunId: inputHash is required");
  const digest = crypto
    .createHash("sha256")
    .update(input.parentRunId)
    .update("\0")
    .update(input.stepId)
    .update("\0")
    .update(input.inputHash)
    .digest("base64url")
    .slice(0, 32);
  const runId = `wfr_child_${digest}`;
  assert(
    WorkflowRunIdSchema.safeParse(runId).success,
    "deriveChildWorkflowRunId: derived child run id must satisfy workflow run id schema"
  );
  return runId;
}
