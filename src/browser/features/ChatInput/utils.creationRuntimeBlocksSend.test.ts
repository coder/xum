import { describe, expect, test } from "bun:test";
import type { ParsedRuntime } from "@/common/types/runtime";
import { creationRuntimeBlocksSend } from "./utils";

const devcontainer: ParsedRuntime = { mode: "devcontainer", configPath: "" };
const worktree: ParsedRuntime = { mode: "worktree" };

describe("creationRuntimeBlocksSend", () => {
  test("a local runtime never waits", () => {
    expect(creationRuntimeBlocksSend({ mode: "local" }, "loading", false)).toBe(false);
  });

  test("other runtimes wait for a loaded branch list (#6033, #6055)", () => {
    expect(creationRuntimeBlocksSend(worktree, "loading", true)).toBe(true);
    expect(creationRuntimeBlocksSend(worktree, "failed", true)).toBe(true);
    expect(creationRuntimeBlocksSend(worktree, "loaded", false)).toBe(false);
  });

  // #6383: a reconnect keeps the shown configs while it probes again.
  test("a Dev Container also waits for the current runtime probe", () => {
    expect(creationRuntimeBlocksSend(devcontainer, "loaded", false)).toBe(true);
    expect(creationRuntimeBlocksSend(devcontainer, "loaded", true)).toBe(false);
  });
});
