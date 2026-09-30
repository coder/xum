import { act, cleanup, render, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";
import { GlobalWindow } from "happy-dom";
import { StrictMode } from "react";
import { useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import type { WorkspaceSelection } from "@/browser/components/AgentListItem/AgentListItem";
import {
  LAST_VISITED_ROUTE_KEY,
  LAUNCH_BEHAVIOR_KEY,
  SELECTED_WORKSPACE_KEY,
} from "@/common/constants/storage";
import { RouterProvider, useRouter, type RouterContext } from "./RouterContext";

function createMatchMedia(isStandalone = false): typeof window.matchMedia {
  return ((query: string) =>
    ({
      matches: isStandalone && query === "(display-mode: standalone)",
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    }) satisfies MediaQueryList) as typeof window.matchMedia;
}

type NavigationType = "navigate" | "reload" | "back_forward" | "prerender";

function installWindow(
  url: string,
  options?: { isStandalone?: boolean; navigationType?: NavigationType }
) {
  // Happy DOM can default to an opaque origin ("null") which breaks URL-based
  // logic in RouterContext. Give it a stable origin.
  const happyWindow = new GlobalWindow({ url });
  globalThis.window = happyWindow as unknown as Window & typeof globalThis;
  globalThis.document = happyWindow.document as unknown as Document;
  globalThis.window.matchMedia = createMatchMedia(options?.isStandalone);
  globalThis.window.localStorage.clear();
  globalThis.window.sessionStorage.clear();

  const navigationEntries = [
    { type: options?.navigationType ?? "navigate" } as unknown as PerformanceNavigationTiming,
  ];
  Object.defineProperty(globalThis.window.performance, "getEntriesByType", {
    configurable: true,
    value: (entryType: string) =>
      entryType === "navigation" ? (navigationEntries as unknown as PerformanceEntryList) : [],
  });
}

function PathnameObserver() {
  const location = useLocation();
  return <div data-testid="pathname">{location.pathname}</div>;
}

describe("modal background location", () => {
  let latestRouter: RouterContext | null = null;
  let latestNavigate: NavigateFunction | null = null;

  function Observer() {
    const router = useRouter();
    const location = useLocation();
    latestRouter = router;
    latestNavigate = useNavigate();

    return (
      <div>
        <div data-testid="pathname">{location.pathname}</div>
        <div data-testid="search">{location.search}</div>
        <div data-testid="settingsSection">{router.currentSettingsSection ?? ""}</div>
        <div data-testid="workspaceId">{router.currentWorkspaceId ?? ""}</div>
        <div data-testid="projectPathFromState">{router.currentProjectPathFromState ?? ""}</div>
        <div data-testid="draftId">{router.pendingDraftId ?? ""}</div>
        <div data-testid="analyticsOpen">{String(router.isAnalyticsOpen)}</div>
      </div>
    );
  }

  async function renderRouter() {
    const view = render(
      <RouterProvider>
        <Observer />
      </RouterProvider>
    );
    await waitFor(() => {
      expect(latestRouter).not.toBeNull();
    });
    return view;
  }

  beforeEach(saveDomGlobals);
  afterEach(() => {
    cleanup();
    latestRouter = null;
    latestNavigate = null;
    restoreDomGlobals();
  });

  test("keeps the workspace behind settings across section switches and redirects", async () => {
    installWindow("https://mux.example.com/workspace/test");
    const view = await renderRouter();

    act(() => latestRouter!.navigateToSettings("general"));
    await waitFor(() => {
      expect(view.getByTestId("settingsSection").textContent).toBe("general");
    });
    expect(view.getByTestId("workspaceId").textContent).toBe("test");

    act(() => latestRouter!.navigateToSettings("models"));
    await waitFor(() => {
      expect(view.getByTestId("settingsSection").textContent).toBe("models");
    });
    act(() => latestRouter!.navigateToSettings("experiments", { replace: true }));
    await waitFor(() => {
      expect(view.getByTestId("settingsSection").textContent).toBe("experiments");
    });
    expect(view.getByTestId("workspaceId").textContent).toBe("test");

    act(() => latestRouter!.navigateFromSettings());
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/workspace/test");
    });
    expect(view.getByTestId("settingsSection").textContent).toBe("");
  });

  test("keeps the project draft and its location.state behind settings and restores them", async () => {
    installWindow("https://mux.example.com/workspace/test");
    const view = await renderRouter();

    // Use a project path that cannot be recovered from the URL alone, so losing
    // location.state would break the /project view.
    const projectPath = "/tmp/unconfigured-project";
    act(() => latestRouter!.navigateToProject(projectPath, "draft-1"));
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/project");
    });

    act(() => latestRouter!.navigateToSettings("providers"));
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/settings/providers");
    });
    expect(view.getByTestId("projectPathFromState").textContent).toBe(projectPath);
    expect(view.getByTestId("draftId").textContent).toBe("draft-1");

    act(() => latestRouter!.navigateFromSettings());
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/project");
    });
    expect(view.getByTestId("search").textContent).toContain("draft=draft-1");
    expect(view.getByTestId("projectPathFromState").textContent).toBe(projectPath);
  });

  test("treats cold settings links and malformed background state as the root page", async () => {
    installWindow("https://mux.example.com/settings/providers");
    const view = await renderRouter();

    expect(view.getByTestId("settingsSection").textContent).toBe("providers");
    expect(view.getByTestId("workspaceId").textContent).toBe("");
    act(() => latestRouter!.navigateFromSettings());
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/");
    });

    act(() => {
      void latestNavigate!("/settings/general", {
        state: { settingsBackground: { pathname: 42, search: "?x", state: null } },
      });
    });
    await waitFor(() => {
      expect(view.getByTestId("settingsSection").textContent).toBe("general");
    });
    expect(view.getByTestId("workspaceId").textContent).toBe("");
    act(() => latestRouter!.navigateFromSettings());
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/");
    });
  });

  test("keeps the workspace behind analytics; closing or going back returns to it", async () => {
    installWindow("https://mux.example.com/workspace/test");
    const view = await renderRouter();

    act(() => latestRouter!.navigateToAnalytics());
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/analytics");
    });
    expect(view.getByTestId("analyticsOpen").textContent).toBe("true");
    expect(view.getByTestId("workspaceId").textContent).toBe("test");

    act(() => latestRouter!.navigateFromAnalytics());
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/workspace/test");
    });
    expect(view.getByTestId("analyticsOpen").textContent).toBe("false");

    act(() => latestRouter!.navigateToAnalytics());
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/analytics");
    });
    act(() => {
      void latestNavigate!(-1);
    });
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/workspace/test");
    });
    expect(view.getByTestId("analyticsOpen").textContent).toBe("false");
  });

  test("opens dispatched before a re-render push a single analytics history entry", async () => {
    installWindow("https://mux.example.com/workspace/test");
    const view = await renderRouter();

    // Keydowns fired in one task all see the pre-open location before React re-renders.
    act(() => {
      const router = latestRouter!;
      router.navigateToAnalytics();
      router.navigateToAnalytics();
      router.navigateToAnalytics();
    });
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/analytics");
    });

    act(() => {
      void latestNavigate!(-1);
    });
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/workspace/test");
    });

    // Back to the same history entry must still be able to open analytics again.
    act(() => latestRouter!.navigateToAnalytics());
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/analytics");
    });
  });

  test("keeps the project draft and its location.state behind analytics and restores them", async () => {
    installWindow("https://mux.example.com/workspace/test");
    const view = await renderRouter();

    const projectPath = "/tmp/unconfigured-project";
    act(() => latestRouter!.navigateToProject(projectPath, "draft-1"));
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/project");
    });

    act(() => latestRouter!.navigateToAnalytics());
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/analytics");
    });
    expect(view.getByTestId("projectPathFromState").textContent).toBe(projectPath);
    expect(view.getByTestId("draftId").textContent).toBe("draft-1");

    act(() => latestRouter!.navigateFromAnalytics());
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/project");
    });
    expect(view.getByTestId("search").textContent).toContain("draft=draft-1");
    expect(view.getByTestId("projectPathFromState").textContent).toBe(projectPath);
  });

  test("treats cold analytics links and malformed background state as the root page", async () => {
    installWindow("https://mux.example.com/analytics");
    const view = await renderRouter();

    expect(view.getByTestId("analyticsOpen").textContent).toBe("true");
    expect(view.getByTestId("workspaceId").textContent).toBe("");
    act(() => latestRouter!.navigateFromAnalytics());
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/");
    });

    // A background pointing at a modal route must not nest modals.
    act(() => {
      void latestNavigate!("/analytics", {
        state: { analyticsBackground: { pathname: "/settings/general", search: "", state: null } },
      });
    });
    await waitFor(() => {
      expect(view.getByTestId("analyticsOpen").textContent).toBe("true");
    });
    expect(view.getByTestId("settingsSection").textContent).toBe("");
    act(() => latestRouter!.navigateFromAnalytics());
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/");
    });
  });

  test("settings opened over analytics returns to analytics over the same page", async () => {
    installWindow("https://mux.example.com/workspace/test");
    const view = await renderRouter();

    act(() => latestRouter!.navigateToAnalytics());
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/analytics");
    });
    act(() => latestRouter!.navigateToSettings("models"));
    await waitFor(() => {
      expect(view.getByTestId("settingsSection").textContent).toBe("models");
    });
    expect(view.getByTestId("analyticsOpen").textContent).toBe("true");
    expect(view.getByTestId("workspaceId").textContent).toBe("test");

    act(() => latestRouter!.navigateFromSettings());
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/analytics");
    });
    expect(view.getByTestId("workspaceId").textContent).toBe("test");

    act(() => latestRouter!.navigateFromAnalytics());
    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/workspace/test");
    });
  });
});

