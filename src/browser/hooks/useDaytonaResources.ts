/**
 * Daytona data for the creation controls: the public credential view (never the key) and
 * snapshots for the snapshot select. The runtime config itself is owned by the caller.
 */
import { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import type { DaytonaPublicConfig } from "@/common/orpc/schemas/daytona";
import { getErrorMessage } from "@/common/utils/errors";

export interface DaytonaResources {
  /** Null while loading or when the API is not connected. */
  config: DaytonaPublicConfig | null;
  /** Set when the Daytona settings could not be read at all. */
  configError: string | null;
  snapshots: string[];
  snapshotsError: string | null;
  loadingSnapshots: boolean;
}

const EMPTY_DAYTONA_RESOURCES: DaytonaResources = {
  config: null,
  configError: null,
  snapshots: [],
  snapshotsError: null,
  loadingSnapshots: false,
};

export function useDaytonaResources(): DaytonaResources {
  const { api } = useAPI();
  const [resources, setResources] = useState<DaytonaResources>(EMPTY_DAYTONA_RESOURCES);

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
      update({ loadingSnapshots: true });
      const result = await api.daytona.listSnapshots();
      update(
        result.ok
          ? {
              snapshots: result.snapshots.map((snapshot) => snapshot.name),
              snapshotsError: null,
              loadingSnapshots: false,
            }
          : { snapshots: [], snapshotsError: result.error, loadingSnapshots: false }
      );
    };

    load().catch((error: unknown) => {
      const message = getErrorMessage(error);
      update({
        configError: message,
        snapshotsError: message,
        loadingSnapshots: false,
      });
    });

    return () => {
      active = false;
    };
  }, [api]);

  return resources;
}
