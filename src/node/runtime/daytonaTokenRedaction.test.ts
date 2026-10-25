import { describe, expect, it } from "bun:test";
import type { PtyHandle } from "./transports";
import {
  DAYTONA_TOKEN_PLACEHOLDER,
  redactDaytonaPty,
  redactDaytonaTokens,
  rememberDaytonaToken,
} from "./daytonaTokenRedaction";

describe("Daytona token redaction", () => {
  it("still redacts the oldest of many live tokens", () => {
    const now = Date.now();
    const tokens = Array.from({ length: 300 }, (_, i) => `many-live-token-${i}-x9q`);
    for (const token of tokens) rememberDaytonaToken(token, now);

    expect(redactDaytonaTokens(`${tokens[0]}@host: Permission denied`)).toBe(
      `${DAYTONA_TOKEN_PLACEHOLDER}@host: Permission denied`
    );
  });

  it("forgets a token once it is older than the retention window", () => {
    // Past times only: the store is process-wide, and a future clock would age out other tests.
    rememberDaytonaToken("aged-out-token-k3v", Date.now() - 4 * 60 * 60_000);
    rememberDaytonaToken("fresh-token-k3v");

    expect(redactDaytonaTokens("aged-out-token-k3v fresh-token-k3v")).toBe(
      `aged-out-token-k3v ${DAYTONA_TOKEN_PLACEHOLDER}`
    );
  });
});

describe("redactDaytonaPty", () => {
  const TOKEN = "pty-token-z7w";
  rememberDaytonaToken(TOKEN);

  function setup() {
    const dataHandlers = new Set<(data: string) => void>();
    let killed = false;
    const pty: PtyHandle = {
      write: () => undefined,
      resize: () => undefined,
      kill: () => {
        killed = true;
      },
      onData: (handler) => {
        dataHandlers.add(handler);
        return { dispose: () => dataHandlers.delete(handler) };
      },
      onExit: () => ({ dispose: () => undefined }),
    };
    const redacted = redactDaytonaPty(pty);
    const output: string[] = [];
    redacted.onData((data) => output.push(data));
    return {
      redacted,
      output,
      emit: (data: string) => {
        for (const handler of dataHandlers) handler(data);
      },
      wasKilled: () => killed,
    };
  }

  it("redacts a token within one chunk", () => {
    const pty = setup();
    pty.emit(`${TOKEN}@gateway: Permission denied\r\n`);
    expect(pty.output.join("")).toBe(`${DAYTONA_TOKEN_PLACEHOLDER}@gateway: Permission denied\r\n`);
  });

  it("passes other output through and kills the underlying pty", () => {
    const pty = setup();
    pty.emit("hello world\r\n");
    expect(pty.output).toEqual(["hello world\r\n"]);
    pty.redacted.kill();
    expect(pty.wasKilled()).toBe(true);
  });
});
