import { ExternalLink, Plug } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/browser/components/Popover/Popover";
import { HttpsUrlSchema } from "@/common/orpc/schemas/mcp";
import type {
  MCPConnectionRef,
  MCPServerIdentity,
  MCPServerInfo,
  MCPTestResult,
} from "@/common/types/mcp";
import { httpsOriginOf } from "@/common/utils/mcp/httpsUrl";
import { serverDisplayName } from "@/common/utils/mcp/serverDisplayName";

// Settings knows the configured mode, not the transport negotiated by the test.
// Keep "auto" in this UI-only shape; captured chat connections remain resolved.
type DisplayConnection = Omit<MCPConnectionRef, "transport"> & Pick<MCPServerInfo, "transport">;

/**
 * UI-safe description of a configured connection. Only the configured key, the
 * transport and (for remote servers) the HTTPS origin leave this function:
 * never commands, args, cwd, env, paths, query strings or URL credentials.
 */
export function describeConfiguredConnection(key: string, entry: MCPServerInfo): DisplayConnection {
  if (entry.transport === "stdio") return { key, transport: "stdio" };
  const transport = entry.transport;
  // httpsOriginOf keeps scheme + host + port only (no userinfo, path or query)
  // and yields nothing for non-HTTPS or unparseable URLs.
  const origin = httpsOriginOf(entry.url);
  return origin === undefined ? { key, transport } : { key, transport, origin };
}

/**
 * Identity is display-only and session-scoped; the localStorage test cache
 * must keep its pre-identity shape (tools/testedAt) so branding never survives
 * a reload or restart without a fresh test.
 */
export function stripServerInfo(result: MCPTestResult): MCPTestResult {
  if (!result.success || result.serverInfo === undefined) return result;
  const { serverInfo: _serverInfo, ...rest } = result;
  return rest;
}

interface MCPServerIdentityBadgeProps {
  connection: DisplayConnection;
  identity: MCPServerIdentity;
  /** Show the short display name next to the icon (chat headers). */
  compact?: boolean;
}

export function MCPServerIdentityBadge(props: MCPServerIdentityBadgeProps) {
  const { connection, identity } = props;
  const displayName = serverDisplayName(identity);
  // Re-validated at render: cached or historical values may predate the schema.
  const website =
    identity.websiteUrl !== undefined && HttpsUrlSchema.safeParse(identity.websiteUrl).success
      ? identity.websiteUrl
      : undefined;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Server information: ${connection.key}`}
          // A server-info click must not also expand the surrounding tool header.
          onClick={(event) => event.stopPropagation()}
          className="text-muted hover:text-foreground focus-visible:ring-accent inline-flex shrink-0 items-center gap-1 rounded px-0.5 align-middle font-sans text-[10px] focus-visible:ring-1"
        >
          <Plug aria-hidden className="size-3.5" />
          {props.compact && <span className="truncate">{displayName}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={12}
        className="bg-modal-bg text-foreground w-[300px] max-w-[calc(100vw-24px)] p-3 font-sans text-xs"
        aria-label={`About ${connection.key}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-2">
          <Plug aria-hidden className="size-6 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium wrap-anywhere">{displayName}</div>
            <div className="text-muted text-[10px] wrap-anywhere">v{identity.version}</div>
          </div>
        </div>
        {identity.description && (
          <p className="text-muted mb-3 leading-relaxed wrap-anywhere">{identity.description}</p>
        )}
        <div className="border-border border-t pt-2">
          <div className="text-muted mb-1 text-[10px]">Configured connection</div>
          <div className="font-mono text-[11px] wrap-anywhere">{connection.key}</div>
          <div className="text-muted mt-1 font-mono text-[10px] wrap-anywhere">
            {connection.origin
              ? `${connection.transport} · ${connection.origin}`
              : connection.transport}
          </div>
        </div>
        {website && (
          // Desktop main process routes _blank navigations through shell.openExternal.
          <a
            href={website}
            target="_blank"
            rel="noopener noreferrer"
            className="text-link mt-3 inline-flex items-center gap-1"
          >
            Website <ExternalLink aria-hidden className="size-3" />
          </a>
        )}
        <p className="text-muted mt-3 text-[10px]">
          Server-provided display information. Not a verified identity.
        </p>
      </PopoverContent>
    </Popover>
  );
}
