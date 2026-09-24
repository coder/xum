import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { MAX_LOG_ENTRIES } from "@/common/constants/ui";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import * as realAPI from "@/browser/contexts/API";

restoreModulesAfterSuite([["@/browser/contexts/API", { ...realAPI }]]);

type LogLevel = "error" | "warn" | "info" | "debug";

interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  location: string;
}

type LogStreamEvent =
  | { type: "snapshot"; epoch: number; entries: LogEntry[] }
  | { type: "append"; epoch: number; entries: LogEntry[] }
  | { type: "reset"; epoch: number };

interface MockAPI {
  general: {
    subscribeLogs: () => Promise<AsyncGenerator<LogStreamEvent, void, unknown>>;
    clearLogs: () => Promise<{ success: boolean; error?: string | null }>;
  };
}

let mockApi: MockAPI | null = null;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: mockApi,
    status: mockApi ? ("connected" as const) : ("connecting" as const),
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

import { OutputTab } from "../OutputTab/OutputTab";

function formatEntryMessage(id: number): string {
  return `entry-${id.toString().padStart(4, "0")}`;
}

function createEntries(startId: number, count: number): LogEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const id = startId + i;
    return {
      timestamp: id,
      level: "info",
      message: formatEntryMessage(id),
      location: `src/test.ts:${id}`,
    };
  });
}

function streamEvents(...events: LogStreamEvent[]): AsyncGenerator<LogStreamEvent, void, unknown> {
  return (async function* () {
    for (const event of events) {
      yield event;
      // Keep this helper explicitly async to match oRPC stream semantics.
      await Promise.resolve();
    }
  })();
}

describe("OutputTab", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    mockApi = null;
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("renders initial log snapshot from subscription", async () => {
    const initialEntries = createEntries(0, 5);
    mockApi = {
      general: {
        subscribeLogs: () =>
          Promise.resolve(streamEvents({ type: "snapshot", epoch: 1, entries: initialEntries })),
        clearLogs: () => Promise.resolve({ success: true }),
      },
    };

    const view = render(<OutputTab workspaceId="workspace-1" />);

    await waitFor(() => {
      expect(view.getAllByText(/^entry-\d{4}$/)).toHaveLength(5);
    });

    expect(view.getByText(formatEntryMessage(0))).toBeTruthy();
    expect(view.getByText(formatEntryMessage(4))).toBeTruthy();
  });

  test("caps streamed entries and evicts the oldest entries", async () => {
    const initialEntries = createEntries(0, MAX_LOG_ENTRIES);
    const appendedEntries = createEntries(MAX_LOG_ENTRIES, 200);

    mockApi = {
      general: {
        subscribeLogs: () =>
          Promise.resolve(
            streamEvents(
              { type: "snapshot", epoch: 1, entries: initialEntries },
              { type: "append", epoch: 1, entries: appendedEntries }
            )
          ),
        clearLogs: () => Promise.resolve({ success: true }),
      },
    };

    const view = render(<OutputTab workspaceId="workspace-1" />);

    await waitFor(() => {
      expect(view.getAllByText(/^entry-\d{4}$/)).toHaveLength(MAX_LOG_ENTRIES);
    });

    expect(view.queryByText(formatEntryMessage(0))).toBeNull();
    expect(view.queryByText(formatEntryMessage(199))).toBeNull();
    expect(view.getByText(formatEntryMessage(200))).toBeTruthy();
    expect(view.getByText(formatEntryMessage(MAX_LOG_ENTRIES + 199))).toBeTruthy();
  });

  test("reset event clears entries", async () => {
    const initialEntries = createEntries(0, 3);

    let resolveResetGate: () => void = () => undefined;
    const resetGate = new Promise<void>((resolve) => {
      resolveResetGate = () => resolve();
    });

    mockApi = {
      general: {
        subscribeLogs: () =>
          Promise.resolve(
            (async function* (): AsyncGenerator<LogStreamEvent, void, unknown> {
              yield { type: "snapshot", epoch: 1, entries: initialEntries };
              await resetGate;
              yield { type: "reset", epoch: 2 };
            })()
          ),
        clearLogs: () => Promise.resolve({ success: true }),
      },
    };

    const view = render(<OutputTab workspaceId="workspace-1" />);

    await waitFor(() => {
      expect(view.getByText(formatEntryMessage(0))).toBeTruthy();
    });

    resolveResetGate();

    await waitFor(() => {
      expect(view.queryByText(formatEntryMessage(0))).toBeNull();
    });
  });

  test("displays warning when clearLogs returns failure", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      mockApi = {
        general: {
          subscribeLogs: () =>
            Promise.resolve(
              streamEvents({ type: "snapshot", epoch: 1, entries: createEntries(0, 1) })
            ),
          clearLogs: () => Promise.resolve({ success: false, error: "disk error" }),
        },
      };

      const view = render(<OutputTab workspaceId="workspace-1" />);
      const deleteButton = view.getByRole("button", { name: "Delete output logs" });

      fireEvent.click(deleteButton);

      await waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith("Log files could not be fully deleted:", "disk error");
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("stale append after reset is rejected", async () => {
    const initialEntries = createEntries(0, 1);
    const staleEntries = createEntries(1000, 1);
    const currentEpochEntries = createEntries(2000, 1);

    let resolvePostSnapshotGate: () => void = () => undefined;
    const postSnapshotGate = new Promise<void>((resolve) => {
      resolvePostSnapshotGate = () => resolve();
    });

    mockApi = {
      general: {
        subscribeLogs: () =>
          Promise.resolve(
            (async function* (): AsyncGenerator<LogStreamEvent, void, unknown> {
              yield { type: "snapshot", epoch: 1, entries: initialEntries };
              await postSnapshotGate;
              yield { type: "reset", epoch: 2 };
              yield { type: "append", epoch: 1, entries: staleEntries };
              yield { type: "append", epoch: 2, entries: currentEpochEntries };
            })()
          ),
        clearLogs: () => Promise.resolve({ success: true }),
      },
    };

    const view = render(<OutputTab workspaceId="workspace-1" />);

    await waitFor(() => {
      expect(view.getByText(formatEntryMessage(0))).toBeTruthy();
    });

    resolvePostSnapshotGate();

    await waitFor(() => {
      expect(view.queryByText(formatEntryMessage(0))).toBeNull();
      expect(view.queryByText(formatEntryMessage(1000))).toBeNull();
      expect(view.getByText(formatEntryMessage(2000))).toBeTruthy();
    });
  });
});
