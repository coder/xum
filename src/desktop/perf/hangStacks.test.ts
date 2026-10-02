import { describe, expect, test } from "bun:test";
import {
  collectStackWithTimeout,
  createHangTracker,
  getRecentHangRecords,
  JS_CALL_STACKS_DOCUMENT_POLICY,
  MAX_HANG_RECORDS,
  mergeEnableFeatures,
  withDocumentPolicyHeader,
} from "./hangStacks";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let urlCounter = 0;
function uniqueUrl(label: string): string {
  urlCounter += 1;
  return `file:///hang-test/${label}-${urlCounter}`;
}

function recordsFor(url: string) {
  return getRecentHangRecords().filter((record) => record.url === url);
}

describe("collectStackWithTimeout", () => {
  test("returns the stack when collection resolves", async () => {
    expect(await collectStackWithTimeout(() => Promise.resolve("at loop"), 1000)).toEqual({
      ok: true,
      stack: "at loop",
    });
  });

  test("turns rejections, synchronous throws, and empty results into errors", async () => {
    expect(await collectStackWithTimeout(() => Promise.reject(new Error("boom")), 1000)).toEqual({
      ok: false,
      error: "boom",
    });
    expect(
      await collectStackWithTimeout(() => {
        throw new Error("frame gone");
      }, 1000)
    ).toEqual({ ok: false, error: "frame gone" });
    expect(await collectStackWithTimeout(() => Promise.resolve(undefined), 1000)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(await collectStackWithTimeout(() => Promise.resolve(""), 1000)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  test("times out when collection never settles", async () => {
    const result = await collectStackWithTimeout(() => new Promise<string>(() => undefined), 20);
    expect(result).toEqual({ ok: false, error: "timeout" });
  });
});

describe("createHangTracker", () => {
  test("collects once per episode, logs the stack, and records recovery time", async () => {
    const url = uniqueUrl("episode");
    let clock = 1_000;
    let collectCalls = 0;
    const pending = deferred<string>();
    const warnings: unknown[][] = [];
    const tracker = createHangTracker({
      collect: () => {
        collectCalls += 1;
        return pending.promise;
      },
      getUrl: () => url,
      log: { warn: (...args) => warnings.push(args) },
      now: () => clock,
    });

    const first = tracker.onUnresponsive();
    // Chromium can re-fire `unresponsive` while the renderer stays hung.
    await tracker.onUnresponsive();
    expect(collectCalls).toBe(1);

    clock = 4_500;
    tracker.onResponsive();
    expect(recordsFor(url)).toEqual([{ at: 1_000, durationUntilResponsive: 3_500, url }]);

    pending.resolve("at xumBusyLoop (index.js:1:1)");
    await first;
    expect(recordsFor(url)).toEqual([
      { at: 1_000, durationUntilResponsive: 3_500, stack: "at xumBusyLoop (index.js:1:1)", url },
    ]);
    expect(warnings).toEqual([
      ["[diag] renderer unresponsive JS stack", { url, stack: "at xumBusyLoop (index.js:1:1)" }],
    ]);
  });

  test("a late stack lands in the episode it was collected for", async () => {
    const urls = [uniqueUrl("late-a"), uniqueUrl("late-b")];
    const collections = [deferred<string>(), deferred<string>()];
    let episode = 0;
    const tracker = createHangTracker({
      collect: () => collections[episode].promise,
      getUrl: () => urls[episode],
      log: { warn: () => undefined },
    });

    const first = tracker.onUnresponsive();
    tracker.onResponsive();
    episode = 1;
    const second = tracker.onUnresponsive();

    collections[0].resolve("stack-a");
    await first;
    expect(recordsFor(urls[0])[0]?.stack).toBe("stack-a");
    expect(recordsFor(urls[1])[0]?.stack).toBeUndefined();

    collections[1].resolve("stack-b");
    await second;
    expect(recordsFor(urls[1])[0]?.stack).toBe("stack-b");
  });

  test("logs a timeout once and keeps the error on the record", async () => {
    const url = uniqueUrl("timeout");
    const warnings: unknown[][] = [];
    const tracker = createHangTracker({
      collect: () => new Promise<string>(() => undefined),
      getUrl: () => url,
      log: { warn: (...args) => warnings.push(args) },
      timeoutMs: 20,
    });

    await tracker.onUnresponsive();
    expect(recordsFor(url)[0]?.stackError).toBe("timeout");
    expect(warnings).toEqual([
      ["[diag] renderer unresponsive JS stack unavailable", { url, error: "timeout" }],
    ]);
  });

  test("keeps only the newest records, oldest first, and hands out copies", async () => {
    const urls: string[] = [];
    let current = "";
    const tracker = createHangTracker({
      collect: () => Promise.resolve("stack"),
      getUrl: () => current,
      log: { warn: () => undefined },
    });
    for (let i = 0; i < MAX_HANG_RECORDS + 2; i++) {
      current = uniqueUrl("ring");
      urls.push(current);
      await tracker.onUnresponsive();
      tracker.onResponsive();
    }

    const records = getRecentHangRecords();
    expect(records.map((record) => record.url)).toEqual(urls.slice(2));

    (records[0] as { stack?: string }).stack = "mutated";
    expect(getRecentHangRecords()[0]?.stack).toBe("stack");
  });
});

describe("mergeEnableFeatures", () => {
  test.each([
    ["", "Feat"],
    ["Other", "Other,Feat"],
    ["Other, Feat ,Other", "Other,Feat"],
    ["Feat", "Feat"],
  ])("merges %p", (existing, expected) => {
    expect(mergeEnableFeatures(existing, "Feat")).toBe(expected);
  });
});

describe("withDocumentPolicyHeader", () => {
  test("adds the directive without touching other headers", () => {
    const csp = ["default-src 'self'"];
    expect(withDocumentPolicyHeader({ "Content-Security-Policy": csp })).toEqual({
      "Content-Security-Policy": csp,
      "Document-Policy": JS_CALL_STACKS_DOCUMENT_POLICY,
    });
    expect(withDocumentPolicyHeader(undefined)).toEqual({
      "Document-Policy": JS_CALL_STACKS_DOCUMENT_POLICY,
    });
  });

  test("merges into an existing header under its original casing, once", () => {
    const merged = withDocumentPolicyHeader({ "document-policy": ["oversized-images=2.0"] });
    expect(merged).toEqual({
      "document-policy": `oversized-images=2.0, ${JS_CALL_STACKS_DOCUMENT_POLICY}`,
    });
    expect(withDocumentPolicyHeader(merged)).toEqual(merged);
  });

  test("keeps the page owner's explicit value for the directive", () => {
    const optedOut = { "Document-Policy": `${JS_CALL_STACKS_DOCUMENT_POLICY}=?0` };
    expect(withDocumentPolicyHeader(optedOut)).toEqual(optedOut);
  });
});
