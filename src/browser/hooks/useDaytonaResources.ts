/**
 * Daytona data for the creation controls and Settings: the public credential view (never the
 * key), snapshots for the snapshot select, and sandboxes for the existing-sandbox picker.
 * The runtime config itself is owned by the caller (selectedRuntime.daytona or project defaults).
 */
import { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import type { DaytonaPublicConfig, DaytonaSandboxSummary } from "@/common/orpc/schemas/daytona";
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

export function useDaytonaResources(options: UseDaytonaResourcesOptions): DaytonaResources {
  const { api } = useAPI();
  // One state object so consumers get a stable identity until something actually loads.
  const [resources, setResources] = useState<DaytonaResources>(EMPTY_DAYTONA_RESOURCES);
  const { loadSandboxes } = options;

  useEffect(() => {
    if (!api) return;
    let active = true;
    const update = (patch: Partial<DaytonaResources>) => {
      if (active) setResources((prev) => ({ ...prev, ...patch }));
    };

    const load = async () => {
      const config = await api.daytona.getConfig();
      update({ config, configError: null });
      if (!config.apiKeySet) return;
      update({ loadingSnapshots: true, loadingSandboxes: loadSandboxes });
      await Promise.all([
        api.daytona.listSnapshots().then((result) =>
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
          ? api.daytona
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
  }, [api, loadSandboxes]);

  return resources;
}
