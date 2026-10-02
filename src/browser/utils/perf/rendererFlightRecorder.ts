import type {
  RendererBatch,
  RendererEventEntry,
  RendererLoafEntry,
  RendererLoafScript,
} from "@/common/orpc/schemas/perfFlightRecorder";
import { perfEpochFromRelativeMs, perfEpochNowMs } from "@/common/utils/perf/clock";
import {
  FLIGHT_RECORDER_EVENT_DURATION_THRESHOLD_MS,
  FLIGHT_RECORDER_MAX_EVENT_NAME_CHARS,
  FLIGHT_RECORDER_MAX_EVENTS_PER_BATCH,
  FLIGHT_RECORDER_MAX_FUNCTION_NAME_CHARS,
  FLIGHT_RECORDER_MAX_INVOKER_CHARS,
  FLIGHT_RECORDER_MAX_LOAF_PER_BATCH,
  FLIGHT_RECORDER_MAX_SCRIPTS_PER_LOAF,
  FLIGHT_RECORDER_MAX_SOURCE_URL_CHARS,
  FLIGHT_RECORDER_MAX_TAG_CHARS,
  FLIGHT_RECORDER_RENDERER_BATCH_INTERVAL_MS,
} from "@/constants/perfFlightRecorder";

/** `PerformanceScriptTiming` fields we keep (not in TypeScript's DOM lib yet). */
export interface ObservedLoafScript {
  readonly sourceURL?: string;
  readonly sourceFunctionName?: string;
  readonly sourceCharPosition?: number;
  readonly invoker?: string;
  readonly invokerType?: string;
  readonly duration?: number;
  readonly forcedStyleAndLayoutDuration?: number;
}

/**
 * The subset of a `long-animation-frame` or `event` PerformanceEntry the
 * recorder reads. Real entries are structurally assignable.
 */
export interface ObservedEntry {
  readonly entryType: string;
  readonly name: string;
  readonly startTime: number;
  readonly duration: number;
  readonly blockingDuration?: number;
  readonly renderStart?: number;
  readonly styleAndLayoutStart?: number;
  readonly scripts?: readonly ObservedLoafScript[];
  readonly interactionId?: number;
  readonly target?: unknown;
}

export interface ObserverHandle {
  disconnect(): void;
}

export interface ObserverFactory {
  readonly supportedEntryTypes: readonly string[];
  observe(
    options: { type: string; durationThreshold?: number },
    onEntries: (entries: readonly ObservedEntry[]) => void
  ): ObserverHandle;
}

export interface RendererFlightRecorderScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface RendererFlightRecorderOptions {
  push: (batch: RendererBatch) => Promise<{ accepted: boolean }>;
  /** Defaults to the browser's PerformanceObserver; null when unavailable. */
  observers?: ObserverFactory | null;
  scheduler?: RendererFlightRecorderScheduler;
}

const LOAF_ENTRY_TYPE = "long-animation-frame";
const EVENT_ENTRY_TYPE = "event";

function truncate(value: string | undefined, maxChars: number): string {
  return (value ?? "").slice(0, maxChars);
}

