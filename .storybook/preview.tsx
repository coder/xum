import type { Preview } from "@storybook/react-vite";
import { isPixel } from "@coder/pixel-storybook/storyapi";
import { ThemeProvider, type ThemeMode } from "../src/browser/contexts/ThemeContext";
import "../src/browser/styles/globals.css";
import {
  TUTORIAL_STATE_KEY,
  RIGHT_SIDEBAR_COLLAPSED_KEY,
  LEFT_SIDEBAR_COLLAPSED_KEY,
  EXPANDED_PROJECTS_KEY,
  WORKSPACE_DRAFTS_BY_PROJECT_KEY,
  type TutorialState,
} from "../src/common/constants/storage";
import { NOW } from "../src/browser/stories/storyTime";
import { updatePersistedState } from "../src/browser/hooks/usePersistedState";
import { configure } from "storybook/test";

// Signal Storybook runtime to modules that need to stabilize for visual snapshots
// (e.g. the ChatInput placeholder tip carousel pins to its lead tip so
// tip-list reorders don't cascade into baseline diffs across every story).
// Set as early as possible so it precedes any story-module import that might
// evaluate carousel logic during render.
(globalThis as { __MUX_STORYBOOK__?: boolean }).__MUX_STORYBOOK__ = true;

// Raise the default async-util timeout from 1 000 ms → 5 000 ms.
// waitFor / findBy* calls inherit this, so individual stories don't need
// explicit `{ timeout }` unless they intentionally want a longer budget.
// Prevents flakes on CPU-constrained CI runners where React re-renders
// after userEvent.click can exceed the 1 s default.
configure({ asyncUtilTimeout: 5000 });

const PIXEL_STABILITY_CSS = `
  *, *::before, *::after {
    animation: none !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
    transition: none !important;
  }
  /*
   * Sticky elements (the chat composer dock, tool headers, sidebars) often rest at a
   * fractional offset inside a composited scroller. Chromium rasterizes them either
   * in their own layer or with the scroller depending on timing, which snaps their
   * text/borders a device pixel apart between otherwise identical captures (seen as
   * a composer "jitter" diff on App/MCP Identity/Chat/Plugin Server Details).
   * Forcing a dedicated layer makes the snapping path deterministic.
   */
  .sticky {
    will-change: transform;
  }
`;

const STORYBOOK_FONTS_READY_TIMEOUT_MS = 2500;

let fontsReadyPromise: Promise<void> | null = null;

function ensureStorybookFontsReady(): Promise<void> {
  fontsReadyPromise ??= (async () => {
    if (typeof document === "undefined") {
      return;
    }

    const fonts = document.fonts;

    // Trigger load of layout-affecting fonts so snapshots aren't captured mid font-swap.
    await Promise.allSettled([
      fonts.load("400 14px 'Geist'"),
      fonts.load("600 14px 'Geist'"),
      fonts.load("400 14px 'Geist Mono'"),
      fonts.load("600 14px 'Geist Mono'"),
      fonts.load("400 14px 'Seti'"),
    ]);

    await fonts.ready;
  })().catch(() => {});

  return fontsReadyPromise;
}
// Freeze the wall clock globally for deterministic snapshots. Components using
// Date.now() for elapsed-time math need a stable reference, and so does every
// zero-arg `new Date()`: mocking only Date.now left `new Date()` on the real
// clock, so fixtures stamped with it (e.g. createWorkspace's default createdAt)
// sorted by whichever millisecond each call landed in. That reordered the
// sidebar in App/ChatLoading/Replay between otherwise identical captures.
const RealDate = Date;
globalThis.Date = new Proxy(RealDate, {
  construct: (target, args: unknown[], newTarget: new (...args: unknown[]) => unknown) =>
    Reflect.construct(target, args.length === 0 ? [NOW] : args, newTarget) as object,
  // `Date()` called as a function returns the current time as a string.
  apply: () => new RealDate(NOW).toString(),
  get: (target, property, receiver) =>
    property === "now" ? () => NOW : Reflect.get(target, property, receiver),
});

// Disable tutorials by default in Storybook to prevent them from interfering with stories
// Individual stories can override this by setting localStorage before rendering
function disableTutorials() {
  if (typeof localStorage !== "undefined") {
    const disabledState: TutorialState = {
      disabled: true,
      completed: { creation: true, workspace: true },
    };
    localStorage.setItem(TUTORIAL_STATE_KEY, JSON.stringify(disabledState));
  }
}

