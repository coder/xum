/**
 * Light theme: muted (`--color-muted`) and secondary (`--color-secondary`) text meets WCAG AA
 * (4.5:1) on the main screens: home, a workspace with both sidebars open, and Settings. The
 * stories check every visible text in those colors, so a later change to either token, or to a
 * background behind them, fails here (#5950, #5951).
 *
 * The code stories (#5980) check, in light and flexoki-light, every syntax-highlighted token in
 * a code block and in the review diff (with its green and red line tints), inline code in both
 * message kinds, the selected right-sidebar tab (#5965) and the selected Stats pill.
 *
 * The review diff's gutter (+ and − signs, line numbers) is checked in all four themes, on the
 * line tints and under the review-range highlight (#5985).
 *
 * The dark code stories check every syntax-highlighted token, and every min-dark replacement
 * color, in dark and flexoki-dark on the code block, the diff tints and the review-range
 * highlight (#5983).
 */

import { expect, waitFor, within } from "@storybook/test";

import type { ThemeMode } from "@/browser/contexts/ThemeContext";
import { getRightSidebarLayoutKey, RIGHT_SIDEBAR_TAB_KEY } from "@/common/constants/storage";
import { SECTION_COLOR_PALETTE } from "@/common/constants/ui";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  colorContrastOn,
  flatGradientColor,
  opaqueBackgroundOwner,
  textContrastOnBase,
  textContrasts,
  tokenTextContrasts,
  type TextContrast,
} from "@/browser/stories/helpers/contrast";
import {
  SHIKI_COLOR_REPLACEMENTS,
  SHIKI_DARK_THEME,
  SHIKI_LIGHT_THEME,
} from "@/browser/utils/highlighting/shiki-shared";
import { setupSettingsStory } from "@/browser/features/Settings/Sections/settingsStoryUtils";

import { setupSimpleChatStory } from "./helpers/chatSetup";
import { setWorkspaceDrafts } from "./helpers/drafts";
import { createReview } from "./helpers/reviews";
import { expandLeftSidebar, expandRightSidebar, selectWorkspace } from "./helpers/uiState";
import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta.js";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { createMockORPCClient } from "./mocks/orpc";
import { seedMockReviewState } from "./mocks/reviewState";
import { createWorkspace, groupWorkspacesByProject, STABLE_TIMESTAMP } from "./mocks/workspaces";
import { openSettingsDialog } from "./storyPlayHelpers";

export default {
  ...appMeta,
  title: "App/LightThemeTokenContrast",
};

const TOKENS = ["--color-muted", "--color-secondary"];

/** The token texts under `root`. Project badges have their own stories (#5978). */
const checkedTokenTexts = (root: HTMLElement) => tokenTextContrasts(root, TOKENS);

/**
 * Every muted and secondary text under `root` reaches 4.5:1, and at least `minimum` texts of
 * each listed token were found, so an empty screen cannot pass.
 */
async function expectTokenTextsReadable(root: HTMLElement, minimum: Record<string, number>) {
  await waitFor(
    () => {
      const found = checkedTokenTexts(root);
      for (const [token, count] of Object.entries(minimum)) {
        const ofToken = found.filter((entry) => entry.token === token);
        if (ofToken.length < count) {
          throw new Error(`expected ${count}+ texts in ${token}, found ${ofToken.length}`);
        }
      }
    },
    { timeout: 15_000 }
  );
  await expectReadable(checkedTokenTexts(root).map((entry) => ({ ...entry, label: entry.token })));
}

/** Every entry reaches 4.5:1. A joined string, so a failure names every text, not a count. */
async function expectReadable(entries: Array<TextContrast & { label: string }>) {
  const failing = entries
    .filter((entry) => entry.ratio < 4.5)
    .map((entry) => `${entry.label} ${entry.ratio.toFixed(2)}:1 "${entry.text}"`);
  await expect(failing.join("\n")).toBe("");
}

/** The texts of `count`+ elements matched by `find`, waiting until enough have rendered. */
async function findTexts(
  what: string,
  count: number,
  find: () => HTMLElement[]
): Promise<Array<TextContrast & { label: string }>> {
  return waitFor(
    () => {
      const texts = find().flatMap((element) =>
        textContrasts(element).map((entry) => ({ ...entry, label: what }))
      );
      if (texts.length < count)
        throw new Error(`expected ${count}+ ${what} texts, found ${texts.length}`);
      return texts;
    },
    { timeout: 15_000 }
  );
}

// Behavioral contract only, so Pixel snapshots are off: Pixel's own stories show the colors.
const lightContract = { ...appMeta.parameters, pixel: PIXEL_DISABLED };

