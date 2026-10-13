import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import { useLiveAPI } from "@/browser/contexts/API";
import { createConnectionHarness, GAP_MODES } from "@/browser/contexts/connection.testHarness";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { createWorkspace } from "@/browser/stories/mocks/workspaces";
import { useDiscardSideChatOnLeave } from "./useDiscardSideChatOnLeave";

let removed: string[] = [];

const serverOverrides = () => ({
  workspace: {
    remove: (input: { workspaceId: string }) => {
      removed.push(input.workspaceId);
      return Promise.resolve({ success: true as const });
    },
  },
});

const metadata: ReadonlyMap<string, FrontendWorkspaceMetadata> = new Map([
  ["main", createWorkspace({ id: "main", name: "main", projectName: "proj" })],
  [
    "side",
    {
      ...createWorkspace({ id: "side", name: "side", projectName: "proj" }),
      sideChatParentWorkspaceId: "main",
    },
  ],
]);

/** Wires the hook the way WorkspaceContext does: it gets the live client. */
function Probe(props: { currentWorkspaceId: string }) {
  useDiscardSideChatOnLeave(useLiveAPI(), props.currentWorkspaceId, metadata);
  return null;
}

describe.each([...GAP_MODES])("useDiscardSideChatOnLeave (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
    removed = [];
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("a side chat left while offline is discarded once the connection is back", async () => {
    const harness = createConnectionHarness(mode, serverOverrides);
    const view = render(<Probe currentWorkspaceId="side" />, { wrapper: harness.Wrapper });

    await harness.drop();
    view.rerender(<Probe currentWorkspaceId="main" />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Nothing is sent to a server that is not there: the discard waits.
    expect(removed).toEqual([]);

    harness.reconnect();
    await waitFor(() => expect(removed).toEqual(["side"]));
  });
});
