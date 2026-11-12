import type { FilterListItem } from "@/browser/components/FilterList/filterListItems";

/**
 * How the creation page's two lists are grouped. A repository can hold hundreds of branches (one
 * per agent workspace) and a user dozens of projects; an alphabetical list makes the likely pick
 * as hard to find as any other. Both lists therefore lead with what was used last.
 */

const RECENT_SECTION = "Recent";

/**
 * The base-branch rows: the default branch first (tagged), then the branches committed to most
 * recently, then every other branch in the order given. With nothing recent the list has no
 * captions.
 */
export function branchPickerItems(
  branches: readonly string[],
  defaultBranch: string | null,
  recentBranches: readonly string[]
): FilterListItem[] {
  const known = new Set(branches);
  const lead = defaultBranch !== null && known.has(defaultBranch) ? [defaultBranch] : [];
  const recent = recentBranches.filter((name) => known.has(name) && !lead.includes(name));
  const placed = new Set([...lead, ...recent]);
  const rest = branches.filter((name) => !placed.has(name));
  const sectioned = recent.length > 0 && rest.length > 0;
  const row = (name: string, section: string | undefined): FilterListItem => ({
    value: name,
    label: name,
    badge: name === defaultBranch ? "default" : undefined,
    section,
  });
  return [
    ...lead.map((name) => row(name, undefined)),
    ...recent.map((name) => row(name, sectioned ? RECENT_SECTION : undefined)),
    ...rest.map((name) => row(name, sectioned ? "All branches" : undefined)),
  ];
}

/** Below this many projects the whole list is in view, and captions would only add noise. */
export const PROJECT_GROUPS_MIN_PROJECTS = 6;
const RECENT_PROJECT_COUNT = 3;

/**
 * Splits the projects into the ones worked in last (newest first) and the rest (order kept). A
 * project's recency is that of its most recently active workspace.
 */
export function groupProjectsByRecency(
  projectPaths: readonly string[],
  workspaces: Iterable<{ id: string; projectPath: string }>,
  recency: Readonly<Record<string, number>>
): { recent: string[]; rest: string[] } {
  if (projectPaths.length < PROJECT_GROUPS_MIN_PROJECTS)
    return { recent: [], rest: [...projectPaths] };
  const lastActive = new Map<string, number>();
  for (const workspace of workspaces) {
    const at = recency[workspace.id] ?? 0;
    if (at > (lastActive.get(workspace.projectPath) ?? 0))
      lastActive.set(workspace.projectPath, at);
  }
  const recent = projectPaths
    .filter((path) => lastActive.has(path))
    .sort((a, b) => (lastActive.get(b) ?? 0) - (lastActive.get(a) ?? 0))
    .slice(0, RECENT_PROJECT_COUNT);
  return { recent, rest: projectPaths.filter((path) => !recent.includes(path)) };
}

export const PROJECT_SECTIONS = { recent: RECENT_SECTION, all: "All projects" } as const;