describe("browser startup launch behavior", () => {
  beforeEach(saveDomGlobals);
  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  test("dashboard mode preserves a direct /workspace/:id URL", async () => {
    installWindow("https://mux.example.com/workspace/direct-123");
    window.localStorage.setItem(LAUNCH_BEHAVIOR_KEY, JSON.stringify("dashboard"));

    const view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/workspace/direct-123");
    });
  });

  test("same-tab browser reload preserves a /workspace/:id URL in dashboard mode", async () => {
    installWindow("https://mux.example.com/workspace/reload-me", { navigationType: "reload" });
    window.localStorage.setItem(LAUNCH_BEHAVIOR_KEY, JSON.stringify("dashboard"));

    const view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/workspace/reload-me");
    });
  });

  test("last-workspace mode preserves a /workspace/:id URL", async () => {
    installWindow("https://mux.example.com/workspace/stale-123");
    window.localStorage.setItem(LAUNCH_BEHAVIOR_KEY, JSON.stringify("last-workspace"));

    const view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/workspace/stale-123");
    });
  });

  test("dashboard mode still preserves non-workspace routes", async () => {
    installWindow("https://mux.example.com/settings/general");
    window.localStorage.setItem(LAUNCH_BEHAVIOR_KEY, JSON.stringify("dashboard"));

    const view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/settings/general");
    });
  });

  test("default launch behavior preserves a direct /workspace/:id URL", async () => {
    installWindow("https://mux.example.com/workspace/direct-default");

    const view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/workspace/direct-default");
    });
  });
});

