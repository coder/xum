// Bootstrap Happy DOM before react-dom evaluates.
import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import type { APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import type { TestApiOverrides } from "@/browser/testUtils";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import { useWorkflowRunById } from "./useWorkflowRunById";

function makeRun(sequence: number): WorkflowRunRecord {
  const at = `2026-06-26T00:00:0${sequence}.000Z`;
  return {
    id: "wfr_child",
    workspaceId: "workspace-1",
    workflow: { name: "loop", description: "Loop", scope: "global", executable: true },
    source: "export default function workflow() { return null; }",
    sourceHash: "sha256:test",
    args: {},
    status: "running",
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: at,
    events: [{ sequence, type: "status", at, status: "running" }],
    steps: [],
  };
}

let harness: ConnectionHarness;
let serverRun: WorkflowRunRecord;

// The nested-workflow views poll a running child run. While the connection is down, a poll
// fails with ConnectionLostError (kept-gap): that must not replace the shown run with an error.
describe.each([...GAP_MODES])("useWorkflowRunById across a reconnect (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    serverRun = makeRun(1);
    harness = createConnectionHarness(mode, (): TestApiOverrides<APIClient> => {
      const run = serverRun;
      return { workflows: { getRun: () => Promise.resolve(run) } };
    });
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps the shown run without an error while offline", async () => {
    const view = renderHook(
      () =>
        useWorkflowRunById({
          workspaceId: "workspace-1",
          runId: "wfr_child",
          pollWhileActive: true,
        }),
      { wrapper: harness.Wrapper }
    );
    await waitFor(() => expect(view.result.current.run?.events[0]?.sequence).toBe(1));

    await harness.drop();
    // Let one poll interval pass while the connection is down.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_100));
    });
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.run?.events[0]?.sequence).toBe(1);

    serverRun = makeRun(2);
    harness.reconnect();
    await waitFor(() => expect(view.result.current.run?.events[0]?.sequence).toBe(2));
    expect(view.result.current.error).toBeNull();
  });
});
