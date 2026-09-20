import { describe, expect, test } from "bun:test";

import { parseCommand } from "@/browser/utils/slashCommands/parser";

import { commandBypassesTranscriptBarrier } from "./transcriptBarrier";

describe("commandBypassesTranscriptBarrier", () => {
  test("goal and settings commands stay usable while the transcript hydrates", () => {
    for (const input of [
      "/goal",
      "/goal ship the release",
      "/goal pause",
      "/goal resume",
      "/goal clear",
      "/model gpt-5",
      "/vim",
      "/plan",
    ]) {
      expect(commandBypassesTranscriptBarrier(parseCommand(input))).toBe(true);
    }
  });

  test("plain text, sends and history mutations go through the barrier", () => {
    expect(commandBypassesTranscriptBarrier(null)).toBe(false);
    for (const input of ["hello", "/clear", "/reset", "/compact", "/fork", "/new", "/nope"]) {
      expect(commandBypassesTranscriptBarrier(parseCommand(input))).toBe(false);
    }
  });
});
