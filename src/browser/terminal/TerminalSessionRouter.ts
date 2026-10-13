/**
 * TerminalSessionRouter - Centralized manager for terminal session streams
 *
 * Eliminates entire classes of bugs by enforcing:
 * 1. Exactly one ORPC stream per sessionId (no duplicate subscriptions)
 * 2. Explicit routing via Map lookup (no closure captures)
 * 3. Synchronous subscribe/unsubscribe (no timing races)
 * 4. Cached screenState for late subscribers
 *
 * Usage:
 * ```typescript
 * const router = new TerminalSessionRouter(api);
 * const unsubscribe = router.subscribe(sessionId, {
 *   onOutput: (data) => term.write(data),
 *   onScreenState: (state) => { term.clear(); term.write(state); },
 *   onExit: (code) => console.log('Exit:', code),
 * });
 * // Later:
 * unsubscribe();
 * ```
 */

import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import { getErrorMessage } from "@/common/utils/errors";
import { isConnectionLostError } from "@/browser/contexts/connectionLink";

type APIClient = RouterClient<AppRouter>;

export interface TerminalSubscriberCallbacks {
  onOutput: (data: string) => void;
  /**
   * The full screen (with the server's scrollback). `replace` is set when it follows a reattach
   * after a reconnect: the subscriber already shows an older screen and must reset before
   * writing, or the scrollback lines repeat.
   */
  onScreenState: (state: string, options?: { replace: boolean }) => void;
  onExit: (code: number) => void;
}

interface SessionState {
  /** Unique subscriber ID → callbacks */
  subscribers: Map<number, TerminalSubscriberCallbacks>;
  /** Cached screen state (sent to new subscribers immediately) */
  screenState: string | null;
  /** Abort controller for the attach and exit streams of the current client */
  abortController: AbortController;
  /** Bumped on each new client: a stream of an older client stops delivering. */
  generation: number;
  /** The next screenState follows a reattach and replaces the screen. */
  replaceNextScreen: boolean;
  /** Whether the session has exited */
  exited: boolean;
  /** Exit code if exited */
  exitCode?: number;
}

let nextSubscriberId = 1;

/**
 * The router lives as long as its provider. When the API client changes (a reconnect), it keeps
 * every session, subscriber and cached screen and restarts the streams on the new client, so an
 * open terminal keeps its screen instead of being cleared. With no client (the connection is
 * down), streams stop, input is dropped, and the sessions wait.
 */
export class TerminalSessionRouter {
  private api: APIClient | null;
  private sessions = new Map<string, SessionState>();
  /** The last size sent per session, sent again after a reattach. */
  private sizes = new Map<string, { cols: number; rows: number }>();

  /** True in a pop-out terminal window: its attaches keep the session out of the sidebar. */
  private readonly popout: boolean;

  constructor(api: APIClient | null, options?: { popout?: boolean }) {
    this.api = api;
    this.popout = options?.popout === true;
  }

  /** The client the streams run on now; null while the connection is down. */
  getApi(): APIClient | null {
    return this.api;
  }

  /**
   * Move every session to a new client (a reconnect), or stop the streams (null). Sessions,
   * subscribers and cached screens stay. Exited sessions are not restarted.
   */
  setClient(api: APIClient | null): void {
    if (api === this.api) return;
    this.api = api;
    for (const [sessionId, session] of this.sessions) {
      session.abortController.abort();
      session.abortController = new AbortController();
      session.generation += 1;
      if (session.exited) continue;
      // Only a subscriber that already shows a screen must reset before the new one.
      session.replaceNextScreen = session.screenState !== null;
      if (api != null) this.startStream(sessionId, session);
    }
  }

