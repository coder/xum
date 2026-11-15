import type { BashToolResult } from "@/common/types/tools";

const DENIAL_KINDS = {
  write: {
    blocked: "a write to",
    why: "Only the workspace, temp folders and caches are writable.",
  },
  read: {
    blocked: "a read of",
    why: "Files outside the workspace, its toolchains and caches stay hidden.",
  },
  network: {
    blocked: "a connection to",
    why: "Only the hosts that the sandbox setting allows are reachable.",
  },
} as const;

function isDenialKind(kind: string): kind is keyof typeof DENIAL_KINDS {
  return Object.hasOwn(DENIAL_KINDS, kind);
}

/**
 * The footer line of a bash card whose command the sandbox blocked. The backend reports each
 * denial as "<kind> <target>" ("write /Users/me/.zshrc", "network paste.example.net"); the line
 * names the first one. Paths stay as reported: the browser does not know the backend's home.
 */
export function describeSandboxDenials(result: BashToolResult | undefined): string | null {
  const denials = result && "sandboxDenials" in result ? result.sandboxDenials : undefined;
  const [first, ...others] = denials ?? [];
  if (first === undefined) return null;
  const more = others.length > 0 ? ` and ${others.length} more` : "";
  const match = /^(\S+) (.+)$/.exec(first);
  if (match === null || !isDenialKind(match[1])) {
    return `The sandbox blocked ${first}${more}.`;
  }
  const kind = DENIAL_KINDS[match[1]];
  return `The sandbox blocked ${kind.blocked} ${match[2]}${more}. ${kind.why}`;
}
