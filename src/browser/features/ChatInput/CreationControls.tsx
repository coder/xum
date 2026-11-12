import React, { useCallback, useEffect } from "react";
import {
  buildRuntimeConfig,
  normalizeRuntimeEnablement,
  RUNTIME_MODE,
  sshNoneRuntimeOf,
  type CoderWorkspaceConfig,
  type ParsedRuntime,
  type RuntimeEnablement,
  CODER_RUNTIME_PLACEHOLDER,
} from "@/common/types/runtime";
import type { RuntimeAvailabilityMap, RuntimeAvailabilityState } from "./useCreationWorkspace";
import {
  resolveDevcontainerSelection,
  DEFAULT_DEVCONTAINER_CONFIG_PATH,
} from "@/browser/utils/devcontainerSelection";
import {
  Select as RadixSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { Loader2, Wand2 } from "lucide-react";
import type { ProjectConfig } from "@/common/types/project";
import { CreationEnvironmentPanel, type IsolationSelectOption } from "./CreationEnvironmentPanel";
import {
  describeEnvironment,
  environmentUsesBaseBranch,
  summarizeEnvironment,
  type EnvironmentSummaryInput,
  type RuntimeFieldError,
} from "./creationEnvironmentSummary";
import { CreationProjectSelect } from "./CreationProjectSelect";
import { SetDefaultIsolationButton, useSetDefaultIsolation } from "./SetDefaultIsolationButton";
import { SshDirectoryTrustNotice } from "./SshDirectoryTrustNotice";
import { SshHostSuggestions } from "./SshHostSuggestions";
import { RuntimeConfigInput } from "@/browser/components/RuntimeConfigInput/RuntimeConfigInput";
import { usePerfRenderMarker } from "@/browser/utils/perf/PerfRenderMarker";
import { KEYBINDS } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";
import { formatNameGenerationError } from "@/common/utils/errors/formatNameGenerationError";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { Skeleton } from "@/browser/components/Skeleton/Skeleton";
import type { BranchLoadStatus } from "./branchListLoad";
import { DocsLink } from "@/browser/components/DocsLink/DocsLink";
import {
  PROJECT_ISOLATION_UI,
  RUNTIME_OPTION_FIELDS,
  WORKSPACE_ISOLATION_UI,
  type RuntimeChoice,
} from "@/browser/utils/runtimeUi";
import {
  PROJECT_ISOLATIONS,
  WORKSPACE_ISOLATIONS,
  getUnsupportedIsolationReason,
  isolationEquals,
  isolationFromRuntimeConfig,
  isolationFromRuntimeId,
  isProjectIsolationEnabled,
  isWorkspaceIsolationEnabled,
  nearestSupportedIsolation,
  resolveEnabledIsolation,
  runtimeIdFromIsolation,
  type IsolationChoice,
  type ProjectIsolation,
  type WorkspaceIsolation,
} from "@/common/types/isolation";

import type { WorkspaceNameState, WorkspaceNameUIError } from "@/browser/hooks/useWorkspaceName";
import type { CoderInfo } from "@/common/orpc/schemas/coder";
import {
  CoderAvailabilityMessage,
  CoderWorkspaceForm,
  resolveCoderAvailability,
  type CoderAvailabilityState,
  type CoderControlsProps,
} from "../Runtime/CoderControls";

/** A field inside the environment panel: label above, input as wide as its column. */
const PANEL_FIELD_INPUT_CLASSES = "w-full";

/** Credential sharing checkbox - used by Docker and Devcontainer runtimes */
function CredentialSharingCheckbox(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  docsPath: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        disabled={props.disabled}
        className="accent-accent"
      />
      <span className="text-muted">Share credentials (SSH, Git)</span>
      <DocsLink path={props.docsPath} />
    </label>
  );
}

function NameErrorDisplay(props: { error: Extract<WorkspaceNameUIError, { kind: "generation" }> }) {
  const formatted = formatNameGenerationError(props.error.error);
  return (
    <div className="text-primary rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs">
      <div className="font-medium">{formatted.title}</div>
      <div>{formatted.message}</div>
      {formatted.hint && <div className="text-secondary mt-1">Fix: {formatted.hint}</div>}
      {formatted.docsPath && (
        <DocsLink path={formatted.docsPath} className="mt-1 text-xs">
          Troubleshooting
        </DocsLink>
      )}
    </div>
  );
}

export type { RuntimeFieldError };

/** Order to fall back through when the current pair is disabled or unavailable. */
const RUNTIME_FALLBACK_ORDER: RuntimeChoice[] = [
  RUNTIME_MODE.WORKTREE,
  RUNTIME_MODE.LOCAL,
  RUNTIME_MODE.SSH,
  "coder",
  RUNTIME_MODE.DOCKER,
  RUNTIME_MODE.DEVCONTAINER,
];

