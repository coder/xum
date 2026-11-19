import { useCallback, useEffect, useState, type ReactNode } from "react";
import { encode } from "uqr";
import { Eye, EyeOff } from "lucide-react";
import {
  SETTINGS_GROUP_HEADING_CLASS,
  SettingsAnchor,
  SettingsMark,
} from "../Components/SettingsLayout";
import { ConfigurableBindUrlControls } from "./ExperimentsSection";
import {
  buildConnectionLink,
  defaultPairingBaseUrl,
  isLoopbackBaseUrl,
  maskConnectionLink,
  pairingBaseUrls,
} from "./pairDeviceQr";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { Button } from "@/browser/components/Button/Button";
import { CopyButton } from "@/browser/components/CopyButton/CopyButton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { useAPI, useLiveAPI, type APIClient } from "@/browser/contexts/API";
import { isConnectionLostError } from "@/browser/contexts/connectionLink";
import type { ApiServerStatus, ServerAuthSession } from "@/common/orpc/types";
import { getErrorMessage } from "@/common/utils/errors";

function formatTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString();
}

function formatRelativeTime(timestampMs: number): string {
  const deltaMs = Date.now() - timestampMs;
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    return "just now";
  }

  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (deltaMs < minuteMs) {
    return "just now";
  }

  if (deltaMs < hourMs) {
    return `${Math.floor(deltaMs / minuteMs)}m ago`;
  }

  if (deltaMs < dayMs) {
    return `${Math.floor(deltaMs / hourMs)}h ago`;
  }

  return `${Math.floor(deltaMs / dayMs)}d ago`;
}

function SessionRow(props: {
  session: ServerAuthSession;
  disabled: boolean;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const session = props.session;
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-sm font-medium">
          {session.label}
          {session.isCurrent ? " (Current)" : ""}
        </div>
        <div className="text-muted text-xs">
          Last active {formatRelativeTime(session.lastUsedAtMs)} · Created{" "}
          {formatTimestamp(session.createdAtMs)}
        </div>
      </div>

      <Button
        variant={session.isCurrent ? "destructive" : "ghost"}
        size="sm"
        onClick={props.onRevoke}
        disabled={props.disabled || props.revoking}
      >
        {props.revoking ? "Revoking..." : session.isCurrent ? "Log out" : "Revoke"}
      </Button>
    </div>
  );
}

export function ServerAccessSection() {
  const { api, retry } = useAPI();
  // Offline, the kept sessions stay on screen, but every action is disabled: it could not reach
  // the server, and a click must not look like it did something.
  const offline = useLiveAPI() == null;
  const [sessions, setSessions] = useState<ServerAuthSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokingSessionId, setRevokingSessionId] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);

  const refreshSessions = useCallback(async () => {
    if (!api) {
      // Offline, keep the shown sessions: the reconnect reloads them.
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const nextSessions = await api.serverAuth.listSessions();
      setSessions(nextSessions);
    } catch (refreshError) {
      // A lost connection is no load failure: keep the shown sessions for the reconnect.
      if (isConnectionLostError(refreshError)) return;
      const message = getErrorMessage(refreshError);
      setError(message);
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const handleRevokeSession = useCallback(
    async (session: ServerAuthSession) => {
      if (!api) {
        return;
      }

      setRevokingSessionId(session.id);
      setError(null);

      try {
        const result = await api.serverAuth.revokeSession({ sessionId: session.id });
        if (!result.removed) {
          setError("Session not found");
        }
      } catch (revokeError) {
        const message = getErrorMessage(revokeError);
        setError(message);
      } finally {
        setRevokingSessionId(null);
      }

      await refreshSessions();

      if (session.isCurrent) {
        retry();
      }
    },
    [api, refreshSessions, retry]
  );

  const handleRevokeOthers = useCallback(async () => {
    if (!api) {
      return;
    }

    setRevokingOthers(true);
    setError(null);

    try {
      await api.serverAuth.revokeOtherSessions();
    } catch (revokeError) {
      const message = getErrorMessage(revokeError);
      setError(message);
    } finally {
      setRevokingOthers(false);
    }

    await refreshSessions();
  }, [api, refreshSessions]);

  const currentSession = sessions.find((session) => session.isCurrent) ?? null;
  const hasOtherSessions = sessions.some((session) => !session.isCurrent);
  // Revoke-other requires a current cookie-backed session id; bearer-token auth
  // has no current session and should not expose a no-op destructive action.
  const canRevokeOtherSessions = currentSession != null && hasOtherSessions;

  return (
    <div className="space-y-4">
      <div>
        <SettingsMark id="server-sessions" />
        <h3 className="text-foreground text-sm font-medium">Server access sessions</h3>
        <p className="text-muted mt-1 text-xs">
          Manage browser sessions for this server. Revoke devices you no longer trust.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void refreshSessions()}
          disabled={loading || offline}
        >
          Refresh
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            void handleRevokeOthers();
          }}
          disabled={loading || offline || revokingOthers || !canRevokeOtherSessions}
        >
          {revokingOthers ? "Revoking..." : "Revoke other sessions"}
        </Button>
      </div>

      {error ? <div className="text-destructive text-xs">{error}</div> : null}

      {/* A reload (Refresh, reconnect) keeps the shown sessions: "Loading" only replaces an empty list. */}
      {loading && sessions.length === 0 ? (
        <div className="text-muted text-xs">Loading sessions...</div>
      ) : sessions.length === 0 ? (
        <div className="text-muted text-xs">No active sessions found.</div>
      ) : (
        <div className="border-border-light divide-border-light divide-y rounded-md border">
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              disabled={loading || offline}
              revoking={revokingSessionId === session.id}
              onRevoke={() => {
                void handleRevokeSession(session);
              }}
            />
          ))}
        </div>
      )}

      {currentSession ? (
        <p className="text-muted text-xs">
          Current session last active {formatRelativeTime(currentSession.lastUsedAtMs)}.
        </p>
      ) : null}

      <LanAccessGroup />

      <PairDeviceGroup />
    </div>
  );
}

