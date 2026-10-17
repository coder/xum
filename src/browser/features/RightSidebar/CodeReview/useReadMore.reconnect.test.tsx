// Bootstrap Happy DOM before react-dom evaluates.
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../../tests/ui/dom";
import type { APIClient } from "@/browser/contexts/API";
import { createConnectionHarness, GAP_MODES } from "@/browser/contexts/connection.testHarness";
import {
  WorkspaceContext,
  type WorkspaceContext as WorkspaceContextValue,
} from "@/browser/contexts/WorkspaceContext";
import { getReviewStateStore } from "@/browser/stores/ReviewStateStore";
import { createTestApiClient, type TestApiOverrides } from "@/browser/testUtils";
import type { ReviewStateEvent } from "@/common/orpc/schemas/reviewState";
import type { DiffHunk } from "@/common/types/review";
import { useReadMore } from "./useReadMore";

const HUNK: DiffHunk = {
  id: "hunk-1",
  filePath: "src/a.ts",
  oldStart: 10,
  oldLines: 2,
  newStart: 10,
  newLines: 2,
  content: " a\n b",
  header: "@@ -10,2 +10,2 @@",
};

/** Review state with the hunk expanded downward, so the hook reads the lines below it. */
function serveExpandedHunk() {
  const sections = { readMore: { [HUNK.id]: { up: 0, down: 20 } } };
  const reviewState = {
    subscribe: (_input: { workspaceId: string }, opts?: { signal?: AbortSignal }) => {
      const first: ReviewStateEvent = { type: "snapshot", snapshot: { sections }, revision: 1 };
      return Promise.resolve(
        (async function* () {
          yield first;
          await new Promise<void>((resolve) =>
            opts?.signal?.addEventListener("abort", () => resolve(), { once: true })
          );
        })()
      );
    },
    update: () => Promise.resolve({ sections, revision: 2 }),
  };
  getReviewStateStore().setClient(createTestApiClient({ workspace: { reviewState } }));
}

/** The read below the hunk: held until the test answers or a drop cuts it off. */
function serverOverrides(): TestApiOverrides<APIClient> {
  return {
    workspace: { executeBash: () => new Promise(() => undefined) },
  } as unknown as TestApiOverrides<APIClient>;
}

// A read cut off by a lost connection must end its loading row: the expand button stays, and
// the reconnect can read again.
describe.each([...GAP_MODES])("useReadMore across a dropped connection (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    serveExpandedHunk();
  });

  afterEach(() => {
    cleanup();
    getReviewStateStore().setClient(null);
    cleanupDom?.();
    cleanupDom = null;
  });

  test("a read the drop cut off does not leave a loading row", async () => {
    const harness = createConnectionHarness(mode, serverOverrides);
    const workspaceContext = {
      workspaceMetadata: new Map(),
      loading: false,
      loaded: true,
      loadError: null,
    } as unknown as WorkspaceContextValue;
    const wrapper = (props: { children: ReactNode }) => (
      <harness.Wrapper>
        <WorkspaceContext.Provider value={workspaceContext}>
          {props.children}
        </WorkspaceContext.Provider>
      </harness.Wrapper>
    );
    const view = renderHook(
      () =>
        useReadMore({
          hunk: HUNK,
          hunkId: HUNK.id,
          workspaceId: "ws-1",
          diffBase: "HEAD",
          includeUncommitted: true,
        }),
      { wrapper }
    );
    await waitFor(() => expect(view.result.current.downLoading).toBe(true));

    await harness.drop();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(view.result.current.downLoading).toBe(false);
  });
});
