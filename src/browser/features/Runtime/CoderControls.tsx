/**
 * Coder workspace controls for the SSH-based Coder runtime.
 * Enables creating or connecting to Coder cloud workspaces.
 */
import type {
  CoderInfo,
  CoderTemplate,
  CoderPreset,
  CoderWorkspace,
} from "@/common/orpc/schemas/coder";
import type { CoderWorkspaceConfig } from "@/common/types/runtime";
import { cn } from "@/common/lib/utils";
import { Loader2 } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";

export interface CoderControlsProps {
  /** Whether Coder is enabled for this workspace */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;

  /** Coder CLI availability info (null while checking) */
  coderInfo: CoderInfo | null;

  /** Current Coder configuration */
  coderConfig: CoderWorkspaceConfig | null;
  onCoderConfigChange: (config: CoderWorkspaceConfig | null) => void;

  /** Data for dropdowns (loaded async) */
  templates: CoderTemplate[];
  templatesError?: string | null;
  presets: CoderPreset[];
  presetsError?: string | null;
  existingWorkspaces: CoderWorkspace[];
  workspacesError?: string | null;

  /** Loading states */
  loadingTemplates: boolean;
  loadingPresets: boolean;
  loadingWorkspaces: boolean;

  /** Disabled state (e.g., during creation) */
  disabled: boolean;

  /** Error state for visual feedback */
  hasError?: boolean;
}

type CoderMode = "new" | "existing";

const CODER_CHECKING_LABEL = "Checking…";

/** Check if a template name exists in multiple organizations (for disambiguation in UI) */
function hasTemplateDuplicateName(template: CoderTemplate, allTemplates: CoderTemplate[]): boolean {
  return allTemplates.some(
    (t) => t.name === template.name && t.organizationName !== template.organizationName
  );
}

/**
 * Which of the form's three selects to mark invalid: one whose list failed to load, or the one a
 * refused Send is waiting for. Marking that control (not only the form's border) lets the
 * environment panel put the keyboard on it. The missing one follows the order in which creation
 * validation checks the form: the workspace, or the template and then the preset.
 */
export function invalidCoderControls(input: {
  hasError: boolean;
  mode: "new" | "existing";
  template: string | undefined;
  templatesError: unknown;
  presetsError: unknown;
  workspacesError: unknown;
}): Record<"template" | "preset" | "workspace", true | undefined> {
  const missing = !input.hasError
    ? null
    : input.mode === "existing"
      ? "workspace"
      : (input.template ?? "").trim() === ""
        ? "template"
        : "preset";
  const mark = (field: string, loadError: unknown) =>
    Boolean(loadError) || missing === field ? true : undefined;
  return {
    template: mark("template", input.templatesError),
    preset: mark("preset", input.presetsError),
    workspace: mark("workspace", input.workspacesError),
  };
}

export type CoderAvailabilityState =
  | { state: "loading"; reason: string; shouldShowRuntimeButton: false }
  | { state: "outdated"; reason: string; shouldShowRuntimeButton: true }
  | { state: "unavailable"; reason: string; shouldShowRuntimeButton: boolean }
  | { state: "available"; shouldShowRuntimeButton: true };

function getCoderOutdatedReason(coderInfo: Extract<CoderInfo, { state: "outdated" }>) {
  const cliLabel = coderInfo.binaryPath ?? "Coder CLI";
  return `${cliLabel} ${coderInfo.version} is below minimum v${coderInfo.minVersion}.`;
}

function getCoderUnavailableReason(coderInfo: Extract<CoderInfo, { state: "unavailable" }>) {
  if (coderInfo.reason === "missing") {
    return "Coder CLI not found. Install to enable.";
  }

  if (coderInfo.reason.kind === "not-logged-in") {
    return coderInfo.reason.message || "CLI not logged in. Run `coder login <url>` first.";
  }

  return `Coder CLI error: ${coderInfo.reason.message}`;
}

