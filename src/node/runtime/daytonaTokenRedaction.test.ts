import { describe, expect, it } from "bun:test";
import {
  createDaytonaRedactingStream,
  DAYTONA_TOKEN_PLACEHOLDER,
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