export const Home: AppStory = {
  globals: { theme: "light" },
  parameters: lightContract,
  render: () => <AppWithMocks setup={() => createMockORPCClient()} />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("No projects", {}, { timeout: 15_000 });
    await expectTokenTextsReadable(canvasElement, { "--color-muted": 1 });
  },
};

const REVIEW_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 export function start() {
+  console.log("ready");
   return true;
 }
`;

/** A workspace with both sidebars open. Flat mode shows the sidebar header's "New chat" button. */
function setupWorkspaceWithSidebars(options: { flatSidebar: boolean }) {
  const client = setupSimpleChatStory({
    workspaceId: "ws-light-tokens",
    workspaceName: "feature/light-tokens",
    projectName: "my-app",
    messages: [
      createUserMessage("u1", "Add a ready log to start().", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP - 60_000,
      }),
      createAssistantMessage("a1", "Added the log line in src/app.ts.", {
        historySequence: 2,
        timestamp: STABLE_TIMESTAMP,
      }),
    ],
    gitDiff: { diffOutput: REVIEW_DIFF, numstatOutput: "1\t0\tsrc/app.ts" },
    userPreferences: options.flatSidebar ? { ui: { sidebarFlatMode: true } } : undefined,
  });
  // setupSimpleChatStory collapses the right sidebar; open both for this screen.
  expandLeftSidebar();
  expandRightSidebar();
  updatePersistedState(RIGHT_SIDEBAR_TAB_KEY, "review");
  return client;
}

async function waitForWorkspace(canvasElement: HTMLElement) {
  await within(canvasElement).findByText(
    "Added the log line in src/app.ts.",
    {},
    { timeout: 15_000 }
  );
}

export const WorkspaceWithSidebars: AppStory = {
  globals: { theme: "light" },
  parameters: lightContract,
  render: () => <AppWithMocks setup={() => setupWorkspaceWithSidebars({ flatSidebar: false })} />,
  play: async ({ canvasElement }) => {
    await waitForWorkspace(canvasElement);
    await expectTokenTextsReadable(canvasElement, { "--color-muted": 3 });
  },
};

// The flat sidebar's header has the one `--color-secondary` text on these screens ("New chat").
export const WorkspaceWithFlatSidebar: AppStory = {
  globals: { theme: "light" },
  parameters: lightContract,
  render: () => <AppWithMocks setup={() => setupWorkspaceWithSidebars({ flatSidebar: true })} />,
  play: async ({ canvasElement }) => {
    await waitForWorkspace(canvasElement);
    await within(canvasElement).findByText("New chat", {}, { timeout: 15_000 });
    await expectTokenTextsReadable(canvasElement, { "--color-muted": 3, "--color-secondary": 1 });
  },
};

// ─── Flat-sidebar project badges (#5978) ─────────────────────────────────────────────────────

/** Every palette color, plus the two custom hex extremes a user can type. */
const BADGE_COLORS = [...SECTION_COLOR_PALETTE.map(([name]) => name), "#000000", "#ffffff"];

const badgeProjectName = (color: string) => `badge-${color.replace("#", "hex-").toLowerCase()}`;

/**
 * A flat sidebar with one chat and one draft per badge color. The first chat is selected, so
 * one row shows the selected background and the rest the unselected one.
 */
function setupProjectBadges() {
  const workspaces = BADGE_COLORS.map((color) =>
    createWorkspace({
      id: `ws-${badgeProjectName(color)}`,
      name: `chat-${badgeProjectName(color)}`,
      projectName: badgeProjectName(color),
    })
  );
  const projects = groupWorkspacesByProject(workspaces);
  for (const [index, color] of BADGE_COLORS.entries()) {
    const path = workspaces[index].projectPath;
    const config = projects.get(path);
    if (!config) throw new Error(`no project config for ${path}`);
    projects.set(path, { ...config, color });
    setWorkspaceDrafts(path, [{ draftId: `draft-${index}`, workspaceName: `draft-${index}` }]);
  }
  selectWorkspace(workspaces[0]);
  expandLeftSidebar();
  return createMockORPCClient({
    projects,
    workspaces,
    userPreferences: { ui: { sidebarFlatMode: true } },
  });
}

/**
 * Every chat and draft badge reaches 4.5:1 on an unselected row and on the selected row. Hovered
 * rows use the selected row's background (`hover:bg-surface-secondary`), and `:hover` cannot be
 * triggered from a play, so the selected color stands in for both.
 */
async function expectProjectBadgesReadable(canvasElement: HTMLElement) {
  const badges = await waitFor(
    () => {
      const found = [
        ...canvasElement.querySelectorAll<HTMLElement>('[data-testid^="workspace-project-badge-"]'),
      ];
      const drafts = found.filter((badge) => badge.dataset.testid?.includes("-draft-"));
      if (
        found.length - drafts.length < BADGE_COLORS.length ||
        drafts.length < BADGE_COLORS.length
      ) {
        throw new Error(
          `expected ${BADGE_COLORS.length} chat and draft badges, found ${found.length}`
        );
      }
      return found;
    },
    { timeout: 15_000 }
  );
  const rowBackground = (badge: HTMLElement) => {
    const row = opaqueBackgroundOwner(badge);
    if (!row) throw new Error(`no opaque row behind "${badge.textContent}"`);
    return getComputedStyle(row).backgroundColor;
  };
  const selected = badges.find((badge) =>
    badge.dataset.testid?.endsWith(`ws-${badgeProjectName(BADGE_COLORS[0])}`)
  );
  if (!selected) throw new Error("no badge on the selected chat");
  const selectedBackground = rowBackground(selected);
  const unselectedBackground = rowBackground(badges[badges.length - 1]);
  // Both row states must be on screen, or one of them would pass by absence.
  await expect(selectedBackground).not.toBe(unselectedBackground);

  await expectReadable(
    badges.flatMap((badge) =>
      [
        ["unselected", unselectedBackground],
        ["selected or hovered", selectedBackground],
      ].map(([state, base]) => ({
        element: badge,
        text: badge.textContent ?? "",
        ratio: textContrastOnBase(badge, base),
        label: `${badge.dataset.testid?.includes("-draft-") ? "draft" : "chat"} badge, ${state} row`,
      }))
    )
  );
}

const projectBadgeStory = (theme: ThemeMode): AppStory => ({
  globals: { theme },
  parameters: lightContract,
  render: () => <AppWithMocks setup={setupProjectBadges} />,
  play: async ({ canvasElement }) => {
    await expectProjectBadgesReadable(canvasElement);
  },
});

export const ProjectBadgesLight = projectBadgeStory("light");
export const ProjectBadgesFlexokiLight = projectBadgeStory("flexoki-light");
export const ProjectBadgesDark = projectBadgeStory("dark");
export const ProjectBadgesFlexokiDark = projectBadgeStory("flexoki-dark");

export const Settings: AppStory = {
  globals: { theme: "light" },
  parameters: lightContract,
  render: () => <AppWithMocks setup={() => setupSettingsStory({})} />,
  play: async ({ canvasElement }) => {
    const dialog = await openSettingsDialog(canvasElement);
    await expectTokenTextsReadable(dialog, { "--color-muted": 3 });
  },
};

// ─── Code colors (#5980) and the selected-tab count (#5965) ─────────────────────────────────

const CODE_ANSWER = [
  "Renamed `startServer` and added a retry:",
  "",
  "```ts",
  "// Retry the listen call before giving up.",
  "export function startServer(port: number, retries = 3): boolean {",
  '  const label = "server";',
  "  if (retries > 0) return true;",
  "  return false;",
  "}",
  "```",
].join("\n");