// Collapse right sidebar by default to ensure deterministic snapshots
// Stories that need expanded sidebar call expandRightSidebar() in their setup
function collapseRightSidebar() {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(RIGHT_SIDEBAR_COLLAPSED_KEY, JSON.stringify(true));
  }
}
// Reset the left sidebar to the app's viewport default before each story render.
// This prevents stories from inheriting whichever open/closed state a previous
// story left behind, while still allowing individual stories to override it.
function resetLeftSidebar() {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(LEFT_SIDEBAR_COLLAPSED_KEY, JSON.stringify(window.innerWidth <= 768));
  }
}
// Collapse projects by default to ensure deterministic snapshots.
// Some stories explicitly expand projects via expandProjects() in their setup.
function collapseProjects() {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify([]));
  }
}

// Clear workspace drafts to ensure deterministic snapshots.
// Drafts persist in localStorage and can leak between stories causing flaky diffs.
// Uses updatePersistedState to notify subscribers (WorkspaceContext uses listener: true).
function clearWorkspaceDrafts() {
  updatePersistedState(WORKSPACE_DRAFTS_BY_PROJECT_KEY, {});
}

const preview: Preview = {
  globalTypes: {
    theme: {
      name: "Theme",
      description: "Choose between light and dark UI themes",
      toolbar: {
        icon: "mirror",
        items: [
          { value: "dark", title: "Dark" },
          { value: "light", title: "Light" },
        ],
        dynamicTitle: true,
      },
    },
  },
  loaders: [
    async () => {
      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, STORYBOOK_FONTS_READY_TIMEOUT_MS);
      });

      await Promise.race([ensureStorybookFontsReady(), timeout]);
      return {};
    },
  ],
  initialGlobals: {
    theme: "dark",
  },
  decorators: [
    // Theme provider
    (Story, context) => {
      const mode = (context.globals.theme as ThemeMode | undefined) ?? "dark";

      // Apply theme synchronously before React renders - critical for visual snapshots
      if (typeof document !== "undefined") {
        document.documentElement.dataset.theme = mode;
        document.documentElement.style.colorScheme = mode;
      }

      // Disable tutorials by default unless explicitly enabled for this story
      if (!context.parameters?.tutorialEnabled) {
        disableTutorials();
      }

      // Reset the left sidebar to the app's viewport-dependent default.
      // Stories that need a specific open/closed state can override it in setup.
      resetLeftSidebar();

      // Collapse right sidebar by default for deterministic snapshots
      // Stories can expand via expandRightSidebar() in setup after this runs
      collapseRightSidebar();

      // Collapse projects by default so one story doesn't leak expanded state into the next.
      // Stories that want expanded projects should call expandProjects() in setup.
      collapseProjects();

      // Clear workspace drafts so they don't leak between stories.
      clearWorkspaceDrafts();

      return (
        <>
          {/* Pixel captures semantic states, never arbitrary animation frames or blinking carets. */}
          {isPixel() && <style data-pixel-stability>{PIXEL_STABILITY_CSS}</style>}
          <ThemeProvider forcedTheme={mode}>
            <Story />
          </ThemeProvider>
        </>
      );
    },
  ],
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    initialGlobals: {
      theme: "dark",
      viewport: { value: "desktop", isRotated: false },
    },
    viewport: {
      options: {
        mobile1: {
          name: "iPhone SE",
          styles: { width: "375px", height: "667px" },
          type: "mobile",
        },
        mobile2: {
          name: "iPhone XR",
          styles: { width: "414px", height: "896px" },
          type: "mobile",
        },
        tablet: {
          name: "iPad",
          styles: { width: "768px", height: "1024px" },
          type: "mobile",
        },
        desktop: {
          name: "Desktop",
          styles: { width: "1280px", height: "800px" },
          type: "mobile",
        },
        wide: {
          // Wide enough to trigger the @container query that reveals the
          // sticky plan TOC next to a centered max-w-4xl transcript.
          name: "Desktop wide",
          styles: { width: "1600px", height: "900px" },
          type: "desktop",
        },
      },
    },
  },
};

export default preview;
