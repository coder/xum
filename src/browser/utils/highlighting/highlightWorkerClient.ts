/**
 * Syntax highlighting client
 *
 * Provides async API for off-main-thread syntax highlighting via Web Worker.
 * Falls back to main-thread highlighting in test environments where
 * Web Workers aren't available.
 *
 * Optimistic + bounded-cost contract:
 *   - Worker calls are serialized in the client and each call has a hard
 *     time budget (HIGHLIGHT_TIMEOUT_MS) that starts only once that payload
 *     reaches the front of the queue and a ready worker. When it expires we
 *     assume the worker is wedged in native code (e.g. Oniguruma catastrophic
 *     backtracking on a TextMate grammar) and terminate the worker, freeing its
 *     CPU immediately.
 *   - Worker start-up (script load, Shiki's engine, the language's grammar) is
 *     not part of that budget: it has its own limit (WORKER_START_TIMEOUT_MS).
 *     A start that exceeds it ends the worker but never marks the input.
 *   - Inputs that exceeded the budget are remembered by fingerprint so
 *     subsequent re-renders (theme changes, streaming, scroll) don't kill
 *     a fresh worker for the same payload.
 *   - We deliberately do NOT fall back to the main-thread highlighter on
 *     worker runtime errors: it uses the same Oniguruma engine and would
 *     freeze the UI instead of one core. Main-thread Shiki is only used
 *     when the worker is structurally unavailable (vscode webview, tests).
 *   - Callers already render plain text when this function throws, so
 *     timeout = "render the diff/code block as plain text" — never a hang.
 *
 * Note: Caching happens at the caller level (DiffRenderer's highlightedDiffCache)
 * to enable synchronous cache hits and avoid "Processing" flash.
 */

import * as Comlink from "comlink";
import type { Highlighter } from "shiki";
import type { HighlightWorkerAPI } from "@/browser/workers/highlightWorker";
import {
  mapToShikiLang,
  SHIKI_COLOR_REPLACEMENTS,
  SHIKI_DARK_THEME,
  SHIKI_LIGHT_THEME,
} from "./shiki-shared";
import { isVscodeWebview } from "@/browser/utils/env";

// 5 s is generous for human-scale files (a 10k-LoC file at typical line lengths
// highlights in well under 1 s on real hardware) but cuts off catastrophic
// backtracking, which otherwise pegs a core indefinitely.
const HIGHLIGHT_TIMEOUT_MS = 5000;

// Sentinel thrown internally when the time budget is exceeded. Kept distinct
// from generic Errors so the caller path can choose how loudly to log it.
const TIMEOUT_MARKER = "HIGHLIGHT_TIMEOUT";

// Limit for a worker to start: load its script and get Shiki and the language's grammar ready.
// A cold dev server compiles the worker module and Shiki's chunks on first use, which took more
// than the 5 s budget (#6292); 20 s leaves room for that on a slow machine. The limit only
// guards a worker that never starts (a script that never loads): the queue waits that long, and
// those diffs show as plain text meanwhile, so a longer limit costs nothing on a healthy start.
const WORKER_START_TIMEOUT_MS = 20_000;
const START_TIMEOUT_MARKER = "HIGHLIGHT_WORKER_START_TIMEOUT";
// The worker fired `onerror` (its script failed to load, or it crashed) while a call waited.
const WORKER_DIED_MARKER = "HIGHLIGHT_WORKER_DIED";
// The worker fired `onerror` before it was ready (a script that failed to load): a start failure,
// as transient as a start time-out (#6309).
const START_FAILED_MARKER = "HIGHLIGHT_WORKER_START_FAILED";

/**
 * True when the worker did not start: it timed out, or it died before it was ready. Transient,
 * unlike a budget timeout: the input is not marked, so callers must not cache their plain-text
 * fallback for it either, and highlightCode retries it once a worker is ready.
 */