export function resolveCoderAvailability(coderInfo: CoderInfo | null): CoderAvailabilityState {
  if (coderInfo === null) {
    return { state: "loading", reason: CODER_CHECKING_LABEL, shouldShowRuntimeButton: false };
  }

  if (coderInfo.state === "outdated") {
    return {
      state: "outdated",
      reason: getCoderOutdatedReason(coderInfo),
      shouldShowRuntimeButton: true,
    };
  }

  if (coderInfo.state === "unavailable") {
    const shouldShowRuntimeButton =
      coderInfo.reason !== "missing" && coderInfo.reason.kind === "not-logged-in";

    return {
      state: "unavailable",
      reason: getCoderUnavailableReason(coderInfo),
      shouldShowRuntimeButton,
    };
  }

  // Only show the runtime button once the CLI is confirmed available (matches devcontainer UX).
  return { state: "available", shouldShowRuntimeButton: true };
}

// Standalone availability messaging used by the Coder runtime UI.
export function CoderAvailabilityMessage(props: { coderInfo: CoderInfo | null }) {
  const availability = resolveCoderAvailability(props.coderInfo);

  if (availability.state === "loading") {
    return (
      <span className="text-muted flex items-center gap-1 text-xs">
        <Loader2 className="h-3 w-3 animate-spin" />
        {CODER_CHECKING_LABEL}
      </span>
    );
  }

  if (availability.state === "outdated") {
    return <p className="text-xs text-yellow-500">{availability.reason}</p>;
  }

  if (availability.state === "unavailable" && availability.shouldShowRuntimeButton) {
    return <p className="text-xs text-yellow-500">{availability.reason}</p>;
  }

  return null;
}

export type CoderWorkspaceFormProps = Omit<
  CoderControlsProps,
  "enabled" | "onEnabledChange" | "coderInfo"
> & {
  username?: string;
  deploymentUrl?: string;
  className?: string;
};