const CODE_DIFF = `diff --git a/src/server.ts b/src/server.ts
index 1111111..2222222 100644
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,4 +1,4 @@
-// Start once, no retry.
-export function start(port: number, retries = 0) {
+// Retry the listen call before giving up.
+export function startServer(port: number, retries = 3) {
   return true;
 }
`;

/**
 * A review on removed line 2, the first context line (old 3) and added line 1, so the diff shows
 * an added, a removed and a context line both with and without the review-range highlight.
 */
const GUTTER_REVIEW = createReview(
  "review-gutter",
  "src/server.ts",
  "-2-3 +1",
  "Check the retry count.",
  "pending",
  STABLE_TIMESTAMP
);

/** A workspace whose chat and review diff show highlighted code and inline code. */
function setupCodeWorkspace(tab: "review" | "costs", withGutterReview = false) {
  if (withGutterReview) {
    seedMockReviewState("ws-light-code", { reviews: { [GUTTER_REVIEW.id]: GUTTER_REVIEW } });
  }
  const client = setupSimpleChatStory({
    workspaceId: "ws-light-code",
    workspaceName: "feature/light-code",
    projectName: "my-app",
    messages: [
      createUserMessage("u1", "Rename `start` and add a retry.", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP - 60_000,
      }),
      createAssistantMessage("a1", CODE_ANSWER, {
        historySequence: 2,
        timestamp: STABLE_TIMESTAMP,
      }),
    ],
    gitDiff: { diffOutput: CODE_DIFF, numstatOutput: "2\t2\tsrc/server.ts" },
    sessionUsage: {
      byModel: {
        "anthropic:claude-sonnet-4-20250514": {
          input: { tokens: 12_000, cost_usd: 0.04 },
          cached: { tokens: 0, cost_usd: 0 },
          cacheCreate: { tokens: 0, cost_usd: 0 },
          output: { tokens: 3_000, cost_usd: 0.05 },
          reasoning: { tokens: 0, cost_usd: 0 },
          model: "anthropic:claude-sonnet-4-20250514",
        },
      },
      version: 1,
    },
  });
  expandLeftSidebar();
  expandRightSidebar();
  updatePersistedState(RIGHT_SIDEBAR_TAB_KEY, tab);
  // The per-workspace layout remembers the last tab across stories; drop it so `tab` applies.
  updatePersistedState(getRightSidebarLayoutKey("ws-light-code"), null);
  return client;
}

