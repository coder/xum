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

/**
 * Redact a byte stream chunk by chunk. A token split across two chunks is not caught: ssh writes
 * each message (`<token>@host: Permission denied`) in one write.
 */
export function createDaytonaRedactingStream(): Transform {
  const decoder = new StringDecoder("utf8");
  const emit = (stream: Transform, text: string) => {
    if (text) stream.push(Buffer.from(redactDaytonaTokens(text), "utf8"));
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      emit(this, decoder.write(chunk));
      callback();
    },
    flush(callback) {
      emit(this, decoder.end());
      callback();
    },
  });
}

/**
 * Redact a PTY's output chunk by chunk: OpenSSH can print `<token>@gateway: Permission denied`
 * into the terminal, which clients replay. The host block turns off password and
 * keyboard-interactive auth, so no prompt names the token.
 */
export function redactDaytonaPty(pty: PtyHandle): PtyHandle {
  return {
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: () => pty.kill(),
    onData: (handler) => pty.onData((data) => handler(redactDaytonaTokens(data))),
    onExit: (handler) => pty.onExit(handler),
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
