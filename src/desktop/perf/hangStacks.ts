/**
 * Renderer hang diagnostics for the desktop main window.
 *
 * When Chromium's hang monitor fires `unresponsive` on the main window, the main
 * process asks the renderer's main frame for its current JS call stack
 * (`WebFrameMain.collectJavaScriptCallStack()`), logs it once, and keeps the last
 * few hang records in memory so a later "Report slowness" bundle can include them.
 *
 * Electron only returns a stack when the `DocumentPolicyIncludeJSCallStacksInCrashReports`
 * feature is enabled and the page was served with
 * `Document-Policy: include-js-call-stacks-in-crash-reports` (electron/electron#45356).
 *
 * This module has no Electron imports so its logic stays unit-testable under bun.
 */

/** Chromium feature that lets the browser process read a hung renderer's JS stack. */
export const JS_CALL_STACKS_FEATURE = "DocumentPolicyIncludeJSCallStacksInCrashReports";
/** Document-Policy directive the app page must opt into for stack collection. */
export const JS_CALL_STACKS_DOCUMENT_POLICY = "include-js-call-stacks-in-crash-reports";

export const MAX_HANG_RECORDS = 10;
/** `collectJavaScriptCallStack()` never settles when no JS runs, so collection is bounded. */
export const HANG_STACK_TIMEOUT_MS = 2000;

export interface HangRecord {
  /** Epoch ms when `unresponsive` fired. */
  at: number;
  /** Set when the window became responsive again. */
  durationUntilResponsive?: number;
  stack?: string;
  /** "timeout", "unavailable", or the collection error message. */
  stackError?: string;
  url: string;
}

export type StackCollectionResult = { ok: true; stack: string } | { ok: false; error: string };

// Newest last. Records stay mutable here so a hang episode's late stack result and its
// recovery duration land in the same record; readers only ever get copies.
const hangRecords: HangRecord[] = [];

function pushHangRecord(record: HangRecord): void {
  hangRecords.push(record);
  while (hangRecords.length > MAX_HANG_RECORDS) {
    hangRecords.shift();
  }
}

/** Recent hang records, oldest first. Returns copies so callers cannot mutate the ring. */
export function getRecentHangRecords(): readonly HangRecord[] {
  return hangRecords.map((record) => ({ ...record }));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Race a stack collection against a timer. Never rejects: synchronous throws, rejections,
 * empty results, and timeouts all become `{ ok: false }`.
 */
export async function collectStackWithTimeout(
  collect: () => Promise<string | void>,
  timeoutMs: number
): Promise<StackCollectionResult> {
  if (!(timeoutMs > 0)) {
    throw new Error(`collectStackWithTimeout: timeoutMs must be positive, got ${timeoutMs}`);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<StackCollectionResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), timeoutMs);
  });

  const collection = (async (): Promise<StackCollectionResult> => {
    try {
      const stack = await collect();
      // Electron resolves undefined when the stack cannot be collected. Without the
      // Document-Policy opt-in it resolves an explanatory string instead, which is kept
      // as the stack: it names the cause better than a generic error would.
      return typeof stack === "string" && stack.length > 0
        ? { ok: true, stack }
        : { ok: false, error: "unavailable" };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  })();

  try {
    return await Promise.race([collection, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface HangTrackerDeps {
  collect: () => Promise<string | void>;
  getUrl: () => string;
  log: { warn: (...args: unknown[]) => void };
  now?: () => number;
  timeoutMs?: number;
}

export interface HangTracker {
  /** Starts a hang episode. Resolves after its stack was logged; never rejects. */
  onUnresponsive: () => Promise<void>;
  onResponsive: () => void;
}

/**
 * One stack collection per hang episode: `unresponsive` can fire repeatedly while the
 * renderer stays hung, and each collection would otherwise queue another (likely
 * timed-out) request.
 */
export function createHangTracker(deps: HangTrackerDeps): HangTracker {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? HANG_STACK_TIMEOUT_MS;
  // Validate at setup: the hang handlers themselves must never throw.
  if (!(timeoutMs > 0)) {
    throw new Error(`createHangTracker: timeoutMs must be positive, got ${timeoutMs}`);
  }
  let openRecord: HangRecord | null = null;

  const safeUrl = (): string => {
    try {
      return deps.getUrl();
    } catch {
      return "";
    }
  };

  return {
    onUnresponsive: async () => {
      if (openRecord !== null) {
        return;
      }
      // Create the record before collecting so `responsive` can set the duration even
      // while collection is still pending.
      const record: HangRecord = { at: now(), url: safeUrl() };
      openRecord = record;
      pushHangRecord(record);

      const result = await collectStackWithTimeout(deps.collect, timeoutMs);
      // Write into the record this collection started for, even if a newer episode is
      // open by now.
      try {
        if (result.ok) {
          record.stack = result.stack;
          deps.log.warn("[diag] renderer unresponsive JS stack", {
            url: record.url,
            stack: result.stack,
          });
        } else {
          record.stackError = result.error;
          deps.log.warn("[diag] renderer unresponsive JS stack unavailable", {
            url: record.url,
            error: result.error,
          });
        }
      } catch {
        // Diagnostics must never throw out of the hang handlers.
      }
    },
    onResponsive: () => {
      if (openRecord === null) {
        return;
      }
      openRecord.durationUntilResponsive = now() - openRecord.at;
      openRecord = null;
    },
  };
}

/**
 * Add `feature` to a comma-separated `--enable-features` value without dropping or
 * duplicating features that are already enabled.
 */
export function mergeEnableFeatures(existing: string, feature: string): string {
  if (feature.length === 0 || feature.includes(",")) {
    throw new Error(`mergeEnableFeatures: invalid feature name "${feature}"`);
  }
  const features: string[] = [];
  for (const raw of existing.split(",")) {
    const name = raw.trim();
    if (name.length > 0 && !features.includes(name)) {
      features.push(name);
    }
  }
  if (!features.includes(feature)) {
    features.push(feature);
  }
  return features.join(",");
}

/** Append the JS call stacks directive to an existing Document-Policy value, if missing. */
export function mergeDocumentPolicyValue(existing: string | null | undefined): string {
  const current = existing?.trim() ?? "";
  if (current.length === 0) {
    return JS_CALL_STACKS_DOCUMENT_POLICY;
  }
  const directives = current.split(",").map((directive) => directive.trim());
  // A directive may carry parameters (`name;report-to=x`) or an explicit value (`name=?0`);
  // an explicit value is the page owner's choice, so leave it alone.
  if (
    directives.some((directive) => directive.split(/[;=]/, 1)[0] === JS_CALL_STACKS_DOCUMENT_POLICY)
  ) {
    return current;
  }
  return `${current}, ${JS_CALL_STACKS_DOCUMENT_POLICY}`;
}

/**
 * Merge the directive into a webRequest `responseHeaders` map. Header names there keep
 * the server's casing, so an existing Document-Policy header is matched case-insensitively
 * and every other header (CSP included) is returned unchanged.
 */
export function withDocumentPolicyHeader(
  headers: Record<string, string | string[]> | undefined
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = { ...headers };
  const key =
    Object.keys(result).find((name) => name.toLowerCase() === "document-policy") ??
    "Document-Policy";
  const value = result[key];
  const existing = Array.isArray(value) ? value.join(", ") : value;
  result[key] = mergeDocumentPolicyValue(existing);
  return result;
}