/**
 * Shiki writes each token's color as the inline style `color:#rrggbb`, which is how its spans are
 * found. Other inline-colored UI (diff gutters, file icons) uses CSS variables, so it is not
 * matched; it is not a syntax color.
 */
const shikiTokens = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("span[style]")].filter(
    (span) =>
      /^color:#[0-9a-f]{6}/i.test(span.getAttribute("style") ?? "") && span.textContent?.trim()
  );

const selectedTab = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>('[role="tab"][aria-selected="true"]'),
];

/**
 * Every highlighted token, inline code and the selected tab reach 4.5:1. Also checks every
 * min-light replacement color on each background a token really sits on, so a color that this
 * screen does not happen to render (for example the warning token) is still proven, including
 * on the review diff's green and red line tints.
 */
async function expectCodeReadable(canvasElement: HTMLElement, theme: ThemeMode) {
  await within(canvasElement).findByText("Renamed", { exact: false }, { timeout: 15_000 });
  const tokens = await findTexts("highlighted token", 8, () => shikiTokens(canvasElement));
  // The diff's added and removed lines carry a green and a red tint over the code background.
  await waitFor(() => {
    for (const tint of ["--color-success", "--color-danger"]) {
      if (!tokens.some((token) => token.element.closest(`[style*="${tint}"]`))) {
        throw new Error(`no highlighted token on a ${tint} diff line yet`);
      }
    }
  });
  const inlineCode = await findTexts("inline code", 2, () =>
    [...canvasElement.querySelectorAll<HTMLElement>(".markdown-content code")].filter(
      (code) => !code.closest("pre")
    )
  );
  const tab = await findTexts("selected tab", 2, () => selectedTab(canvasElement));
  // The branch name shows in the chat header and in the footer's branch selector (text-muted).
  // Light only: flexoki-light's muted token is 4.47:1 on the footer, a token decision (#5984).
  const branch =
    theme === "light"
      ? await findTexts("branch name", 2, () =>
          within(canvasElement).queryAllByText("feature/light-code")
        )
      : [];
  await expectReadable([...tokens, ...inlineCode, ...tab, ...branch]);

  const replacements = Object.values(SHIKI_COLOR_REPLACEMENTS[SHIKI_LIGHT_THEME]);
  const onRealBackgrounds = tokens.flatMap((token) =>
    replacements.map((color) => ({
      element: token.element,
      text: `${color} behind "${token.text}"`,
      ratio: colorContrastOn(color, token.element),
      label: "min-light replacement",
    }))
  );
  await expectReadable(onRealBackgrounds);
}

type GutterKind = "add" | "remove" | "context";

const GUTTER_KIND: Record<string, GutterKind> = { "+": "add", "−": "remove", "": "context" };

/**
 * The review diff's gutter text reaches 4.5:1: the + and − signs and every line number, each on
 * its own line tint (#5985). Each kind of line must be seen both plain and under the
 * review-range highlight (a flat gradient over the tint), so neither case passes by absence.
 */
