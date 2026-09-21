import type { MuxMessage, MuxMessageMetadata } from "@/common/types/message";
import { PLAN_REVIEW_METADATA_TYPE } from "@/constants/planReview";
import {
  PlanReviewRecordSchema,
  type PlanReviewRecord,
  type PlanReviewRecordKind,
} from "./planReviewRecord";

/**
 * `<mux_plan_review>` envelope: JSON record framed by a root XML tag, same escaping and parse
 * strictness as the agent peer-message envelope (agentMessageEnvelope.ts). Feedback rows reach
 * the model in this form; snapshot/resolve/reopen rows are hidden UI state that never leaves the
 * history file.
 */

const ROOT_OPEN = "<mux_plan_review>";
const ROOT_CLOSE = "</mux_plan_review>";
const ROOT_PATTERN = /^<mux_plan_review>\n([\s\S]*)\n<\/mux_plan_review>$/;

/**
 * JSON framing keeps arbitrary user text out of the tag structure, but a literal
 * `</mux_plan_review>` inside a string value could still terminate a tag-based scan. Escape
 * every `</` as `<\/` (a legal JSON string escape) so the payload can never spoof or truncate the
 * envelope while JSON.parse round-trips the text losslessly.
 */
export function formatPlanReviewEnvelope(record: PlanReviewRecord): string {
  const json = JSON.stringify(record, null, 2).replaceAll("</", "<\\/");
  return `${ROOT_OPEN}\n${json}\n${ROOT_CLOSE}`;
}

export function parsePlanReviewEnvelope(content: string): PlanReviewRecord | null {
  const root = ROOT_PATTERN.exec(content);
  if (!root) return null;
  let value: unknown;
  try {
    value = JSON.parse(root[1]);
  } catch {
    return null;
  }
  const parsed = PlanReviewRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Anti-spoof provenance for the model request: only the plan-review send path writes rows whose
 * metadata AND envelope agree, so every other occurrence of the wrapper (pasted text, model
 * output, repository content in tool results) is renamed rather than stripped — the model still
 * sees what was pasted, but cannot mistake it for the review protocol.
 */
export function neutralizePlanReviewEnvelopeLookalikes(text: string): string {
  if (!text.includes("mux_plan_review")) return text;
  return text
    .replaceAll(ROOT_OPEN, "<user_pasted_mux_plan_review>")
    .replaceAll(ROOT_CLOSE, "</user_pasted_mux_plan_review>");
}

/** Validated shape of the persisted `plan-review` metadata variant. */
export type PlanReviewMeta = Extract<MuxMessageMetadata, { type: "plan-review" }>;

const RECORD_KINDS: ReadonlySet<string> = new Set<PlanReviewRecordKind>([
  "snapshot",
  "feedback",
  "resolve",
  "reopen",
]);

function isRecordKind(value: unknown): value is PlanReviewRecordKind {
  return typeof value === "string" && RECORD_KINDS.has(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/**
 * Validate persisted `plan-review` metadata. muxMetadata crosses the history/oRPC boundary as a
 * black box, so a corrupted row can carry the discriminator with malformed fields; consumers
 * must treat null as "not a record" (self-healing rule).
 */
export function getValidPlanReviewMeta(muxMeta: unknown): PlanReviewMeta | null {
  if (typeof muxMeta !== "object" || muxMeta === null) return null;
  const record = muxMeta as Record<string, unknown>;
  if (record.type !== PLAN_REVIEW_METADATA_TYPE) return null;
  if (!isRecordKind(record.kind)) return null;
  if (typeof record.recordId !== "string" || record.recordId.length === 0) return null;
  if (
    !isOptionalString(record.snapshotId) ||
    !isOptionalString(record.threadId) ||
    !isOptionalString(record.feedbackId)
  ) {
    return null;
  }
  return {
    type: PLAN_REVIEW_METADATA_TYPE,
    kind: record.kind,
    recordId: record.recordId,
    ...(record.snapshotId !== undefined ? { snapshotId: record.snapshotId } : {}),
    ...(record.threadId !== undefined ? { threadId: record.threadId } : {}),
    ...(record.feedbackId !== undefined ? { feedbackId: record.feedbackId } : {}),
  };
}

/** Metadata mirror of a record: everything the UI and filters need without re-parsing the text. */
export function buildPlanReviewMetadata(record: PlanReviewRecord): PlanReviewMeta {
  switch (record.kind) {
    case "snapshot":
      return {
        type: PLAN_REVIEW_METADATA_TYPE,
        kind: record.kind,
        recordId: record.recordId,
        snapshotId: record.snapshotId,
      };
    case "feedback":
      return {
        type: PLAN_REVIEW_METADATA_TYPE,
        kind: record.kind,
        recordId: record.recordId,
        snapshotId: record.snapshotId,
        feedbackId: record.feedbackId,
      };
    case "resolve":
    case "reopen":
      return {
        type: PLAN_REVIEW_METADATA_TYPE,
        kind: record.kind,
        recordId: record.recordId,
        threadId: record.threadId,
      };
  }
}

/**
 * Hidden record rows (snapshot/resolve/reopen): UI state persisted in history that must never
 * reach the model, be copied across compaction boundaries, or count as a human turn. Feedback
 * rows are real user messages and are excluded on purpose. Keyed on the discriminator alone so a
 * corrupted record row stays hidden instead of leaking its text into a provider request.
 */
export function isPlanReviewRecordMessage(message: Pick<MuxMessage, "metadata">): boolean {
  const muxMeta = message.metadata?.muxMetadata;
  return muxMeta?.type === PLAN_REVIEW_METADATA_TYPE && muxMeta.kind !== "feedback";
}

/**
 * The record a row carries, or null unless the row is authentic: user role, valid metadata,
 * exactly one text part that is a well-formed envelope, and the parsed identity fields MATCH
 * the metadata (the write path stamps both from the same record). Mirrors
 * getValidAgentPeerMessage: a row where the UI would attribute one record while the text says
 * another must count for nothing.
 */
export function getAuthenticPlanReviewRecord(message: MuxMessage): PlanReviewRecord | null {
  if (message.role !== "user") return null;
  const meta = getValidPlanReviewMeta(message.metadata?.muxMetadata);
  if (meta === null) return null;
  if (message.parts.length !== 1) return null;
  const [part] = message.parts;
  if (part.type !== "text") return null;
  const record = parsePlanReviewEnvelope(part.text);
  if (record === null) return null;
  const expected = buildPlanReviewMetadata(record);
  if (
    expected.kind !== meta.kind ||
    expected.recordId !== meta.recordId ||
    expected.snapshotId !== meta.snapshotId ||
    expected.threadId !== meta.threadId ||
    expected.feedbackId !== meta.feedbackId
  ) {
    return null;
  }
  return record;
}
