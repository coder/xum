/**
 * Daytona data for the creation controls and Settings: the public credential view (never the
 * key), snapshots for the snapshot select, and sandboxes for the existing-sandbox picker.
 * The runtime config itself is owned by the caller (selectedRuntime.daytona or project defaults).
 */
import { useEffect, useState } from "react";
import { useAPI, useLiveAPI } from "@/browser/contexts/API";
import type { DaytonaPublicConfig, DaytonaSandboxSummary } from "@/common/orpc/schemas/daytona";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { getErrorMessage } from "@/common/utils/errors";

export interface DaytonaResources {
  /** Null while loading or when the API is not connected. */
  config: DaytonaPublicConfig | null;
  /** Set when the Daytona settings could not be read at all. */
  configError: string | null;
  snapshots: string[];
  snapshotsError: string | null;
  loadingSnapshots: boolean;
  sandboxes: DaytonaSandboxSummary[];
  sandboxesError: string | null;
  loadingSandboxes: boolean;
}

export const EMPTY_DAYTONA_RESOURCES: DaytonaResources = {
  config: null,
  configError: null,
  snapshots: [],
  snapshotsError: null,
  loadingSnapshots: false,
  sandboxes: [],
  sandboxesError: null,
  loadingSandboxes: false,
};

interface UseDaytonaResourcesOptions {
  /**
   * The existing-sandbox picker is creation-only; Settings defaults never need the list, and
   * each list is a billed-account API call.
   */
  loadSandboxes: boolean;
}

/**
 * Changes each time Daytona access is saved in Settings. Settings covers views that stay
 * mounted (the creation controls), so what they loaded from the old access must reload.
 */
export function useDaytonaConfigVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((previous) => previous + 1);
    window.addEventListener(CUSTOM_EVENTS.DAYTONA_CONFIG_CHANGED, bump);
    return () => window.removeEventListener(CUSTOM_EVENTS.DAYTONA_CONFIG_CHANGED, bump);
  }, []);
  return version;
}

/** What a load depends on: another API connection or saved access starts from empty. */
interface DaytonaLoadKey {
  api: unknown;
  configVersion: number;
  loadSandboxes: boolean;
}

interface LoadedDaytonaResources extends DaytonaLoadKey {
  resources: DaytonaResources;
}

/** `loaded`'s resources if they came from the load `key` names, else empty ones. */
function resourcesFor(loaded: LoadedDaytonaResources | null, key: DaytonaLoadKey) {
  return loaded !== null &&
    loaded.api === key.api &&
    loaded.configVersion === key.configVersion &&
    loaded.loadSandboxes === key.loadSandboxes
    ? loaded.resources
    : EMPTY_DAYTONA_RESOURCES;
}

export function useDaytonaResources(options: UseDaytonaResourcesOptions): DaytonaResources {
  const { api } = useAPI();
  // Loads run on the live client only. While Xum reconnects `api` can stay the last client,
  // whose calls fail at once, and the same object may come back: a load keyed on it alone would
  // keep that failure until something else changed.
  const liveApi = useLiveAPI();
  const configVersion = useDaytonaConfigVersion();
  // One state object so consumers get a stable identity until something actually loads.
  const [loaded, setLoaded] = useState<LoadedDaytonaResources | null>(null);
  const { loadSandboxes } = options;

  useEffect(() => {
    if (!liveApi) return;
    let active = true;
    const update = (patch: Partial<DaytonaResources>) => {
      if (!active) return;
      const key = { api, configVersion, loadSandboxes };
      setLoaded((prev) => ({ ...key, resources: { ...resourcesFor(prev, key), ...patch } }));
    };

    const load = async () => {
      const config = await liveApi.daytona.getConfig();
      update({ config, configError: null });
      if (!config.apiKeySet) return;
      update({ loadingSnapshots: true, loadingSandboxes: loadSandboxes });
      await Promise.all([
        liveApi.daytona.listSnapshots().then((result) =>
          update(
            result.ok
              ? {
                  snapshots: result.snapshots.map((snapshot) => snapshot.name),
                  snapshotsError: null,
                  loadingSnapshots: false,
                }
              : { snapshots: [], snapshotsError: result.error, loadingSnapshots: false }
          )
        ),
        loadSandboxes
          ? liveApi.daytona
              .listSandboxes()
              .then((result) =>
                update(
                  result.ok
                    ? { sandboxes: result.sandboxes, sandboxesError: null, loadingSandboxes: false }
                    : { sandboxes: [], sandboxesError: result.error, loadingSandboxes: false }
                )
              )
          : Promise.resolve(),
      ]);
    };

    load().catch((error: unknown) => {
      const message = getErrorMessage(error);
      update({
        configError: message,
        snapshotsError: message,
        sandboxesError: message,
        loadingSnapshots: false,
        loadingSandboxes: false,
      });
    });

    return () => {
      active = false;
    };
  }, [api, liveApi, loadSandboxes, configVersion]);

  // A reload never shows what the previous load found: a failed or keyless reload would
  // otherwise leave the form ready with the old account's config, snapshots and sandboxes.
  return resourcesFor(loaded, { api, configVersion, loadSandboxes });
}
