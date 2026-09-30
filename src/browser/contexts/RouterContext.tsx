import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  prependInitialAppProxyBasePath,
  stripInitialAppProxyBasePathFromPathname,
} from "@/browser/utils/frontendBasePath";
import {
  LAST_VISITED_ROUTE_KEY,
  LAUNCH_BEHAVIOR_KEY,
  SELECTED_WORKSPACE_KEY,
  type LaunchBehavior,
} from "@/common/constants/storage";
import type { WorkspaceSelection } from "@/browser/components/ProjectSidebar/ProjectSidebar";
import { getProjectRouteId } from "@/common/utils/projectRouteId";

export interface RouterContext {
  navigateToWorkspace: (workspaceId: string) => void;
  navigateToProject: (
    projectPath: string,
    draftId?: string,
    options?: { replace?: boolean }
  ) => void;
  navigateToHome: () => void;
  navigateToSettings: (section?: string, options?: { replace?: boolean }) => void;
  navigateFromSettings: () => void;
  navigateToAnalytics: () => void;
  navigateFromAnalytics: () => void;
  currentWorkspaceId: string | null;

  /** Settings section from URL (null when settings is closed). */
  currentSettingsSection: string | null;

  /** Project identifier from URL (does not include full filesystem path). */
  currentProjectId: string | null;

  /** Optional project path carried via in-memory navigation state (not persisted on refresh). */
  currentProjectPathFromState: string | null;

  /** Draft ID for UI-only workspace creation drafts (from URL) */
  pendingDraftId: string | null;

  /** True when the analytics dashboard route is active. */
  isAnalyticsOpen: boolean;
}

const RouterContext = createContext<RouterContext | undefined>(undefined);

export function useRouter(): RouterContext {
  const ctx = useContext(RouterContext);
  if (!ctx) {
    throw new Error("useRouter must be used within RouterProvider");
  }
  return ctx;
}

type StartupNavigationType = "navigate" | "reload" | "back_forward" | "prerender" | null;

function isStandalonePwa(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches
  );
}

function getStartupNavigationType(): StartupNavigationType {
  const entries = window.performance?.getEntriesByType?.("navigation");
  const firstEntry = entries?.[0];
  const entryType =
    firstEntry && typeof firstEntry === "object" && "type" in firstEntry ? firstEntry.type : null;

  if (
    entryType === "navigate" ||
    entryType === "reload" ||
    entryType === "back_forward" ||
    entryType === "prerender"
  ) {
    return entryType;
  }

  const legacyType = window.performance?.navigation?.type;
  if (legacyType === 1) {
    return "reload";
  }
  if (legacyType === 2) {
    return "back_forward";
  }
  if (legacyType === 0) {
    return "navigate";
  }

  return null;
}

function isRouteRestoringNavigationType(type: StartupNavigationType): boolean {
  return type === "reload" || type === "back_forward";
}

function shouldRestoreWorkspaceUrlOnStartup(options: {
  isStandalone: boolean;
  launchBehavior: LaunchBehavior | null;
  navigationType: StartupNavigationType;
}): boolean {
  if (options.isStandalone) {
    return isRouteRestoringNavigationType(options.navigationType);
  }

  return (
    options.launchBehavior === "last-workspace" ||
    options.navigationType === "navigate" ||
    isRouteRestoringNavigationType(options.navigationType)
  );
}

function hasValidEncodedPathSegment(encodedValue: string): boolean {
  if (encodedValue.length === 0) {
    return false;
  }

  try {
    decodeURIComponent(encodedValue);
    return true;
  } catch {
    return false;
  }
}

