import * as RealMarkdownCore from "../Messages/MarkdownCore";
import * as RealMarkdownRenderer from "../Messages/MarkdownRenderer";
import * as RealClipboard from "@/browser/utils/clipboard";
import { APIContext, APIProvider } from "@/browser/contexts/API";
import type { ReactElement, ReactNode } from "react";
import { PlanTab } from "./PlanTab";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { APIClient } from "@/browser/contexts/API";
import { createTestApiClient, type TestApiOverrides } from "@/browser/testUtils";
import { CUSTOM_EVENTS, type CustomEventType } from "@/common/constants/events";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getPlanTabScrollTopKey } from "@/common/constants/storage";

type GetPlanContentResult =
  | { success: true; data: { content: string; path: string } }
  | { success: false; error: string };

let mockApi: TestApiOverrides<APIClient> | null = null;

// Scope module mocks to each test so renderer assertions use the real pipeline.
const realModules: Array<[string, Record<string, unknown>]> = [
  ["@/browser/features/Messages/MarkdownCore", { ...RealMarkdownCore }],
  ["@/browser/features/Messages/MarkdownRenderer", { ...RealMarkdownRenderer }],
  ["@/browser/utils/clipboard", { ...RealClipboard }],
];

/** What the mocked clipboard received. */
let clipboardWrites: string[] = [];

async function installModuleMocks() {
  await mock.module("@/browser/features/Messages/MarkdownCore", () => ({
    MarkdownCore: (props: { content: string }) => (
      <div data-testid="plan-markdown-core">{props.content}</div>
    ),
  }));

  await mock.module("@/browser/features/Messages/MarkdownRenderer", () => ({
    PlanMarkdownContainer: (props: { children: ReactNode }) => (
      <div data-testid="plan-markdown-container">{props.children}</div>
    ),
  }));

  await mock.module("@/browser/utils/clipboard", () => ({
    ...RealClipboard,
    copyToClipboard: (text: string) => {
      clipboardWrites.push(text);
      return Promise.resolve();
    },
  }));
}

// Inject the client through the real provider (a module mock of contexts/API is process-wide).
// The wrapper reads mockApi at render time; a null mockApi models an unavailable backend.
function ApiWrapper(props: { children: ReactNode }) {
  if (mockApi === null) {
    return (
      <APIContext.Provider
        value={{
          status: "error",
          api: null,
          error: "API unavailable",
          authenticate: () => undefined,
          retry: () => undefined,
        }}
      >
        {props.children}
      </APIContext.Provider>
    );
  }
  return <APIProvider client={createTestApiClient(mockApi)}>{props.children}</APIProvider>;
}

function renderWithApi(ui: ReactElement) {
  return render(ui, { wrapper: ApiWrapper });
}

async function restoreModuleMocks() {
  for (const [path, exports] of realModules) await mock.module(path, () => exports);
}

function planResult(content: string, path = "/tmp/plan.md"): GetPlanContentResult {
  return { success: true, data: { content, path } };
}