export function CoderWorkspaceForm(props: CoderWorkspaceFormProps) {
  const {
    coderConfig,
    onCoderConfigChange,
    templates,
    templatesError,
    presets,
    presetsError,
    existingWorkspaces,
    workspacesError,
    loadingTemplates,
    loadingPresets,
    loadingWorkspaces,
    disabled,
    hasError,
    username,
    deploymentUrl,
    className,
  } = props;

  const mode: CoderMode = coderConfig?.existingWorkspace ? "existing" : "new";
  const formHasError = Boolean(
    (hasError ?? false) ||
    (mode === "existing" && Boolean(workspacesError)) ||
    (mode === "new" && Boolean(templatesError ?? presetsError))
  );
  const invalid = invalidCoderControls({
    hasError: hasError ?? false,
    mode,
    template: coderConfig?.template,
    templatesError,
    presetsError,
    workspacesError,
  });
  const templateErrorId = templatesError ? "coder-template-error" : undefined;
  const presetErrorId = presetsError ? "coder-preset-error" : undefined;
  const workspaceErrorId = workspacesError ? "coder-workspace-error" : undefined;

  const handleModeChange = (newMode: CoderMode) => {
    if (newMode === "existing") {
      // Switch to existing workspace mode (workspaceName starts empty, user selects)
      onCoderConfigChange({
        workspaceName: undefined,
        existingWorkspace: true,
      });
    } else {
      // Switch to new workspace mode (workspaceName omitted; backend derives from branch)
      const firstTemplate = templates[0];
      onCoderConfigChange({
        existingWorkspace: false,
        template: firstTemplate?.name,
        templateOrg: firstTemplate?.organizationName,
      });
    }
  };

  const handleTemplateChange = (value: string) => {
    if (!coderConfig) return;

    // Value is "org/name" when duplicates exist, otherwise just "name"
    const [orgOrName, maybeName] = value.split("/");
    const templateName = maybeName ?? orgOrName;

    // Always resolve the org from the templates list so --org is passed to CLI
    // even when the user belongs to multiple orgs but template names don't collide
    const matchedTemplate = templates.find(
      (t) => t.name === templateName && (maybeName ? t.organizationName === orgOrName : true)
    );
    const templateOrg = maybeName ? orgOrName : matchedTemplate?.organizationName;

    onCoderConfigChange({
      ...coderConfig,
      template: templateName,
      templateOrg,
      preset: undefined, // Reset preset when template changes
    });
    // Presets will be loaded by parent via effect
  };

  const handlePresetChange = (presetName: string) => {
    if (!coderConfig) return;

    onCoderConfigChange({
      ...coderConfig,
      preset: presetName || undefined,
    });
  };

  const handleExistingWorkspaceChange = (workspaceName: string) => {
    onCoderConfigChange({
      workspaceName,
      existingWorkspace: true,
    });
  };

  // Preset value: hook handles auto-selection, but keep a UI fallback to avoid a brief
  // "Select preset" flash while async preset loading + config update races.
  const defaultPresetName = presets.find((p) => p.isDefault)?.name;
  const effectivePreset =
    presets.length === 0
      ? undefined
      : presets.length === 1
        ? presets[0]?.name
        : (coderConfig?.preset ?? defaultPresetName ?? presets[0]?.name);

  const templatePlaceholder = templatesError
    ? "Error loading templates"
    : templates.length === 0
      ? "No templates"
      : "Select template...";
  const templateSelectDisabled = disabled || templates.length === 0 || Boolean(templatesError);

  const presetPlaceholder = presetsError
    ? "Error loading presets"
    : presets.length === 0
      ? "No presets"
      : "Select preset...";
  const presetSelectDisabled = disabled || presets.length === 0 || Boolean(presetsError);

  const workspacePlaceholder = workspacesError
    ? "Error loading workspaces"
    : existingWorkspaces.length === 0
      ? "No workspaces found"
      : "Select workspace...";
  const workspaceSelectDisabled =
    disabled || existingWorkspaces.length === 0 || Boolean(workspacesError);

  const headerBorderClass = formHasError
    ? "border-b border-red-500"
    : "border-b border-border-medium";

  // Only show login context when we can name the user and the deployment they're on.
  const showLoginInfo = Boolean(username && deploymentUrl);
  return (
    <div
      className={cn(
        "flex flex-col rounded-md border",
        className ?? "w-[22rem]",
        formHasError ? "border-red-500" : "border-border-medium"
      )}
      data-testid="coder-controls-inner"
    >
      {showLoginInfo && (
        <div className={cn("text-muted-foreground px-2 py-1.5 text-xs", headerBorderClass)}>
          Logged in as <span className="text-foreground font-medium">{username}</span> on{" "}
          <span className="text-foreground font-medium">{deploymentUrl}</span>
        </div>
      )}
      <div className="flex">
        {/* Left column: New/Existing toggle buttons */}
        <div
          className="border-border-medium flex flex-col gap-1 border-r p-2 pr-3"
          role="group"
          aria-label="Coder workspace mode"
          data-testid="coder-mode-toggle"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => handleModeChange("new")}
                disabled={disabled}
                className={cn(
                  "rounded-md border px-2 py-1 text-xs transition-colors",
                  mode === "new"
                    ? "border-accent bg-accent/20 text-foreground"
                    : "border-transparent bg-transparent text-muted hover:border-border-medium"
                )}
                aria-pressed={mode === "new"}
              >
                New
              </button>
            </TooltipTrigger>
            <TooltipContent>Create a new Coder workspace from a template</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => handleModeChange("existing")}
                disabled={disabled}
                className={cn(
                  "rounded-md border px-2 py-1 text-xs transition-colors",
                  mode === "existing"
                    ? "border-accent bg-accent/20 text-foreground"
                    : "border-transparent bg-transparent text-muted hover:border-border-medium"
                )}
                aria-pressed={mode === "existing"}
              >
                Existing
              </button>
            </TooltipTrigger>
            <TooltipContent>Connect to an existing Coder workspace</TooltipContent>
          </Tooltip>
        </div>

        {/* Right column: Mode-specific controls */}
        {/* New workspace controls - template/preset stacked vertically */}
        {mode === "new" && (
          <div className="flex flex-col gap-1 p-2 pl-3">
            <div className="flex h-7 items-center gap-2">
              <label className="text-muted-foreground w-16 text-xs">Template</label>
              {loadingTemplates ? (
                <Loader2 className="text-muted h-4 w-4 animate-spin" />
              ) : (
                <Select
                  value={(() => {
                    const templateName = coderConfig?.template;
                    if (!templateName) {
                      return "";
                    }

                    const matchingTemplates = templates.filter((t) => t.name === templateName);
                    const firstMatch = matchingTemplates[0];
                    const hasDuplicate =
                      firstMatch && hasTemplateDuplicateName(firstMatch, templates);

                    if (!hasDuplicate) {
                      return templateName;
                    }

                    const org =
                      coderConfig?.templateOrg ?? firstMatch?.organizationName ?? undefined;
                    return org ? `${org}/${templateName}` : templateName;
                  })()}
                  onValueChange={handleTemplateChange}
                  disabled={templateSelectDisabled}
                >
                  <SelectTrigger
                    className="h-7 w-[180px] text-xs"
                    data-testid="coder-template-select"
                    aria-invalid={invalid.template}
                    aria-describedby={templateErrorId}
                  >
                    <SelectValue placeholder={templatePlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((t) => {
                      // Show org name only if there are duplicate template names
                      const hasDuplicate = hasTemplateDuplicateName(t, templates);
                      // Use org/name as value when duplicates exist for disambiguation
                      const itemValue = hasDuplicate ? `${t.organizationName}/${t.name}` : t.name;
                      return (
                        <SelectItem key={`${t.organizationName}/${t.name}`} value={itemValue}>
                          {t.displayName || t.name}
                          {hasDuplicate && (
                            <span className="text-muted ml-1">({t.organizationName})</span>
                          )}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              )}
            </div>
            {templatesError && (
              <p id={templateErrorId} role="alert" className="text-xs break-all text-red-500">
                {templatesError}
              </p>
            )}
            <div className="flex h-7 items-center gap-2">
              <label className="text-muted-foreground w-16 text-xs">Preset</label>
              {loadingPresets ? (
                <Loader2 className="text-muted h-4 w-4 animate-spin" />
              ) : (
                <Select
                  value={effectivePreset ?? ""}
                  onValueChange={handlePresetChange}
                  disabled={presetSelectDisabled}
                >
                  <SelectTrigger
                    className="h-7 w-[180px] text-xs"
                    data-testid="coder-preset-select"
                    aria-invalid={invalid.preset}
                    aria-describedby={presetErrorId}
                  >
                    <SelectValue placeholder={presetPlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {presets.map((p) => (
                      <SelectItem key={p.id} value={p.name}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {presetsError && (
              <p id={presetErrorId} role="alert" className="text-xs break-all text-red-500">
                {presetsError}
              </p>
            )}
          </div>
        )}

        {/* Existing workspace controls - keep base height aligned with New mode (2×h-7 + gap-1). */}
        {mode === "existing" && (
          <div className="flex w-[17rem] flex-col gap-1 p-2 pl-3">
            <div className="flex min-h-[3.75rem] items-center gap-2">
              <label className="text-muted-foreground w-16 text-xs">Workspace</label>
              {loadingWorkspaces ? (
                <Loader2 className="text-muted h-4 w-4 animate-spin" />
              ) : (
                <Select
                  value={coderConfig?.workspaceName ?? ""}
                  onValueChange={handleExistingWorkspaceChange}
                  disabled={workspaceSelectDisabled}
                >
                  <SelectTrigger
                    className="h-7 w-[180px] text-xs"
                    data-testid="coder-workspace-select"
                    aria-invalid={invalid.workspace}
                    aria-describedby={workspaceErrorId}
                  >
                    <SelectValue placeholder={workspacePlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {existingWorkspaces
                      .filter((w) => w.status !== "deleted" && w.status !== "deleting")
                      .map((w) => (
                        <SelectItem key={w.name} value={w.name}>
                          {w.name}
                          <span className="text-muted ml-1">
                            ({w.templateDisplayName} • {w.status})
                          </span>
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {workspacesError && (
              <p id={workspaceErrorId} role="alert" className="text-xs break-all text-red-500">
                {workspacesError}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
