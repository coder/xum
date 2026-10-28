/**
 * Daytona sandbox controls for the SSH-based Daytona runtime: create a sandbox from a snapshot
 * at a size preset, on workspace creation.
 */
import { Loader2 } from "lucide-react";
import {
  DAYTONA_DEFAULT_SIZE_PRESET_ID,
  DAYTONA_SIZE_PRESETS,
  findDaytonaSizePreset,
  type DaytonaSizePreset,
  type DaytonaSizePresetId,
} from "@/common/constants/daytona";
import type { DaytonaSandboxConfig } from "@/common/orpc/schemas/daytona";
import { useDaytonaResources, type DaytonaResources } from "@/browser/hooks/useDaytonaResources";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";

// Radix Select reserves the empty string, so "use Daytona's default snapshot" needs a token.
const DEFAULT_SNAPSHOT_VALUE = "__daytona_default__";

export function getDaytonaSizePresetId(config: DaytonaSandboxConfig): DaytonaSizePresetId {
  return findDaytonaSizePreset(config)?.id ?? DAYTONA_DEFAULT_SIZE_PRESET_ID;
}

export function withDaytonaSizePreset(
  config: DaytonaSandboxConfig,
  presetId: string
): DaytonaSandboxConfig {
  const preset = DAYTONA_SIZE_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) return config;
  return { ...config, cpu: preset.cpu, memoryGiB: preset.memoryGiB, diskGiB: preset.diskGiB };
}

export function formatDaytonaSizePreset(preset: DaytonaSizePreset): string {
  return `${preset.label} (${preset.cpu} vCPU, ${preset.memoryGiB} GiB, ${preset.diskGiB} GiB disk)`;
}

/** Shown instead of the form when Daytona cannot be used yet. */
function DaytonaAccessNotice(props: { resources: DaytonaResources }) {
  if (props.resources.configError) {
    return (
      <p role="alert" className="text-xs break-words text-red-500">
        Could not read Daytona settings: {props.resources.configError}
      </p>
    );
  }
  if (!props.resources.config) {
    return (
      <p className="text-muted flex items-center gap-1.5 text-xs">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking Daytona access...
      </p>
    );
  }
  return (
    <p className="text-xs text-yellow-500">
      Set a Daytona API key in Settings &gt; Runtimes to create sandboxes.
    </p>
  );
}

const ROW_CLASS = "flex min-h-7 items-center gap-2";
const LABEL_CLASS = "text-muted-foreground w-16 shrink-0 text-xs";
const TRIGGER_CLASS = "h-7 min-w-0 flex-1 text-xs";

function SnapshotRow(props: {
  config: DaytonaSandboxConfig;
  onConfigChange: (config: DaytonaSandboxConfig) => void;
  resources: DaytonaResources;
  disabled?: boolean;
}) {
  const { snapshots, snapshotsError, loadingSnapshots } = props.resources;
  const current = props.config.snapshot;
  // Keep a saved snapshot selectable even when the list failed or no longer has it.
  const options = current && !snapshots.includes(current) ? [current, ...snapshots] : snapshots;
  return (
    <>
      <div className={ROW_CLASS}>
        <label className={LABEL_CLASS}>Snapshot</label>
        {loadingSnapshots ? (
          <Loader2 className="text-muted h-4 w-4 animate-spin" />
        ) : (
          <Select
            value={current ?? DEFAULT_SNAPSHOT_VALUE}
            onValueChange={(value) =>
              props.onConfigChange({
                ...props.config,
                snapshot: value === DEFAULT_SNAPSHOT_VALUE ? undefined : value,
              })
            }
            disabled={props.disabled}
          >
            <SelectTrigger
              className={TRIGGER_CLASS}
              aria-label="Daytona snapshot"
              data-testid="daytona-snapshot-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_SNAPSHOT_VALUE}>Daytona default</SelectItem>
              {options.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {snapshotsError && (
        <p role="alert" className="text-xs break-words text-red-500">
          Could not list snapshots: {snapshotsError}
        </p>
      )}
    </>
  );
}

function SizeRow(props: {
  config: DaytonaSandboxConfig;
  onConfigChange: (config: DaytonaSandboxConfig) => void;
  disabled?: boolean;
}) {
  return (
    <div className={ROW_CLASS}>
      <label className={LABEL_CLASS}>Size</label>
      <Select
        value={getDaytonaSizePresetId(props.config)}
        onValueChange={(value) => props.onConfigChange(withDaytonaSizePreset(props.config, value))}
        disabled={props.disabled}
      >
        <SelectTrigger
          className={TRIGGER_CLASS}
          aria-label="Daytona size"
          data-testid="daytona-size-select"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DAYTONA_SIZE_PRESETS.map((preset) => (
            <SelectItem key={preset.id} value={preset.id}>
              {formatDaytonaSizePreset(preset)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The workspace-creation form. Mounted only while Daytona is the picked runtime, so the
 * snapshot list (an account API call) loads only then.
 */
export function DaytonaCreationForm(props: {
  config: DaytonaSandboxConfig;
  onConfigChange: (config: DaytonaSandboxConfig) => void;
  disabled?: boolean;
}) {
  const resources = useDaytonaResources();
  const ready = resources.config?.apiKeySet === true;

  return (
    <div
      className="border-border-medium flex w-full max-w-[22rem] flex-col gap-1.5 rounded-md border p-2"
      data-testid="daytona-sandbox-form"
    >
      {!ready ? (
        <DaytonaAccessNotice resources={resources} />
      ) : (
        <>
          <SnapshotRow
            config={props.config}
            onConfigChange={props.onConfigChange}
            resources={resources}
            disabled={props.disabled}
          />
          <SizeRow
            config={props.config}
            onConfigChange={props.onConfigChange}
            disabled={props.disabled}
          />
        </>
      )}
    </div>
  );
}