describe("PlanTab", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(async () => {
    await installModuleMocks();
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    mockApi = null;
    clipboardWrites = [];
  });

  afterEach(async () => {
    cleanup();
    await restoreModuleMocks();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("shows the plan and its path once read", async () => {
    const getPlanContent = mock(() => Promise.resolve(planResult("# Plan title\n\n- item")));
    mockApi = { workspace: { getPlanContent } };

    const view = renderWithApi(<PlanTab workspaceId="workspace-1" />);

    await waitFor(() => {
      expect(view.getByTestId("plan-markdown-core").textContent).toContain("# Plan title");
    });
    expect(getPlanContent).toHaveBeenCalledTimes(1);
    expect(view.getByTestId("plan-tab-path").textContent).toBe("/tmp/plan.md");
    expect(view.getByRole("button", { name: "Implement" }).hasAttribute("disabled")).toBe(false);
  });

  test("re-reads the plan when the window regains focus", async () => {
    let planText = "# First draft";
    const getPlanContent = mock(() => Promise.resolve(planResult(planText)));
    mockApi = { workspace: { getPlanContent } };

    const view = renderWithApi(<PlanTab workspaceId="workspace-1" />);
    await waitFor(() => {
      expect(view.getByTestId("plan-markdown-core").textContent).toContain("# First draft");
    });

    // An external editor saved the file: the next focus shows the saved text.
    planText = "# Second draft";
    act(() => {
      window.dispatchEvent(new window.Event("focus"));
    });

    await waitFor(() => {
      expect(view.getByTestId("plan-markdown-core").textContent).toContain("# Second draft");
    });
    expect(getPlanContent).toHaveBeenCalledTimes(2);
  });

  test("a workspace without a plan says how to get one and disables the actions", async () => {
    const getPlanContent = mock(() =>
      Promise.resolve({
        success: false,
        error: "Plan file not found at /tmp/plans/ws.md",
      } satisfies GetPlanContentResult)
    );
    mockApi = { workspace: { getPlanContent } };

    const view = renderWithApi(<PlanTab workspaceId="workspace-2" />);

    await waitFor(() => {
      expect(view.getByTestId("plan-tab-error").textContent).toContain("Plan file not found");
    });
    expect(view.getByText(/Switch to the Plan agent/)).toBeTruthy();
    expect(view.getByRole("button", { name: "Implement" }).hasAttribute("disabled")).toBe(true);
    expect(view.getByRole("button", { name: "Edit" }).hasAttribute("disabled")).toBe(true);
  });

  test("other read errors show without the how-to hint", async () => {
    const getPlanContent = mock(() =>
      Promise.resolve({
        success: false,
        error: "Could not read the plan file because the workspace runtime is unreachable",
      } satisfies GetPlanContentResult)
    );
    mockApi = { workspace: { getPlanContent } };

    const view = renderWithApi(<PlanTab workspaceId="workspace-2" />);

    await waitFor(() => {
      expect(view.getByTestId("plan-tab-error").textContent).toContain("unreachable");
    });
    expect(view.queryByText(/Switch to the Plan agent/)).toBeNull();
  });

  test("restores a workspace's plan scroll offset when the tab returns", async () => {
    const getPlanContent = mock(() => Promise.resolve(planResult("# Long plan")));
    mockApi = { workspace: { getPlanContent } };

    const first = renderWithApi(<PlanTab workspaceId="workspace-1" />);
    await waitFor(() => {
      expect(first.getByTestId("plan-markdown-core").textContent).toContain("# Long plan");
    });
    fireEvent.scroll(first.getByTestId("plan-tab-body"), { target: { scrollTop: 120 } });
    // Leaving the workspace (or switching tabs) unmounts the body, which saves the offset.
    first.unmount();

    const second = renderWithApi(<PlanTab workspaceId="workspace-1" />);
    await waitFor(() => {
      expect(second.getByTestId("plan-markdown-core").textContent).toContain("# Long plan");
    });
    expect(second.getByTestId("plan-tab-body").scrollTop).toBe(120);
    second.unmount();

    // Another workspace starts from its own (unset) offset.
    const other = renderWithApi(<PlanTab workspaceId="workspace-2" />);
    await waitFor(() => {
      expect(other.getByTestId("plan-markdown-core").textContent).toContain("# Long plan");
    });
    expect(other.getByTestId("plan-tab-body").scrollTop).toBe(0);
  });

  test("a saved scroll offset survives an unmount before the plan loaded", () => {
    const key = getPlanTabScrollTopKey("workspace-1");
    updatePersistedState<number>(key, 120, 0);
    // The read never settles: a slow remote runtime.
    mockApi = { workspace: { getPlanContent: mock(() => new Promise<never>(() => undefined)) } };

    const view = renderWithApi(<PlanTab workspaceId="workspace-1" />);
    expect(view.getByText("Loading plan…")).toBeTruthy();
    view.unmount();

    expect(readPersistedState<number>(key, 0)).toBe(120);
  });

  test("a re-read that fails clears the shown plan and disables its actions", async () => {
    let read: GetPlanContentResult = planResult("# Plan");
    const getPlanContent = mock(() => Promise.resolve(read));
    mockApi = { workspace: { getPlanContent } };

    const view = renderWithApi(<PlanTab workspaceId="workspace-1" />);
    await waitFor(() => {
      expect(view.getByTestId("plan-markdown-core").textContent).toContain("# Plan");
    });

    // The file was deleted after it was shown.
    read = { success: false, error: "Plan file not found at /tmp/plan.md" };
    act(() => {
      window.dispatchEvent(new window.Event("focus"));
    });

    await waitFor(() => {
      expect(view.getByTestId("plan-tab-error").textContent).toContain("Plan file not found");
    });
    expect(view.queryByTestId("plan-markdown-core")).toBeNull();
    expect(view.queryByTestId("plan-tab-path")).toBeNull();
    expect(view.getByRole("button", { name: "Implement" }).hasAttribute("disabled")).toBe(true);
    expect(view.getByRole("button", { name: "Edit" }).hasAttribute("disabled")).toBe(true);
    expect(view.getByRole("button", { name: "Copy" }).hasAttribute("disabled")).toBe(true);
  });

  test("single-key shortcuts act while the tab has focus, not from a text field", async () => {
    mockApi = { workspace: { getPlanContent: mock(() => Promise.resolve(planResult("# Plan"))) } };
    const view = renderWithApi(<PlanTab workspaceId="workspace-1" />);
    await waitFor(() => {
      expect(view.getByTestId("plan-markdown-core").textContent).toContain("# Plan");
    });

    const panel = view.getByTestId("plan-tab");
    fireEvent.keyDown(panel, { key: "y" });
    expect(clipboardWrites).toEqual(["# Plan"]);

    // A text field inside the tab keeps its letters.
    const field = document.createElement("input");
    panel.appendChild(field);
    fireEvent.keyDown(field, { key: "y" });
    expect(clipboardWrites).toEqual(["# Plan"]);
  });

  test("takes focus when opened by its shortcut, once", async () => {
    mockApi = { workspace: { getPlanContent: mock(() => Promise.resolve(planResult("# Plan"))) } };
    const consumed = mock(() => undefined);
    const view = renderWithApi(
      <PlanTab workspaceId="workspace-1" autoFocus onAutoFocusConsumed={consumed} />
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(view.getByTestId("plan-tab"));
    });
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  test("renders API-unavailable state when not connected", async () => {
    mockApi = null;

    const view = renderWithApi(<PlanTab workspaceId="workspace-3" />);

    await waitFor(() => {
      expect(view.getByTestId("plan-tab-error").textContent).toContain("API unavailable");
    });
  });

  test("Implement runs the latest plan card's action and reports when none can run", async () => {
    mockApi = { workspace: { getPlanContent: mock(() => Promise.resolve(planResult("# Plan"))) } };
    const view = renderWithApi(<PlanTab workspaceId="workspace-1" />);
    await waitFor(() => {
      expect(view.getByRole("button", { name: "Implement" }).hasAttribute("disabled")).toBe(false);
    });

    // showFeedbackToast dispatches its event only where the composer hosts toasts; elsewhere
    // it falls back to a native alert.
    const composer = document.createElement("div");
    composer.setAttribute("data-component", "ChatInputSection");
    document.body.appendChild(composer);
    const toasts: Array<{ type: string }> = [];
    const onToast = (event: Event) => {
      toasts.push((event as CustomEventType<typeof CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST>).detail);
    };
    const requests: string[] = [];
    const planCard = (event: Event) => {
      const { detail } = event as CustomEventType<typeof CUSTOM_EVENTS.RUN_LATEST_PLAN_ACTION>;
      requests.push(detail.workspaceId);
      detail.handled = true;
    };
    window.addEventListener(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, onToast);
    window.addEventListener(CUSTOM_EVENTS.RUN_LATEST_PLAN_ACTION, planCard);
    try {
      // A plan card is listening: it runs the action, so there is nothing to report.
      fireEvent.click(view.getByRole("button", { name: "Implement" }));
      expect(requests).toEqual(["workspace-1"]);
      expect(toasts).toEqual([]);

      // No card can run it (none rendered, or its action disabled): the tab says so.
      window.removeEventListener(CUSTOM_EVENTS.RUN_LATEST_PLAN_ACTION, planCard);
      fireEvent.click(view.getByRole("button", { name: "Implement" }));
      expect(toasts.map((toast) => toast.type)).toEqual(["error"]);
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, onToast);
      window.removeEventListener(CUSTOM_EVENTS.RUN_LATEST_PLAN_ACTION, planCard);
      composer.remove();
    }
  });
});