interface CreationControlsProps {
  branches: string[];
  /** Where the branch list stands; only a loaded empty list means a non-git repo (#6055). */
  branchLoad: BranchLoadStatus;
  /** The repository's default branch, tagged "default" in the branch list. */
  defaultBranch?: string | null;
  /** The branches committed to most recently, listed under the default. */
  recentBranches?: string[];
  /** Loads the branch list again after a failed load. */
  onReloadBranches?: () => void;
  trunkBranch: string;
  onTrunkBranchChange: (branch: string) => void;
  /** Currently selected runtime (discriminated union: SSH has host, Docker has image) */
  selectedRuntime: ParsedRuntime;
  /** Fallback Coder config to restore prior selections. */
  coderConfigFallback: CoderWorkspaceConfig;
  /** Fallback SSH host to restore when leaving Coder. */
  sshHostFallback: string;
  /** Set the currently selected runtime (discriminated union) */
  onSelectedRuntimeChange: (runtime: ParsedRuntime) => void;
  disabled: boolean;
  /** Owning project path used for runtime/settings scoping (always the parent). */
  projectPath: string;
  /**
   * Path of the project actually selected by the user. May be a sub-project
   * even when {@link projectPath} is its parent, since workspace creation is
   * always owned by the top-level parent. Used for the dropdown's selected
   * value/label so sub-projects render correctly. Falls back to
   * {@link projectPath} when omitted.
   */
  selectedProjectPath?: string;
  /** Stable project data passed by ChatInput so typing does not subscribe this form to broad contexts. */
  userProjects: Map<string, ProjectConfig>;
  onSelectedProjectPathChange: (path: string) => void;
  /** The project waits for a send, and for input the composer is still reading. */
  projectSelectDisabled: boolean;
  /** Project name to display as header */
  projectName: string;
  /** Workspace name/title generation state and actions */
  nameState: WorkspaceNameState;
  /** Runtime availability state for each mode */
  runtimeAvailabilityState: RuntimeAvailabilityState;
  /** Runtime enablement toggles from Settings (hide disabled runtimes). */
  runtimeEnablement?: RuntimeEnablement;
  /** Which runtime field (if any) is in error state for visual feedback */
  runtimeFieldError?: RuntimeFieldError | null;
  /** How many sends the runtime validation refused; each one reopens the environment panel. */
  runtimeFieldErrorAttempt?: number;

  /** Coder CLI availability info (null while checking) */
  coderInfo?: CoderInfo | null;
  /** Coder workspace controls props (optional - only rendered when provided) */
  coderProps?: Omit<CoderControlsProps, "disabled">;
}

/** What the isolation selects need to decide which options to show and enable. */
interface IsolationOptionContext {
  current: IsolationChoice;
  availabilityMap: RuntimeAvailabilityMap | null;
  runtimeAvailabilityState: RuntimeAvailabilityState;
  runtimeEnablement?: RuntimeEnablement;
  coderAvailability: CoderAvailabilityState;
}

/** Availability of the runtime behind a pair: explicit "unavailable" only (loading allows it). */
function runtimeUnavailableReason(
  choice: IsolationChoice,
  context: IsolationOptionContext
): string | null {
  if (choice.project === "coder" && context.coderAvailability.state !== "available") {
    return context.coderAvailability.reason ?? "Unavailable";
  }
  const runtimeId = runtimeIdFromIsolation(choice);
  if (runtimeId === null) {
    return getUnsupportedIsolationReason(choice);
  }
  // SSH availability reports on the local repo the worktree pair syncs from; SSH+None runs in an
  // existing directory on the host, so it has nothing to check here (the backend validates it).
  if (choice.project === "ssh" && choice.workspace === "none") {
    return null;
  }
  // Coder is SSH under the hood; every other choice is its own RuntimeMode.
  const availability = context.availabilityMap?.[runtimeId === "coder" ? "ssh" : runtimeId];
  return availability && !availability.available ? availability.reason : null;
}

export function buildProjectIsolationOptions(
  context: IsolationOptionContext
): Array<IsolationSelectOption<ProjectIsolation>> {
  return PROJECT_ISOLATIONS.filter((project) => {
    const isCurrent = project === context.current.project;
    // Match devcontainer UX: only surface Coder once availability is confirmed (no flash),
    // but keep it visible when already selected to avoid an empty selector.
    if (project === "coder" && !context.coderAvailability.shouldShowRuntimeButton && !isCurrent) {
      return false;
    }
    // User request: hide Settings-disabled options (selection auto-switches elsewhere), but keep
    // the active one visible so the user is never trapped without a replacement.
    return isCurrent || isProjectIsolationEnabled(context.runtimeEnablement, project);
  }).map((project) => ({
    value: project,
    ui: PROJECT_ISOLATION_UI[project],
    disabledReason: runtimeUnavailableReason(
      nearestSupportedIsolation({ project, workspace: context.current.workspace }),
      context
    ),
  }));
}

export function buildWorkspaceIsolationOptions(
  context: IsolationOptionContext
): Array<IsolationSelectOption<WorkspaceIsolation>> {
  const { availabilityMap, runtimeAvailabilityState } = context;
  const isDevcontainerMissing =
    availabilityMap?.devcontainer?.available === false &&
    availabilityMap.devcontainer.reason === "No devcontainer.json found";
  // Hide devcontainer while loading OR when confirmed missing, to avoid a layout flash for
  // projects without devcontainer.json (the common case).
  const hideDevcontainer = runtimeAvailabilityState.status === "loading" || isDevcontainerMissing;

  return WORKSPACE_ISOLATIONS.filter((workspace) => {
    const isCurrent = workspace === context.current.workspace;
    if (workspace === "devcontainer" && hideDevcontainer && !isCurrent) {
      return false;
    }
    return isCurrent || isWorkspaceIsolationEnabled(context.runtimeEnablement, workspace);
  }).map((workspace) => {
    const choice: IsolationChoice = { project: context.current.project, workspace };
    // The project select already explains Coder's unavailability (its CLI), so the workspace
    // select only reports what is specific to the pair. SSH availability is pair-specific: it
    // checks the local repo that SSH x Worktree syncs from, which SSH x None does not need, so a
    // non-git project keeps SSH x None and must not offer a Worktree pick the correction effect
    // would then move to Local.
    const disabledReason =
      getUnsupportedIsolationReason(choice) ??
      (choice.project !== "coder" ? runtimeUnavailableReason(choice, context) : null);
    return { value: workspace, ui: WORKSPACE_ISOLATION_UI[workspace], disabledReason };
  });
}

/**
 * Prominent controls shown above the input during workspace creation.
 * Displays project name as header, workspace name with magic wand, and the environment chip
 * (where it runs, isolation, base branch) that opens the environment panel.
 */
