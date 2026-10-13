// Bootstrap Happy DOM before react-dom evaluates.
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../../tests/ui/dom";
import type { APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import type { TestApiOverrides } from "@/browser/testUtils";
import type { ServerAuthSession } from "@/common/orpc/types";
import { ServerAccessSection } from "./ServerAccessSection";

function session(id: string, label: string): ServerAuthSession {
  return { id, label, createdAtMs: 1, lastUsedAtMs: 1, isCurrent: false };
}

let harness: ConnectionHarness;
/** The sessions the next server lists, or a promise of them. */
let serverSessions: ServerAuthSession[] | Promise<ServerAuthSession[]>;

// The session list must stay on screen while offline and while the new client reloads it:
// "Loading sessions..." only replaces an empty list.
describe.each([...GAP_MODES])("ServerAccessSection across a reconnect (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    serverSessions = [session("s1", "Laptop")];
    harness = createConnectionHarness(mode, (): TestApiOverrides<APIClient> => {
      const sessions = serverSessions;
      return { serverAuth: { listSessions: () => Promise.resolve(sessions) } };
    });
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps the listed sessions until the reload answers", async () => {
    const view = render(
      <harness.Wrapper>
        <ServerAccessSection />
      </harness.Wrapper>
    );
    await view.findByText("Laptop");

    let answer: ((sessions: ServerAuthSession[]) => void) | null = null;
    serverSessions = new Promise((resolve) => (answer = resolve));
    await harness.drop();
    expect(view.queryByText("Laptop")).not.toBeNull();
    harness.reconnect();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(view.queryByText("Laptop")).not.toBeNull();
    expect(view.queryByText("Loading sessions...")).toBeNull();

    act(() => answer?.([session("s2", "Phone")]));
    await view.findByText("Phone");
    await waitFor(() => expect(view.queryByText("Laptop")).toBeNull());
  });
});

// A server cancel on a live socket is a plain AbortError. It is a real failure: no reconnect
// comes to reload, so swallowing it would leave the section stuck on stale or no sessions.
describe("ServerAccessSection on a server cancel", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("reports the cancel while connected", async () => {
    harness = createConnectionHarness(
      "kept-gap",
      (): TestApiOverrides<APIClient> => ({
        serverAuth: {
          listSessions: () => Promise.reject(new DOMException("Request cancelled", "AbortError")),
        },
      })
    );
    const view = render(
      <harness.Wrapper>
        <ServerAccessSection />
      </harness.Wrapper>
    );

    await view.findByText("Request cancelled");
    expect(view.queryByText("Loading sessions...")).toBeNull();
  });
});
