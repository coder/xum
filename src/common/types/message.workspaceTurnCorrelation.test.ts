import { describe, expect, test } from "bun:test";

import { parseWorkspaceTurnTaskCorrelation } from "./message";

const correlation = {
  taskHandleId: "wst_handle",
  ownerWorkspaceId: "parentworkspace",
  turnId: "turn",
};

describe("parseWorkspaceTurnTaskCorrelation", () => {
  test("reads a workspace-turn-task marker", () => {
    expect(
      parseWorkspaceTurnTaskCorrelation({ type: "workspace-turn-task", ...correlation })
    ).toEqual(correlation);
  });

  test("reads the continuation a reactivating bash-monitor wake carries", () => {
    expect(
      parseWorkspaceTurnTaskCorrelation({
        type: "bash-monitor-wake",
        records: [],
        workspaceTurn: correlation,
      })
    ).toEqual(correlation);
  });

  test("a plain wake or an incomplete correlation is not a correlation", () => {
    expect(
      parseWorkspaceTurnTaskCorrelation({ type: "bash-monitor-wake", records: [] })
    ).toBeNull();
    expect(
      parseWorkspaceTurnTaskCorrelation({
        type: "bash-monitor-wake",
        records: [],
        workspaceTurn: { taskHandleId: "wst_handle", ownerWorkspaceId: " ", turnId: "turn" },
      })
    ).toBeNull();
    expect(parseWorkspaceTurnTaskCorrelation({ type: "normal" })).toBeNull();
    expect(parseWorkspaceTurnTaskCorrelation(undefined)).toBeNull();
  });
});
