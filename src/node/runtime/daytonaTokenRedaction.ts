import type { ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import { Transform } from "stream";
import { isXumDaytonaHost } from "@/common/constants/daytona";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import type { PtyHandle } from "./transports";

/**
 * Daytona's SSH gateway takes the access token as the ssh user name, so OpenSSH messages such
 * as `<token>@host: Permission denied` carry it. DaytonaService remembers every token it mints
 * (live, replaced and revoked ones alike, until well after they expire), and what Xum keeps
 * from a Daytona host's ssh stderr and errors goes through redactDaytonaTokens first.
 */
export const DAYTONA_TOKEN_PLACEHOLDER = "<daytona-token>";

// Tokens are minted for an hour; a revoked or expired one can still show up in a late error.
// Expiry is by age only: a count cap would drop tokens that are still live. Real mints (one per
// sandbox per hour or so) bound the growth.
const REMEMBER_MS = 3 * 60 * 60_000;

/** token -> when it was remembered */
const rememberedTokens = new Map<string, number>();

export function rememberDaytonaToken(token: string, now = Date.now()): void {
  if (!token) return;
  rememberedTokens.delete(token);
  rememberedTokens.set(token, now);
  for (const [known, at] of rememberedTokens) {
    if (now - at >= REMEMBER_MS) rememberedTokens.delete(known);
  }
}

export function redactDaytonaTokens(text: string): string {
  let redacted = text;
  for (const token of rememberedTokens.keys()) {
    redacted = redacted.replaceAll(token, DAYTONA_TOKEN_PLACEHOLDER);
  }
  return redacted;
}

/** Redact the message (and stack) of an Error in place; keeps its class for callers. */
export function redactDaytonaError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return typeof error === "string" ? redactDaytonaTokens(error) : error;
  }
  error.message = redactDaytonaTokens(error.message);
  if (error.stack) error.stack = redactDaytonaTokens(error.stack);
  return error;
}

/** How many trailing chars of `text` could be the start of a remembered token. */
function tokenPrefixSuffixLength(text: string): number {
  let held = 0;
  for (const token of rememberedTokens.keys()) {
    for (let length = Math.min(token.length - 1, text.length); length > held; length--) {
      if (text.endsWith(token.slice(0, length))) {
        held = length;
        break;
      }
    }
  }
  return held;
}

export interface DaytonaTextRedactor {
  /** Redacted text that is safe to publish now; a possible token start stays held. */
  push(text: string): string;
  /** Everything still held, redacted. */
  flush(): string;
  /** The held text, only while the whole possible token start is shorter than the bound. */
  releaseShortTail(): string;
  holding(): boolean;
}

// An accidental match of a token's first chars this short is negligible, and a leaked prefix
// this short is useless, so it may echo; a longer possible token start waits for more text.
const RELEASABLE_TAIL_LENGTH = 4;

function commonPrefixLength(a: string, b: string): number {
  let length = 0;
  while (length < a.length && a[length] === b[length]) length++;
  return length;
}

/**
 * Redact text that arrives in pieces. A token split across pieces is caught by keeping the tail
 * that could start one: its held part waits for the next piece (or the end), and its released
 * part (already published) is redacted again with what follows, so a token whose start was
 * released is still masked from there on. The text is redacted before the tail is chosen, so a
 * whole token whose last chars also start a token is not split.
 */
export function createDaytonaTextRedactor(): DaytonaTextRedactor {
  let released = "";
  let held = "";
  return {
    push(text) {
      const redacted = redactDaytonaTokens(released + held + text);
      const published = commonPrefixLength(released, redacted);
      const tailStart = redacted.length - tokenPrefixSuffixLength(redacted);
      const cut = Math.max(published, tailStart);
      released = redacted.slice(tailStart, cut);
      held = redacted.slice(cut);
      return redacted.slice(published, cut);
    },
    flush() {
      const rest = held;
      released = "";
      held = "";
      return rest;
    },
    releaseShortTail() {
      if (released.length + held.length >= RELEASABLE_TAIL_LENGTH) return "";
      const rest = held;
      released += held;
      held = "";
      return rest;
    },
    holding: () => held !== "",
  };
}

/** Redact a byte stream with createDaytonaTextRedactor. */
export function createDaytonaRedactingStream(): Transform {
  const decoder = new StringDecoder("utf8");
  const redactor = createDaytonaTextRedactor();
  const emit = (stream: Transform, text: string) => {
    if (text) stream.push(Buffer.from(text, "utf8"));
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      emit(this, redactor.push(decoder.write(chunk)));
      callback();
    },
    flush(callback) {
      emit(this, redactor.push(decoder.end()) + redactor.flush());
      callback();
    },
  });
}

// A PTY gives no signal that more output is coming, so a short held tail is published after
// this quiet period. Otherwise a typed char that happens to start a token would not echo until
// the next output.
const PTY_HOLD_MS = 50;

type CancelTimer = () => void;

function scheduleHoldFlush(run: () => void): CancelTimer {
  const timer = setTimeout(run, PTY_HOLD_MS);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * Redact a PTY's output: without BatchMode OpenSSH can print `<token>@gateway: Permission
 * denied` or a password prompt naming the token into the terminal, which clients replay.
 */
export function redactDaytonaPty(
  pty: PtyHandle,
  schedule: (run: () => void) => CancelTimer = scheduleHoldFlush
): PtyHandle {
  const redactor = createDaytonaTextRedactor();
  const handlers = new Set<(data: string) => void>();
  let subscribed = false;
  let cancelTimer: CancelTimer | undefined;
  const stopTimer = () => {
    cancelTimer?.();
    cancelTimer = undefined;
  };
  const publish = (text: string) => {
    if (!text) return;
    for (const handler of handlers) handler(text);
  };
  const flushHeld = () => {
    stopTimer();
    publish(redactor.flush());
  };
  const releaseShortTail = () => {
    cancelTimer = undefined;
    publish(redactor.releaseShortTail());
  };
  const onRawData = (data: string) => {
    stopTimer();
    publish(redactor.push(data));
    if (redactor.holding()) cancelTimer = schedule(releaseShortTail);
  };
  return {
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: () => {
      stopTimer();
      pty.kill();
    },
    onData(handler) {
      handlers.add(handler);
      if (!subscribed) {
        subscribed = true;
        pty.onData(onRawData);
      }
      return { dispose: () => handlers.delete(handler) };
    },
    onExit: (handler) =>
      pty.onExit((event) => {
        flushHeld();
        handler(event);
      }),
  };
}

/** redactChildStderr for an ssh process to a Daytona alias; other hosts are left alone. */
export function redactDaytonaHostStderr(child: ChildProcess, host: string): void {
  if (isXumDaytonaHost(host)) redactChildStderr(child);
}

/** Route a spawned ssh process's stderr through createDaytonaRedactingStream. */
export function redactChildStderr(child: ChildProcess): void {
  const original = child.stderr;
  if (!original) return;
  const redacting = createDaytonaRedactingStream();
  original.on("error", (error) => {
    log.debug("ssh stderr stream failed", { error: redactDaytonaTokens(getErrorMessage(error)) });
    redacting.end();
  });
  original.pipe(redacting);
  // Every reader of this process's stderr (exec streams, error reporting) attaches after this.
  Object.defineProperty(child, "stderr", { value: redacting, configurable: true });
}
