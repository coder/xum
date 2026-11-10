import React, { useCallback, useEffect } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import {
  buildRuntimeConfig,
  normalizeRuntimeEnablement,
  RUNTIME_MODE,
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
import { GitBranch, Loader2, Wand2 } from "lucide-react";
import type { ProjectConfig } from "@/common/types/project";
import { CreationProjectSelect } from "./CreationProjectSelect";
import { SshDirectoryTrustNotice } from "./SshDirectoryTrustNotice";
import { RuntimeConfigInput } from "@/browser/components/RuntimeConfigInput/RuntimeConfigInput";
import { usePerfRenderMarker } from "@/browser/utils/perf/PerfRenderMarker";
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
  type IsolationOptionUi,
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

/**
 * Shared styling for inline form controls in the creation UI.
 * Used by both Select and text inputs to ensure visual consistency.
 * Fixed width ensures Select (with chevron) and text inputs render identically.
 */
const INLINE_CONTROL_CLASSES =
  "h-7 w-[140px] rounded border border-border-light bg-transparent px-2 text-xs text-foreground focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

const SENTENCE_CLAUSE_CLASSES = "flex w-full min-w-0 items-center gap-2 md:w-auto";

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

/** The creation input that failed validation: Docker image, SSH host, or SSH+None directory. */
export type RuntimeFieldError = "docker" | "ssh" | "sshProjectDir";

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

  /** Coder CLI availability info (null while checking) */
  coderInfo?: CoderInfo | null;
  /** Coder workspace controls props (optional - only rendered when provided) */
  coderProps?: Omit<CoderControlsProps, "disabled">;
}

/** One option on an isolation axis, with its UI and why it cannot be picked (if it cannot). */
interface IsolationSelectOption<T extends string> {
  value: T;
  ui: IsolationOptionUi;
  disabledReason: string | null;
}

