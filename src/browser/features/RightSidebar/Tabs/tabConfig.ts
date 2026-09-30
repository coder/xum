import { EXPERIMENT_IDS } from "@/common/constants/experiments";

/**
 * Lightweight right-sidebar tab config.
 *
 * Keep this file free of React component imports: it is consumed by shared
 * helpers (types, layout migrations, command sources) that are also bundled by
 * the VS Code extension. Pulling the full panel registry into those helpers
 * eagerly imports Desktop/noVNC code and breaks esbuild's non-Vite build.
 */
export interface TabConfig {
  /** Display name shown in tab strip / pickers. */
  name: string;
  /** Content container CSS classes. */
  contentClassName: string;
  /** Whether the panel should remain mounted while hidden. */
  keepAlive?: boolean;
  /** Optional feature/experiment flag required to show this tab. */
  featureFlag?: string;
  /** Whether the tab should appear in default layouts for new/existing workspaces. */
  inDefaultLayout?: boolean;
  /** Sort order in the default layout & Add-Tool picker. */
  defaultOrder: number;
  /** Optional palette keywords to improve fuzzy search in the command palette. */
  paletteKeywords?: string[];
}

const TAB_CONFIG_DEF = {
  costs: {
    name: "Stats",
    contentClassName: "overflow-y-auto p-[15px]",
    inDefaultLayout: true,
    defaultOrder: 10,
    paletteKeywords: ["cost", "stats", "tokens", "timing"],
  },
  review: {
    name: "Review",
    contentClassName: "overflow-y-auto p-0",
    inDefaultLayout: true,
    defaultOrder: 20,
    paletteKeywords: ["review", "diff", "code review"],
  },
  instructions: {
    name: "Instructions",
    contentClassName: "overflow-hidden p-0",
    inDefaultLayout: true,
    defaultOrder: 30,
    paletteKeywords: ["agents", "agents.md", "claude.md", "instructions", "prompt", "context"],
  },
  goal: {
    name: "Goal",
    contentClassName: "overflow-y-auto p-0",
    defaultOrder: 35,
    paletteKeywords: ["goal", "target", "objective"],
  },
  workflows: {
    name: "Workflows",
    contentClassName: "overflow-y-auto p-[15px]",
    // Gated on the same experiment that enables durable workflows — the tab is
    // their observation surface, so a separate flag would just be a second toggle.
    featureFlag: EXPERIMENT_IDS.DYNAMIC_WORKFLOWS,
    defaultOrder: 36,
    paletteKeywords: ["workflow", "workflows", "orchestration", "agents", "run"],
  },
  timeline: {
    name: "Timeline",
    contentClassName: "overflow-hidden p-0",
    featureFlag: EXPERIMENT_IDS.TIMELINE,
    defaultOrder: 37,
    paletteKeywords: ["timeline", "events", "history", "activity"],
  },
  memory: {
    name: "Memory",
    contentClassName: "overflow-hidden p-0",
    featureFlag: EXPERIMENT_IDS.MEMORY,
    defaultOrder: 38,
    paletteKeywords: ["memory", "memories", "remember"],
  },
  desktop: {
    name: "Desktop",
    contentClassName: "overflow-hidden p-0",
    featureFlag: EXPERIMENT_IDS.PORTABLE_DESKTOP,
    defaultOrder: 40,
    paletteKeywords: ["desktop", "vnc", "screen"],
  },
  browser: {
    name: "Browser",
    contentClassName: "overflow-hidden p-0",
    keepAlive: false,
    featureFlag: EXPERIMENT_IDS.AGENT_BROWSER,
    defaultOrder: 50,
    paletteKeywords: ["browser", "web"],
  },
  output: {
    name: "Output",
    contentClassName: "overflow-hidden p-0",
    defaultOrder: 60,
    paletteKeywords: ["log", "logs", "output"],
  },
  debug: {
    name: "Debug",
    contentClassName: "overflow-y-auto p-0",
    defaultOrder: 70,
    paletteKeywords: ["debug", "devtools", "diagnostics"],
  },
} satisfies Record<string, TabConfig>;

/** Static (non-terminal) tab id union, derived from the lightweight config keys. */
export type BaseTabType = keyof typeof TAB_CONFIG_DEF;

/** Public lightweight config indexed by tab id. */
export const TAB_CONFIG: Record<BaseTabType, TabConfig> = TAB_CONFIG_DEF;

/** Runtime-iterable list of base tab ids (for validators & iteration). */
export const BASE_TAB_IDS = Object.keys(TAB_CONFIG_DEF) as BaseTabType[];

/** Type-narrowing predicate for static (non-terminal) tab ids. */
export function isBaseTabId(value: unknown): value is BaseTabType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TAB_CONFIG_DEF, value);
}

export function getTabConfig(id: BaseTabType): TabConfig {
  return TAB_CONFIG[id];
}

/** Default-layout tab ids in canonical order (used for new workspaces & migration). */
export function getDefaultLayoutTabIds(): BaseTabType[] {
  return BASE_TAB_IDS.filter((id) => TAB_CONFIG[id].inDefaultLayout === true).sort(
    (a, b) => TAB_CONFIG[a].defaultOrder - TAB_CONFIG[b].defaultOrder
  );
}

/** All static tabs ordered by defaultOrder (used by Add-Tool picker). */
export function getOrderedBaseTabIds(): BaseTabType[] {
  return [...BASE_TAB_IDS].sort((a, b) => TAB_CONFIG[a].defaultOrder - TAB_CONFIG[b].defaultOrder);
}
