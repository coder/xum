// Daytona Cloud is a managed compute provider layered on the `ssh` runtime (ssh + daytona
// sub-config), reached through Daytona's SSH gateway. These constants are shared by the UI,
// the runtime's validateBeforePersist and the node-side ssh config writer.

/** Default Daytona control-plane URL (BYOC installs override it in Settings > Runtimes). */
export const DAYTONA_DEFAULT_API_URL = "https://app.daytona.io/api";

/**
 * Host suffix for Daytona sandboxes (`<sandboxId>.xum--daytona`). The `--` keeps Xum's managed
 * ssh config block from colliding with user-managed entries, as the Coder suffix does.
 */
export const XUM_DAYTONA_HOST_SUFFIX = "xum--daytona";

/** Build the SSH alias for a Daytona sandbox (e.g. `abc123.xum--daytona`). */
export function toXumDaytonaHost(sandboxId: string): string {
  return `${sandboxId}.${XUM_DAYTONA_HOST_SUFFIX}`;
}

export const XUM_DAYTONA_SSH_BLOCK_START = "# --- START XUM DAYTONA SSH ---";
export const XUM_DAYTONA_SSH_BLOCK_END = "# --- END XUM DAYTONA SSH ---";

export type DaytonaSizePresetId = "small" | "medium" | "large";

export interface DaytonaSizePreset {
  id: DaytonaSizePresetId;
  label: string;
  cpu: number;
  memoryGiB: number;
  diskGiB: number;
}

/**
 * The only box sizes Xum offers. There is deliberately no free-form CPU/memory input: a fixed
 * list keeps cost predictable and lets validateBeforePersist reject hand-edited configs.
 */
export const DAYTONA_SIZE_PRESETS: readonly DaytonaSizePreset[] = [
  { id: "small", label: "Small", cpu: 2, memoryGiB: 4, diskGiB: 10 },
  { id: "medium", label: "Medium", cpu: 4, memoryGiB: 8, diskGiB: 20 },
  { id: "large", label: "Large", cpu: 8, memoryGiB: 16, diskGiB: 40 },
];

export const DAYTONA_DEFAULT_SIZE_PRESET_ID: DaytonaSizePresetId = "small";

/** Find the preset whose resources match exactly; undefined when the triple is not a preset. */
export function findDaytonaSizePreset(resources: {
  cpu?: number;
  memoryGiB?: number;
  diskGiB?: number;
}): DaytonaSizePreset | undefined {
  return DAYTONA_SIZE_PRESETS.find(
    (preset) =>
      preset.cpu === resources.cpu &&
      preset.memoryGiB === resources.memoryGiB &&
      preset.diskGiB === resources.diskGiB
  );
}