export function isHighlightStartFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === START_TIMEOUT_MARKER || error.message === START_FAILED_MARKER)
  );
}

function isHighlightStartTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === START_TIMEOUT_MARKER;
}

/** A failure whose worker is already ended: it did not start, or it died mid-call. */
function isWorkerGoneFailure(error: unknown): boolean {
  return (
    isHighlightStartFailure(error) ||
    (error instanceof Error && error.message === WORKER_DIED_MARKER)
  );
}

// Inputs that previously exceeded the time budget. We don't ship them to a
// new worker again — that would just terminate another worker for the same
// pathological payload. Keyed by a cheap fingerprint that includes language
// and theme since both can change the matcher's behavior. Safe because
// `enqueueHighlightWithBudget` starts the timeout only after the payload reaches
// the front of the client-side queue, so queued requests are not mislabeled as
// pathological merely because an earlier request is stuck.
const timedOutInputs = new Set<string>();

let workerHighlightQueue: Promise<void> = Promise.resolve();

/**
 * Cheap fingerprint for memoizing "this input previously blew the budget".
 *
 * We deliberately avoid hashing the full string (it's the hot path on every
 * render of a streaming code block). Length + endpoints + language + theme is
 * enough: false collisions only cost an extra plain-text render, never
 * correctness.
 */
