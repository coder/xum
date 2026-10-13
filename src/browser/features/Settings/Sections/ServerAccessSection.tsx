import { useCallback, useEffect, useState } from "react";
import { Button } from "@/browser/components/Button/Button";
import { useAPI } from "@/browser/contexts/API";
import { isAbortError } from "@/browser/utils/isAbortError";
import type { ServerAuthSession } from "@/common/orpc/types";
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
  loading: boolean;
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
        disabled={props.loading || props.revoking}
      >
        {props.revoking ? "Revoking..." : session.isCurrent ? "Log out" : "Revoke"}
      </Button>
    </div>
  );
}

export function ServerAccessSection() {
  const { api, retry } = useAPI();
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
      if (isAbortError(refreshError)) return;
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
          disabled={loading}
        >
          Refresh
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            void handleRevokeOthers();
          }}
          disabled={loading || revokingOthers || !canRevokeOtherSessions}
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
              loading={loading}
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
    </div>
  );
}
