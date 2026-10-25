import { describe, expect, it } from "bun:test";
import type { PtyHandle } from "./transports";
import {
  createDaytonaRedactingStream,
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

  it("redacts a token that a stream splits across chunks", async () => {
    rememberDaytonaToken("split-stream-token-q8r");
    const stream = createDaytonaRedactingStream();
    const out: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => out.push(chunk));
    const done = new Promise((resolve) => stream.on("end", resolve));
    stream.write("split-stream-");
    stream.end("token-q8r@gateway: Permission denied\r\n");
    await done;

    expect(Buffer.concat(out).toString()).toBe(
      `${DAYTONA_TOKEN_PLACEHOLDER}@gateway: Permission denied\r\n`
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

  it("redacts a token split across chunks, and shows a held end that was not one", async () => {
    const pty = setup();
    pty.emit(`denied for ${TOKEN.slice(0, 5)}`);
    pty.emit(`${TOKEN.slice(5)}@gateway\r\n$ pty-`);
    expect(pty.output.join("")).toBe(`denied for ${DAYTONA_TOKEN_PLACEHOLDER}@gateway\r\n$ `);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pty.output.join("")).toEndWith("\r\n$ pty-");
  });

  it("passes other output through and kills the underlying pty", () => {
    const pty = setup();
    pty.emit("hello world\r\n");
    expect(pty.output).toEqual(["hello world\r\n"]);
    pty.redacted.kill();
    expect(pty.wasKilled()).toBe(true);
  });
});
