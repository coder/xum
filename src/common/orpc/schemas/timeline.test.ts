import { describe, expect, test } from "bun:test";
import {
  TIMELINE_EVENT_KINDS,
  TimelineEventDraftSchema,
  TimelineEventSchema,
  TimelinePageSchema,
  TimelinePreviewSchema,
} from "./timeline";

const baseEvent = {
  v: 1 as const,
  seq: 1,
  id: "event-1",
  ts: 1_700_000_000_000,
  kind: "turn.completed",
  source: { system: "chat" as const },
};

describe("timeline schemas", () => {
  test("keeps known kinds exhaustive while accepting unknown persisted kinds", () => {
    expect(TIMELINE_EVENT_KINDS).toContain("agent.event");
    expect(TimelineEventSchema.parse({ ...baseEvent, kind: "future.event" }).kind).toBe(
      "future.event"
    );
  });

  test("accepts typed flat event data and rejects untyped fields", () => {
    const parsed = TimelineEventSchema.parse({
      ...baseEvent,
      data: { description: "Pushed the branch", durationMs: 42, category: "milestone" },
    });

    expect(parsed.data).toEqual({
      description: "Pushed the branch",
      durationMs: 42,
      category: "milestone",
    });
    expect(() =>
      TimelineEventSchema.parse({ ...baseEvent, data: { arbitraryPayload: { nested: true } } })
    ).toThrow();
  });

  test("reads future source and anchor shapes that writes still reject", () => {
    const futureRow = {
      ...baseEvent,
      source: { system: "workflow", key: "run-1", origin: "future" },
      anchor: { messageId: "message-1", stepId: "future-step" },
      status: "queued",
      data: { category: "future_category" },
    };

    const page = TimelinePageSchema.parse({
      events: [futureRow],
      nextCursor: null,
      hasOlder: false,
    });

    expect(page.events[0]?.source.system).toBe("workflow");
    expect(page.events[0]?.status).toBe("queued");
    expect(page.events[0]?.anchor).toEqual({ messageId: "message-1" });
    expect(page.events[0]?.data?.category).toBe("future_category");
    expect(() => TimelineEventSchema.parse(futureRow)).toThrow();
  });

  test("defines drafts, pages, and bounded previews for the backend API", () => {
    const draft = TimelineEventDraftSchema.parse({
      ts: baseEvent.ts,
      kind: baseEvent.kind,
      source: baseEvent.source,
      anchor: { historySequence: 7, messageId: "message-1" },
    });
    const page = TimelinePageSchema.parse({
      events: [baseEvent],
      nextCursor: 1,
      hasOlder: true,
    });
    const preview = TimelinePreviewSchema.parse({
      role: "assistant",
      textExcerpt: "Finished the change",
    });

    expect(draft.anchor?.historySequence).toBe(7);
    expect(page.events).toHaveLength(1);
    expect(preview.textExcerpt).toBe("Finished the change");
  });
});
