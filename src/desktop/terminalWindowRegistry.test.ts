import { describe, expect, test } from "bun:test";
import { TerminalWindowRegistry } from "./terminalWindowRegistry";

describe("TerminalWindowRegistry (#5739)", () => {
  test("when one of two pop-outs exits, only its window is closed and the other stays open", () => {
    const registry = new TerminalWindowRegistry<string>();
    registry.add("ws-1", "window-a", "session-a");
    registry.add("ws-1", "window-b", "session-b");
    registry.add("ws-2", "window-c", "session-a");

    expect(registry.select("ws-1", "session-a")).toEqual(["window-a"]);

    registry.remove("ws-1", "window-a");
    expect(registry.select("ws-1")).toEqual(["window-b"]);
  });

  test("a close without a session closes every pop-out of the workspace", () => {
    const registry = new TerminalWindowRegistry<string>();
    registry.add("ws-1", "window-a", "session-a");
    registry.add("ws-1", "window-b", undefined);

    expect(registry.select("ws-1")).toEqual(["window-a", "window-b"]);
    expect(registry.select("ws-unknown")).toEqual([]);
  });
});
