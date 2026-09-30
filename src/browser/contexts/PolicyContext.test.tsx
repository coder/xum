import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import React from "react";
import type { PolicyGetResponse } from "@/common/orpc/types";
import { APIProvider, type APIClient } from "./API";
import { PolicyProvider, usePolicy } from "./PolicyContext";
import { createTestApiClient } from "@/browser/testUtils";

async function* emptyStream() {
  // no-op
}

let mockGet: () => Promise<PolicyGetResponse>;

// Keep the API client local to each render so this suite does not leak a process-global
// mock.module override into later context tests.
function createApiClient(): APIClient {
  return createTestApiClient({
    policy: {
      get: () => mockGet(),
      onChanged: () => Promise.resolve(emptyStream()),
    },
  });
}

const buildBlockedResponse = (reason: string): PolicyGetResponse => ({
  source: "governor",
  status: { state: "blocked", reason },
  policy: null,
});

const buildEnforcedResponse = (): PolicyGetResponse => ({
  source: "governor",
  status: { state: "enforced" },
  policy: {
    policyFormatVersion: "0.1",
    providerAccess: null,
    mcp: { allowUserDefined: { stdio: true, remote: true } },
    runtimes: null,
  },
});

function Wrapper(props: { children: React.ReactNode }) {
  return (
    <APIProvider client={createApiClient()}>
      <PolicyProvider>{props.children}</PolicyProvider>
    </APIProvider>
  );
}
Wrapper.displayName = "PolicyContextTestWrapper";

describe("PolicyContext", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalLocalStorage: typeof globalThis.localStorage;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
  });

  test("updates when blocked reason changes", async () => {
    // Keep this response mock resilient to multiple mount refreshes.
    let current = buildBlockedResponse("Reason A");
    mockGet = () => Promise.resolve(current);

    const { result } = renderHook(() => usePolicy(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.status.reason).toBe("Reason A"), {
      timeout: 3000,
    });

    current = buildBlockedResponse("Reason B");
    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => expect(result.current.status.reason).toBe("Reason B"), {
      timeout: 3000,
    });
  });

  test("keeps identical policy responses stable", async () => {
    mockGet = () => Promise.resolve(buildEnforcedResponse());

    const { result } = renderHook(() => usePolicy(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.policy).not.toBeNull(), { timeout: 3000 });

    const firstPolicy = result.current.policy;
    const firstStatus = result.current.status;

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.policy).toBe(firstPolicy);
    expect(result.current.status).toBe(firstStatus);
  });
});