interface RuntimeChoiceContext {
  selectedRuntime: ParsedRuntime;
  sshHostFallback: string;
  coderConfigFallback: CoderWorkspaceConfig;
  runtimeAvailabilityState: RuntimeAvailabilityState;
}

/** The runtime each workspace-type pick switches to, keeping what was entered for that type. */
const RUNTIME_FOR_CHOICE: Record<RuntimeChoice, (context: RuntimeChoiceContext) => ParsedRuntime> =
  {
    // Switch to SSH mode with the last known Coder config so prior selections restore.
    coder: (context) => ({
      mode: "ssh",
      host: CODER_RUNTIME_PLACEHOLDER,
      coder: context.coderConfigFallback,
    }),
    [RUNTIME_MODE.SSH]: ({ selectedRuntime: current, sshHostFallback }) => ({
      mode: "ssh",
      host:
        current.mode === "ssh" && current.host !== CODER_RUNTIME_PLACEHOLDER
          ? current.host
          : sshHostFallback,
    }),
    [RUNTIME_MODE.DOCKER]: ({ selectedRuntime: current }) => ({
      mode: "docker",
      image: current.mode === "docker" ? current.image : "",
    }),
    [RUNTIME_MODE.DEVCONTAINER]: ({ selectedRuntime: current, runtimeAvailabilityState }) => {
      if (current.mode === "devcontainer") {
        return {
          mode: "devcontainer",
          configPath: current.configPath,
          shareCredentials: current.shareCredentials,
        };
      }
      // Use resolver to get initial config path (prefers first available config)
      const initialSelection = resolveDevcontainerSelection({
        selectedRuntime: { mode: "devcontainer", configPath: "" },
        availabilityState: runtimeAvailabilityState,
      });
      return {
        mode: "devcontainer",
        configPath: initialSelection.configPath,
        shareCredentials: false,
      };
    },
    [RUNTIME_MODE.LOCAL]: () => ({ mode: "local" }),
    [RUNTIME_MODE.WORKTREE]: () => ({ mode: "worktree" }),
  };

function buildRuntimeForChoice(
  choice: RuntimeChoice,
  context: RuntimeChoiceContext
): ParsedRuntime {
  return RUNTIME_FOR_CHOICE[choice](context);
}

/** The SSH+None directory a switch to SSH+None keeps. */
function nextSshNoneProjectDir(current: ParsedRuntime): string | undefined {
  const sshNone = sshNoneRuntimeOf(current);
  // Empty asks the draft settings to refill the project's remembered directory.
  return sshNone ? sshNone.projectDir : "";
}

/**
 * The runtime a pick in either isolation select switches to, or null when the pick cannot apply
 * (no runtime for the pair, or Coder without its controls). Either select changes one axis; an
 * unsupported pair snaps to the nearest one the project supports. The pair maps to a runtime
 * choice, so per-runtime inputs (host, image) carry over.
 */
export function runtimeForIsolationChoice(
  choice: IsolationChoice,
  context: {
    runtimeChoiceContext: RuntimeChoiceContext;
    runtimeEnablement: RuntimeEnablement | undefined;
    coderAvailable: boolean;
  }
): ParsedRuntime | null {
  // Same rule as the Settings default: skip pairs with no backend and pairs Settings disable,
  // keeping the picked project isolation when any of its pairs is enabled.
  const next =
    (context.runtimeEnablement
      ? resolveEnabledIsolation(choice, context.runtimeEnablement)
      : null) ?? nearestSupportedIsolation(choice);
  const runtimeId = runtimeIdFromIsolation(next);
  if (runtimeId === null || (runtimeId === "coder" && !context.coderAvailable)) {
    return null;
  }
  const runtime = buildRuntimeForChoice(runtimeId, context.runtimeChoiceContext);
  if (runtime.mode !== RUNTIME_MODE.SSH || next.workspace !== "none") {
    return runtime;
  }
  return {
    ...runtime,
    workspaceIsolation: "none",
    projectDir: nextSshNoneProjectDir(context.runtimeChoiceContext.selectedRuntime),
  };
}

/** The SSH+None selection with another directory on the host; the host and Coder stay. */
function withSshNoneProjectDir(
  runtime: Extract<ParsedRuntime, { mode: "ssh" }>,
  projectDir: string
): ParsedRuntime {
  return {
    mode: "ssh",
    host: runtime.host,
    coder: runtime.coder,
    workspaceIsolation: "none",
    projectDir,
  };
}

/** The trust row for the SSH+None directory being configured; nothing for other selections. */
function SshNoneDirectoryTrust(props: {
  runtime: Extract<ParsedRuntime, { mode: "ssh" }> | null;
  projectPath: string;
  userProjects: Map<string, ProjectConfig>;
  disabled: boolean;
  onSelectedRuntimeChange: (runtime: ParsedRuntime) => void;
}) {
  const runtime = props.runtime;
  if (runtime === null) return null;
  return (
    <SshDirectoryTrustNotice
      projectPath={props.projectPath}
      userProjects={props.userProjects}
      host={runtime.host}
      projectDir={runtime.projectDir ?? ""}
      disabled={props.disabled}
      onProjectDirResolved={(projectDir) =>
        props.onSelectedRuntimeChange(withSshNoneProjectDir(runtime, projectDir))
      }
    />
  );
}