async function expectDiffGutterReadable(canvasElement: HTMLElement) {
  const entries = await waitFor(
    () => {
      const found: Array<TextContrast & { label: string }> = [];
      const seen = new Set<string>();
      for (const indicator of canvasElement.querySelectorAll<HTMLElement>(
        "[data-diff-indicator]"
      )) {
        const gutter = indicator.previousElementSibling;
        if (!(gutter instanceof HTMLElement)) continue;
        const kind = GUTTER_KIND[indicator.textContent?.trim() ?? ""];
        if (!kind) continue;
        const image = getComputedStyle(indicator).backgroundImage;
        // A highlight the contrast helper cannot read would be measured as if it were absent.
        if (image !== "none" && !flatGradientColor(image))
          throw new Error(`unread highlight ${image}`);
        const where = image === "none" ? "plain" : "highlighted";
        const texts = [...textContrasts(indicator), ...textContrasts(gutter)];
        // Context lines have no sign: their texts are the line numbers alone.
        if (texts.length === 0) continue;
        seen.add(`${kind} ${where}`);
        found.push(...texts.map((entry) => ({ ...entry, label: `${kind} ${where} gutter` })));
      }
      for (const kind of ["add", "remove", "context"]) {
        for (const where of ["plain", "highlighted"]) {
          if (!seen.has(`${kind} ${where}`)) throw new Error(`no ${kind} ${where} diff line yet`);
        }
      }
      return found;
    },
    { timeout: 15_000 }
  );
  await expectReadable(entries);
}

const codeStory = (theme: ThemeMode): AppStory => ({
  globals: { theme },
  parameters: lightContract,
  render: () => <AppWithMocks setup={() => setupCodeWorkspace("review")} />,
  play: async ({ canvasElement }) => {
    await expectCodeReadable(canvasElement, theme);
  },
});

export const CodeLight = codeStory("light");
export const CodeFlexokiLight = codeStory("flexoki-light");

/** The gutter only, in every theme: the dark themes' syntax colors are #5983. */
const diffGutterStory = (theme: ThemeMode): AppStory => ({
  globals: { theme },
  parameters: lightContract,
  render: () => <AppWithMocks setup={() => setupCodeWorkspace("review", true)} />,
  play: async ({ canvasElement }) => {
    await expectDiffGutterReadable(canvasElement);
  },
});

/**
 * Dark themes (#5983): every highlighted token in the code block and the review diff reaches
 * 4.5:1, including tokens on a line under the review-range highlight. Every min-dark replacement
 * color is also checked on each background a token really sits on, so a color this screen does
 * not render (for example the debug token) is still proven.
 */
async function expectDarkCodeReadable(canvasElement: HTMLElement) {
  await within(canvasElement).findByText("Renamed", { exact: false }, { timeout: 15_000 });
  const tokens = await findTexts("highlighted token", 8, () => shikiTokens(canvasElement));
  await waitFor(() => {
    const highlighted = tokens.some((token) => {
      const cell = token.element.closest<HTMLElement>("[data-diff-indicator] ~ span");
      return cell != null && getComputedStyle(cell).backgroundImage !== "none";
    });
    if (!highlighted) throw new Error("no highlighted token on a review-highlighted line yet");
  });
  await expectReadable(tokens);

  const replacements = Object.values(SHIKI_COLOR_REPLACEMENTS[SHIKI_DARK_THEME]);
  await expectReadable(
    tokens.flatMap((token) =>
      replacements.map((color) => ({
        element: token.element,
        text: `${color} behind "${token.text}"`,
        ratio: colorContrastOn(color, token.element),
        label: "min-dark replacement",
      }))
    )
  );
}

const darkCodeStory = (theme: ThemeMode): AppStory => ({
  globals: { theme },
  parameters: lightContract,
  render: () => <AppWithMocks setup={() => setupCodeWorkspace("review", true)} />,
  play: async ({ canvasElement }) => {
    await expectDarkCodeReadable(canvasElement);
  },
});

export const CodeDark = darkCodeStory("dark");
export const CodeFlexokiDark = darkCodeStory("flexoki-dark");

export const DiffGutterLight = diffGutterStory("light");
export const DiffGutterFlexokiLight = diffGutterStory("flexoki-light");
export const DiffGutterDark = diffGutterStory("dark");
export const DiffGutterFlexokiDark = diffGutterStory("flexoki-dark");

const statsStory = (theme: ThemeMode): AppStory => ({
  globals: { theme },
  parameters: lightContract,
  render: () => <AppWithMocks setup={() => setupCodeWorkspace("costs")} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // ByText with a selector: ByRole computes every button's accessible name on each retry,
    // which is too slow on this screen.
    const pill = await canvas.findByText("Cost", { selector: "button" }, { timeout: 15_000 });
    const tab = await findTexts("selected tab", 2, () => selectedTab(canvasElement));
    await expectReadable([
      ...tab,
      ...textContrasts(pill).map((entry) => ({ ...entry, label: "selected Stats pill" })),
    ]);
  },
});

export const StatsLight = statsStory("light");
export const StatsFlexokiLight = statsStory("flexoki-light");