  /**
   * Subscribe to a terminal session's output.
   *
   * If this is the first subscriber for the session, starts the ORPC stream.
   * If screenState is already cached (from a previous subscriber), delivers it immediately.
   *
   * @returns Unsubscribe function (call to stop receiving data)
   */
  subscribe(sessionId: string, callbacks: TerminalSubscriberCallbacks): () => void {
    const subscriberId = nextSubscriberId++;

    console.debug(`[TerminalRouter] Subscribe: session=${sessionId}, subscriberId=${subscriberId}`);

    let session = this.sessions.get(sessionId);
    if (!session) {
      // First subscriber - create session state and start stream
      console.debug(`[TerminalRouter] First subscriber for ${sessionId}, starting stream`);
      session = {
        subscribers: new Map(),
        screenState: null,
        abortController: new AbortController(),
        generation: 0,
        replaceNextScreen: false,
        exited: false,
      };
      this.sessions.set(sessionId, session);
      this.startStream(sessionId, session);
    }

    // Add subscriber
    session.subscribers.set(subscriberId, callbacks);
    console.debug(
      `[TerminalRouter] Session ${sessionId} now has ${session.subscribers.size} subscribers`
    );

    // Deliver cached screenState if available (for late subscribers)
    if (session.screenState !== null) {
      // Use setTimeout to ensure this happens after the caller has finished setup
      setTimeout(() => {
        const currentSession = this.sessions.get(sessionId);
        const currentCallbacks = currentSession?.subscribers.get(subscriberId);
        if (currentCallbacks && currentSession && currentSession.screenState !== null) {
          currentCallbacks.onScreenState(currentSession.screenState);
        }
      }, 0);
    }

    // If session already exited, notify immediately
    if (session.exited && session.exitCode !== undefined) {
      setTimeout(() => {
        const currentSession = this.sessions.get(sessionId);
        const currentCallbacks = currentSession?.subscribers.get(subscriberId);
        if (currentCallbacks && currentSession?.exited && currentSession.exitCode !== undefined) {
          currentCallbacks.onExit(currentSession.exitCode);
        }
      }, 0);
    }

    // Return unsubscribe function
    return () => {
      console.debug(
        `[TerminalRouter] Unsubscribe: session=${sessionId}, subscriberId=${subscriberId}`
      );
      const currentSession = this.sessions.get(sessionId);
      if (!currentSession) {
        console.debug(`[TerminalRouter] Session ${sessionId} already removed`);
        return;
      }

      currentSession.subscribers.delete(subscriberId);
      console.debug(
        `[TerminalRouter] Session ${sessionId} now has ${currentSession.subscribers.size} subscribers`
      );

      // If no more subscribers, tear down the stream
      if (currentSession.subscribers.size === 0) {
        console.debug(`[TerminalRouter] No more subscribers for ${sessionId}, tearing down stream`);
        currentSession.abortController.abort();
        this.sessions.delete(sessionId);
        this.sizes.delete(sessionId);
      }
    };
  }

  /**
   * Intercept terminal color queries that ghostty-web might not respond to yet.
   *
   * OSC 10/11 queries (foreground/background) are used by some TUIs to theme themselves.
   */
  private handleTerminalQueries(sessionId: string, data: string) {
    if (data.includes("\x1b]11;?") || data.includes("\x1b]10;?")) {
      const styles = getComputedStyle(document.documentElement);
      if (data.includes("\x1b]11;?")) {
        const bg = styles.getPropertyValue("--color-terminal-bg").trim() || "#1e1e1e";
        this.sendInput(sessionId, `\x1b]11;${this.formatXtermColor(bg)}\x07`);
      }
      if (data.includes("\x1b]10;?")) {
        const fg = styles.getPropertyValue("--color-terminal-fg").trim() || "#d4d4d4";
        this.sendInput(sessionId, `\x1b]10;${this.formatXtermColor(fg)}\x07`);
      }
    }
  }

