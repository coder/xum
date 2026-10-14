// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { createTestApiClient } from "@/browser/testUtils";
import type { McpAppViewDomains } from "@/common/orpc/schemas/mcpApps";
import { useFollowMcpAppViewDomains, useMcpAppViewDomains } from "./mcpAppViewDomainsStore";

/**
 * Config change streams the test pushes into. Each open stream gets every change (the app's
 * own AppConfigStore subscribes too).
 */
function changeStream() {
  const streams = new Set<{ queued: number; wake: (() => void) | null }>();
  const open = (_input: unknown, options?: { signal?: AbortSignal }) => {
    const stream = { queued: 0, wake: null as (() => void) | null };
    streams.add(stream);
    options?.signal?.addEventListener("abort", () => {
      streams.delete(stream);
      stream.wake?.();
    });
    const stopped = () => options?.signal?.aborted === true;
    async function* changes() {
      while (!stopped()) {
        if (stream.queued === 0) await new Promise<void>((resolve) => (stream.wake = resolve));
        if (stopped()) return;
        stream.queued--;
        yield undefined;
      }
    }
    return Promise.resolve(changes());
  };
  const push = () => {
    for (const stream of streams) {
      stream.queued++;
      stream.wake?.();
    }
  };
  return { open, push };
}

function Follower(props: { projectPath: string; serverName: string }) {
  useFollowMcpAppViewDomains(props.projectPath, props.serverName);
  const entry = useMcpAppViewDomains(props.projectPath, props.serverName);
  return (
    <span data-testid={`${props.projectPath}:${props.serverName}`}>
      {entry === undefined ? "none" : entry.origins.join(",") || "empty"}
    </span>
  );
}

describe("live follow of view-domain approvals", () => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
  });

  // E.g. a Revoke in another window, or another Xum process editing config.json.
  test("a change elsewhere reaches mounted views; unmounting the last one stops the stream", async () => {
    const changes = changeStream();
    let stored: McpAppViewDomains[] = [
      { projectPath: "/live", serverName: "charts", origins: ["https://a.example.com"] },
    ];
    let revision = 1_000;
    const reads: number[] = [];
    const client: APIClient = createTestApiClient({
      config: { onConfigChanged: changes.open },
      mcpApps: {
        readViewDomains: () => {
          reads.push(++revision);
          return Promise.resolve({ revision, approvals: stored });
        },
      },
    });
    const view = render(
      <APIProvider client={client}>
        <Follower projectPath="/live" serverName="charts" />
        <Follower projectPath="/live" serverName="maps" />
      </APIProvider>
    );
    const shown = (server: string) => view.getByTestId(`/live:${server}`).textContent;
    // The first read, right after the stream opened, covers changes before it.
    await waitFor(() => expect(shown("charts")).toBe("https://a.example.com"));
    expect(shown("maps")).toBe("empty");
    // Two views, one stream: one read per change.
    expect(reads.length).toBe(1);

    stored = [];
    act(() => changes.push());
    await waitFor(() => expect(shown("charts")).toBe("empty"));
    expect(reads.length).toBe(2);

    view.unmount();
    changes.push();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads.length).toBe(2);
  });

  // A read publishes only the keys followed when it started. A view that mounts during it gets
  // one more read right after: its getView list can predate the change that read covers.
  test("a view that mounts during a read gets a read of its own right after", async () => {
    const changes = changeStream();
    let release = () => undefined as void;
    let revision = 2_000;
    let hold = false;
    const published: string[][] = [];
    const client: APIClient = createTestApiClient({
      config: { onConfigChanged: changes.open },
      mcpApps: {
        readViewDomains: async () => {
          const read = ++revision;
          if (hold) await new Promise<void>((resolve) => (release = resolve));
          return { revision: read, approvals: [] };
        },
      },
    });
    const tree = (late: boolean) => (
      <APIProvider client={client}>
        <Follower projectPath="/snap" serverName="early" />
        {late && <Follower projectPath="/snap" serverName="late" />}
      </APIProvider>
    );
    const view = render(tree(false));
    const shown = (server: string) => view.getByTestId(`/snap:${server}`).textContent;
    await waitFor(() => expect(shown("early")).toBe("empty"));
    hold = true;
    act(() => changes.push());
    await waitFor(() => expect(revision).toBe(2_002));
    view.rerender(tree(true));
    published.push([shown("late") ?? ""]);
    hold = false;
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // No change event came, yet the late view got the next read.
    await waitFor(() => expect(shown("late")).toBe("empty"));
    expect(revision).toBe(2_003);
    expect(published).toEqual([["none"]]);
  });

  // A failed read must not end the follow: a later Revoke elsewhere still has to reach the view.
  test("a failed read opens a new stream after a backoff", async () => {
    const changes = changeStream();
    let failNext = true;
    let revision = 3_000;
    const client: APIClient = createTestApiClient({
      config: { onConfigChanged: changes.open },
      mcpApps: {
        readViewDomains: () => {
          if (failNext) {
            failNext = false;
            return Promise.reject(new Error("backend busy"));
          }
          return Promise.resolve({
            revision: ++revision,
            approvals: [
              { projectPath: "/retry", serverName: "charts", origins: ["https://b.example.com"] },
            ],
          });
        },
      },
    });
    const view = render(
      <APIProvider client={client}>
        <Follower projectPath="/retry" serverName="charts" />
      </APIProvider>
    );
    await waitFor(
      () => expect(view.getByTestId("/retry:charts").textContent).toBe("https://b.example.com"),
      {
        timeout: 3_000,
      }
    );
  });
});