/**
 * The pairing QR code, rendered locally from the link (the token never leaves the machine):
 * dark modules on a light quiet zone, as QR scanners expect, regardless of the app theme.
 */
function PairingQrCode(props: { text: string; sizePx: number }) {
  if (!props.text) return null;
  const qr = encode(props.text, { ecc: "M", border: 2 });
  return (
    <svg
      width={props.sizePx}
      height={props.sizePx}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      role="img"
      aria-label="Pairing QR code"
      shapeRendering="crispEdges"
    >
      <rect width={qr.size} height={qr.size} fill="#ffffff" />
      {qr.data.flatMap((row, y) =>
        row.map((dark, x) =>
          dark ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="#000000" /> : null
        )
      )}
    </svg>
  );
}

function StatusNotice(props: { children: ReactNode; error?: boolean }) {
  return (
    <div
      className={`bg-background-secondary px-4 py-3 text-xs ${
        props.error ? "text-destructive" : "text-muted"
      }`}
    >
      {props.children}
    </div>
  );
}

/**
 * Loads the server status the pairing panel shows. Offline (no api) it settles with no status:
 * the QR could not be trusted anyway, since the server may have restarted with a new token.
 */
function useApiServerStatus(api: APIClient | null): {
  status: ApiServerStatus | null;
  loading: boolean;
  error: string | null;
  /** The address the QR encodes; kept across reloads, reset to the default when it disappears. */
  selectedUrl: string | null;
  selectUrl: (url: string) => void;
} {
  const [status, setStatus] = useState<ApiServerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!api) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    api.server
      .getApiServerStatus()
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setSelectedUrl((prev) => {
          const urls = pairingBaseUrls(next);
          return prev != null && urls.includes(prev) ? prev : defaultPairingBaseUrl(urls);
        });
      })
      .catch((statusError) => {
        if (cancelled) return;
        setError(getErrorMessage(statusError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api]);

  return { status, loading, error, selectedUrl, selectUrl: setSelectedUrl };
}

function PairDeviceControls() {
  const { api } = useAPI();
  const { status, loading, error, selectedUrl, selectUrl } = useApiServerStatus(api);
  const [revealed, setRevealed] = useState(false);

  // The state notices mirror how LAN / VPN access reports the server status.
  if (error != null) {
    return <StatusNotice error>{error}</StatusNotice>;
  }

  if (api == null) {
    return <StatusNotice>Connect to xum to pair a device.</StatusNotice>;
  }

  if (status == null || loading) {
    return <StatusNotice>Loading server status…</StatusNotice>;
  }

  if (!status.running) {
    return <StatusNotice>Server is not running.</StatusNotice>;
  }

  const urls = pairingBaseUrls(status);
  if (urls.length === 0) {
    return <StatusNotice>No server URL available.</StatusNotice>;
  }

  return (
    <PairDeviceForm
      status={status}
      urls={urls}
      loopbackOnly={urls.every((url) => isLoopbackBaseUrl(url))}
      selectedUrl={selectedUrl}
      onSelectUrl={selectUrl}
      revealed={revealed}
      onToggleRevealed={() => setRevealed((prev) => !prev)}
    />
  );
}

function PairDeviceForm(props: {
  status: ApiServerStatus;
  urls: string[];
  loopbackOnly: boolean;
  selectedUrl: string | null;
  onSelectUrl: (url: string) => void;
  revealed: boolean;
  onToggleRevealed: () => void;
}) {
  const tokenMissing = props.status.token == null;
  const link =
    props.status.token != null && props.selectedUrl != null
      ? buildConnectionLink(props.selectedUrl, props.status.token)
      : null;

  return (
    <div className="bg-background-secondary space-y-4 px-4 py-3">
      {props.loopbackOnly ? (
        <div className="text-warning text-xs">
          This server only listens on localhost, so a phone cannot reach it. To pair a device,
          expose the server on your LAN or VPN: enable “Expose API server on LAN/VPN” in Settings →
          Experiments and pick a network bind host under LAN / VPN access.
        </div>
      ) : null}

      {tokenMissing ? (
        <div className="text-muted text-xs">
          This server runs without an auth token, and the Xum app needs one to connect. Restart the
          server with token auth enabled to pair a device.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-foreground text-sm">Server address</div>
              <div className="text-muted text-xs">
                The address the QR encodes; pick one the phone can reach
              </div>
            </div>
            {props.selectedUrl != null ? (
              <Select value={props.selectedUrl} onValueChange={props.onSelectUrl}>
                <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-64 cursor-pointer rounded-md border px-3 text-sm transition-colors">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {props.urls.map((url) => (
                    <SelectItem key={url} value={url}>
                      {addressLabel(url)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>

          {link ? (
            <PairingLinkRow
              link={link}
              revealed={props.revealed}
              onToggleRevealed={props.onToggleRevealed}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function PairingLinkRow(props: { link: string; revealed: boolean; onToggleRevealed: () => void }) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      {props.revealed ? (
        <div className="rounded-md bg-white p-2">
          <PairingQrCode text={props.link} sizePx={160} />
        </div>
      ) : (
        <div className="bg-background-tertiary text-muted flex h-[176px] w-[176px] items-center justify-center rounded-md p-2 text-xs">
          Hidden until revealed
        </div>
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-muted text-xs">Connection link</div>
        <div className="font-mono text-xs break-all">
          {props.revealed ? props.link : maskConnectionLink(props.link)}
        </div>
        <div className="text-muted text-xs">
          Anyone who scans this code gets full access to the server.
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={props.onToggleRevealed}
          className="text-muted hover:text-foreground flex cursor-pointer items-center justify-center rounded-sm border-none bg-transparent px-1 py-0.5 transition-all duration-200"
          aria-label={props.revealed ? "Hide pairing code" : "Show pairing code"}
        >
          {props.revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
        <CopyButton text={props.link} />
      </div>
    </div>
  );
}

function addressLabel(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Server access → Pair device: a QR code the Xum iOS app scans to connect to this server. */
export function PairDeviceGroup() {
  return (
    <section className="space-y-2 pt-4">
      <div className="px-1">
        <h3 className={SETTINGS_GROUP_HEADING_CLASS}>Pair device</h3>
        <div className="text-content-secondary mt-1 text-xs">
          Scan with the Xum iOS app to sign in to this server. The code carries the server address
          and its auth token.
        </div>
      </div>
      <SettingsAnchor
        id="pair-device"
        className="border-border-light overflow-hidden rounded-lg border"
      >
        <PairDeviceControls />
      </SettingsAnchor>
    </section>
  );
}
/** Server access → LAN / VPN access: shown while "Expose API server on LAN/VPN" is on. */
export function LanAccessGroup() {
  const enabled = useExperimentValue(EXPERIMENT_IDS.CONFIGURABLE_BIND_URL);
  if (!enabled) return null;
  return (
    <section className="space-y-2 pt-4">
      <div className="px-1">
        <h3 className={SETTINGS_GROUP_HEADING_CLASS}>LAN / VPN access</h3>
        <div className="text-content-secondary mt-1 text-xs">
          Bind host, port and web UI for the API server (experimental).
        </div>
      </div>
      <SettingsAnchor
        id="lan-bind"
        className="border-border-light overflow-hidden rounded-lg border"
      >
        <ConfigurableBindUrlControls />
      </SettingsAnchor>
    </section>
  );
}