  private formatXtermColor(color: string): string {
    // OSC 10/11 responses are typically expected in xterm's `rgb:RRRR/GGGG/BBBB` form.
    //
    // Note: our theme vars often use HSL (see globals.css), so we must resolve to an RGB
    // value before responding.
    if (color.startsWith("#")) {
      const hex = color.slice(1);
      if (hex.length === 3) {
        const r16 = hex[0].repeat(4);
        const g16 = hex[1].repeat(4);
        const b16 = hex[2].repeat(4);
        return `rgb:${r16}/${g16}/${b16}`;
      }
      if (hex.length === 6) {
        const r8 = hex.slice(0, 2);
        const g8 = hex.slice(2, 4);
        const b8 = hex.slice(4, 6);
        return `rgb:${r8}${r8}/${g8}${g8}/${b8}${b8}`;
      }
    }

    const computedRgb = this.computeCssColorToRgb(color);
    if (!computedRgb) {
      return color;
    }

    const toHex2 = (value: number) => {
      const clamped = Math.max(0, Math.min(255, Math.round(value)));
      return clamped.toString(16).padStart(2, "0");
    };

    const r8 = toHex2(computedRgb.r);
    const g8 = toHex2(computedRgb.g);
    const b8 = toHex2(computedRgb.b);
    return `rgb:${r8}${r8}/${g8}${g8}/${b8}${b8}`;
  }

