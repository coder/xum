import * as crypto from "crypto";
import assert from "@/common/utils/assert";

/**
 * Attempt identity for agent tasks (WorkspaceConfigEntry.taskAttemptId): an opaque, never-reused
 * id minted by every admission that can start a publishing execution. Receipts and claims name
 * attempts by this id, so its shape is asserted at every write and read rather than trusted.
 */
const TASK_ATTEMPT_ID_PATTERN = /^att_[0-9a-f]{16}$/;

export function isTaskAttemptId(value: unknown): value is string {
  return typeof value === "string" && TASK_ATTEMPT_ID_PATTERN.test(value);
}

export function assertTaskAttemptId(value: string, context: string): void {
  assert(isTaskAttemptId(value), `${context}: malformed task attempt id`);
}

export function newTaskAttemptId(): string {
  const id = `att_${crypto.randomBytes(8).toString("hex")}`;
  assertTaskAttemptId(id, "newTaskAttemptId");
  return id;
}
