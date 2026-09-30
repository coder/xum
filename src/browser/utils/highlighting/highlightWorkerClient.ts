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
 *     reaches the front of the queue. When it expires we assume the worker is
 *     wedged in native code (e.g. Oniguruma catastrophic backtracking on a
 *     TextMate grammar) and terminate the worker, freeing its CPU immediately.
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
import { mapToShikiLang, SHIKI_DARK_THEME, SHIKI_LIGHT_THEME } from "./shiki-shared";
import { isVscodeWebview } from "@/browser/utils/env";

// 5 s is generous for human-scale files (a 10k-LoC file at typical line lengths
// highlights in well under 1 s on real hardware) but cuts off catastrophic
// backtracking, which otherwise pegs a core indefinitely.
const HIGHLIGHT_TIMEOUT_MS = 5000;

// Sentinel thrown internally when the time budget is exceeded. Kept distinct
// from generic Errors so the caller path can choose how loudly to log it.
const TIMEOUT_MARKER = "HIGHLIGHT_TIMEOUT";

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

    createdWorker.onerror = (e) => {
      // A worker that errored out is not necessarily permanently broken — the
      // error may be confined to a single grammar/input. Clear state so the
      // next highlight call builds a fresh worker, but only if this is still
      // the active worker. Stale error events from already-replaced workers
      // must not terminate a healthy replacement.
      console.error("[highlightWorkerClient] Worker errored; recycling:", e);
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
  theme: "dark" | "light"
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

  const shikiTheme = theme === "light" ? SHIKI_LIGHT_THEME : SHIKI_DARK_THEME;
  return highlighter.codeToHtml(code, {
    lang: shikiLang,
    theme: shikiTheme,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Race `call` against the time budget. On budget expiry:
 *   - invoke `onTimeout` (production: terminate the wedged worker),
 *   - remember the input fingerprint so we don't retry it,
 *   - throw the timeout sentinel so the caller renders plain text.
 *
 * Exported for unit testing. Production callers should use `highlightCode`.
 */
export async function highlightWithBudget(
  code: string,
  language: string,
  theme: "dark" | "light",
  call: () => Promise<string>,
  onTimeout: () => void,
  timeoutMs: number = HIGHLIGHT_TIMEOUT_MS
): Promise<string> {
  const key = inputKey(code, language, theme);
  if (timedOutInputs.has(key)) {
    // Previously blew the budget. Bail fast without touching the worker so we
    // don't keep terminating workers for the same input on every re-render.
    throw new Error(TIMEOUT_MARKER);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(TIMEOUT_MARKER)), timeoutMs);
      }),
    ]);
  } catch (e) {
    if (e instanceof Error && e.message === TIMEOUT_MARKER) {
      timedOutInputs.add(key);
      // Side effect (terminate worker) happens AFTER the cache is populated
      // so any synchronous follow-on call sees the fingerprint immediately.
      onTimeout();
    }
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  timeoutMs: number = HIGHLIGHT_TIMEOUT_MS
): Promise<string> {
  const run = () => highlightWithBudget(code, language, theme, call, onTimeout, timeoutMs);
  const result = workerHighlightQueue.then(run, run);
  workerHighlightQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
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
 * @returns Promise resolving to HTML string with syntax highlighting
 * @throws Error if highlighting fails or exceeds the time budget. Caller
 *   should fall back to plain text on any throw.
 */
export async function highlightCode(
  code: string,
  language: string,
  theme: "dark" | "light"
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
          return highlightMainThread(code, language, theme);
        }

        return api.highlight(code, language, theme);
      },
      recycleWorker
    );
  } catch (e) {
    if (e instanceof Error && e.message === TIMEOUT_MARKER) {
      // Demote to a warn once per pathological input — `timedOutInputs` is the
      // dedupe key. The terminate side effect already happened inside
      // `highlightWithBudget`.
      console.warn(
        `[highlightWorkerClient] highlight exceeded ${HIGHLIGHT_TIMEOUT_MS}ms budget for ${language}; ` +
          `rendering as plain text and skipping this input henceforth (${code.length} chars)`
      );
    } else {
      // Non-timeout error — worker may be in an indeterminate state. Recycle
      // so the next call gets a fresh one. Don't main-thread fallback (same
      // engine, same risk).
      console.warn("[highlightWorkerClient] worker highlight failed; recycling:", e);
      recycleWorker();
    }
    throw e;
  }
}

/**
 * Test-only: reset all module state (worker singleton, structural-unavailability
 * flag, timed-out input cache). Lets unit tests start from a clean slate.
 */
export function __resetForTests(): void {
  recycleWorker();
  workerHighlightQueue = Promise.resolve();
  workerStructurallyUnavailable = false;
  warnedVscodeWorkerDisabled = false;
  timedOutInputs.clear();
}