/** SSH+None asks for the existing directory on the host that its workspaces run in. */
function SshNoneDirectoryInput(props: {
  runtime: Extract<ParsedRuntime, { mode: "ssh" }>;
  disabled: boolean;
  hasError: boolean;
  onSelectedRuntimeChange: (runtime: ParsedRuntime) => void;
}) {
  return (
    <RuntimeConfigInput
      id="ssh-project-dir"
      fieldSpec={RUNTIME_OPTION_FIELDS.sshProjectDir}
      value={props.runtime.projectDir ?? ""}
      onChange={(value) =>
        props.onSelectedRuntimeChange(withSshNoneProjectDir(props.runtime, value))
      }
      disabled={props.disabled}
      hasError={props.hasError}
      ariaLabel="Project directory on host"
      stacked
      inputClassName={PANEL_FIELD_INPUT_CLASSES}
    />
  );
}

/** The SSH host; hidden while Coder owns the SSH runtime or may be about to. */
function SshHostInput(props: {
  selectedRuntime: ParsedRuntime;
  isCoderSelected: boolean;
  coderProps: CreationControlsProps["coderProps"];
  disabled: boolean;
  hasError: boolean;
  onSelectedRuntimeChange: (runtime: ParsedRuntime) => void;
}) {
  const { selectedRuntime, coderProps } = props;
  if (selectedRuntime.mode !== "ssh" || props.isCoderSelected || coderProps?.enabled) return null;
  // Also hide when Coder is still checking but has saved config (will enable after check)
  if (coderProps?.coderInfo === null && coderProps?.coderConfig) return null;
  const setHost = (value: string) =>
    props.onSelectedRuntimeChange({
      mode: "ssh",
      host: value,
      workspaceIsolation: selectedRuntime.workspaceIsolation,
      projectDir: selectedRuntime.projectDir,
    });
  return (
    <>
      <RuntimeConfigInput
        id="ssh-host"
        fieldSpec={RUNTIME_OPTION_FIELDS.ssh}
        value={selectedRuntime.host}
        onChange={setHost}
        disabled={props.disabled}
        hasError={props.hasError}
        stacked
        inputClassName={PANEL_FIELD_INPUT_CLASSES}
      />
      <SshHostSuggestions typed={selectedRuntime.host} disabled={props.disabled} onPick={setHost} />
    </>
  );
}

/**
 * What the selected "Run on" option asks for, shown under its row in the environment panel: the
 * SSH host (and, without isolation, the directory), or the Coder workspace form.
 * These used to trail the sentence of selects; under the row they belong to, it is clear which
 * choice asks for them.
 */
function ProjectIsolationFields(props: {
  selectedRuntime: ParsedRuntime;
  sshNoneRuntime: Extract<ParsedRuntime, { mode: "ssh" }> | null;
  isCoderSelected: boolean;
  coderProps: CreationControlsProps["coderProps"];
  coderUsername: string | undefined;
  coderDeploymentUrl: string | undefined;
  disabled: boolean;
  runtimeFieldError: RuntimeFieldError | null;
  onSelectedRuntimeChange: (runtime: ParsedRuntime) => void;
}) {
  const { coderProps, onSelectedRuntimeChange } = props;
  return (
    <>
      <SshHostInput
        selectedRuntime={props.selectedRuntime}
        isCoderSelected={props.isCoderSelected}
        coderProps={coderProps}
        disabled={props.disabled}
        hasError={props.runtimeFieldError === "ssh"}
        onSelectedRuntimeChange={onSelectedRuntimeChange}
      />
      {props.sshNoneRuntime && (
        <SshNoneDirectoryInput
          runtime={props.sshNoneRuntime}
          disabled={props.disabled}
          hasError={props.runtimeFieldError === "sshProjectDir"}
          onSelectedRuntimeChange={onSelectedRuntimeChange}
        />
      )}
      {props.isCoderSelected && coderProps && (
        <div className="flex flex-col gap-1.5" data-testid="coder-controls">
          {/* Coder runtime needs availability status without the SSH-only toggle. */}
          <CoderAvailabilityMessage coderInfo={coderProps.coderInfo} />
          {coderProps.enabled && (
            <CoderWorkspaceForm
              className="w-full"
              coderConfig={coderProps.coderConfig}
              username={props.coderUsername}
              deploymentUrl={props.coderDeploymentUrl}
              onCoderConfigChange={coderProps.onCoderConfigChange}
              templates={coderProps.templates}
              templatesError={coderProps.templatesError}
              presets={coderProps.presets}
              presetsError={coderProps.presetsError}
              existingWorkspaces={coderProps.existingWorkspaces}
              workspacesError={coderProps.workspacesError}
              loadingTemplates={coderProps.loadingTemplates}
              loadingPresets={coderProps.loadingPresets}
              loadingWorkspaces={coderProps.loadingWorkspaces}
              disabled={props.disabled}
              hasError={props.runtimeFieldError === "ssh"}
            />
          )}
        </div>
      )}
    </>
  );
}

/** The dev container config: a skeleton while configs load, a select of them, or a path input. */
function DevcontainerConfigField(props: {
  selection: ReturnType<typeof resolveDevcontainerSelection>;
  shareCredentials: boolean | undefined;
  disabled: boolean;
  onSelectedRuntimeChange: (runtime: ParsedRuntime) => void;
}) {
  const { selection } = props;
  const setConfigPath = (configPath: string) =>
    props.onSelectedRuntimeChange({
      mode: "devcontainer",
      configPath,
      shareCredentials: props.shareCredentials,
    });
  if (selection.uiMode === "loading") {
    // Skeleton placeholder while loading - matches dropdown dimensions
    return <Skeleton className="h-6 w-full rounded-md" />;
  }
  if (selection.uiMode === "dropdown") {
    return (
      <RadixSelect
        value={selection.configPath}
        onValueChange={setConfigPath}
        disabled={props.disabled}
      >
        <SelectTrigger className="h-6 w-full text-xs" aria-label="Dev container config">
          <SelectValue placeholder="Select config" />
        </SelectTrigger>
        <SelectContent>
          {selection.configs.map((config) => (
            <SelectItem key={config.path} value={config.path}>
              {config.label}
            </SelectItem>
          ))}
        </SelectContent>
      </RadixSelect>
    );
  }
  return (
    <input
      type="text"
      value={selection.configPath}
      onChange={(e) => setConfigPath(e.target.value)}
      placeholder={DEFAULT_DEVCONTAINER_CONFIG_PATH}
      disabled={props.disabled}
      className="bg-bg-dark text-foreground border-border-medium focus:border-accent h-7 w-full rounded-md border px-2 text-xs focus:outline-none disabled:opacity-50"
      aria-label="Dev container config path"
    />
  );
}

