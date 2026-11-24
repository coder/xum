import { useEffect, useState } from "react";
import { Switch } from "@/browser/components/Switch/Switch";
import { useAPI, useLiveAPI, type APIClient } from "@/browser/contexts/API";
import { isConnectionLostError } from "@/browser/contexts/connectionLink";
import assert from "@/common/utils/assert";
import { SettingRow, SettingsGroup } from "../Components/SettingsLayout";
import { isBrowserMode } from "./settingsEnv";

/**
 * "Keep screen awake while agents are working" (moved from General to Agents, next to the
 * work it is about). The sleep blocker lives in the Electron main process, so browser mode
 * (including `xum server` and desktop server windows) has nothing to toggle.
 */
export function KeepScreenAwakeSetting() {
  if (isBrowserMode()) return null;
  return <KeepScreenAwakeGroup />;
}

/** Shared by the save chain and the external refresh of one mounted switch. */
interface KeepAwakeSync {
  /** Bumped by every local change; a load or refresh started before it must not apply. */
  nonce: number;
  /** Last value the backend confirmed; a failed save rolls back to it. */
  saved: boolean;
  /** Local saves still in flight; an external refresh must not replace the user's newest choice. */
  pendingWrites: number;
  /**
   * An external config change arrived while local saves were pending; replay it once they settle
   * so a later value accepted by the backend (e.g. from the palette command) is not lost.
   */
  refreshDeferred: boolean;
  refresh: (() => Promise<void>) | null;
  chain: Promise<void>;
}

type SetKeepAwake = (value: boolean) => void;

function createKeepAwakeSync(): KeepAwakeSync {
  return {
    nonce: 0,
    saved: false,
    pendingWrites: 0,
    refreshDeferred: false,
    refresh: null,
    chain: Promise.resolve(),
  };
}

function applySaved(sync: KeepAwakeSync, value: boolean, setValue: SetKeepAwake) {
  sync.saved = value;
  setValue(value);
}

/** The last local save to settle replays a refresh that was deferred while saves ran. */
function settleKeepAwakeWrite(sync: KeepAwakeSync): Promise<void> | undefined {
  sync.pendingWrites--;
  assert(sync.pendingWrites >= 0, "keep-awake pending write count went negative");
  if (sync.pendingWrites > 0 || !sync.refreshDeferred) return undefined;
  sync.refreshDeferred = false;
  return sync.refresh?.().catch(() => {
    // Best-effort: keep the last known value and wait for the next change.
  });
}

function saveKeepAwake(
  api: APIClient,
  sync: KeepAwakeSync,
  checked: boolean,
  setValue: SetKeepAwake
) {
  // Invalidate any in-flight config load so it does not overwrite the user's selection.
  const nonce = ++sync.nonce;
  setValue(checked);
  // Serialize writes, but only roll back the latest selection when persistence fails.
  sync.pendingWrites++;
  sync.chain = sync.chain
    .then(async () => {
      await api.config.updateKeepScreenAwake({ enabled: checked });
      sync.saved = checked;
    })
    .catch(() => {
      if (nonce === sync.nonce) setValue(sync.saved);
    })
    .finally(() => settleKeepAwakeWrite(sync));
}

async function refreshKeepAwake(
  api: APIClient,
  sync: KeepAwakeSync,
  signal: AbortSignal,
  setValue: SetKeepAwake
) {
  // Defer while our own saves are in flight: disk may still hold an older value. The last
  // save to settle replays this refresh, so a newer external value still wins.
  if (sync.pendingWrites > 0) {
    sync.refreshDeferred = true;
    return;
  }
  const nonce = sync.nonce;
  const cfg = await api.config.getConfig();
  if (signal.aborted) return;
  if (nonce !== sync.nonce || sync.pendingWrites > 0) {
    // A local click started a save during the read; re-read once it settles.
    sync.refreshDeferred = true;
    return;
  }
  applySaved(sync, cfg.keepScreenAwake === true, setValue);
}

/**
 * Run onChange for every config change until the signal aborts. The iterator goes into `opened`
 * so the effect cleanup can end it at once instead of waiting for the next event.
 */
async function followConfigChanges(
  onConfigChanged: APIClient["config"]["onConfigChanged"],
  signal: AbortSignal,
  onChange: () => Promise<void>,
  opened: { iterator?: AsyncIterator<unknown> }
) {
  const iterator = await onConfigChanged(undefined, { signal });
  opened.iterator = iterator;
  try {
    for (;;) {
      if (signal.aborted) return;
      const event = await iterator.next();
      if (event.done || signal.aborted) return;
      await onChange().catch(() => {
        // Best-effort: keep the last known value and wait for the next change.
      });
    }
  } finally {
    await iterator.return?.();
  }
}

function useKeepAwakeLoad(api: APIClient | null, sync: KeepAwakeSync, setValue: SetKeepAwake) {
  useEffect(() => {
    if (!api) return;
    const nonce = ++sync.nonce;
    api.config
      .getConfig()
      .then((cfg) => {
        if (nonce === sync.nonce) applySaved(sync, cfg.keepScreenAwake === true, setValue);
      })
      .catch((error: unknown) => {
        // A lost connection is no read failure: the reconnect reads again.
        if (isConnectionLostError(error)) return;
      });
  }, [api, sync, setValue]);
}

function useKeepAwakeFollow(api: APIClient | null, sync: KeepAwakeSync, setValue: SetKeepAwake) {
  // The setting can also change outside this section (the "Toggle Keep Screen Awake" palette
  // command runs while Settings is open), so follow config changes instead of showing a stale
  // switch whose next click would rewrite the current value rather than toggle it.
  useEffect(() => {
    const onConfigChanged = api?.config?.onConfigChanged;
    if (!api || onConfigChanged == null) return;
    const abortController = new AbortController();
    const refresh = () => refreshKeepAwake(api, sync, abortController.signal, setValue);
    sync.refresh = refresh;
    const opened: { iterator?: AsyncIterator<unknown> } = {};
    // Settles on its own once aborted; cancellation is expected during unmount/API reconnects.
    followConfigChanges(onConfigChanged, abortController.signal, refresh, opened).catch(
      () => undefined
    );
    return () => {
      abortController.abort();
      void opened.iterator?.return?.();
      if (sync.refresh === refresh) sync.refresh = null;
    };
  }, [api, sync, setValue]);
}

function KeepScreenAwakeGroup() {
  const { api } = useAPI();
  // Offline the switch is disabled: its write could not reach the server.
  const offline = useLiveAPI() == null;
  const [keepScreenAwake, setKeepScreenAwake] = useState(false);
  // One mutable record per mounted switch (a lazy state initializer, so it is never re-created).
  const [sync] = useState(createKeepAwakeSync);
  useKeepAwakeLoad(api, sync, setKeepScreenAwake);
  useKeepAwakeFollow(api, sync, setKeepScreenAwake);

  return (
    <SettingsGroup title="System">
      {/* Electron's display-sleep blocker does not guarantee the OS lock policy is suppressed,
          so the copy only promises display/system sleep. */}
      <SettingRow id="keep-screen-awake">
        <Switch
          checked={keepScreenAwake}
          onCheckedChange={(checked) => {
            if (api) saveKeepAwake(api, sync, checked, setKeepScreenAwake);
          }}
          disabled={offline}
          aria-label="Toggle keep screen awake while agents are working"
        />
      </SettingRow>
    </SettingsGroup>
  );
}