describe("desktop startup route restoration", () => {
  beforeEach(saveDomGlobals);
  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  test("restores the last visited route when Electron boots from file:///index.html", async () => {
    installWindow("file:///index.html");
    window.localStorage.setItem(LAST_VISITED_ROUTE_KEY, JSON.stringify("/workspace/reload-me"));

    const view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/workspace/reload-me");
    });
  });

  test("ignores persisted desktop root routes so last-workspace fallback can win", async () => {
    installWindow("file:///index.html");

    const savedWorkspace: WorkspaceSelection = {
      workspaceId: "workspace-123",
      projectPath: "/tmp/project",
      projectName: "Test Project",
      namedWorkspacePath: "/tmp/project/workspace-123",
    };

    window.localStorage.setItem(LAST_VISITED_ROUTE_KEY, JSON.stringify("/"));
    window.localStorage.setItem(LAUNCH_BEHAVIOR_KEY, JSON.stringify("last-workspace"));
    window.localStorage.setItem(SELECTED_WORKSPACE_KEY, JSON.stringify(savedWorkspace));

    const view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/workspace/workspace-123");
    });
  });

  test("ignores malformed persisted desktop routes instead of crashing startup", async () => {
    installWindow("file:///index.html");
    window.localStorage.setItem(LAST_VISITED_ROUTE_KEY, JSON.stringify({ bad: true }));

    const view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/");
    });
  });

  test("ignores invalid percent-encoded workspace routes instead of restoring a crash loop", async () => {
    installWindow("file:///index.html");
    window.localStorage.setItem(LAST_VISITED_ROUTE_KEY, JSON.stringify("/workspace/%"));

    const view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/");
    });
  });

  test("ignores desktop routes that only share a project/analytics prefix", async () => {
    installWindow("file:///index.html");
    window.localStorage.setItem(LAST_VISITED_ROUTE_KEY, JSON.stringify("/projectevil"));

    let view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/");
    });

    cleanup();
    installWindow("file:///index.html");
    window.localStorage.setItem(LAST_VISITED_ROUTE_KEY, JSON.stringify("/analytics-old"));

    view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/");
    });
  });

  test("persists route changes so the next desktop load can restore them", async () => {
    installWindow("file:///index.html");
    let latestRouter: RouterContext | null = null;

    function Observer() {
      latestRouter = useRouter();
      return <PathnameObserver />;
    }

    const view = render(
      <RouterProvider>
        <Observer />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(latestRouter).not.toBeNull();
      expect(view.getByTestId("pathname").textContent).toBe("/");
    });

    act(() => {
      latestRouter!.navigateToWorkspace("persist-me");
    });

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/workspace/persist-me");
      expect(window.localStorage.getItem(LAST_VISITED_ROUTE_KEY)).toBe(
        JSON.stringify("/workspace/persist-me")
      );
    });
  });
  test("keeps the last meaningful desktop route when navigation briefly hits /", async () => {
    installWindow("file:///index.html");
    let latestRouter: RouterContext | null = null;

    function Observer() {
      latestRouter = useRouter();
      return <PathnameObserver />;
    }

    const view = render(
      <RouterProvider>
        <Observer />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(latestRouter).not.toBeNull();
      expect(view.getByTestId("pathname").textContent).toBe("/");
    });

    act(() => {
      latestRouter!.navigateToWorkspace("persist-me");
    });

    await waitFor(() => {
      expect(window.localStorage.getItem(LAST_VISITED_ROUTE_KEY)).toBe(
        JSON.stringify("/workspace/persist-me")
      );
    });

    act(() => {
      latestRouter!.navigateToHome();
    });

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/");
    });

    expect(window.localStorage.getItem(LAST_VISITED_ROUTE_KEY)).toBe(
      JSON.stringify("/workspace/persist-me")
    );
  });
});

