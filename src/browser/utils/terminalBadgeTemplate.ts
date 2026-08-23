export interface TerminalBadgeVariables {
  workspace: string;
  project: string;
  tab: string;
}

/**
 * Expand a terminal badge template. Only {workspace}, {project}, and {tab}
 * are substituted; unknown {tokens} pass through unchanged so typos stay
 * visible instead of silently vanishing.
 */
export function formatTerminalBadge(template: string, vars: TerminalBadgeVariables): string {
  return template
    .replace(
      /\{(workspace|project|tab)\}/g,
      (_match, token: keyof TerminalBadgeVariables) => vars[token]
    )
    .trim();
}
