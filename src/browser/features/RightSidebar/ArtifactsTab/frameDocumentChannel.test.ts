import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { advanceClock } from "@/browser/testFakeClock";
import {
  FRAME_DOCUMENT_CHECK_CAP_MS,
  FRAME_DOCUMENT_CHECK_DEADLINE_MS,
  FRAME_DOCUMENT_CHECK_LATE_MS,
  FRAME_DOCUMENT_HEARTBEAT_MS,
} from "@/common/constants/artifactInteractions";
import {
  ARTIFACT_BRIDGE_MAX_MESSAGES_PER_SECOND,
  createFrameDocumentChannel,
  mcpAppDocumentChannelScript,
  type FrameDocumentChannel,
} from "./frameDocumentChannel";
import { runFrameDocument, type FrameParent } from "./frameDocument.testHarness";

const tick = () => new Promise((resolve) => setImmediate(resolve));
/** `vi` with the fake-timer method bun implements but bun-types does not declare. */
const fakeTimers = vi as typeof vi & { getTimerCount(): number };

/** A parent window that hands each announcement to `channel`, like the frame hosts do. */
function hostFor(channel: FrameDocumentChannel): FrameParent {
  return {
    postMessage: (data, _targetOrigin, transfer = []) => {
      channel.acceptOpen({ data, ports: transfer });
    },
  };
}

/** An MCP App view document (its preamble's channel part), with what it got as the view. */
function openView(nonce: string, channel: FrameDocumentChannel) {
  const view = runFrameDocument(mcpAppDocumentChannelScript(nonce), hostFor(channel));
  const events: Array<{ data: unknown; source: unknown }> = [];
  view.win.addEventListener("message", (event) => {
    const message = event as unknown as { data: unknown; source: unknown };
    events.push({ data: message.data, source: message.source });
  });
  const parent = view.win.parent as unknown as { postMessage: (message: unknown) => void };
  return { ...view, events, parent };
}

/** A channel bound to a port the test holds: the document side, answering only as told. */
function boundChannel(now?: () => number) {
  const channel = createFrameDocumentChannel("ab12", now);
  const document = new MessageChannel();
  const checks: string[] = [];
  document.port1.onmessage = (event: MessageEvent<{ type?: string; value?: string }>) => {
    if (event.data.type === "check" && event.data.value != null) checks.push(event.data.value);
  };
  const bound = channel.acceptOpen({
    data: { xumFrameDocument: 1, type: "open", nonce: "ab12" },
    ports: [document.port2],
  });
  expect(bound).toBe(true);
  const answer = (value: string) =>
    document.port1.postMessage({ xumFrameDocument: 1, type: "checked", value });
  return { channel, checks, answer, port: document.port1 };
}

