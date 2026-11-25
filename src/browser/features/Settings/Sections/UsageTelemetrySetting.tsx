import { useEffect, useRef, useState } from "react";
import { Switch } from "@/browser/components/Switch/Switch";
import { useAPI } from "@/browser/contexts/API";
import { SettingRow, SettingsGroup } from "../Components/SettingsLayout";

/**
 * "Usage Telemetry" opt-out (Settings → Behavior → Privacy). It lived in General until the
 * settings split turned General into Appearance; Behavior already holds the other app-wide
 * switch (keep screen awake). Rendered outside the task settings fieldset, so the privacy
 * control never waits on (or locks with) the task settings load.
 */
export function UsageTelemetrySetting() {
  const { api } = useAPI();
  // Optimistic default: telemetry is on unless config says otherwise.
  const [telemetryEnabled, setTelemetryEnabled] = useState(true);
  // Env hard-off (XUM_DISABLE_TELEMETRY, CI): the switch renders disabled
  // instead of pretending the config toggle controls anything.
  const [telemetryDisabledByEnv, setTelemetryDisabledByEnv] = useState(false);
  const telemetryEnabledLoadNonceRef = useRef(0);
  // Monotonic id per telemetry toggle; failure handling may only touch state
  // while its own intent is still the latest.
  const telemetryEnabledIntentRef = useRef(0);
  // Writes still in flight (including their failure reconciliation). Config
  // change notifications are deferred while > 0 — NOT dropped: the backend
  // emits onConfigChanged before the RPC resolves, so even our own final
  // write's notification can arrive while this counter is positive, and an
  // external change during the write window would otherwise be lost.
  const telemetryEnabledPendingWritesRef = useRef(0);
  // Set when a notification was deferred; drained (with a refresh) when the
  // pending-writes counter reaches zero.
  const telemetryEnabledMissedNotificationRef = useRef(false);
  // The mount-time config read is still in flight: a refresh requested meanwhile (the
  // subscription connecting, an external change) waits for it instead of racing a second
  // read, and the load's settle replays it. A change that lands during the load is still
  // picked up by the replayed read.
  const telemetryMountLoadPendingRef = useRef(false);
  const telemetryRefreshAfterMountLoadRef = useRef(false);
  // Always points at the CURRENT api generation's refresh: settle-replay
  // callbacks from old writes (or the mount load) outlive an API replacement and
  // must not replay through the disconnected client they captured (a failed read
  // there would consume the deferred notification and strand the switch stale).
  const refreshTelemetryRef = useRef<() => void>(() => {
    // No-op until the api effect installs the real refresh.
  });
  const telemetryEnabledUpdateChainRef = useRef<Promise<void>>(Promise.resolve());

  // Re-read the persisted telemetry state and apply it unless a newer local
  // action (toggle or later refresh) superseded this read.
  const refreshTelemetryFromBackend = async () => {
    if (!api?.config?.getConfig) {
      return;
    }
    const nonce = ++telemetryEnabledLoadNonceRef.current;
    try {
      const cfg = await api.config.getConfig();
      if (nonce === telemetryEnabledLoadNonceRef.current) {
        setTelemetryEnabled(cfg.telemetryEnabled !== false);
        setTelemetryDisabledByEnv(cfg.telemetryDisabledByEnv === true);
      }
    } catch {
      // Notifications are edge-triggered: with no later refresh guaranteed, a
      // failed read must not strand the switch. Indeterminate state renders
      // ON — showing "off" while collection may have resumed is the one lie a
      // privacy toggle can't tell (same doctrine as the toggle failure path).
      // The nonce guard keeps a newer local action authoritative.
      if (nonce === telemetryEnabledLoadNonceRef.current) {
        setTelemetryEnabled(true);
      }
    }
  };

  // Mount-time read. Declared before the subscription effect so the pending flag is set
  // before the subscription's first refresh can look at it.
  useEffect(() => {
    if (!api) {
      return;
    }
    const telemetryEnabledNonce = ++telemetryEnabledLoadNonceRef.current;
    telemetryMountLoadPendingRef.current = true;

    void api.config
      .getConfig()
      .then((cfg) => {
        if (telemetryEnabledNonce === telemetryEnabledLoadNonceRef.current) {
          setTelemetryEnabled(cfg.telemetryEnabled !== false);
          setTelemetryDisabledByEnv(cfg.telemetryDisabledByEnv === true);
        }
      })
      .catch(() => {
        // Keep the optimistic default; a lost connection reads again on reconnect, and
        // the subscription's connect refresh re-syncs.
      })
      .finally(() => {
        telemetryMountLoadPendingRef.current = false;
        if (telemetryRefreshAfterMountLoadRef.current) {
          telemetryRefreshAfterMountLoadRef.current = false;
          refreshTelemetryRef.current();
        }
      });
  }, [api]);

  const handleTelemetryEnabledChange = (checked: boolean) => {
    // No usable API (browser-mode outage): don't flip optimistically — the
    // switch would render OFF with no write ever issued while the backend may
    // keep collecting, silently discarding the intent. The switch itself is
    // also disabled while api is null; this guard covers the race where the
    // connection drops between render and click.
    if (!api?.config?.updateTelemetryEnabled) {
      return;
    }

    // Invalidate any in-flight config load so it doesn't overwrite the user's selection.
    telemetryEnabledLoadNonceRef.current++;
    setTelemetryEnabled(checked);

    const intent = ++telemetryEnabledIntentRef.current;
    telemetryEnabledPendingWritesRef.current++;

    // Serialize writes so rapid toggles always persist the last user choice.
    telemetryEnabledUpdateChainRef.current = telemetryEnabledUpdateChainRef.current
      .catch(() => {
        // Best-effort only.
      })
      .then(() => api.config.updateTelemetryEnabled({ enabled: checked }))
      .then(() => {
        // Coerce the chain back to Promise<void>.
      })
      .catch(async () => {
        // A privacy control must never read "off" while collection continues.
        // A superseded request's failure is not ours to handle — a later write
        // in the chain carries the newest choice and its own handling. For the
        // latest intent, reload the backend truth rather than guessing with a
        // blind flip (earlier writes in the chain may themselves have failed).
        if (telemetryEnabledIntentRef.current !== intent) {
          return;
        }
        try {
          const cfg = await api.config.getConfig();
          if (telemetryEnabledIntentRef.current === intent) {
            setTelemetryEnabled(cfg.telemetryEnabled !== false);
          }
        } catch {
          if (telemetryEnabledIntentRef.current === intent) {
            // Backend truth is unreachable (e.g. the connection dropped after
            // the request may already have persisted and applied). Indeterminate
            // state must render as ON: showing "off" while telemetry might be
            // collecting is the one lie a privacy toggle can't tell. The next
            // successful config load reconciles the real value.
            setTelemetryEnabled(true);
          }
        }
      })
      .finally(() => {
        telemetryEnabledPendingWritesRef.current--;
        // Replay a notification that arrived during the write window: the
        // backend may have changed under us (another client, or our own write
        // whose notification fired before the RPC resolved). Replays go
        // through the ref so they use the CURRENT api generation — this
        // callback can outlive an API replacement.
        if (
          telemetryEnabledPendingWritesRef.current === 0 &&
          telemetryEnabledMissedNotificationRef.current
        ) {
          telemetryEnabledMissedNotificationRef.current = false;
          refreshTelemetryRef.current();
        }
      });
  };

  // An API replacement (browser-mode reconnect) obsoletes in-flight telemetry
  // writes made through the previous client: invalidate their pending intents
  // so a late rejection from the old client can't run failure reconciliation
  // against state the new client has since confirmed. The subscription effect
  // below re-establishes on the new client and re-syncs on connect.
  useEffect(() => {
    telemetryEnabledIntentRef.current++;
    refreshTelemetryRef.current = () => void refreshTelemetryFromBackend();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshTelemetryFromBackend only closes over `api` (the dep) and stable refs/setters.
  }, [api]);

  // Cross-client telemetry sync: another window/tab (or the API server) can
  // flip the toggle; consume the config-change stream so this pane's switch
  // tracks the true collection state instead of showing a stale value.
  useEffect(() => {
    if (!api?.config?.onConfigChanged) {
      return;
    }
    const abortController = new AbortController();
    const signal = abortController.signal;
    let iterator: AsyncIterator<unknown> | null = null;

    const refreshTelemetry = () => {
      // Defer (never drop) while our own writes are in flight: the settle
      // handler replays the refresh once the queue drains.
      if (telemetryEnabledPendingWritesRef.current > 0) {
        telemetryEnabledMissedNotificationRef.current = true;
        return;
      }
      // Likewise while the mount-time read is still out: its settle replays the refresh.
      if (telemetryMountLoadPendingRef.current) {
        telemetryRefreshAfterMountLoadRef.current = true;
        return;
      }
      void refreshTelemetryFromBackend();
    };

    const subscription = (async () => {
      try {
        const subscribedIterator = await api.config.onConfigChanged(undefined, { signal });
        if (signal.aborted) {
          const cleanup = subscribedIterator.return?.();
          cleanup?.catch(() => undefined);
          return;
        }
        iterator = subscribedIterator;
        // The initial config snapshot raced this subscription's establishment:
        // a change landing in that gap had no listener and would leave the
        // switch stale until the next unrelated edit. Re-sync once connected.
        refreshTelemetry();
        for await (const _ of subscribedIterator) {
          if (signal.aborted) {
            break;
          }
          void refreshTelemetry();
        }
      } catch {
        // Config subscriptions are cancelled during unmounts and API reconnects.
      }
    })();
    subscription.catch(() => undefined);

    return () => {
      abortController.abort();
      const cleanup = iterator?.return?.(undefined);
      cleanup?.catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshTelemetryFromBackend only closes over `api` (already a dep) and stable refs/setters.
  }, [api]);

  return (
    <SettingsGroup title="Privacy">
      <SettingRow
        id="usage-telemetry"
        hint={
          <div className="text-content-secondary mt-0.5 text-xs">
            <a
              href="https://mux.coder.com/reference/telemetry"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              What is collected
            </a>
            {telemetryDisabledByEnv && (
              <span className="text-warning block">
                Disabled by the environment (XUM_DISABLE_TELEMETRY / CI) — this switch has no effect
                until that is removed.
              </span>
            )}
          </div>
        }
      >
        <Switch
          checked={telemetryEnabled && !telemetryDisabledByEnv}
          onCheckedChange={handleTelemetryEnabledChange}
          // Also disabled without a usable API (browser-mode outage): a
          // privacy toggle must not accept a change it cannot deliver.
          disabled={telemetryDisabledByEnv || !api}
          aria-label="Toggle Usage Telemetry"
        />
      </SettingRow>
    </SettingsGroup>
  );
}