/** The Docker image and credential sharing, under the Docker row. */
function DockerFields(props: {
  selectedRuntime: Extract<ParsedRuntime, { mode: "docker" }>;
  disabled: boolean;
  hasError: boolean;
  onSelectedRuntimeChange: (runtime: ParsedRuntime) => void;
}) {
  const { selectedRuntime, onSelectedRuntimeChange } = props;
  return (
    <>
      <RuntimeConfigInput
        fieldSpec={RUNTIME_OPTION_FIELDS.docker}
        value={selectedRuntime.image}
        onChange={(value) =>
          onSelectedRuntimeChange({
            mode: "docker",
            image: value,
            shareCredentials: selectedRuntime.shareCredentials,
          })
        }
        disabled={props.disabled}
        hasError={props.hasError}
        id="docker-image"
        ariaLabel="Docker image"
        stacked
        inputClassName={PANEL_FIELD_INPUT_CLASSES}
      />
      <CredentialSharingCheckbox
        checked={selectedRuntime.shareCredentials ?? false}
        onChange={(checked) =>
          onSelectedRuntimeChange({
            mode: "docker",
            image: selectedRuntime.image,
            shareCredentials: checked,
          })
        }
        disabled={props.disabled}
        docsPath="/runtime/docker#credential-sharing"
      />
    </>
  );
}

/** The dev container config and credential sharing, under the Dev container row. */
function DevcontainerFields(props: {
  selectedRuntime: Extract<ParsedRuntime, { mode: "devcontainer" }>;
  devcontainerSelection: ReturnType<typeof resolveDevcontainerSelection>;
  disabled: boolean;
  onSelectedRuntimeChange: (runtime: ParsedRuntime) => void;
}) {
  const { selectedRuntime, devcontainerSelection, onSelectedRuntimeChange } = props;
  return (
    <>
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs font-medium">
          {RUNTIME_OPTION_FIELDS.devcontainer.label}
        </span>
        <DevcontainerConfigField
          selection={devcontainerSelection}
          shareCredentials={selectedRuntime.shareCredentials}
          disabled={props.disabled}
          onSelectedRuntimeChange={onSelectedRuntimeChange}
        />
      </div>
      {devcontainerSelection.helperText && (
        <p className="text-muted-foreground text-xs">{devcontainerSelection.helperText}</p>
      )}
      <CredentialSharingCheckbox
        checked={selectedRuntime.shareCredentials ?? false}
        onChange={(checked) =>
          onSelectedRuntimeChange({
            mode: "devcontainer",
            configPath: devcontainerSelection.configPath,
            shareCredentials: checked,
          })
        }
        disabled={props.disabled}
        docsPath="/runtime/docker#credential-sharing"
      />
    </>
  );
}

/**
 * What the selected isolation asks for, shown under its row in the environment panel; null when
 * it asks for nothing, so the row gets no empty block below it.
 */
function workspaceIsolationFields(input: {
  selectedRuntime: ParsedRuntime;
  devcontainerSelection: ReturnType<typeof resolveDevcontainerSelection>;
  disabled: boolean;
  runtimeFieldError: RuntimeFieldError | null;
  onSelectedRuntimeChange: (runtime: ParsedRuntime) => void;
}): React.ReactNode {
  const { selectedRuntime } = input;
  if (selectedRuntime.mode === "docker") {
    return (
      <DockerFields
        selectedRuntime={selectedRuntime}
        disabled={input.disabled}
        hasError={input.runtimeFieldError === "docker"}
        onSelectedRuntimeChange={input.onSelectedRuntimeChange}
      />
    );
  }
  if (selectedRuntime.mode === "devcontainer" && input.devcontainerSelection.uiMode !== "hidden") {
    return (
      <DevcontainerFields
        selectedRuntime={selectedRuntime}
        devcontainerSelection={input.devcontainerSelection}
        disabled={input.disabled}
        onSelectedRuntimeChange={input.onSelectedRuntimeChange}
      />
    );
  }
  return null;
}