describe("frame document channel: MCP App view document", () => {
  // Keys inside the frame never reach the app: a maximized app tab restores on these (#6165).
  test("Escape and Shift+F the view did not handle reach the host as exit", async () => {
    const channel = createFrameDocumentChannel("ab12");
    const received: unknown[] = [];
    let exits = 0;
    channel.setReceiver({
      message: (data) => received.push(data),
      leave: () => undefined,
      exit: () => exits++,
    });
    const view = openView("ab12", channel);
    const { win } = view;
    interface KeyTarget {
      dispatchEvent: (event: InstanceType<typeof win.KeyboardEvent>) => boolean;
    }
    const key = (
      init: { key: string; shiftKey?: boolean; composed?: boolean },
      target: KeyTarget = win
    ) =>
      target.dispatchEvent(
        new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
      );
    key({ key: "Escape" });
    key({ key: "F", shiftKey: true });
    // A view listener that runs after the preamble's (a window-level one) handles it: no exit.
    const keep = (event: { preventDefault: () => void }) => event.preventDefault();
    win.addEventListener("keydown", keep);
    key({ key: "Escape" });
    win.removeEventListener("keydown", keep);
    // Typing a capital F in a text field, or another key: no exit.
    const input = win.document.createElement("input");
    win.document.body.appendChild(input);
    key({ key: "F", shiftKey: true }, input);
    // An input inside an open shadow root: event.target is its non-editable host element.
    const field = win.document.createElement("my-field");
    win.document.body.appendChild(field);
    const shadowInput = win.document.createElement("input");
    field.attachShadow({ mode: "open" }).appendChild(shadowInput);
    key({ key: "F", shiftKey: true, composed: true }, shadowInput);
    key({ key: "f" });
    // The preamble reads defaultPrevented in a task, then the port delivers in another.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    expect(exits).toBe(2);
    expect(received).toEqual([]);
  });

  test("view and host talk only over the port of the document that opened it", async () => {
    const channel = createFrameDocumentChannel("ab12");
    const received: unknown[] = [];
    channel.setReceiver({ message: (data) => received.push(data), leave: () => undefined });
    const view = openView("ab12", channel);

    view.parent.postMessage({ jsonrpc: "2.0", id: 1, method: "ping" });
    channel.post({ jsonrpc: "2.0", id: 1, result: {} });
    await tick();
    expect(received).toEqual([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    // The host's message arrives from window.parent, the source the MCP Apps SDK checks.
    expect(view.events).toEqual([
      { data: { jsonrpc: "2.0", id: 1, result: {} }, source: view.parent },
    ]);
  });

  test("only the first open with the document's nonce binds the channel", async () => {
    const channel = createFrameDocumentChannel("ab12");
    const received: unknown[] = [];
    channel.setReceiver({ message: (data) => received.push(data), leave: () => undefined });
    // An earlier document of the frame does not know this document's nonce.
    const earlier = openView("cd34", channel);
    const view = openView("ab12", channel);
    // A page the view navigated to cannot rebind it, even with the nonce.
    const next = openView("ab12", channel);

    for (const page of [earlier, view, next]) {
      page.parent.postMessage({ jsonrpc: "2.0", method: "from", params: { page: page === view } });
    }
    channel.post({ jsonrpc: "2.0", method: "to-view" });
    await tick();
    expect(received).toEqual([{ jsonrpc: "2.0", method: "from", params: { page: true } }]);
    expect(earlier.events).toEqual([]);
    expect(next.events).toEqual([]);
  });

  // The document's first script hands over exactly one port: its own end of the channel.
  test("an open announcement binds only with exactly one port", async () => {
    const channel = createFrameDocumentChannel("ab12");
    const received: unknown[] = [];
    channel.setReceiver({ message: (data) => received.push(data), leave: () => undefined });
    const open = { xumFrameDocument: 1, type: "open", nonce: "ab12" };
    const first = new MessageChannel();
    const second = new MessageChannel();
    expect(channel.acceptOpen({ data: open, ports: [] })).toBe(false);
    expect(channel.acceptOpen({ data: open, ports: [first.port2, second.port2] })).toBe(false);
    first.port1.postMessage({ from: "two ports" });
    const document = new MessageChannel();
    expect(channel.acceptOpen({ data: open, ports: [document.port2] })).toBe(true);
    document.port1.postMessage({ from: "one port" });
    await tick();
    expect(received).toEqual([{ from: "one port" }]);
    for (const port of [first.port1, second.port1, document.port1]) port.close();
  });

  test("an unloading document closes its frame; a closed channel carries nothing", async () => {
    const channel = createFrameDocumentChannel("ab12");
    const received: unknown[] = [];
    let left = 0;
    channel.setReceiver({ message: (data) => received.push(data), leave: () => left++ });
    const view = openView("ab12", channel);

    view.dispatch("pagehide");
    await tick();
    expect(left).toBe(1);

    channel.close();
    view.parent.postMessage({ jsonrpc: "2.0", id: 2, method: "ping" });
    channel.post({ jsonrpc: "2.0", method: "late" });
    await tick();
    expect(received).toEqual([]);
    expect(view.events).toEqual([]);
  });

  test("a burst over the rate limit drops the extra messages, not the unload", async () => {
    const channel = createFrameDocumentChannel("ab12");
    const received: unknown[] = [];
    let left = 0;
    channel.setReceiver({ message: (data) => received.push(data), leave: () => left++ });
    const view = openView("ab12", channel);
    for (let id = 0; id < ARTIFACT_BRIDGE_MAX_MESSAGES_PER_SECOND + 5; id++) {
      view.parent.postMessage({ jsonrpc: "2.0", id, method: "ping" });
    }
    view.dispatch("pagehide");
    await tick();
    expect(received).toHaveLength(ARTIFACT_BRIDGE_MAX_MESSAGES_PER_SECOND);
    expect(left).toBe(1);
  });
});

describe("frame document channel: checks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("the document answers a check over its port, and the view never sees it", async () => {
    const channel = createFrameDocumentChannel("ab12");
    channel.setReceiver({ message: () => undefined, leave: () => undefined });
    const view = openView("ab12", channel);
    let missed = 0;
    channel.check(() => missed++);
    await advanceClock(FRAME_DOCUMENT_CHECK_DEADLINE_MS + 1);
    expect(missed).toBe(0);
    expect(view.events).toEqual([]);
  });

  test("a document that answers nothing misses the check at the deadline", async () => {
    const { channel } = boundChannel();
    let missed = 0;
    channel.check(() => missed++);
    await advanceClock(FRAME_DOCUMENT_CHECK_DEADLINE_MS - 1);
    expect(missed).toBe(0);
    await advanceClock(1);
    expect(missed).toBe(1);
  });

  // An answer the old document sent just before it died must not clear a check sent after the
  // destination loaded.
  test("only an answer to the latest check clears it", async () => {
    const { channel, checks, answer } = boundChannel();
    let missed = 0;
    channel.check(() => missed++);
    channel.check(() => missed++);
    await advanceClock(1);
    expect(checks).toHaveLength(2);
    expect(checks[0]).not.toBe(checks[1]);
    answer(checks[0]);
    await advanceClock(FRAME_DOCUMENT_CHECK_DEADLINE_MS);
    expect(missed).toBe(1);

    channel.check(() => missed++);
    await advanceClock(1);
    answer(checks[2]);
    await advanceClock(FRAME_DOCUMENT_CHECK_DEADLINE_MS);
    expect(missed).toBe(1);
  });

  // A destination page that reloads itself sends loads; each one must not push the deadline out.
  test("later checks keep the first unanswered check's deadline", async () => {
    const { channel } = boundChannel();
    let missed = 0;
    channel.check(() => missed++);
    await advanceClock(FRAME_DOCUMENT_CHECK_DEADLINE_MS - 100);
    channel.check(() => missed++);
    await advanceClock(100);
    expect(missed).toBe(1);
  });

  test("an answer after a burst over the rate limit still clears the check", async () => {
    const { channel, checks, answer, port } = boundChannel();
    channel.setReceiver({ message: () => undefined, leave: () => undefined });
    let missed = 0;
    channel.check(() => missed++);
    for (let i = 0; i < ARTIFACT_BRIDGE_MAX_MESSAGES_PER_SECOND + 5; i++) port.postMessage({ i });
    await advanceClock(1);
    answer(checks[0]);
    await advanceClock(FRAME_DOCUMENT_CHECK_DEADLINE_MS);
    expect(missed).toBe(0);
  });

  /**
   * The channel's clock, `blocked.ms` ahead of the fake timers: as if the app's thread had been
   * blocked that long, so a timer due now fires that much late.
   */
  function blockedClock() {
    const blocked = { ms: 0 };
    return { blocked, now: () => performance.now() + blocked.ms };
  }

  // The app's own thread was blocked past the deadline, so the document could not answer either.
  test("a deadline that fires late extends the same check and sends no new one", async () => {
    const { blocked, now } = blockedClock();
    const { channel, checks, answer } = boundChannel(now);
    let missed = 0;
    channel.check(() => missed++);
    await advanceClock(1);
    blocked.ms = FRAME_DOCUMENT_CHECK_LATE_MS + 1;
    await advanceClock(FRAME_DOCUMENT_CHECK_DEADLINE_MS);
    expect(missed).toBe(0);
    expect(checks).toHaveLength(1);
    answer(checks[0]);
    await advanceClock(FRAME_DOCUMENT_CHECK_CAP_MS);
    expect(missed).toBe(0);
  });

  test("an extended check that stays unanswered misses one deadline after the late timer", async () => {
    const { blocked, now } = blockedClock();
    const { channel } = boundChannel(now);
    let missed = 0;
    channel.check(() => missed++);
    await advanceClock(1);
    blocked.ms = FRAME_DOCUMENT_CHECK_LATE_MS + 1;
    // The late timer fires at the deadline; the extension ends one deadline later.
    await advanceClock(FRAME_DOCUMENT_CHECK_DEADLINE_MS * 2 - 2);
    expect(missed).toBe(0);
    await advanceClock(1);
    expect(missed).toBe(1);
  });

  // A busy host fires timers a little late; only a blocked thread is late by more.
  test("a deadline late by the threshold or less still misses at once", async () => {
    const { blocked, now } = blockedClock();
    const { channel } = boundChannel(now);
    let missed = 0;
    channel.check(() => missed++);
    blocked.ms = FRAME_DOCUMENT_CHECK_LATE_MS;
    await advanceClock(FRAME_DOCUMENT_CHECK_DEADLINE_MS);
    expect(missed).toBe(1);
  });

  // However often its timers fire late, a check closes the frame by the cap.
  test("an extension never ends past the cap after the first unanswered check", async () => {
    const { blocked, now } = blockedClock();
    const { channel } = boundChannel(now);
    let missed = 0;
    channel.check(() => missed++);
    await advanceClock(1);
    // The timer fires at the deadline, 1 s before the cap by the blocked clock, so the extension
    // ends at the cap: 1 s later, not one full deadline later.
    blocked.ms = FRAME_DOCUMENT_CHECK_CAP_MS - FRAME_DOCUMENT_CHECK_DEADLINE_MS - 1000;
    await advanceClock(FRAME_DOCUMENT_CHECK_DEADLINE_MS + 998);
    expect(missed).toBe(0);
    await advanceClock(1);
    expect(missed).toBe(1);
  });

  test("a deadline that fires late past the cap misses at once", async () => {
    const { blocked, now } = blockedClock();
    const { channel } = boundChannel(now);
    let missed = 0;
    channel.check(() => missed++);
    blocked.ms = FRAME_DOCUMENT_CHECK_CAP_MS;
    await advanceClock(FRAME_DOCUMENT_CHECK_DEADLINE_MS);
    expect(missed).toBe(1);
  });

  test("a deadline that fires late exactly at the cap misses at once", async () => {
    const { blocked, now } = blockedClock();
    const { channel } = boundChannel(now);
    let missed = 0;
    channel.check(() => missed++);
    blocked.ms = FRAME_DOCUMENT_CHECK_CAP_MS - FRAME_DOCUMENT_CHECK_DEADLINE_MS;
    await advanceClock(FRAME_DOCUMENT_CHECK_DEADLINE_MS);
    expect(missed).toBe(1);
  });

  // A destination page that reloads itself sends loads; each one must not push the cap out.
  test("a later check keeps the cap counted from the first unanswered check", async () => {
    const { blocked, now } = blockedClock();
    const { channel } = boundChannel(now);
    let missed = 0;
    channel.check(() => missed++);
    await advanceClock(FRAME_DOCUMENT_CHECK_DEADLINE_MS - 1000);
    channel.check(() => missed++);
    // The timer fires at the deadline, 1 s past the cap by the blocked clock, but 3 s before a cap
    // counted from the later check.
    blocked.ms = FRAME_DOCUMENT_CHECK_CAP_MS - FRAME_DOCUMENT_CHECK_DEADLINE_MS + 1000;
    await advanceClock(1000);
    expect(missed).toBe(1);
  });

  test("close stops the deadline", async () => {
    const { channel } = boundChannel();
    let missed = 0;
    channel.check(() => missed++);
    channel.close();
    await advanceClock(FRAME_DOCUMENT_CHECK_DEADLINE_MS + 1);
    expect(missed).toBe(0);
  });

  /**
   * The channel's clock while `block(ms)` runs: Xum's thread is blocked that long, so each timer
   * due meanwhile fires when the block ends, as late as it is.
   */
  function blockingClock() {
    let blockEndsAt: number | null = null;
    return {
      now: () => blockEndsAt ?? performance.now(),
      block: async (ms: number) => {
        blockEndsAt = performance.now() + ms;
        await advanceClock(ms);
        blockEndsAt = null;
      },
    };
  }

  // An artifact that runs chained tasks holds its answer back past the deadline, and the deadline
  // itself can fire on time, at the boundary between two of its tasks.
  test("a block of Xum's thread before an on-time deadline extends the check once", async () => {
    const clock = blockingClock();
    const { channel } = boundChannel(clock.now);
    let missed = 0;
    channel.check(() => missed++);
    await advanceClock(1000);
    await clock.block(1000);
    await advanceClock(FRAME_DOCUMENT_CHECK_DEADLINE_MS - 2000);
    expect(missed).toBe(0);
    // The extended window sees no block, so its deadline closes the frame.
    await advanceClock(FRAME_DOCUMENT_CHECK_DEADLINE_MS - 1);
    expect(missed).toBe(0);
    await advanceClock(1);
    expect(missed).toBe(1);
  });

  test("a heartbeat late by the threshold or less does not extend the check", async () => {
    const clock = blockingClock();
    const { channel } = boundChannel(clock.now);
    let missed = 0;
    channel.check(() => missed++);
    // The block starts at a beat, so the next beat fires exactly the threshold late.
    await advanceClock(FRAME_DOCUMENT_HEARTBEAT_MS);
    await clock.block(FRAME_DOCUMENT_HEARTBEAT_MS + FRAME_DOCUMENT_CHECK_LATE_MS);
    await advanceClock(
      FRAME_DOCUMENT_CHECK_DEADLINE_MS -
        2 * FRAME_DOCUMENT_HEARTBEAT_MS -
        FRAME_DOCUMENT_CHECK_LATE_MS
    );
    expect(missed).toBe(1);
  });

  test("the heartbeat runs only while a check is pending", async () => {
    const { channel, checks, answer } = boundChannel();
    expect(fakeTimers.getTimerCount()).toBe(0);
    let missed = 0;
    channel.check(() => missed++);
    await advanceClock(FRAME_DOCUMENT_HEARTBEAT_MS * 2);
    answer(checks[0]);
    await advanceClock(1);
    expect(fakeTimers.getTimerCount()).toBe(0);

    channel.check(() => missed++);
    await advanceClock(FRAME_DOCUMENT_CHECK_DEADLINE_MS);
    expect(missed).toBe(1);
    expect(fakeTimers.getTimerCount()).toBe(0);

    channel.check(() => missed++);
    channel.close();
    expect(fakeTimers.getTimerCount()).toBe(0);
  });
});