/** A select for one isolation axis (project or workspace). */
function IsolationSelect<T extends string>(props: {
  ariaLabel: string;
  placeholder: string;
  value: T;
  options: Array<IsolationSelectOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const selectedOption =
    props.options.find((option) => option.value === props.value) ?? props.options[0] ?? null;

  return (
    <RadixSelect
      value={selectedOption?.value}
      onValueChange={(value) => {
        const nextOption = props.options.find((option) => option.value === value);
        if (nextOption) {
          props.onChange(nextOption.value);
        }
      }}
      disabled={Boolean(props.disabled) || props.options.length === 0}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <SelectTrigger
            aria-label={props.ariaLabel}
            className={cn(
              "h-7 w-full justify-between gap-2 rounded-md border px-2.5 text-xs font-medium shadow-none md:w-[148px]",
              selectedOption?.ui.triggerClass
            )}
          >
            {selectedOption ? (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <selectedOption.ui.Icon
                  size={12}
                  className={cn("shrink-0", selectedOption.ui.iconClass)}
                />
                <span className="truncate">{selectedOption.ui.label}</span>
              </div>
            ) : (
              <SelectValue placeholder={props.placeholder} />
            )}
          </SelectTrigger>
        </TooltipTrigger>
        {selectedOption ? (
          <TooltipContent align="start" className="max-w-56">
            <div className="flex items-start justify-between gap-3">
              <span className="block max-w-[170px] text-xs leading-snug whitespace-normal">
                {selectedOption.ui.description}
              </span>
              <DocsLink path={selectedOption.ui.docsPath} />
            </div>
            {selectedOption.disabledReason ? (
              <p className="mt-1 text-yellow-500">{selectedOption.disabledReason}</p>
            ) : null}
          </TooltipContent>
        ) : null}
      </Tooltip>
      <SelectContent className="border-border-medium w-[232px]">
        {props.options.map((option) => {
          const Icon = option.ui.Icon;
          return (
            <SelectPrimitive.Item
              key={option.value}
              value={option.value}
              disabled={Boolean(props.disabled) || option.disabledReason !== null}
              className={cn(
                "focus:bg-hover data-[state=checked]:bg-hover relative flex cursor-default select-none items-center rounded-sm py-1.5 pr-3 pl-3 text-xs outline-none",
                "data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                <Icon size={12} className={cn("shrink-0", option.ui.iconClass)} />
                <div className="flex w-[164px] min-w-0 flex-col gap-0.5">
                  <SelectPrimitive.ItemText>
                    <span className="text-foreground text-xs font-medium">{option.ui.label}</span>
                  </SelectPrimitive.ItemText>
                  <span className="text-muted line-clamp-2 text-[11px] leading-snug whitespace-normal">
                    {option.ui.description}
                  </span>
                  {option.disabledReason !== null ? (
                    <span className="line-clamp-2 text-[11px] leading-snug whitespace-normal text-yellow-500">
                      {option.disabledReason}
                    </span>
                  ) : null}
                </div>
              </div>
            </SelectPrimitive.Item>
          );
        })}
      </SelectContent>
    </RadixSelect>
  );
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
    // The project select already explains project-level unavailability (SSH, Coder CLI), so the
    // workspace select only reports what is specific to the pair.
    const disabledReason =
      getUnsupportedIsolationReason(choice) ??
      (choice.project === "local" ? runtimeUnavailableReason(choice, context) : null);
    return { value: workspace, ui: WORKSPACE_ISOLATION_UI[workspace], disabledReason };
  });
}

/**
 * Prominent controls shown above the input during workspace creation.
 * Displays project name as header, workspace name with magic wand, and runtime/branch selectors.
 */
/**
 * The "from" branch picker: a skeleton while the list loads, the select once it loaded, and a short
 * notice when the list failed (#6055). A failed list keeps Send off for every runtime except Local;
 * reopening the project retries.
 */
function SourceBranchPicker(props: {
  branchLoad: BranchLoadStatus;
  trunkBranch: string;
  onTrunkBranchChange: (branch: string) => void;
  disabled: boolean;
  branchOptions: string[];
}) {
  if (props.branchLoad === "loading") {
    return <Skeleton className="h-7 w-full rounded md:w-[140px]" />;
  }
  if (props.branchLoad === "failed") {
    return (
      <span className="text-error text-xs" role="status">
        Could not load branches
      </span>
    );
  }
  return (
    <RadixSelect
      value={props.trunkBranch}
      onValueChange={props.onTrunkBranchChange}
      disabled={props.disabled}
    >
      <SelectTrigger
        className={cn(INLINE_CONTROL_CLASSES, "w-full md:w-[140px]")}
        aria-label="Select source branch"
      >
        <SelectValue placeholder="Select source branch" />
      </SelectTrigger>
      <SelectContent className="border-border-medium">
        {props.branchOptions.map((branch) => (
          <SelectItem key={branch} value={branch}>
            {branch}
          </SelectItem>
        ))}
      </SelectContent>
    </RadixSelect>
  );
}

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

function CreationControlsContent(props: CreationControlsProps) {
  usePerfRenderMarker("chat-input.creation-controls");
  const { nameState, runtimeAvailabilityState } = props;

  const { selectedRuntime, onSelectedRuntimeChange } = props;
  // Coder is surfaced as its own project isolation while keeping SSH as the config mode.
  const isCoderSelected =
    selectedRuntime.mode === RUNTIME_MODE.SSH && selectedRuntime.coder != null;
  // The two-axis view of the selection; ParsedRuntime stays the source of truth.
  const currentIsolation = isolationFromRuntimeConfig(buildRuntimeConfig(selectedRuntime));
  const isSshNoneSelected =
    selectedRuntime.mode === RUNTIME_MODE.SSH && selectedRuntime.workspaceIsolation === "none";
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
  const isBranchSelectorDisabled =
    Boolean(props.disabled) || isNonGitRepo || branchOptions.length === 0;

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
  const currentSshProjectDir =
    selectedRuntime.mode === RUNTIME_MODE.SSH ? selectedRuntime.projectDir : undefined;

  // Either select changes one axis; an unsupported pair snaps to the nearest one the project
  // supports. The pair maps to a runtime choice, so per-runtime inputs (host, image) carry over.
  const selectIsolation = (choice: IsolationChoice) => {
    // Same rule as the Settings default: skip pairs with no backend and pairs Settings disable,
    // keeping the picked project isolation when any of its pairs is enabled.
    const next =
      (props.runtimeEnablement ? resolveEnabledIsolation(choice, props.runtimeEnablement) : null) ??
      nearestSupportedIsolation(choice);
    const runtimeId = runtimeIdFromIsolation(next);
    if (runtimeId === null || (runtimeId === "coder" && !props.coderProps)) {
      return;
    }
    const runtime = buildRuntimeForChoice(runtimeId, runtimeChoiceContext);
    if (runtime.mode === RUNTIME_MODE.SSH && next.workspace === "none") {
      onSelectedRuntimeChange({
        ...runtime,
        workspaceIsolation: "none",
        // Empty asks the draft settings to refill the project's remembered directory.
        projectDir: isSshNoneSelected ? currentSshProjectDir : "",
      });
      return;
    }
    onSelectedRuntimeChange(runtime);
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

      <div className="flex flex-col gap-1.5" data-component="RuntimeTypeGroup">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
          {/* Project isolation + workspace isolation share a row on mobile */}
          <div className="flex w-full items-center gap-2 md:contents md:w-auto">
            <span className="text-muted-foreground shrink-0">Run on</span>
            <div
              className="flex min-w-0 flex-1 items-center gap-1.5 md:flex-initial"
              data-component="ProjectIsolationSelect"
            >
              <IsolationSelect
                ariaLabel="Project isolation"
                placeholder="Select where to run"
                value={currentIsolation.project}
                options={projectIsolationOptions}
                onChange={(project) =>
                  selectIsolation({ project, workspace: currentIsolation.workspace })
                }
                disabled={props.disabled}
              />
            </div>
            <span className="text-muted-foreground shrink-0">with</span>
            <div
              className="flex min-w-0 flex-1 items-center gap-1.5 md:flex-initial"
              data-component="WorkspaceIsolationSelect"
            >
              <IsolationSelect
                ariaLabel="Workspace isolation"
                placeholder="Select isolation"
                value={currentIsolation.workspace}
                options={workspaceIsolationOptions}
                onChange={(workspace) =>
                  selectIsolation({ project: currentIsolation.project, workspace })
                }
                disabled={props.disabled}
              />
            </div>
          </div>
          {/* end mobile row wrapper */}

          {selectedRuntime.mode === "ssh" &&
            !isCoderSelected &&
            !props.coderProps?.enabled &&
            // Also hide when Coder is still checking but has saved config (will enable after check)
            !(props.coderProps?.coderInfo === null && props.coderProps?.coderConfig) && (
              <div className={SENTENCE_CLAUSE_CLASSES}>
                <span className="text-muted-foreground shrink-0">on host</span>
                <RuntimeConfigInput
                  id="ssh-host"
                  fieldSpec={RUNTIME_OPTION_FIELDS.ssh}
                  value={selectedRuntime.host}
                  onChange={(value) =>
                    onSelectedRuntimeChange({
                      mode: "ssh",
                      host: value,
                      workspaceIsolation: selectedRuntime.workspaceIsolation,
                      projectDir: selectedRuntime.projectDir,
                    })
                  }
                  disabled={props.disabled}
                  hasError={props.runtimeFieldError === "ssh"}
                  className="min-w-0 flex-1 md:flex-initial"
                  labelClassName="sr-only"
                  inputClassName={cn(INLINE_CONTROL_CLASSES, "w-full md:w-[160px]")}
                />
              </div>
            )}

          {selectedRuntime.mode === "ssh" && isSshNoneSelected && (
            <div className={SENTENCE_CLAUSE_CLASSES}>
              <span className="text-muted-foreground shrink-0">in</span>
              <RuntimeConfigInput
                id="ssh-project-dir"
                fieldSpec={RUNTIME_OPTION_FIELDS.sshProjectDir}
                value={selectedRuntime.projectDir ?? ""}
                onChange={(value) =>
                  onSelectedRuntimeChange({
                    mode: "ssh",
                    host: selectedRuntime.host,
                    coder: selectedRuntime.coder,
                    workspaceIsolation: "none",
                    projectDir: value,
                  })
                }
                disabled={props.disabled}
                hasError={props.runtimeFieldError === "sshProjectDir"}
                ariaLabel="Project directory on host"
                className="min-w-0 flex-1 md:flex-initial"
                labelClassName="sr-only"
                inputClassName={cn(INLINE_CONTROL_CLASSES, "w-full md:w-[180px]")}
              />
            </div>
          )}
          {selectedRuntime.mode === "ssh" && isSshNoneSelected && (
            <SshDirectoryTrustNotice
              projectPath={props.projectPath}
              userProjects={props.userProjects}
              host={selectedRuntime.host}
              projectDir={selectedRuntime.projectDir ?? ""}
              disabled={props.disabled}
              onProjectDirResolved={(projectDir) =>
                onSelectedRuntimeChange({
                  mode: "ssh",
                  host: selectedRuntime.host,
                  coder: selectedRuntime.coder,
                  workspaceIsolation: "none",
                  projectDir,
                })
              }
            />
          )}

          {selectedRuntime.mode === "docker" && (
            <div className={SENTENCE_CLAUSE_CLASSES}>
              <span className="text-muted-foreground shrink-0">with image</span>
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
                hasError={props.runtimeFieldError === "docker"}
                id="docker-image"
                ariaLabel="Docker image"
                className="min-w-0 flex-1 md:flex-initial"
                labelClassName="sr-only"
                inputClassName={cn(INLINE_CONTROL_CLASSES, "w-full md:w-[160px]")}
              />
            </div>
          )}
          <div className={SENTENCE_CLAUSE_CLASSES}>
            <span className="text-muted-foreground shrink-0">from</span>
            <div
              className="flex min-w-0 flex-1 items-center gap-1.5 md:flex-initial"
              data-component="BranchSelector"
              data-tutorial="trunk-branch"
            >
              <label className="sr-only" htmlFor="source-branch-select">
                Source Branch
              </label>
              <GitBranch className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
              <SourceBranchPicker
                branchLoad={props.branchLoad}
                trunkBranch={props.trunkBranch}
                onTrunkBranchChange={props.onTrunkBranchChange}
                disabled={isBranchSelectorDisabled}
                branchOptions={branchOptions}
              />
            </div>
          </div>
        </div>

        {/* Dev container controls - config dropdown/input + credential sharing */}
        {selectedRuntime.mode === "devcontainer" && devcontainerSelection.uiMode !== "hidden" && (
          <div className="border-border-medium flex w-fit flex-col gap-1.5 rounded-md border p-2">
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground text-xs">
                {RUNTIME_OPTION_FIELDS.devcontainer.label}
              </label>
              {devcontainerSelection.uiMode === "loading" ? (
                // Skeleton placeholder while loading - matches dropdown dimensions
                <Skeleton className="h-6 w-[280px] rounded-md" />
              ) : devcontainerSelection.uiMode === "dropdown" ? (
                <RadixSelect
                  value={devcontainerSelection.configPath}
                  onValueChange={(value: string) =>
                    onSelectedRuntimeChange({
                      mode: "devcontainer",
                      configPath: value,
                      shareCredentials: selectedRuntime.shareCredentials,
                    })
                  }
                  disabled={props.disabled}
                >
                  <SelectTrigger
                    className="h-6 w-[280px] text-xs"
                    aria-label="Dev container config"
                  >
                    <SelectValue placeholder="Select config" />
                  </SelectTrigger>
                  <SelectContent>
                    {devcontainerSelection.configs.map((config) => (
                      <SelectItem key={config.path} value={config.path}>
                        {config.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </RadixSelect>
              ) : (
                <input
                  type="text"
                  value={devcontainerSelection.configPath}
                  onChange={(e) =>
                    onSelectedRuntimeChange({
                      mode: "devcontainer",
                      configPath: e.target.value,
                      shareCredentials: selectedRuntime.shareCredentials,
                    })
                  }
                  placeholder={DEFAULT_DEVCONTAINER_CONFIG_PATH}
                  disabled={props.disabled}
                  className={cn(
                    "bg-bg-dark text-foreground border-border-medium focus:border-accent h-7 w-[280px] rounded-md border px-2 text-xs focus:outline-none disabled:opacity-50"
                  )}
                  aria-label="Dev container config path"
                />
              )}
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
          </div>
        )}

        {/* Credential sharing - separate row for consistency with Coder controls */}
        {selectedRuntime.mode === "docker" && (
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
        )}

        {/* Coder Controls - shown when Coder runtime is selected */}
        {isCoderSelected && props.coderProps && (
          <div className="flex flex-col gap-1.5" data-testid="coder-controls">
            {/* Coder runtime needs availability status without the SSH-only toggle. */}
            <CoderAvailabilityMessage coderInfo={props.coderProps.coderInfo} />
            {props.coderProps.enabled && (
              <>
                <CoderWorkspaceForm
                  coderConfig={props.coderProps.coderConfig}
                  username={coderUsername}
                  deploymentUrl={coderDeploymentUrl}
                  onCoderConfigChange={props.coderProps.onCoderConfigChange}
                  templates={props.coderProps.templates}
                  templatesError={props.coderProps.templatesError}
                  presets={props.coderProps.presets}
                  presetsError={props.coderProps.presetsError}
                  existingWorkspaces={props.coderProps.existingWorkspaces}
                  workspacesError={props.coderProps.workspacesError}
                  loadingTemplates={props.coderProps.loadingTemplates}
                  loadingPresets={props.coderProps.loadingPresets}
                  loadingWorkspaces={props.coderProps.loadingWorkspaces}
                  disabled={props.disabled}
                  hasError={props.runtimeFieldError === "ssh"}
                />
              </>
            )}
          </div>
        )}
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
      coderInfo={props.coderInfo}
      coderProps={coderProps}
    />
  );
}