function hasValidRestorableWorkspaceRoute(route: string): boolean {
  if (!route.startsWith("/workspace/")) {
    return false;
  }

  const workspaceId = route.slice("/workspace/".length).split(/[?#]/, 1)[0] ?? "";
  return hasValidEncodedPathSegment(workspaceId);
}

function hasValidRestorableSettingsRoute(route: string): boolean {
  if (!route.startsWith("/settings/")) {
    return false;
  }

  const sectionId = route.slice("/settings/".length).split(/[?#]/, 1)[0] ?? "";
  return hasValidEncodedPathSegment(sectionId);
}

function matchesRouteBoundary(route: string, basePath: string): boolean {
  return route === basePath || route.startsWith(`${basePath}?`) || route.startsWith(`${basePath}#`);
}

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function isRestorableRoute(route: unknown): route is string {
  if (typeof route !== "string" || route.length === 0) {
    return false;
  }

  return (
    hasValidRestorableWorkspaceRoute(route) ||
    matchesRouteBoundary(route, "/project") ||
    hasValidRestorableSettingsRoute(route) ||
    matchesRouteBoundary(route, "/analytics")
  );
}

/** Get the initial route, falling back to the compatibility root entrypoint when needed. */
function getInitialRoute(): string {
  const routePathname = stripInitialAppProxyBasePathFromPathname(window.location.pathname);
  const isStorybook = routePathname.endsWith("iframe.html");
  const isStandalone = isStandalonePwa();
  const navigationType = getStartupNavigationType();
  const launchBehavior = !isStandalone
    ? readPersistedState<LaunchBehavior>(LAUNCH_BEHAVIOR_KEY, "dashboard")
    : null;

  if (window.location.protocol === "file:") {
    const persistedRoute = readPersistedState<string | null>(LAST_VISITED_ROUTE_KEY, null);
    if (isRestorableRoute(persistedRoute)) {
      return persistedRoute;
    }
  }

  // In browser mode (not Storybook), read route directly from the current URL. Standalone
  // workspace launches remain special, while normal browser deep links and restore-style
  // navigations such as hard reload/back-forward should reopen the same chat.
  if (window.location.protocol !== "file:" && !isStorybook) {
    const url = routePathname + window.location.search;
    // Only use URL if it's a valid route (starts with /, not just "/" or empty)
    if (url.startsWith("/") && url !== "/") {
      if (!url.startsWith("/workspace/")) {
        return url;
      }

      if (
        shouldRestoreWorkspaceUrlOnStartup({
          isStandalone,
          launchBehavior,
          navigationType,
        })
      ) {
        return url;
      }
    }
  }

  // In Storybook, stories seed localStorage via selectWorkspace() during setup.
  // Read that selection so stories start at the correct workspace view.
  if (isStorybook) {
    const savedWorkspace = readPersistedState<WorkspaceSelection | null>(
      SELECTED_WORKSPACE_KEY,
      null
    );
    if (savedWorkspace?.workspaceId) {
      return `/workspace/${encodeURIComponent(savedWorkspace.workspaceId)}`;
    }
  }

  if (!isStandalone && launchBehavior === "last-workspace") {
    const savedWorkspace = readPersistedState<WorkspaceSelection | null>(
      SELECTED_WORKSPACE_KEY,
      null
    );
    if (savedWorkspace?.workspaceId) {
      return `/workspace/${encodeURIComponent(savedWorkspace.workspaceId)}`;
    }
  }

  // "dashboard" (legacy storage value) and "new-chat" both enter through "/".
  // WorkspaceContext immediately resolves that compatibility root route to a real page.
  return "/";
}

const EMBEDDED_INITIAL_ROUTE = "/";

/** Sync router state to browser URL (dev server) and persist the desktop route. */
function useUrlSync(enabled: boolean): void {
  const location = useLocation();
  useEffect(() => {
    if (!enabled) return;
    const url = location.pathname + location.search + location.hash;

    // The dedicated Xum home page is gone. Keep "/" as a transient compatibility
    // entrypoint, but only persist real restorable routes so desktop relaunches reopen
    // the last meaningful page instead of getting stuck on root.
    if (isRestorableRoute(url)) {
      updatePersistedState(LAST_VISITED_ROUTE_KEY, url);
    }

    const currentRoutePathname = stripInitialAppProxyBasePathFromPathname(window.location.pathname);
    // Skip in Storybook (conflicts with story navigation)
    if (currentRoutePathname.endsWith("iframe.html")) return;
    // Skip in Electron (file:// reloads always boot through index.html; we restore via localStorage above)
    if (window.location.protocol === "file:") return;

    const browserUrl = prependInitialAppProxyBasePath(url);
    if (browserUrl !== window.location.pathname + window.location.search + window.location.hash) {
      window.history.replaceState(null, "", browserUrl);
    }
  }, [enabled, location.pathname, location.search, location.hash]);
}

interface ModalBackgroundLocation {
  pathname: string;
  search: string;
  state: unknown;
}

const SETTINGS_ROUTE_PATTERN = /^\/settings\/([^/]+)$/;
const ANALYTICS_ROUTE = "/analytics";
const ROOT_BACKGROUND: ModalBackgroundLocation = { pathname: "/", search: "", state: null };

// location.state is untyped and can come from older history entries, so malformed values are
// treated as "no background" (the modal then sits over the root shell). Settings may sit over
// analytics (closing settings returns to analytics), but a modal never sits over itself, and
// analytics never sits over settings.
function getModalBackground(
  state: unknown,
  key: "settingsBackground" | "analyticsBackground"
): ModalBackgroundLocation | null {
  if (!state || typeof state !== "object" || !(key in state)) return null;
  const background = (state as Record<string, unknown>)[key];
  if (!background || typeof background !== "object") return null;
  const { pathname, search, state: backgroundState } = background as Record<string, unknown>;
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return null;
  if (SETTINGS_ROUTE_PATTERN.test(pathname)) return null;
  if (key === "analyticsBackground" && pathname === ANALYTICS_ROUTE) return null;
  return {
    pathname,
    search: typeof search === "string" ? search : "",
    state: backgroundState ?? null,
  };
}

/**
 * Resolve which modals are open and the page rendered underneath them. Both settings and
 * analytics are route-backed modals that store the page they were opened over in navigation
 * state; settings opened from analytics stores the analytics route (with its own background).
 */
function resolveModalLocation(location: ModalBackgroundLocation): {
  page: ModalBackgroundLocation;
  /** The analytics route location (with its background state) when analytics is open. */
  analytics: ModalBackgroundLocation | null;
} {
  let current = location;
  if (SETTINGS_ROUTE_PATTERN.test(current.pathname)) {
    current = getModalBackground(current.state, "settingsBackground") ?? ROOT_BACKGROUND;
  }
  if (current.pathname !== ANALYTICS_ROUTE) {
    return { page: current, analytics: null };
  }
  return {
    page: getModalBackground(current.state, "analyticsBackground") ?? ROOT_BACKGROUND,
    analytics: current,
  };
}

function RouterContextInner(props: { children: ReactNode; embedded: boolean }) {
  function getProjectPathFromLocationState(state: unknown): string | null {
    if (!state || typeof state !== "object") return null;
    if (!("projectPath" in state)) return null;
    const projectPath = (state as { projectPath?: unknown }).projectPath;
    return typeof projectPath === "string" ? projectPath : null;
  }

  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  const location = useLocation();
  const locationState: unknown = location.state;
  useUrlSync(!props.embedded);

  const settingsMatch = SETTINGS_ROUTE_PATTERN.exec(location.pathname);
  const currentSettingsSection = settingsMatch ? decodePathSegment(settingsMatch[1]) : null;

  // Settings and analytics render as modals over the page they were opened from, so page-level
  // route state (workspace, project, draft) comes from that background location. Cold modal links
  // have no background and sit over the root shell.
  const currentLocation: ModalBackgroundLocation = {
    pathname: location.pathname,
    search: location.search,
    state: locationState,
  };
  const { page: effectiveLocation, analytics: analyticsLocation } =
    resolveModalLocation(currentLocation);
  const effectiveSearchParams = new URLSearchParams(effectiveLocation.search);
  const isProjectRoute = effectiveLocation.pathname === "/project";

  const workspaceMatch = /^\/workspace\/(.+)$/.exec(effectiveLocation.pathname);
  const currentWorkspaceId = workspaceMatch ? decodePathSegment(workspaceMatch[1]) : null;
  const currentProjectId = isProjectRoute
    ? (effectiveSearchParams.get("project") ?? effectiveSearchParams.get("path"))
    : null;
  const currentProjectPathFromState = isProjectRoute
    ? getProjectPathFromLocationState(effectiveLocation.state)
    : null;
  // Also true while settings sits over analytics, so closing settings returns to analytics.
  const isAnalyticsOpen = analyticsLocation != null;
  const pendingDraftId = isProjectRoute ? effectiveSearchParams.get("draft") : null;

  // Back-compat: if we ever land on a legacy deep link (/project?path=<full path>),
  // immediately replace it with the non-path project id URL.
  useEffect(() => {
    if (location.pathname !== "/project") return;

    const params = new URLSearchParams(location.search);
    const legacyPath = params.get("path");
    const projectParam = params.get("project");
    if (!projectParam && legacyPath) {
      const draft = params.get("draft");
      const projectId = getProjectRouteId(legacyPath);
      const nextParams = new URLSearchParams();
      nextParams.set("project", projectId);
      if (draft) {
        nextParams.set("draft", draft);
      }
      const url = `/project?${nextParams.toString()}`;
      void navigateRef.current(url, { replace: true, state: { projectPath: legacyPath } });
    }
  }, [location.pathname, location.search]);
  // Navigation defaults to push so back/forward keeps working as expected.
  // Callers can opt into replace for compatibility-root redirects that should not
  // add a disposable "/" history entry.
  const navigateToWorkspace = useCallback((id: string) => {
    void navigateRef.current(`/workspace/${encodeURIComponent(id)}`);
  }, []);

  const navigateToProject = useCallback(
    (path: string, draftId?: string, options?: { replace?: boolean }) => {
      const projectId = getProjectRouteId(path);
      const params = new URLSearchParams();
      params.set("project", projectId);
      if (draftId) {
        params.set("draft", draftId);
      }
      const url = `/project?${params.toString()}`;
      void navigateRef.current(url, {
        replace: options?.replace === true,
        state: { projectPath: path },
      });
    },
    []
  );

  const navigateToHome = useCallback(() => {
    void navigateRef.current("/");
  }, []);

  // Key of the rendered location that already navigated to analytics; see navigateToAnalytics.
  // Cleared on every location change so returning to that same history entry (back) can open
  // analytics again.
  const analyticsOpenedFromKeyRef = useRef<string | null>(null);
  useEffect(() => {
    analyticsOpenedFromKeyRef.current = null;
  }, [location.key]);

  // These close over the rendered location (not a ref updated in an effect): settings redirect
  // effects run in children before this provider's effects, so a ref could still be stale.
  const navigateToSettings = useCallback(
    (section?: string, options?: { replace?: boolean }) => {
      const nextSection = section ?? "general";
      // Section switches and redirects inside settings keep the original background.
      const state = SETTINGS_ROUTE_PATTERN.test(location.pathname)
        ? locationState
        : {
            settingsBackground: {
              pathname: location.pathname,
              search: location.search,
              state: locationState,
            } satisfies ModalBackgroundLocation,
          };
      void navigateRef.current(`/settings/${encodeURIComponent(nextSection)}`, {
        replace: options?.replace === true,
        state,
      });
    },
    [location.pathname, location.search, locationState]
  );

  const navigateFromSettings = useCallback(() => {
    if (!SETTINGS_ROUTE_PATTERN.test(location.pathname)) return;
    const background = getModalBackground(locationState, "settingsBackground");
    if (!background) {
      void navigateRef.current("/");
      return;
    }
    void navigateRef.current(background.pathname + background.search, {
      state: background.state,
    });
  }, [location.pathname, locationState]);

  const navigateToAnalytics = useCallback(() => {
    if (location.pathname === ANALYTICS_ROUTE) return;
    // Opens dispatched before the next render (e.g. keydowns fired in one task) all see the old
    // location, so without this each would push its own /analytics history entry.
    if (analyticsOpenedFromKeyRef.current === location.key) return;
    analyticsOpenedFromKeyRef.current = location.key;
    const resolved = resolveModalLocation({
      pathname: location.pathname,
      search: location.search,
      state: locationState,
    });
    // Settings over analytics: returning to the analytics entry closes settings.
    if (resolved.analytics) {
      void navigateRef.current(resolved.analytics.pathname + resolved.analytics.search, {
        state: resolved.analytics.state,
      });
      return;
    }
    // Opening from settings uses the page under settings, so modals never nest as backgrounds.
    void navigateRef.current(ANALYTICS_ROUTE, {
      state: { analyticsBackground: resolved.page satisfies ModalBackgroundLocation },
    });
  }, [location.key, location.pathname, location.search, locationState]);

  const navigateFromAnalytics = useCallback(() => {
    const resolved = resolveModalLocation({
      pathname: location.pathname,
      search: location.search,
      state: locationState,
    });
    if (!resolved.analytics) return;
    // Closes analytics (and settings over it) and returns to the page underneath, including its
    // in-memory state (/project relies on { projectPath }).
    void navigateRef.current(resolved.page.pathname + resolved.page.search, {
      state: resolved.page.state,
    });
  }, [location.pathname, location.search, locationState]);

  const value = useMemo<RouterContext>(
    () => ({
      navigateToWorkspace,
      navigateToProject,
      navigateToHome,
      navigateToSettings,
      navigateFromSettings,
      navigateToAnalytics,
      navigateFromAnalytics,
      currentWorkspaceId,
      currentSettingsSection,
      currentProjectId,
      currentProjectPathFromState,
      pendingDraftId,
      isAnalyticsOpen,
    }),
    [
      navigateToHome,
      navigateToProject,
      navigateToSettings,
      navigateFromSettings,
      navigateToAnalytics,
      navigateFromAnalytics,
      navigateToWorkspace,
      currentWorkspaceId,
      currentSettingsSection,
      currentProjectId,
      currentProjectPathFromState,
      pendingDraftId,
      isAnalyticsOpen,
    ]
  );

  return <RouterContext.Provider value={value}>{props.children}</RouterContext.Provider>;
}

// Disable startTransition wrapping for navigation state updates so they
// batch with other normal-priority React state updates in the same tick.
// Without this, React processes navigation at transition (lower) priority,
// causing a flash of stale UI between normal-priority updates (e.g.
// setIsSending(false)) and the deferred route change.
//
// `embedded` is for hosts whose document URL is not an app route (the VS Code webview): start at
// "/" and keep navigation in memory only — never rewrite the host URL or persist a route for the
// desktop app's relaunch restore.
export function RouterProvider(props: { children: ReactNode; embedded?: boolean }) {
  const embedded = props.embedded === true;
  return (
    <MemoryRouter
      initialEntries={[embedded ? EMBEDDED_INITIAL_ROUTE : getInitialRoute()]}
      unstable_useTransitions={false}
    >
      <RouterContextInner embedded={embedded}>{props.children}</RouterContextInner>
    </MemoryRouter>
  );
}
