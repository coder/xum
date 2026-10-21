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
    const exitHandlers = new Set<(event: { exitCode: number }) => void>();
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
      onExit: (handler) => {
        exitHandlers.add(handler);
        return { dispose: () => exitHandlers.delete(handler) };
      },
    };
    const timers: Array<{ run: () => void; cancelled: boolean }> = [];
    const schedule = (run: () => void) => {
      const timer = { run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    };
    const redacted = redactDaytonaPty(pty, schedule);
    const output: string[] = [];
    redacted.onData((data) => output.push(data));
    return {
      redacted,
      output,
      emit: (data: string) => {
        for (const handler of dataHandlers) handler(data);
      },
      exit: () => {
        for (const handler of exitHandlers) handler({ exitCode: 255 });
      },
      runPendingTimers: () => {
        for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run();
      },
      pendingTimers: () => timers.filter((timer) => !timer.cancelled).length,
      wasKilled: () => killed,
    };
  }

  it("redacts a token within one chunk", () => {
    const pty = setup();
    pty.emit(`${TOKEN}@gateway: Permission denied\r\n`);
    expect(pty.output.join("")).toBe(`${DAYTONA_TOKEN_PLACEHOLDER}@gateway: Permission denied\r\n`);
  });

  it("redacts a token split across chunks", () => {
    const pty = setup();
    pty.emit(`login ${TOKEN.slice(0, 5)}`);
    pty.emit(`${TOKEN.slice(5)}@gateway's password: `);
    expect(pty.output.join("")).toBe(`login ${DAYTONA_TOKEN_PLACEHOLDER}@gateway's password: `);
  });

  it("redacts a token that ends a chunk and ends with its own first char", () => {
    const overlapping = "q-overlap-token-q";
    rememberDaytonaToken(overlapping);
    const pty = setup();
    pty.emit(`denied for ${overlapping}`);
    pty.runPendingTimers();
    expect(pty.output.join("")).toBe(`denied for ${DAYTONA_TOKEN_PLACEHOLDER}`);
  });

  it("emits a held tail that never becomes a token after the bound", () => {
    const pty = setup();
    pty.emit("$ p");
    expect(pty.output.join("")).toBe("$ ");
    pty.runPendingTimers();
    expect(pty.output.join("")).toBe("$ p");
  });

  it("flushes a held tail before reporting exit", () => {
    const pty = setup();
    const events: string[] = [];
    pty.redacted.onExit(() => events.push(`exit:${pty.output.join("")}`));
    pty.emit("bye p");
    pty.exit();
    expect(events).toEqual(["exit:bye p"]);
    expect(pty.pendingTimers()).toBe(0);
  });

  it("passes other output through and cancels the timer on kill", () => {
    const pty = setup();
    pty.emit("hello world\r\n");
    expect(pty.output).toEqual(["hello world\r\n"]);
    pty.emit("p");
    pty.redacted.kill();
    expect(pty.wasKilled()).toBe(true);
    expect(pty.pendingTimers()).toBe(0);
  });
});