function inputKey(code: string, language: string, theme: "dark" | "light"): string {
  const head = code.length > 64 ? code.slice(0, 64) : code;
  const tail = code.length > 128 ? code.slice(-64) : "";
  return `${language}\u0000${theme}\u0000${code.length}\u0000${head}\u0000${tail}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main-thread Shiki (fallback only)
// ─────────────────────────────────────────────────────────────────────────────

let highlighterPromise: Promise<Highlighter> | null = null;

/**
 * Get or create main-thread Shiki highlighter (for fallback when worker unavailable)
 * Uses dynamic import to avoid loading Shiki on main thread unless actually needed.
 */
async function getShikiHighlighter(): Promise<Highlighter> {
  // Must use if-check instead of ??= to prevent race condition
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then(({ createHighlighter }) =>
      createHighlighter({
        themes: [SHIKI_DARK_THEME, SHIKI_LIGHT_THEME],
        langs: [],
      })
    );
  }
  return highlighterPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker Management (via Comlink)
// ─────────────────────────────────────────────────────────────────────────────

let worker: Worker | null = null;
let workerAPI: Comlink.Remote<HighlightWorkerAPI> | null = null;
// Set when the worker is structurally unavailable (vscode webview, construction
// throws). NOT set on runtime errors — we want the next call to spin up a fresh
// worker, since the previous one may have been wedged in native code.
let workerStructurallyUnavailable = false;
let warnedVscodeWorkerDisabled = false;
// Languages the current worker has loaded (its `prepare` resolved). Cleared with the worker.
const preparedLanguages = new Set<string>();
// Rejecters of the calls waiting on the current worker. Its `onerror` rejects them all, because
// recycleWorker's Comlink `releaseProxy` drops a call's pending listener without rejecting it: a
// call to a dead worker would wait out its limit, 20 s to start, or 5 s that also marked the
// input (#6303). A set, not one long-pending promise raced by every call: each race would add a
// reaction to that promise, kept (with its result) for the worker's whole life.
let workerCalls: Set<(error: Error) => void> | null = null;
// After a start failure: per language, one shared start of the next worker that every request of
// that language whose worker did not start waits on, then retries once (#6303). Per language, so
// one grammar's failed recovery does not end another language's wait (#6309).
const workerRecoveries = new Map<string, Promise<void>>();

/**
 * Tear down the current worker so the next call to `getWorkerAPI` builds a
 * fresh one. Used after a timeout (worker assumed wedged in native code) or
 * after a runtime error (worker may be in an indeterminate state).
 *
 * We deliberately do NOT mark the worker as permanently failed — pathological
 * inputs are tracked separately by fingerprint, and well-formed inputs deserve
 * a fresh attempt against a fresh worker.
 */
function recycleWorker(expectedWorker?: Worker): void {
  if (expectedWorker !== undefined && worker !== expectedWorker) {
    // A stale worker can still emit asynchronous errors after a replacement has
    // been created. Do not let that stale event tear down the healthy current
    // worker and cascade fallback through unrelated queued highlights.
    return;
  }

  const currentWorker = worker;
  const currentWorkerAPI = workerAPI;
  worker = null;
  workerAPI = null;
  workerCalls = null;
  preparedLanguages.clear();

  if (currentWorkerAPI !== null) {
    try {
      // Tell Comlink this proxy is intentionally done before terminating the
      // endpoint. Otherwise Comlink's finalizer can later try to post a release
      // message to an already-terminated worker, which surfaces as an
      // unhandled InvalidStateError in Bun's test runner.
      currentWorkerAPI[Comlink.releaseProxy]();
    } catch {
      // If the worker is already gone, clearing our references is enough.
    }
  }

  if (currentWorker !== null) {
    try {
      currentWorker.terminate();
    } catch {
      // terminate() can't really fail, but be defensive — we just want the
      // module state cleared either way.
    }
  }
}

function getWorkerAPI(): Comlink.Remote<HighlightWorkerAPI> | null {
  // VS Code webviews load the chat UI from a bundled ESM file.
  // Our current webview bundling does not ship the worker entrypoint referenced by
  // `new URL("../../workers/highlightWorker.ts", import.meta.url)`, which means the
  // worker will fail to start and Comlink calls can hang.
  //
  // Prefer correctness and responsiveness: fall back to the main-thread highlighter.
  if (isVscodeWebview()) {
    if (!warnedVscodeWorkerDisabled) {
      warnedVscodeWorkerDisabled = true;
      console.warn("[highlightWorkerClient] Worker highlighting disabled in VS Code webview");
    }

    workerStructurallyUnavailable = true;
    worker = null;
    workerAPI = null;
    return null;
  }

  if (workerStructurallyUnavailable) return null;
  if (workerAPI) return workerAPI;

  try {
    // Use relative path - @/ alias doesn't work in worker context.
    const createdWorker = new Worker(new URL("../../workers/highlightWorker.ts", import.meta.url), {
      type: "module",
      name: "shiki-highlighter", // Shows up in DevTools
    });
    worker = createdWorker;
    const calls = new Set<(error: Error) => void>();
    workerCalls = calls;

    createdWorker.onerror = (e) => {
      // A worker that errored out is not necessarily permanently broken — the
      // error may be confined to a single grammar/input. Clear state so the
      // next highlight call builds a fresh worker, but only if this is still
      // the active worker. Stale error events from already-replaced workers
      // must not terminate a healthy replacement.
      console.error("[highlightWorkerClient] Worker errored; recycling:", e);
      failWorkerCalls(calls);
      recycleWorker(createdWorker);
    };

    workerAPI = Comlink.wrap<HighlightWorkerAPI>(createdWorker);
    return workerAPI;
  } catch (e) {
    // Workers not available (e.g., test environment). Construction failures
    // ARE permanent: no point retrying every render.
    console.error("[highlightWorkerClient] Failed to create worker:", e);
    workerStructurallyUnavailable = true;
    worker = null;
    workerAPI = null;
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main-thread Fallback
// ─────────────────────────────────────────────────────────────────────────────

let warnedMainThread = false;

async function highlightMainThread(
  code: string,
  language: string,
  theme: "dark" | "light",
  signal: AbortSignal | undefined
): Promise<string> {
  if (!warnedMainThread) {
    warnedMainThread = true;
    console.warn(
      "[highlightWorkerClient] Syntax highlighting running on main thread (worker unavailable)"
    );
  }

  const highlighter = await getShikiHighlighter();
  const shikiLang = mapToShikiLang(language);

  // Load language on-demand
  const loadedLangs = highlighter.getLoadedLanguages();
  if (!loadedLangs.includes(shikiLang)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    await highlighter.loadLanguage(shikiLang as any);
  }

  // A caller that moved on while Shiki initialized no longer needs this result.
  signal?.throwIfAborted();
  const shikiTheme = theme === "light" ? SHIKI_LIGHT_THEME : SHIKI_DARK_THEME;
  return highlighter.codeToHtml(code, {
    lang: shikiLang,
    theme: shikiTheme,
    colorReplacements: SHIKI_COLOR_REPLACEMENTS,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when `error` is the rejection of a request whose caller aborted `signal`. Callers abort
 * on purpose when their code changes or they unmount, so this is not a highlight failure.
 */
export function isAbortedHighlight(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && error === signal.reason;
}

/** Rejects every call still waiting on a worker that fired `onerror`. */
function failWorkerCalls(calls: Set<(error: Error) => void>): void {
  for (const reject of calls) reject(new Error(WORKER_DIED_MARKER));
  calls.clear();
}

/**
 * `call`, or a rejection once its worker fires `onerror` first. The rejecter leaves `calls` when
 * the call settles, so nothing outlives the call.
 */
function untilWorkerDies<T>(
  call: Promise<T>,
  calls: Set<(error: Error) => void> | null
): Promise<T> {
  if (calls === null) return call;
  return new Promise<T>((resolve, reject) => {
    calls.add(reject);
    call.then(resolve, reject).finally(() => calls.delete(reject));
  });
}

/** `call()`, or a rejection with Error(`marker`) once `ms` pass first. */
async function raceTimeout<T>(call: () => Promise<T>, ms: number, marker: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(marker)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The error a failed `prepare` rejects with. A start time-out ends the worker that did not start.
 * A worker that died before it was ready (onerror already recycled it) is a start failure, not a
 * highlight failure, so it is retried like a time-out and never cached as plain text (#6309).
 */
function startError(e: unknown, startingWorker: Worker | undefined): unknown {
  if (isHighlightStartTimeout(e)) recycleWorker(startingWorker);
  if (e instanceof Error && e.message === WORKER_DIED_MARKER) return new Error(START_FAILED_MARKER);
  return e;
}

/**
 * Get the worker ready for `language` (start it, load Shiki and the grammar) within
 * WORKER_START_TIMEOUT_MS. Runs at the front of the queue before the budget starts. A worker
 * that does not start in time is ended; the next request starts a new one.
 */
async function prepareWorker(language: string): Promise<void> {
  const api = getWorkerAPI();
  if (!api || preparedLanguages.has(language)) return;
  const startingWorker = worker ?? undefined;
  const calls = workerCalls;
  try {
    await raceTimeout(
      () => untilWorkerDies(api.prepare(language), calls),
      WORKER_START_TIMEOUT_MS,
      START_TIMEOUT_MARKER
    );
  } catch (e) {
    throw startError(e, startingWorker);
  }
  if (worker === startingWorker) preparedLanguages.add(language);
}

/**
 * Race `call` against the time budget. On budget expiry:
 *   - invoke `onTimeout` (production: terminate the wedged worker),
 *   - remember the input fingerprint so we don't retry it,
 *   - throw the timeout sentinel so the caller renders plain text.
 *
 * `prepare` runs first, outside the budget: worker start-up is not this input's work (#6292).
 *
 * Exported for unit testing. Production callers should use `highlightCode`.
 */
export async function highlightWithBudget(
  code: string,
  language: string,
  theme: "dark" | "light",
  call: () => Promise<string>,
  onTimeout: () => void,
  timeoutMs: number = HIGHLIGHT_TIMEOUT_MS,
  signal?: AbortSignal,
  prepare: () => Promise<void> = () => Promise.resolve()
): Promise<string> {
  // Skip work whose caller already moved on, before the timer starts and before the cache is
  // read or written: an aborted request must never terminate the worker or mark its input.
  signal?.throwIfAborted();
  const key = inputKey(code, language, theme);
  if (timedOutInputs.has(key)) {
    // Previously blew the budget. Bail fast without touching the worker so we
    // don't keep terminating workers for the same input on every re-render.
    throw new Error(TIMEOUT_MARKER);
  }

  await prepare();
  // The caller may have moved on while the worker started.
  signal?.throwIfAborted();
  try {
    return await raceTimeout(call, timeoutMs, TIMEOUT_MARKER);
  } catch (e) {
    if (e instanceof Error && e.message === TIMEOUT_MARKER) {
      timedOutInputs.add(key);
      // Side effect (terminate worker) happens AFTER the cache is populated
      // so any synchronous follow-on call sees the fingerprint immediately.
      onTimeout();
    }
    throw e;
  }
}

/** Runs `job` once every job queued before it has settled (the worker runs one at a time). */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const result = workerHighlightQueue.then(job, job);
  workerHighlightQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * Resolves once a worker is ready for `language` after a start time-out; rejects when that start
 * times out too. Shared: the requests that wait on it trigger one more worker start between them,
 * not one each, and a worker that never starts ends the wait instead of looping.
 */
function whenWorkerRecovered(language: string): Promise<void> {
  let recovery = workerRecoveries.get(language);
  if (!recovery) {
    recovery = enqueue(() => prepareWorker(language)).finally(() => {
      workerRecoveries.delete(language);
    });
    workerRecoveries.set(language, recovery);
  }
  return recovery;
}

/**
 * Serialize highlight attempts before applying the budget. The worker itself is
 * single-threaded, so concurrent Comlink calls would only queue on the worker;
 * keeping the queue on the client lets the timeout clock measure actual work on
 * the specific payload rather than time spent waiting behind an earlier wedged
 * request.
 *
 * Exported for unit testing. Production callers should use `highlightCode`.
 */
export function enqueueHighlightWithBudget(
  code: string,
  language: string,
  theme: "dark" | "light",
  call: () => Promise<string>,
  onTimeout: () => void,
  timeoutMs: number = HIGHLIGHT_TIMEOUT_MS,
  signal?: AbortSignal,
  prepare?: () => Promise<void>
): Promise<string> {
  // The abort is checked only when the job reaches the front. A job that already runs keeps its
  // slot until it settles or times out, because the single worker is still busy with it.
  return enqueue(() =>
    highlightWithBudget(code, language, theme, call, onTimeout, timeoutMs, signal, prepare)
  );
}

/**
 * Logs why a highlight failed and recycles the worker only when its state is unknown. A budget
 * time-out already ended the worker inside highlightWithBudget, and a start time-out already
 * ended the worker that did not start (prepareWorker).
 */
function reportHighlightFailure(e: unknown, language: string, codeLength: number): void {
  if (e instanceof Error && e.message === TIMEOUT_MARKER) {
    // Demote to a warn once per pathological input — `timedOutInputs` is the dedupe key.
    console.warn(
      `[highlightWorkerClient] highlight exceeded ${HIGHLIGHT_TIMEOUT_MS}ms budget for ${language}; ` +
        `rendering as plain text and skipping this input henceforth (${codeLength} chars)`
    );
  } else if (isWorkerGoneFailure(e)) {
    // The worker is already ended (a start time-out, or onerror), and the input is not marked
    // (#6292, #6303): log why, but do not recycle again, which could hit a newer worker.
    console.warn(
      `[highlightWorkerClient] worker did not start or died (${String(e)}); ` +
        `rendering ${language} as plain text`
    );
  } else {
    // Non-timeout error — the worker may be in an indeterminate state. Recycle so the next call
    // gets a fresh one. Don't main-thread fallback (same engine, same risk).
    console.warn("[highlightWorkerClient] worker highlight failed; recycling:", e);
    recycleWorker();
  }
}

/**
 * Highlight code with syntax highlighting (off-main-thread)
 *
 * Highlighting runs in a Web Worker to avoid blocking the main thread, with
 * a hard time budget per call. If the budget expires (catastrophic
 * backtracking, etc.) the worker is terminated and this function throws — the
 * caller is expected to render plain text. We deliberately do NOT fall back to
 * a main-thread Shiki call on worker timeouts/errors: the same Oniguruma
 * engine would then freeze the UI instead of one core.
 *
 * @param code - Source code to highlight
 * @param language - Language identifier (e.g., "typescript", "python")
 * @param theme - Theme variant ("dark" or "light")
 * @param signal - Aborted by the caller once it no longer needs the result. The queue is FIFO,
 *   so without it every superseded request of a streaming code block still runs: a 60k fence
 *   queued thousands of stale jobs, and its final highlight showed minutes late (#5666).
 *   An aborted request that has not started rejects with `signal.reason`.
 * @returns Promise resolving to HTML string with syntax highlighting
 * @throws Error if highlighting fails or exceeds the time budget. Caller
 *   should fall back to plain text on any throw.
 */
export async function highlightCode(
  code: string,
  language: string,
  theme: "dark" | "light",
  signal?: AbortSignal
): Promise<string> {
  try {
    return await requestHighlight(code, language, theme, signal);
  } catch (e) {
    // A worker that did not start says nothing about this input. The caller shows plain text
    // meanwhile and has no reason to ask again, so retry here, once, after a worker is ready:
    // a mounted block then highlights without a remount (#6303).
    if (!isHighlightStartFailure(e)) throw e;
    signal?.throwIfAborted();
    await whenWorkerRecovered(language);
    return requestHighlight(code, language, theme, signal);
  }
}

/** One highlight request through the queue and its budget, with failures logged. */
async function requestHighlight(
  code: string,
  language: string,
  theme: "dark" | "light",
  signal: AbortSignal | undefined
): Promise<string> {
  try {
    return await enqueueHighlightWithBudget(
      code,
      language,
      theme,
      async () => {
        // Resolve the worker when this queued job starts, not when it is
        // enqueued. If an earlier job timed out and recycled the worker,
        // later queued jobs must talk to the fresh worker rather than a dead
        // Comlink proxy captured from the old worker.
        const api = getWorkerAPI();
        if (!api) {
          // Worker is structurally unavailable (vscode webview / test env).
          // Main-thread Shiki is the only option; timeout protection cannot
          // preempt synchronous work here, but these environments are not the
          // ones that hit the pathological-input bug in practice.
          return highlightMainThread(code, language, theme, signal);
        }

        return untilWorkerDies(api.highlight(code, language, theme), workerCalls);
      },
      recycleWorker,
      HIGHLIGHT_TIMEOUT_MS,
      signal,
      () => prepareWorker(language)
    );
  } catch (e) {
    // Expected when the caller moved on: the worker is fine, so do not warn or recycle it.
    if (isAbortedHighlight(e, signal)) throw e;
    reportHighlightFailure(e, language, code.length);
    throw e;
  }
}

/**
 * Test-only: how many calls still wait on the current worker. A settled call must leave this
 * count, or every highlight of a long session would stay reachable (#6303).
 */
export function __pendingWorkerCallCountForTests(): number {
  return workerCalls?.size ?? 0;
}

/**
 * Test-only: reset all module state (worker singleton, main-thread highlighter,
 * structural-unavailability flag, timed-out input cache). Lets unit tests start from a clean slate.
 */
export function __resetForTests(): void {
  recycleWorker();
  highlighterPromise = null;
  workerHighlightQueue = Promise.resolve();
  workerStructurallyUnavailable = false;
  warnedVscodeWorkerDisabled = false;
  workerRecoveries.clear();
  timedOutInputs.clear();
}