function nonNegative(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Relative timestamp → perf epoch ms; an absent (0) phase start stays the 0 sentinel. */
function epochOrZero(relativeMs: number | undefined): number {
  return relativeMs !== undefined && Number.isFinite(relativeMs) && relativeMs > 0
    ? perfEpochFromRelativeMs(relativeMs)
    : 0;
}

function toLoafScript(script: ObservedLoafScript): RendererLoafScript {
  const charPosition = script.sourceCharPosition;
  return {
    sourceURL: truncate(script.sourceURL, FLIGHT_RECORDER_MAX_SOURCE_URL_CHARS),
    sourceFunctionName: truncate(
      script.sourceFunctionName,
      FLIGHT_RECORDER_MAX_FUNCTION_NAME_CHARS
    ),
    sourceCharPosition:
      charPosition !== undefined && Number.isFinite(charPosition) ? charPosition : -1,
    invoker: truncate(script.invoker, FLIGHT_RECORDER_MAX_INVOKER_CHARS),
    invokerType: truncate(script.invokerType, FLIGHT_RECORDER_MAX_INVOKER_CHARS),
    durationMs: nonNegative(script.duration),
    forcedStyleAndLayoutDurationMs: nonNegative(script.forcedStyleAndLayoutDuration),
  };
}

function toLoafEntry(rendererId: string, entry: ObservedEntry): RendererLoafEntry {
  return {
    rendererId,
    startMs: perfEpochFromRelativeMs(entry.startTime),
    durationMs: nonNegative(entry.duration),
    blockingDurationMs: nonNegative(entry.blockingDuration),
    renderStartMs: epochOrZero(entry.renderStart),
    styleAndLayoutStartMs: epochOrZero(entry.styleAndLayoutStart),
    scripts: (entry.scripts ?? []).slice(0, FLIGHT_RECORDER_MAX_SCRIPTS_PER_LOAF).map(toLoafScript),
  };
}

function readTargetTag(target: unknown): string | null {
  if (typeof target !== "object" || target === null || !("tagName" in target)) return null;
  const tagName = target.tagName;
  return typeof tagName === "string"
    ? tagName.toLowerCase().slice(0, FLIGHT_RECORDER_MAX_TAG_CHARS)
    : null;
}

/** Keeps only the event name, timing, interaction id and target tag: never text content. */
function toEventEntry(rendererId: string, entry: ObservedEntry): RendererEventEntry {
  const interactionId = entry.interactionId;
  return {
    rendererId,
    startMs: perfEpochFromRelativeMs(entry.startTime),
    name: truncate(entry.name, FLIGHT_RECORDER_MAX_EVENT_NAME_CHARS),
    durationMs: nonNegative(entry.duration),
    interactionId:
      interactionId !== undefined && Number.isInteger(interactionId) && interactionId > 0
        ? interactionId
        : 0,
    targetTag: readTargetTag(entry.target),
  };
}

/** Pending entries bounded to one batch; the oldest entries are dropped and counted. */
class RendererBatchBuffer {
  private loaf: RendererLoafEntry[] = [];
  private events: RendererEventEntry[] = [];
  private droppedLoaf = 0;
  private droppedEvents = 0;

  addLoaf(entry: RendererLoafEntry): void {
    this.loaf.push(entry);
    if (this.loaf.length > FLIGHT_RECORDER_MAX_LOAF_PER_BATCH) {
      this.loaf.shift();
      this.droppedLoaf += 1;
    }
  }

  addEvent(entry: RendererEventEntry): void {
    this.events.push(entry);
    if (this.events.length > FLIGHT_RECORDER_MAX_EVENTS_PER_BATCH) {
      this.events.shift();
      this.droppedEvents += 1;
    }
  }

  /**
   * Removes everything pending as one batch, or returns null when nothing is
   * pending. Drop counts alone are pending data: a failed push followed by an
   * idle page must still report its loss.
   */
  take(rendererId: string, sentAtMs: number): RendererBatch | null {
    const hasDrops = this.droppedLoaf > 0 || this.droppedEvents > 0;
    if (this.loaf.length === 0 && this.events.length === 0 && !hasDrops) return null;
    const batch: RendererBatch = {
      rendererId,
      sentAtMs,
      loaf: this.loaf,
      events: this.events,
      droppedLoaf: this.droppedLoaf,
      droppedEvents: this.droppedEvents,
    };
    this.loaf = [];
    this.events = [];
    this.droppedLoaf = 0;
    this.droppedEvents = 0;
    return batch;
  }

  /** A batch the backend never stored: no retry, its entries count as dropped. */
  markUndelivered(batch: RendererBatch): void {
    this.droppedLoaf += batch.droppedLoaf + batch.loaf.length;
    this.droppedEvents += batch.droppedEvents + batch.events.length;
  }
}

function browserObserverFactory(): ObserverFactory | null {
  if (typeof PerformanceObserver === "undefined") return null;
  return {
    supportedEntryTypes: PerformanceObserver.supportedEntryTypes ?? [],
    observe: (options, onEntries) => {
      const observer = new PerformanceObserver((list) => onEntries(list.getEntries()));
      // No `buffered: true`: entries recorded while the experiment was off must not be imported.
      const init: PerformanceObserverInit = options;
      observer.observe(init);
      return observer;
    },
  };
}

const browserScheduler: RendererFlightRecorderScheduler = {
  setInterval: (callback, intervalMs) => window.setInterval(callback, intervalMs),
  clearInterval: (handle) => window.clearInterval(handle as number),
};

let pageRendererId: string | undefined;

/** crypto.randomUUID is missing in insecure contexts (plain-HTTP remote origins). */
function getPageRendererId(): string {
  pageRendererId ??= `r-${Math.random().toString(36).slice(2, 14)}`;
  return pageRendererId;
}

/**
 * Starts collecting long-animation-frame and slow event-timing entries and
 * pushes them to the backend every few seconds (at most one push in flight).
 * Returns the stop function. Without PerformanceObserver support it creates
 * nothing and returns a no-op.
 */
export function startRendererFlightRecorder(options: RendererFlightRecorderOptions): () => void {
  const factory = options.observers === undefined ? browserObserverFactory() : options.observers;
  if (factory === null) return () => undefined;
  const supported = new Set(factory.supportedEntryTypes);
  const observeLoaf = supported.has(LOAF_ENTRY_TYPE);
  const observeEvents = supported.has(EVENT_ENTRY_TYPE);
  if (!observeLoaf && !observeEvents) return () => undefined;

  const scheduler = options.scheduler ?? browserScheduler;
  const rendererId = getPageRendererId();
  const buffer = new RendererBatchBuffer();
  const observers: ObserverHandle[] = [];
  let interval: { handle: unknown } | null = null;
  let stopped = false;
  let inFlight = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (interval !== null) scheduler.clearInterval(interval.handle);
    for (const observer of observers) {
      try {
        observer.disconnect();
      } catch {
        // Best effort: the remaining observers still disconnect.
      }
    }
  };

  const settle = (batch: RendererBatch, accepted: boolean) => {
    inFlight = false;
    if (!accepted) buffer.markUndelivered(batch);
  };

  const flush = () => {
    if (stopped || inFlight) return;
    const batch = buffer.take(rendererId, perfEpochNowMs());
    if (batch === null) return;
    inFlight = true;
    try {
      options.push(batch).then(
        (result) => settle(batch, result.accepted),
        () => settle(batch, false)
      );
    } catch {
      settle(batch, false);
    }
  };

  try {
    if (observeLoaf) {
      observers.push(
        factory.observe({ type: LOAF_ENTRY_TYPE }, (entries) => {
          for (const entry of entries) buffer.addLoaf(toLoafEntry(rendererId, entry));
        })
      );
    }
    if (observeEvents) {
      observers.push(
        factory.observe(
          {
            type: EVENT_ENTRY_TYPE,
            durationThreshold: FLIGHT_RECORDER_EVENT_DURATION_THRESHOLD_MS,
          },
          (entries) => {
            for (const entry of entries) buffer.addEvent(toEventEntry(rendererId, entry));
          }
        )
      );
    }
    interval = {
      handle: scheduler.setInterval(flush, FLIGHT_RECORDER_RENDERER_BATCH_INTERVAL_MS),
    };
  } catch (error) {
    console.warn("[perfFlightRecorder] renderer collection disabled after failure:", error);
    stop();
  }
  return stop;
}