function CreationControlsContent(props: CreationControlsProps) {
  usePerfRenderMarker("chat-input.creation-controls");
  const { nameState, runtimeAvailabilityState } = props;

  const { selectedRuntime, onSelectedRuntimeChange } = props;
  // Coder is surfaced as its own project isolation while keeping SSH as the config mode.
  const isCoderSelected =
    selectedRuntime.mode === RUNTIME_MODE.SSH && selectedRuntime.coder != null;
  // The two-axis view of the selection; ParsedRuntime stays the source of truth.
  const currentIsolation = isolationFromRuntimeConfig(buildRuntimeConfig(selectedRuntime));
  const sshNoneRuntime = sshNoneRuntimeOf(selectedRuntime);
  const runtimeChoiceContext: RuntimeChoiceContext = {
    selectedRuntime,
    sshHostFallback: props.sshHostFallback,
    coderConfigFallback: props.coderConfigFallback,
    runtimeAvailabilityState,
  };
  const coderInfo = props.coderInfo ?? props.coderProps?.coderInfo ?? null;
  const coderAvailability = resolveCoderAvailability(coderInfo);
  const isCoderAvailable = coderAvailability.state === "available";
  const coderUsername = coderInfo?.state === "available" ? coderInfo.username : undefined;
  const coderDeploymentUrl = coderInfo?.state === "available" ? coderInfo.url : undefined;

  const availabilityMap =
    runtimeAvailabilityState.status === "loaded" ? runtimeAvailabilityState.data : null;

  // Centralized devcontainer selection logic
  const devcontainerSelection = resolveDevcontainerSelection({
    selectedRuntime,
    availabilityState: runtimeAvailabilityState,
  });

  const isDevcontainerMissing =
    availabilityMap?.devcontainer?.available === false &&
    availabilityMap.devcontainer.reason === "No devcontainer.json found";

  // Check if git is required (worktree unavailable due to git or no branches)
  const isNonGitRepo =
    (availabilityMap?.worktree?.available === false &&
      availabilityMap.worktree.reason === "Requires git repository") ||
    (props.branchLoad === "loaded" && props.branches.length === 0);

  const branchOptions =
    props.trunkBranch && !props.branches.includes(props.trunkBranch)
      ? [props.trunkBranch, ...props.branches]
      : props.branches;

  // Keep selected runtime aligned with availability + Settings enablement constraints.
  // All constraint checks (non-git, devcontainer missing, enablement) are unified
  // into a single firstEnabled fallback so every edge combination is handled consistently.
  useEffect(() => {
    const runtimeEnablement = props.runtimeEnablement;

    // Determine if the current selection needs correction. Either axis can be disabled.
    const isCurrentDisabledBySettings =
      !isProjectIsolationEnabled(runtimeEnablement, currentIsolation.project) ||
      !isWorkspaceIsolationEnabled(runtimeEnablement, currentIsolation.workspace);
    // In non-git repos every pair that builds a checkout from the local repo is unavailable. The
    // pairs with no isolation (Local and SSH+None) run in an existing directory and need no git.
    const isCurrentUnavailable =
      (isNonGitRepo && currentIsolation.workspace !== "none") ||
      (isDevcontainerMissing && selectedRuntime.mode === RUNTIME_MODE.DEVCONTAINER);

    if (!isCurrentDisabledBySettings && !isCurrentUnavailable) {
      return;
    }

    const firstEnabled = RUNTIME_FALLBACK_ORDER.find((mode) => {
      const candidate = isolationFromRuntimeId(mode);
      if (
        !isProjectIsolationEnabled(runtimeEnablement, candidate.project) ||
        !isWorkspaceIsolationEnabled(runtimeEnablement, candidate.workspace)
      ) {
        return false;
      }
      if (mode === "coder") {
        if (!props.coderProps) {
          return false;
        }
        if (!isCoderAvailable) {
          return false;
        }
      }
      // Filter by availability to avoid selecting unavailable runtimes (e.g., Docker
      // when daemon is down, devcontainer when config missing, non-git projects).
      if (isDevcontainerMissing && mode === RUNTIME_MODE.DEVCONTAINER) {
        return false;
      }
      if (isNonGitRepo && mode !== RUNTIME_MODE.LOCAL) {
        return false;
      }
      // Check the general availability map for any other unavailable runtimes.
      if (mode !== "coder") {
        const avail = availabilityMap?.[mode];
        if (avail !== undefined && !avail.available) {
          return false;
        }
      }
      return true;
    });
    if (!firstEnabled || isolationEquals(isolationFromRuntimeId(firstEnabled), currentIsolation)) {
      return;
    }

    // User request: auto-switch away from Settings-disabled runtimes.
    // The context is rebuilt here so the effect depends on its fields, not a per-render object.
    onSelectedRuntimeChange(
      buildRuntimeForChoice(firstEnabled, {
        selectedRuntime,
        sshHostFallback: props.sshHostFallback,
        coderConfigFallback: props.coderConfigFallback,
        runtimeAvailabilityState,
      })
    );
  }, [
    isDevcontainerMissing,
    isNonGitRepo,
    onSelectedRuntimeChange,
    props.coderProps,
    props.runtimeEnablement,
    props.sshHostFallback,
    props.coderConfigFallback,
    runtimeAvailabilityState,
    availabilityMap,
    currentIsolation,
    selectedRuntime,
    isCoderAvailable,
  ]);

  const isolationOptionContext: IsolationOptionContext = {
    current: currentIsolation,
    availabilityMap,
    runtimeAvailabilityState,
    runtimeEnablement: props.runtimeEnablement,
    coderAvailability,
  };
  const projectIsolationOptions = buildProjectIsolationOptions(isolationOptionContext);
  const workspaceIsolationOptions = buildWorkspaceIsolationOptions(isolationOptionContext);

  const fieldError = props.runtimeFieldError ?? null;
  const environmentInput: EnvironmentSummaryInput = {
    selectedRuntime,
    isolation: currentIsolation,
    trunkBranch: props.trunkBranch,
    branchLoad: props.branchLoad,
    isNonGitRepo,
    fieldError,
  };
  const defaultSaver = useSetDefaultIsolation({
    projectPath: props.projectPath,
    isolation: currentIsolation,
    disabled: props.disabled,
    rememberShownFields: () => onSelectedRuntimeChange(selectedRuntime),
  });
  const selectIsolation = (choice: IsolationChoice) => {
    const runtime = runtimeForIsolationChoice(choice, {
      runtimeChoiceContext,
      runtimeEnablement: props.runtimeEnablement,
      coderAvailable: props.coderProps != null,
    });
    if (runtime !== null) {
      onSelectedRuntimeChange(runtime);
    }
  };

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      nameState.setName(e.target.value);
    },
    [nameState]
  );

  // Clicking into the input disables auto-generation so user can edit
  const handleInputFocus = useCallback(() => {
    if (nameState.autoGenerate) {
      nameState.setAutoGenerate(false);
    }
  }, [nameState]);

  // Toggle auto-generation via wand button
  const handleWandClick = useCallback(() => {
    nameState.setAutoGenerate(!nameState.autoGenerate);
  }, [nameState]);

  const nameTooltipError =
    nameState.error?.kind === "validation" || nameState.error?.kind === "transport"
      ? nameState.error
      : null;

  return (
    <div className="mb-3 flex flex-col gap-4">
      <div
        className={cn("flex gap-y-2", nameState.error ? "items-start" : "items-center")}
        data-component="WorkspaceNameGroup"
      >
        {(() => {
          // Reflect the actual project the user picked (possibly a sub-project)
          // even though workspace creation is owned by the parent — otherwise
          // selecting "gbot/bbot" would show "gbot" because props.projectPath
          // is normalized to the owning parent for runtime/config scoping.
          const selected = props.selectedProjectPath ?? props.projectPath;
          return (
            <CreationProjectSelect
              selected={selected}
              userProjects={props.userProjects}
              onChange={props.onSelectedProjectPathChange}
              disabled={props.projectSelectDisabled}
            />
          );
        })()}
        <span className="text-muted-foreground mx-2 text-lg">/</span>

        {/* Keep generation errors stacked with the name field so remediation appears directly below it. */}
        <div className="flex min-w-0 flex-col gap-1" data-component="WorkspaceNameInputBlock">
          {/* Name input with magic wand */}
          <div className="flex items-center gap-1">
            <Tooltip open={nameTooltipError ? true : undefined}>
              <TooltipTrigger asChild>
                <input
                  id="workspace-name"
                  type="text"
                  // The placeholder changes with auto-naming, so it cannot be the field's name.
                  aria-label="Workspace name"
                  value={nameState.name}
                  onChange={handleNameChange}
                  onFocus={handleInputFocus}
                  placeholder={
                    nameState.isGenerating
                      ? "Generating..."
                      : nameState.autoGenerate
                        ? "Automatic on Send"
                        : "workspace-name"
                  }
                  disabled={props.disabled}
                  aria-invalid={nameState.error ? true : undefined}
                  className={cn(
                    `border-border-medium focus:border-accent h-7 rounded-md
                     border border-transparent bg-transparent text-lg font-semibold 
                     field-sizing-content focus:border focus:bg-bg-dark focus:outline-none 
                     disabled:opacity-50 max-w-[50vw] sm:max-w-[40vw] lg:max-w-[30vw]`,
                    nameState.autoGenerate ? "text-muted" : "text-foreground",
                    // focus:border-red-500 keeps the error border visible while typing;
                    // focus:border-accent would otherwise override it.
                    nameState.error && "border-red-500 focus:border-red-500"
                  )}
                />
              </TooltipTrigger>
              <TooltipContent
                align="start"
                className={cn("max-w-64", nameTooltipError && "border-red-500/40 text-red-500")}
              >
                {nameTooltipError ? (
                  nameTooltipError.message
                ) : (
                  <>
                    Use lowercase letters, numbers, hyphens, underscores, and the <code>/</code>
                    separator. Slashes in git branches map to hyphens in folder and workspace names.
                  </>
                )}
              </TooltipContent>
            </Tooltip>
            {/* Magic wand / loading indicator */}
            {nameState.isGenerating ? (
              <Loader2 className="text-accent-text h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleWandClick}
                    disabled={props.disabled}
                    className="flex shrink-0 items-center disabled:opacity-50"
                    aria-label={
                      nameState.autoGenerate ? "Disable auto-naming" : "Enable auto-naming"
                    }
                  >
                    <Wand2
                      className={cn(
                        "h-3.5 w-3.5 transition-colors",
                        nameState.autoGenerate
                          ? "text-accent-text"
                          : "text-muted-foreground opacity-50 hover:opacity-75"
                      )}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent align="center">
                  {nameState.autoGenerate ? "Auto-naming enabled" : "Click to enable auto-naming"}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          {nameState.error?.kind === "generation" && <NameErrorDisplay error={nameState.error} />}
        </div>
      </div>

      <div
        className="flex min-w-0 flex-col gap-1.5"
        data-component="RuntimeTypeGroup"
        // Tests and stories wait on this the way a user waits for the branch to appear.
        data-branch-load={props.branchLoad}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
          <CreationEnvironmentPanel
            summary={summarizeEnvironment(environmentInput)}
            description={describeEnvironment(environmentInput)}
            disabled={props.disabled}
            isolation={currentIsolation}
            projectOptions={projectIsolationOptions}
            workspaceOptions={workspaceIsolationOptions}
            onSelectIsolation={selectIsolation}
            projectFields={
              currentIsolation.project === "local" ? null : (
                <ProjectIsolationFields
                  selectedRuntime={selectedRuntime}
                  sshNoneRuntime={sshNoneRuntime}
                  isCoderSelected={isCoderSelected}
                  coderProps={props.coderProps}
                  coderUsername={coderUsername}
                  coderDeploymentUrl={coderDeploymentUrl}
                  disabled={props.disabled}
                  runtimeFieldError={fieldError}
                  onSelectedRuntimeChange={onSelectedRuntimeChange}
                />
              )
            }
            workspaceFields={workspaceIsolationFields({
              selectedRuntime,
              devcontainerSelection,
              disabled: props.disabled,
              runtimeFieldError: fieldError,
              onSelectedRuntimeChange,
            })}
            branch={
              environmentUsesBaseBranch(environmentInput)
                ? {
                    load: props.branchLoad,
                    options: branchOptions,
                    selected: props.trunkBranch,
                    defaultBranch: props.defaultBranch ?? null,
                    recentBranches: props.recentBranches ?? [],
                    onRetry: props.onReloadBranches ?? (() => undefined),
                    onSelect: props.onTrunkBranchChange,
                  }
                : null
            }
            fieldError={fieldError}
            fieldErrorAttempt={props.runtimeFieldErrorAttempt ?? 0}
            footerAction={<SetDefaultIsolationButton saver={defaultSaver} />}
            footerShortcut={
              defaultSaver.canSave
                ? { keybind: KEYBINDS.SET_DEFAULT_ISOLATION, run: () => void defaultSaver.save() }
                : null
            }
          />
        </div>

        {/* A failed save from the shortcut has no open panel to report in. */}
        {defaultSaver.error !== null && (
          <span role="alert" className="text-error text-xs">
            {defaultSaver.error}
          </span>
        )}

        {/* The directory's trust stays on the page, under the chip, not inside the panel: its
            pending and error state must survive the panel closing, and the trust state stands
            out on its own row. */}
        <SshNoneDirectoryTrust
          runtime={sshNoneRuntime}
          projectPath={props.projectPath}
          userProjects={props.userProjects}
          disabled={props.disabled}
          onSelectedRuntimeChange={onSelectedRuntimeChange}
        />
      </div>
    </div>
  );
}

// ChatInput is not currently compiler-eligible because of its async control flow,
// so keep this small wrapper compiler-friendly and pass every dependency explicitly.
// React Compiler then retains the expensive control tree while draft text changes.
export function CreationControls(props: CreationControlsProps) {
  const coderEnabled = props.coderProps?.enabled;
  const coderOnEnabledChange = props.coderProps?.onEnabledChange;
  const coderInfo = props.coderProps?.coderInfo;
  const coderConfig = props.coderProps?.coderConfig;
  const coderOnConfigChange = props.coderProps?.onCoderConfigChange;
  const coderTemplates = props.coderProps?.templates;
  const coderTemplatesError = props.coderProps?.templatesError;
  const coderPresets = props.coderProps?.presets;
  const coderPresetsError = props.coderProps?.presetsError;
  const coderExistingWorkspaces = props.coderProps?.existingWorkspaces;
  const coderWorkspacesError = props.coderProps?.workspacesError;
  const coderLoadingTemplates = props.coderProps?.loadingTemplates;
  const coderLoadingPresets = props.coderProps?.loadingPresets;
  const coderLoadingWorkspaces = props.coderProps?.loadingWorkspaces;
  const hasCoderProps = props.coderProps != null;
  const coderProps = !hasCoderProps
    ? undefined
    : {
        enabled: coderEnabled ?? false,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
        onEnabledChange: coderOnEnabledChange!,
        coderInfo: coderInfo ?? null,
        coderConfig: coderConfig ?? null,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
        onCoderConfigChange: coderOnConfigChange!,
        templates: coderTemplates ?? [],
        templatesError: coderTemplatesError ?? null,
        presets: coderPresets ?? [],
        presetsError: coderPresetsError ?? null,
        existingWorkspaces: coderExistingWorkspaces ?? [],
        workspacesError: coderWorkspacesError ?? null,
        loadingTemplates: coderLoadingTemplates ?? false,
        loadingPresets: coderLoadingPresets ?? false,
        loadingWorkspaces: coderLoadingWorkspaces ?? false,
      };
  const runtimeLocal = props.runtimeEnablement?.local;
  const runtimeWorktree = props.runtimeEnablement?.worktree;
  const runtimeSsh = props.runtimeEnablement?.ssh;
  const runtimeCoder = props.runtimeEnablement?.coder;
  const runtimeDocker = props.runtimeEnablement?.docker;
  const runtimeDevcontainer = props.runtimeEnablement?.devcontainer;
  const hasRuntimeEnablement = props.runtimeEnablement != null;
  const runtimeEnablement = !hasRuntimeEnablement
    ? undefined
    : // Rebuilt from primitives so a fresh-but-equal prop object keeps the memoized value;
      // missing keys default to enabled.
      normalizeRuntimeEnablement({
        local: runtimeLocal,
        worktree: runtimeWorktree,
        ssh: runtimeSsh,
        coder: runtimeCoder,
        docker: runtimeDocker,
        devcontainer: runtimeDevcontainer,
      });
  const nameState = {
    name: props.nameState.name,
    title: props.nameState.title,
    isGenerating: props.nameState.isGenerating,
    autoGenerate: props.nameState.autoGenerate,
    error: props.nameState.error,
    setAutoGenerate: props.nameState.setAutoGenerate,
    setName: props.nameState.setName,
  };

  return (
    <CreationControlsContent
      branches={props.branches}
      branchLoad={props.branchLoad}
      defaultBranch={props.defaultBranch}
      recentBranches={props.recentBranches}
      onReloadBranches={props.onReloadBranches}
      trunkBranch={props.trunkBranch}
      onTrunkBranchChange={props.onTrunkBranchChange}
      selectedRuntime={props.selectedRuntime}
      coderConfigFallback={props.coderConfigFallback}
      sshHostFallback={props.sshHostFallback}
      onSelectedRuntimeChange={props.onSelectedRuntimeChange}
      disabled={props.disabled}
      projectPath={props.projectPath}
      selectedProjectPath={props.selectedProjectPath}
      userProjects={props.userProjects}
      onSelectedProjectPathChange={props.onSelectedProjectPathChange}
      projectSelectDisabled={props.projectSelectDisabled}
      projectName={props.projectName}
      nameState={nameState}
      runtimeAvailabilityState={props.runtimeAvailabilityState}
      runtimeEnablement={runtimeEnablement}
      runtimeFieldError={props.runtimeFieldError}
      runtimeFieldErrorAttempt={props.runtimeFieldErrorAttempt}
      coderInfo={props.coderInfo}
      coderProps={coderProps}
    />
  );
}