  private computeCssColorToRgb(color: string): { r: number; g: number; b: number } | null {
    // This is a rare path (only when a TUI queries OSC 10/11), but the terminal output
    // stream is performance sensitive. Be defensive: never throw.
    try {
      const el = document.createElement("div");
      el.style.color = color;

      // Some browsers won't fully resolve computed styles unless the element is in the DOM.
      // Use a hidden element and clean it up immediately.
      el.style.position = "absolute";
      el.style.left = "-9999px";
      el.style.top = "-9999px";

      const parent = document.body ?? document.documentElement;
      parent.appendChild(el);

      try {
        const computed = getComputedStyle(el).color;
        const match = /^rgba?\((.*)\)$/.exec(computed);
        if (!match) {
          return null;
        }

        const beforeSlash = match[1].split("/")[0] ?? "";
        const parts = beforeSlash
          .replace(/,/g, " ")
          .trim()
          .split(/\s+/)
          .filter((p) => p.length > 0);

        if (parts.length < 3) {
          return null;
        }

        const r = Number.parseFloat(parts[0] ?? "");
        const g = Number.parseFloat(parts[1] ?? "");
        const b = Number.parseFloat(parts[2] ?? "");

        if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
          return null;
        }

        return { r, g, b };
      } finally {
        el.remove();
      }
    } catch {
      return null;
    }
  }

  /**
   * Send input to a terminal session.
   */
  sendInput(sessionId: string, data: string): void {
    this.withClient(
      () => console.debug(`[TerminalRouter] Dropped input for ${sessionId}: not connected`),
      (api) => {
        // Typing while the connection drops must not surface as an unhandled rejection.
        api.terminal
          .sendInput({ sessionId, data })
          .catch((err: unknown) =>
            console.debug(`[TerminalRouter] Input for ${sessionId} not sent:`, err)
          );
      }
    );
  }

  /**
   * Resize a terminal session.
   *
   * Returns a promise that resolves when the backend handler has completed.
   * (This is used by TerminalView to keep frontend and PTY dimensions in sync.)
   */
  resize(sessionId: string, cols: number, rows: number): Promise<void> {
    // Offline, the size is kept and sent again once the streams restart.
    this.sizes.set(sessionId, { cols, rows });
    return this.withClient(
      () => Promise.resolve(),
      (api) => api.terminal.resize({ sessionId, cols, rows })
    );
  }

  /** Runs `run` on the current client, or `offline` while the connection is down. */
  private withClient<T>(offline: () => T, run: (api: APIClient) => T): T {
    return this.api == null ? offline() : run(this.api);
  }

  /**
   * Clean up all sessions (call on unmount).
   */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.abortController.abort();
    }
    this.sessions.clear();
    this.sizes.clear();
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  /** Starts the attach and exit streams of a session on the current client, if any. */
  private startStream(sessionId: string, session: SessionState): void {
    const api = this.api;
    if (api == null) return;
    const { signal } = session.abortController;
    const generation = session.generation;
    // Streams of an older client (or of a removed session) stop delivering.
    const isCurrent = () =>
      !signal.aborted &&
      this.sessions.get(sessionId) === session &&
      session.generation === generation;

    console.debug(`[TerminalRouter] Starting stream for session ${sessionId}`);
    const size = this.sizes.get(sessionId);
    // The PTY may have missed a resize while the connection was down. attach waits for it: its
    // first message is the server's screen, which must already have the new size (PTY first).
    const resized =
      size == null
        ? Promise.resolve()
        : api.terminal
            .resize({ sessionId, ...size })
            .catch((err: unknown) =>
              console.debug(`[TerminalRouter] Resize after reattach failed:`, err)
            );
    void this.runAttachStream(api, sessionId, session, signal, isCurrent, resized);
    void this.runExitStream(api, sessionId, session, signal, isCurrent);
  }

  private async runAttachStream(
    api: APIClient,
    sessionId: string,
    session: SessionState,
    signal: AbortSignal,
    isCurrent: () => boolean,
    resized: Promise<void>
  ): Promise<void> {
    await resized;
    if (!isCurrent()) return;
    try {
      const iterator = await api.terminal.attach(
        this.popout ? { sessionId, popout: true } : { sessionId },
        { signal }
      );
      for await (const msg of iterator) {
        if (!isCurrent()) {
          console.debug(`[TerminalRouter] Stream for ${sessionId} superseded, stopping`);
          break;
        }
        this.deliverMessage(sessionId, session, msg);
      }
    } catch (err) {
      // A lost connection is not a stream error: the next client restarts the stream.
      if (isCurrent() && !isConnectionLostError(err)) {
        console.error(`[TerminalRouter] Stream error for ${sessionId}:`, err);
      }
    }
  }

  private async runExitStream(
    api: APIClient,
    sessionId: string,
    session: SessionState,
    signal: AbortSignal,
    isCurrent: () => boolean
  ): Promise<void> {
    try {
      const iterator = await api.terminal.onExit({ sessionId }, { signal });
      for await (const code of iterator) {
        if (!isCurrent()) break;
        session.exited = true;
        session.exitCode = code;
        for (const callbacks of session.subscribers.values()) {
          callbacks.onExit(code);
        }
        break; // Exit only happens once
      }
    } catch (err) {
      if (isCurrent() && !isExpectedExitStreamError(err)) {
        console.error(`[TerminalRouter] Exit stream error for ${sessionId}:`, err);
      }
    }
  }

  private deliverMessage(
    sessionId: string,
    session: SessionState,
    msg: { type: "screenState" | "output"; data: string }
  ): void {
    if (msg.type === "screenState") {
      this.deliverScreen(session, msg.data);
      return;
    }
    // Centralized shim for OSC 10/11 color queries that some TUIs rely on.
    this.handleTerminalQueries(sessionId, msg.data);
    for (const callbacks of session.subscribers.values()) {
      callbacks.onOutput(msg.data);
    }
  }

  /** Cache and broadcast a full screen; the first one after a reattach replaces the old one. */
  private deliverScreen(session: SessionState, state: string): void {
    session.screenState = state;
    const replace = session.replaceNextScreen;
    session.replaceNextScreen = false;
    for (const callbacks of session.subscribers.values()) {
      if (replace) callbacks.onScreenState(state, { replace: true });
      else callbacks.onScreenState(state);
    }
  }
}

/** Exit-stream errors that mean nothing ended: a lost connection, or no session yet. */
export function isExpectedExitStreamError(err: unknown): boolean {
  if (isConnectionLostError(err)) return true;
  const message = getErrorMessage(err);
  return message.includes("isOpen") || message.includes("undefined");
}