describe("standalone PWA startup", () => {
  beforeEach(saveDomGlobals);
  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  test("shows the dashboard on cold launch even if the launch URL points at a workspace", async () => {
    installWindow("https://mux.example.com/workspace/last-opened", { isStandalone: true });

    const view = render(
      <StrictMode>
        <RouterProvider>
          <PathnameObserver />
        </RouterProvider>
      </StrictMode>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/");
    });
  });

  test("ignores last-workspace launch behavior in standalone mode", async () => {
    installWindow("https://mux.example.com/", { isStandalone: true });

    const savedWorkspace: WorkspaceSelection = {
      workspaceId: "workspace-123",
      projectPath: "/tmp/project",
      projectName: "Test Project",
      namedWorkspacePath: "/tmp/project/workspace-123",
    };
    window.localStorage.setItem(LAUNCH_BEHAVIOR_KEY, JSON.stringify("last-workspace"));
    window.localStorage.setItem(SELECTED_WORKSPACE_KEY, JSON.stringify(savedWorkspace));

    const view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/");
    });
  });

  test("preserves non-workspace deep links on cold standalone launch", async () => {
    installWindow("https://mux.example.com/settings/general", { isStandalone: true });

    const view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/settings/general");
    });
  });

  test("still restores the current route on reloads inside the same standalone window", async () => {
    installWindow("https://mux.example.com/workspace/reload-me", {
      isStandalone: true,
      navigationType: "reload",
    });

    const view = render(
      <RouterProvider>
        <PathnameObserver />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/workspace/reload-me");
    });
  });
});

describe("embedded router (VS Code webview)", () => {
  beforeEach(saveDomGlobals);
  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  test("starts at / and keeps navigation in memory without touching the host URL or persisted route", async () => {
    // A webview document URL is not an app route; the embedded host must neither route from it nor
    // rewrite it (replaceState) or persist a route for a desktop relaunch.
    installWindow("https://webview.example/index.html?id=panel-1");
    let latestRouter: RouterContext | null = null;

    function Observer() {
      latestRouter = useRouter();
      return <PathnameObserver />;
    }

    const view = render(
      <RouterProvider embedded>
        <Observer />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/");
    });

    act(() => {
      latestRouter!.navigateToSettings("providers");
    });

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/settings/providers");
    });
    expect(latestRouter!.currentSettingsSection).toBe("providers");
    expect(window.location.pathname + window.location.search).toBe("/index.html?id=panel-1");
    expect(window.localStorage.getItem(LAST_VISITED_ROUTE_KEY)).toBeNull();
  });
});
