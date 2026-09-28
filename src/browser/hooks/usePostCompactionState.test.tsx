import "../../../tests/ui/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { createTestApiClient } from "@/browser/testUtils";
import { usePostCompactionState } from "./usePostCompactionState";

type PostCompactionResult = Awaited<ReturnType<APIClient["workspace"]["getPostCompactionState"]>>;

const BACKEND_STATE: PostCompactionResult = {
  planPath: "~/.xum/plans/demo/ws.md",
  trackedFilePaths: ["src/a.ts"],
  excludedItems: ["file:src/a.ts"],
};

function fakeClient(getPostCompactionState: () => Promise<PostCompactionResult>) {
  return createTestApiClient({ workspace: { getPostCompactionState } });
}

function Probe(props: { workspaceId: string }) {
  const state = usePostCompactionState(props.workspaceId);
  return (
    <output data-testid="state">
      {JSON.stringify({
        planPath: state.planPath,
        trackedFilePaths: state.trackedFilePaths,
        excludedItems: Array.from(state.excludedItems),
      })}
    </output>
  );
}

describe("usePostCompactionState", () => {
  let cleanupDom: () => void;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom();
  });

  test("keeps backend state in memory only: fetched on first mount, instant on remount", async () => {
    // Own workspace ID: the in-memory cache is module-level and outlives other renders.
    const workspaceId = "ws-post-compaction-cache";
    const renderProbe = (client: APIClient) =>
      render(
        <APIProvider client={client}>
          <Probe workspaceId={workspaceId} />
        </APIProvider>
      );

    const firstView = renderProbe(fakeClient(() => Promise.resolve(BACKEND_STATE)));
    expect(JSON.parse(firstView.getByTestId("state").textContent ?? "")).toEqual({
      planPath: null,
      trackedFilePaths: [],
      excludedItems: [],
    });
    await waitFor(() =>
      expect(JSON.parse(firstView.getByTestId("state").textContent ?? "")).toEqual(BACKEND_STATE)
    );
    for (let index = 0; index < window.localStorage.length; index++) {
      expect(window.localStorage.key(index)).not.toStartWith("postCompactionState:");
    }
    firstView.unmount();

    // Remount: seeded from memory before the refetch (which never resolves here) returns.
    const secondView = renderProbe(
      fakeClient(() => new Promise<PostCompactionResult>(() => undefined))
    );
    expect(JSON.parse(secondView.getByTestId("state").textContent ?? "")).toEqual(BACKEND_STATE);
  });
});
