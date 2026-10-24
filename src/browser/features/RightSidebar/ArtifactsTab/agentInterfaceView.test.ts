import { describe, expect, test } from "bun:test";
import { resolveAgentInterfaceView, type AgentInterfaceView } from "./agentInterfaceView";

describe("resolveAgentInterfaceView", () => {
  test.each<[string, boolean, boolean, AgentInterfaceView | null, AgentInterfaceView]>([
    ["defaults to the status page when it exists", true, true, null, "status"],
    ["an explicit chat choice wins over the default", true, true, "chat", "chat"],
    ["an explicit status choice is kept", true, true, "status", "status"],
    // Never a blank pane: without a page the transcript shows, whatever was chosen.
    ["a missing status page shows the transcript", true, false, null, "chat"],
    ["a status choice without a page shows the transcript", true, false, "status", "chat"],
    ["the experiment off shows the transcript", false, true, "status", "chat"],
  ])("%s", (_name, enabled, statusExists, stored, expected) => {
    expect(resolveAgentInterfaceView({ enabled, statusExists, stored })).toBe(expected);
  });
});
