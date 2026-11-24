import type { MCPServerIdentity } from "@/common/types/mcp";

/** Human-facing label for a server identity: the optional title, else the protocol name. */
export function serverDisplayName(identity: Pick<MCPServerIdentity, "name" | "title">): string {
  return identity.title ?? identity.name;
}
