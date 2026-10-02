import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  ARTIFACTS_SELECTION_KEY,
  ARTIFACTS_SELECTION_MAX_CHARS,
  ARTIFACTS_SELECTION_MAX_WORKSPACES,
} from "@/common/constants/storage";

/** What the Artifacts tab's selected path points at. */
export type ArtifactSelectionScope = "artifact" | "pinned";

/**
 * The Artifacts tab selection of one workspace: an artifacts-relative path, or a
 * checkout-relative path when `pinned`; `version` null means "Latest (live)".
 */
export interface ArtifactSelection {
  scope: ArtifactSelectionScope;
  path: string | null;
  version: number | null;
}

/** Workspace id -> selection; key order is least to most recently written. */
type ArtifactSelectionMap = Record<string, ArtifactSelection>;

const DEFAULT_SELECTION: ArtifactSelection = { scope: "artifact", path: null, version: null };
const EMPTY_MAP: ArtifactSelectionMap = {};

// One global most-recently-used map instead of three keys per workspace: per-workspace keys
// multiply by every workspace the user ever opened and overflowed the localStorage budget
// (persistedStateBudget.test.ts).
function sanitize(raw: unknown): ArtifactSelection {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SELECTION;
  const value = raw as Partial<Record<keyof ArtifactSelection, unknown>>;
  const scope = value.scope === "pinned" ? value.scope : ("artifact" as const);
  const path = typeof value.path === "string" && value.path.length > 0 ? value.path : null;
  const version =
    typeof value.version === "number" && Number.isInteger(value.version) && value.version > 0
      ? value.version
      : null;
  return { scope, path, version };
}

function selectionFrom(map: unknown, workspaceId: string): ArtifactSelection {
  if (typeof map !== "object" || map === null || Array.isArray(map)) return DEFAULT_SELECTION;
  return sanitize((map as Record<string, unknown>)[workspaceId]);
}

/** Store `next` for `workspaceId` as the most recent entry, dropping the oldest to stay bounded. */
function withSelection(
  map: unknown,
  workspaceId: string,
  next: ArtifactSelection
): ArtifactSelectionMap {
  const previous =
    typeof map === "object" && map !== null && !Array.isArray(map)
      ? Object.entries(map as Record<string, unknown>).filter(([id]) => id !== workspaceId)
      : [];
  const entries: Array<[string, ArtifactSelection]> = [
    ...previous.map(([id, value]): [string, ArtifactSelection] => [id, sanitize(value)]),
    [workspaceId, next],
  ];
  while (entries.length > ARTIFACTS_SELECTION_MAX_WORKSPACES) entries.shift();
  // Very long paths: drop older workspaces first. If the current entry alone is over the cap,
  // the write path keeps it in memory only, as for any oversized value.
  while (
    entries.length > 1 &&
    JSON.stringify(Object.fromEntries(entries)).length > ARTIFACTS_SELECTION_MAX_CHARS
  ) {
    entries.shift();
  }
  return Object.fromEntries(entries);
}

export function readArtifactSelection(workspaceId: string): ArtifactSelection {
  return selectionFrom(
    readPersistedState<unknown>(ARTIFACTS_SELECTION_KEY, EMPTY_MAP),
    workspaceId
  );
}

/** Merge `patch` into the workspace's selection; listeners (the mounted panel) update. */
export function writeArtifactSelection(
  workspaceId: string,
  patch: Partial<ArtifactSelection>
): void {
  updatePersistedState<unknown>(
    ARTIFACTS_SELECTION_KEY,
    (map: unknown) =>
      withSelection(map, workspaceId, { ...selectionFrom(map, workspaceId), ...patch }),
    EMPTY_MAP
  );
}

/** The workspace's selection, kept in sync with writeArtifactSelection from anywhere. */
export function useArtifactSelection(workspaceId: string): ArtifactSelection {
  const [map] = usePersistedState<unknown>(ARTIFACTS_SELECTION_KEY, EMPTY_MAP, {
    listener: true,
  });
  return selectionFrom(map, workspaceId);
}
