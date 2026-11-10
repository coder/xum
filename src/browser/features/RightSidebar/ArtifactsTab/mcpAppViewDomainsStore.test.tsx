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

  // The follow waits for a change when a second server's view mounts: that view's getView list
  // can predate a change the follow already read.
  test("a view that mounts while the follow waits gets a read at once", async () => {
    const changes = changeStream();
    let revision = 4_000;
    const client: APIClient = createTestApiClient({
      config: { onConfigChanged: changes.open },
      mcpApps: {
        readViewDomains: () => Promise.resolve({ revision: ++revision, approvals: [] }),
      },
    });
    const tree = (late: boolean) => (
      <APIProvider client={client}>
        <Follower projectPath="/idle" serverName="early" />
        {late && <Follower projectPath="/idle" serverName="late" />}
      </APIProvider>
    );
    const view = render(tree(false));
    const shown = (server: string) => view.getByTestId(`/idle:${server}`).textContent;
    await waitFor(() => expect(shown("early")).toBe("empty"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.rerender(tree(true));
    // No change event: the join alone starts the read.
    await waitFor(() => expect(shown("late")).toBe("empty"));
    expect(revision).toBe(4_002);
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

  // #6181: a backend that ends each stream right after one good read must not get a new
  // stream every 500 ms forever.
  test("a stream that ends right after its first read reconnects with a growing backoff", async () => {
    // Each stream of the follow reads once. Counted by reads: the app's own config store opens
    // streams too.
    let reads = 0;
    const client: APIClient = createTestApiClient({
      config: {
        // A stream that ends at once, with no changes.
        onConfigChanged: () =>
          Promise.resolve({
            [Symbol.asyncIterator]: () => ({
              next: () => Promise.resolve({ done: true as const, value: undefined }),
            }),
          }),
      },
      mcpApps: {
        readViewDomains: () =>
          Promise.resolve({
            revision: 7_000 + ++reads,
            approvals: [
              { projectPath: "/ends", serverName: "charts", origins: ["https://e.example.com"] },
            ],
          }),
      },
    });
    const view = render(
      <APIProvider client={client}>
        <Follower projectPath="/ends" serverName="charts" />
      </APIProvider>
    );
    await waitFor(() =>
      expect(view.getByTestId("/ends:charts").textContent).toBe("https://e.example.com")
    );
    // A reset backoff reads at about 0, 0.5, 1.0, 1.5 and 2.0 s. A growing one reads at
    // about 0, 0.5 and 1.5 s.
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    expect(reads).toBeLessThanOrEqual(3);
    view.unmount();
  });

  // #6181: one read that never settles must not stall the follow for good.
  test("a read that never settles times out, and a new stream reads again", async () => {
    let reads = 0;
    const changes = changeStream();
    const client: APIClient = createTestApiClient({
      config: { onConfigChanged: changes.open },
      mcpApps: {
        readViewDomains: (_input: unknown, options?: { signal?: AbortSignal }) => {
          reads++;
          if (reads === 1) {
            // Hangs until the follow gives up on it.
            return new Promise((_resolve, reject) =>
              options?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
            );
          }
          return Promise.resolve({
            revision: 8_000 + reads,
            approvals: [
              { projectPath: "/hang", serverName: "charts", origins: ["https://h.example.com"] },
            ],
          });
        },
      },
    });
    const view = render(
      <APIProvider client={client}>
        <Follower projectPath="/hang" serverName="charts" />
      </APIProvider>
    );
    await waitFor(
      () => expect(view.getByTestId("/hang:charts").textContent).toBe("https://h.example.com"),
      { timeout: 8_000 }
    );
    view.unmount();
  }, 10_000);
});
