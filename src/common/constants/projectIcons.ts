/**
 * Lucide icons a project can show instead of its initial in the flat sidebar. The stored value is
 * the lucide name; names outside this list (hand edits, a newer version) fall back to the initial.
 */
export const PROJECT_ICON_NAMES = [
  "code",
  "terminal",
  "braces",
  "bug",
  "git-branch",
  "workflow",
  "database",
  "server",
  "cloud",
  "globe",
  "cpu",
  "shield",
  "bot",
  "brain",
  "sparkles",
  "flask-conical",
  "atom",
  "package",
  "boxes",
  "layers",
  "puzzle",
  "wrench",
  "hammer",
  "book-open",
  "file-text",
  "pen-tool",
  "image",
  "smartphone",
  "gamepad-2",
  "music",
  "rocket",
  "zap",
  "leaf",
  "heart",
  "star",
] as const;

export type ProjectIconName = (typeof PROJECT_ICON_NAMES)[number];

const PROJECT_ICON_NAME_SET: ReadonlySet<string> = new Set(PROJECT_ICON_NAMES);

export function isProjectIconName(value: unknown): value is ProjectIconName {
  return typeof value === "string" && PROJECT_ICON_NAME_SET.has(value);
}
