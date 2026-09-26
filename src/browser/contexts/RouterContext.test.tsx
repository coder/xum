import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { StrictMode } from "react";
import { useLocation } from "react-router-dom";
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

describe("navigateFromSettings", () => {
  beforeEach(() => {
    installWindow("https://mux.example.com/workspace/test");
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("restores the previous location.state when leaving settings", async () => {
    let latestRouter: RouterContext | null = null;

    function Observer() {
      const router = useRouter();
      const location = useLocation();
      latestRouter = router;

      return (
        <div>
          <div data-testid="pathname">{location.pathname}</div>
          <div data-testid="projectPathFromState">{router.currentProjectPathFromState ?? ""}</div>
        </div>
      );
    }

    const view = render(
      <RouterProvider>
        <Observer />
      </RouterProvider>
    );

    await waitFor(() => {
      expect(latestRouter).not.toBeNull();
    });

    // Use a project path that cannot be recovered from the URL alone, so losing
    // location.state would break the /project view.
    const projectPath = "/tmp/unconfigured-project";

    act(() => {
      latestRouter!.navigateToProject(projectPath);
    });

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/project");
      expect(view.getByTestId("projectPathFromState").textContent).toBe(projectPath);
    });

    // Allow effects to flush so RouterContext has a chance to snapshot the last
    // non-settings location before we navigate into settings.
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      latestRouter!.navigateToSettings("general");
    });

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/settings/general");
    });

    act(() => {
      latestRouter!.navigateFromSettings();
    });

    await waitFor(() => {
      expect(view.getByTestId("pathname").textContent).toBe("/project");
      expect(view.getByTestId("projectPathFromState").textContent).toBe(projectPath);
    });
  });
});

describe("browser startup launch behavior", () => {
  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
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
  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
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
  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
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
  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
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
