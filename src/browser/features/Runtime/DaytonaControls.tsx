/**
 * Daytona sandbox controls for the SSH-based Daytona runtime: create a sandbox from a snapshot
 * at a size preset, or attach to an existing sandbox. Used by workspace creation and by the
 * project defaults in Settings > Runtimes.
 */
import { Loader2 } from "lucide-react";
import { cn } from "@/common/lib/utils";
import {
  DAYTONA_DEFAULT_SIZE_PRESET_ID,
  DAYTONA_SIZE_PRESETS,
  findDaytonaSizePreset,
  type DaytonaSizePreset,
  type DaytonaSizePresetId,
} from "@/common/constants/daytona";
import type { DaytonaSandboxConfig } from "@/common/orpc/schemas/daytona";
import { useDaytonaResources, type DaytonaResources } from "@/browser/hooks/useDaytonaResources";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";

// Radix Select reserves the empty string, so "use Daytona's default snapshot" needs a token.
const DEFAULT_SNAPSHOT_VALUE = "__daytona_default__";

type DaytonaMode = "new" | "existing";

/** Attaching (shared) is the only way a creation config names a sandbox up front. */
function getMode(config: DaytonaSandboxConfig): DaytonaMode {
  return config.shared === true ? "existing" : "new";
}

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

function ModeButton(props: {
  mode: DaytonaMode;
  active: boolean;
  disabled?: boolean;
  tooltip: string;
  onSelect: (mode: DaytonaMode) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => props.onSelect(props.mode)}
          disabled={props.disabled}
          className={cn(
            "rounded-md border px-2 py-1 text-xs transition-colors",
            props.active
              ? "border-accent bg-accent/20 text-foreground"
              : "border-transparent bg-transparent text-muted hover:border-border-medium"
          )}
          aria-pressed={props.active}
        >
          {props.mode === "new" ? "New" : "Existing"}
        </button>
      </TooltipTrigger>
      <TooltipContent>{props.tooltip}</TooltipContent>
    </Tooltip>
  );
}

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

function ExistingSandboxRow(props: {
  config: DaytonaSandboxConfig;
  onConfigChange: (config: DaytonaSandboxConfig) => void;
  resources: DaytonaResources;
  disabled?: boolean;
}) {
  const { sandboxes, sandboxesError, loadingSandboxes } = props.resources;
  const placeholder = sandboxesError
    ? "Error loading sandboxes"
    : sandboxes.length === 0
      ? "No sandboxes found"
      : "Select sandbox...";
  return (
    <>
      <div className={ROW_CLASS}>
        <label className={LABEL_CLASS}>Sandbox</label>
        {loadingSandboxes ? (
          <Loader2 className="text-muted h-4 w-4 animate-spin" />
        ) : (
          <Select
            value={props.config.sandboxId ?? ""}
            onValueChange={(sandboxId) => props.onConfigChange({ sandboxId, shared: true })}
            disabled={props.disabled === true || sandboxes.length === 0}
          >
            <SelectTrigger
              className={TRIGGER_CLASS}
              aria-label="Existing Daytona sandbox"
              data-testid="daytona-sandbox-select"
            >
              <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
              {sandboxes.map((sandbox) => (
                <SelectItem key={sandbox.id} value={sandbox.id}>
                  {sandbox.name || sandbox.id}
                  <span className="text-muted ml-1">({sandbox.state})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {sandboxesError && (
        <p role="alert" className="text-xs break-words text-red-500">
          Could not list sandboxes: {sandboxesError}
        </p>
      )}
    </>
  );
}

export interface DaytonaSandboxFormProps {
  config: DaytonaSandboxConfig;
  onConfigChange: (config: DaytonaSandboxConfig) => void;
  resources: DaytonaResources;
  /** Creation only: attach to an existing sandbox. Project defaults always describe a new one. */
  allowExisting: boolean;
  disabled?: boolean;
  hasError?: boolean;
  className?: string;
}

function DaytonaModeToggle(props: {
  config: DaytonaSandboxConfig;
  onConfigChange: (config: DaytonaSandboxConfig) => void;
  disabled?: boolean;
}) {
  const mode = getMode(props.config);
  const handleModeChange = (next: DaytonaMode) => {
    if (next === mode) return;
    // Existing starts unselected; New keeps nothing from the attached sandbox.
    props.onConfigChange(next === "existing" ? { shared: true } : {});
  };
  return (
    <div className="flex gap-1" role="group" aria-label="Daytona sandbox mode">
      <ModeButton
        mode="new"
        active={mode === "new"}
        disabled={props.disabled}
        tooltip="Create a new Daytona sandbox for this workspace"
        onSelect={handleModeChange}
      />
      <ModeButton
        mode="existing"
        active={mode === "existing"}
        disabled={props.disabled}
        tooltip="Use an existing Daytona sandbox (Xum never deletes it)"
        onSelect={handleModeChange}
      />
    </div>
  );
}

export function DaytonaSandboxForm(props: DaytonaSandboxFormProps) {
  const mode = props.allowExisting ? getMode(props.config) : "new";
  const ready = props.resources.config?.apiKeySet === true;

  return (
    <div
      className={cn(
        "flex w-full flex-col gap-1.5 rounded-md border p-2",
        props.className ?? "max-w-[22rem]",
        props.hasError === true ? "border-red-500" : "border-border-medium"
      )}
      data-testid="daytona-sandbox-form"
    >
      {!ready ? (
        <DaytonaAccessNotice resources={props.resources} />
      ) : (
        <>
          {props.allowExisting && (
            <DaytonaModeToggle
              config={props.config}
              onConfigChange={props.onConfigChange}
              disabled={props.disabled}
            />
          )}
          {mode === "new" ? (
            <>
              <SnapshotRow
                config={props.config}
                onConfigChange={props.onConfigChange}
                resources={props.resources}
                disabled={props.disabled}
              />
              <SizeRow
                config={props.config}
                onConfigChange={props.onConfigChange}
                disabled={props.disabled}
              />
            </>
          ) : (
            <ExistingSandboxRow
              config={props.config}
              onConfigChange={props.onConfigChange}
              resources={props.resources}
              disabled={props.disabled}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The workspace-creation form. Mounted only while Daytona is the picked runtime, so the
 * snapshot and sandbox lists (account API calls) load only then.
 */
export function DaytonaCreationForm(
  props: Omit<DaytonaSandboxFormProps, "resources" | "allowExisting">
) {
  const resources = useDaytonaResources({ enabled: true, loadSandboxes: true });
  return <DaytonaSandboxForm {...props} resources={resources} allowExisting />;
}
