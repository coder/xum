import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import { restartLocalStorage } from "../../../tests/ui/quotaLimitedStorage";
import { APIProvider } from "@/browser/contexts/API";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { createTestApiClient } from "@/browser/testUtils";
import {
  WORKSPACE_NAME_STATE_MANUAL_NAME_MAX_CHARS,
  getWorkspaceNameStateKey,
} from "@/common/constants/storage";
import { useWorkspaceName } from "./useWorkspaceName";

const generateMock = mock(() =>
  Promise.resolve({
    success: true as const,
    data: { name: "quotes-a1b2", title: "Quote heavy message", modelUsed: "test:model" },
  })
);
const api = createTestApiClient({ nameGeneration: { generate: generateMock } });

function Wrapper(props: { children: ReactNode }) {
  return <APIProvider client={api}>{props.children}</APIProvider>;
}

function renderWorkspaceName(message: string) {
  return renderHook(() => useWorkspaceName({ message, debounceMs: 1, scopeId: "draft-scope" }), {
    wrapper: Wrapper,
  });
}

describe("useWorkspaceName persisted draft state", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    generateMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  // An over-budget state lives only in memory, so after a restart the typed name would be gone.
  test("a very long manual name stays visible and restores as a flagged prefix after a restart", () => {
    const longName = "a".repeat(5000);
    const first = renderWorkspaceName("");
    act(() => first.result.current.setAutoGenerate(false));
    act(() => first.result.current.setName(longName));
    expect(first.result.current.name).toBe(longName);
    // Edits past the limit leave the persisted prefix unchanged but must still show.
    act(() => first.result.current.setName(longName.slice(0, -1)));
    expect(first.result.current.name).toBe(longName.slice(0, -1));
    first.unmount();

    restartLocalStorage();
    const restored = renderWorkspaceName("");
    expect(restored.result.current.autoGenerate).toBe(false);
    expect(restored.result.current.name).toBe(
      longName.slice(0, WORKSPACE_NAME_STATE_MANUAL_NAME_MAX_CHARS - 2)
    );
    expect(restored.result.current.error?.kind).toBe("validation");

    act(() => restored.result.current.setName("my-feature"));
    restored.unmount();
    restartLocalStorage();
    const valid = renderWorkspaceName("");
    expect(valid.result.current.name).toBe("my-feature");
    expect(valid.result.current.error).toBeNull();
  });

  // Switching projects remounts the creation controls; only a restart may cut the name.
  test("a very long manual name stays whole when the creation controls remount", () => {
    const longName = "a".repeat(5000);
    const first = renderWorkspaceName("");
    act(() => first.result.current.setAutoGenerate(false));
    act(() => first.result.current.setName(longName));
    first.unmount();

    const remounted = renderWorkspaceName("");
    expect(remounted.result.current.name).toBe(longName);
  });

  test("another tab's manual name replaces the full name kept for this session", () => {
    const view = renderWorkspaceName("");
    act(() => view.result.current.setAutoGenerate(false));
    act(() => view.result.current.setName("a".repeat(5000)));
    act(() => {
      updatePersistedState<Record<string, unknown>>(
        getWorkspaceNameStateKey("draft-scope"),
        (prev) => ({ ...prev, manualName: "other-tab" }),
        {}
      );
    });
    expect(view.result.current.name).toBe("other-tab");
  });

  test("a name generated for an escape-heavy message survives a restart without regenerating", async () => {
    const message = '"'.repeat(1999);
    const first = renderWorkspaceName(message);
    await waitFor(() => expect(first.result.current.name).toBe("quotes-a1b2"));
    expect(generateMock).toHaveBeenCalledTimes(1);
    first.unmount();

    restartLocalStorage();
    const restored = renderWorkspaceName(message);
    expect(restored.result.current.name).toBe("quotes-a1b2");
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(generateMock).toHaveBeenCalledTimes(1);
  });
});
