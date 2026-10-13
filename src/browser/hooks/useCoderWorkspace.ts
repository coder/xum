/**
 * Hook for managing Coder workspace async data in the creation flow.
 * Fetches Coder CLI info, templates, presets, and existing workspaces.
 *
 * The `coderConfig` state is owned by the parent (via selectedRuntime.coder) and passed in.
 * This hook only manages async-fetched data and derived state.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useAPI } from "@/browser/contexts/API";
import { isConnectionLostError } from "@/browser/contexts/connectionLink";
import type {
  CoderInfo,
  CoderTemplate,
  CoderPreset,
  CoderWorkspace,
} from "@/common/orpc/schemas/coder";
import type { CoderWorkspaceConfig } from "@/common/types/runtime";

/**
 * Returns an auto-selected template config if no template is set, otherwise null.
 * Preserves existing config fields (like preset) when auto-selecting.
 */
export function buildAutoSelectedTemplateConfig(
  currentConfig: CoderWorkspaceConfig | null,
  templates: CoderTemplate[]
): CoderWorkspaceConfig | null {
  if (templates.length === 0 || currentConfig?.template || currentConfig?.existingWorkspace) {
    return null;
  }
  const firstTemplate = templates[0];
  return {
    ...(currentConfig ?? {}),
    existingWorkspace: false,
    template: firstTemplate.name,
    templateOrg: firstTemplate.organizationName,
  };
}

export type CoderInfoRefreshPolicy = "mount-only" | "mount-and-focus";

interface UseCoderWorkspaceOptions {
  /** Current Coder config (null = disabled, owned by parent via selectedRuntime.coder) */
  coderConfig: CoderWorkspaceConfig | null;
  /** Callback to update Coder config (updates selectedRuntime.coder) */
  onCoderConfigChange: (config: CoderWorkspaceConfig | null) => void;
  /** Controls whether auth checks run only on mount or also when the window regains focus. */
  coderInfoRefreshPolicy: CoderInfoRefreshPolicy;
}

interface UseCoderWorkspaceReturn {
  /** Whether Coder is enabled (derived: coderConfig != null AND coderInfo available) */
  enabled: boolean;
  /** Toggle Coder on/off (calls onCoderConfigChange with config or null) */
  setEnabled: (enabled: boolean) => void;

  /** Coder CLI availability info */
  coderInfo: CoderInfo | null;

  /** Current Coder configuration (passed through from props) */
  coderConfig: CoderWorkspaceConfig | null;
  /** Update Coder config (passed through from props) */
  setCoderConfig: (config: CoderWorkspaceConfig | null) => void;

  /** Available templates */
  templates: CoderTemplate[];
  /** Error message when templates fail to load (null = no error) */
  templatesError: string | null;
  /** Presets for the currently selected template */
  presets: CoderPreset[];
  /** Error message when presets fail to load (null = no error) */
  presetsError: string | null;
  /** Running Coder workspaces */
  existingWorkspaces: CoderWorkspace[];
  /** Error message when workspaces fail to load (null = no error) */
  workspacesError: string | null;

  /** Loading states */
  loadingTemplates: boolean;
  loadingPresets: boolean;
  loadingWorkspaces: boolean;
}

/**
 * Manages Coder workspace async data for the creation flow.
 *
 * Fetches data lazily:
 * - Coder info is fetched on mount
 * - Templates are fetched when Coder is enabled
 * - Presets are fetched when a template is selected
 * - Workspaces are fetched when Coder is enabled
 *
 * State ownership: coderConfig is owned by parent (selectedRuntime.coder).
 * This hook derives `enabled` from coderConfig and manages only async data.
 */
/** The first line of a list request's error, for the picker's error text. */
function formatCoderListError(error: unknown): string {
  const message =
    error instanceof Error ? error.message.split("\n")[0].slice(0, 200).trim() : "Unknown error";
  return message || "Unknown error";
}

/** True while `config` still selects the template (and org) a presets request was made for. */
function isTemplateSelected(
  config: CoderWorkspaceConfig | null,
  template: string,
  org: string | undefined
): boolean {
  return config?.template === template && config.templateOrg === org;
}

export function useCoderWorkspace({
  coderConfig,
  onCoderConfigChange,
  coderInfoRefreshPolicy,
}: UseCoderWorkspaceOptions): UseCoderWorkspaceReturn {
  const { api } = useAPI();

  // Async-fetched data (owned by this hook)
  const [coderInfo, setCoderInfo] = useState<CoderInfo | null>(null);

  // Derived state: enabled when coderConfig is present AND CLI is confirmed available
  // Loading (null) and outdated/unavailable all result in enabled=false
  const enabled = coderConfig != null && coderInfo?.state === "available";

  // Refs to access current values in async callbacks (avoids stale closures)
  const coderConfigRef = useRef(coderConfig);
  const onCoderConfigChangeRef = useRef(onCoderConfigChange);
  coderConfigRef.current = coderConfig;
  onCoderConfigChangeRef.current = onCoderConfigChange;
  const latestAuthSeqRef = useRef(0);
  const [templates, setTemplates] = useState<CoderTemplate[]>([]);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [presets, setPresets] = useState<CoderPreset[]>([]);
  const [presetsError, setPresetsError] = useState<string | null>(null);
  const [existingWorkspaces, setExistingWorkspaces] = useState<CoderWorkspace[]>([]);
  const [workspacesError, setWorkspacesError] = useState<string | null>(null);

  // Loading states
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [loadingPresets, setLoadingPresets] = useState(false);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  // What the lists show: a reload of shown data keeps it on screen instead of a spinner.
  const templatesShownRef = useRef(false);
  const workspacesShownRef = useRef(false);
  const shownPresetsKeyRef = useRef<string | null>(null);

  const fetchCoderInfo = useCallback(async () => {
    // Advance sequence before the API guard so that an API context change
    // (e.g., reconnecting -> api becomes null) invalidates any in-flight request.
    const seq = ++latestAuthSeqRef.current;

    if (!api) return;

    try {
      const info = await api.coder.getInfo();
      if (seq !== latestAuthSeqRef.current) {
        return;
      }

      setCoderInfo(info);
      // Clear Coder config when CLI is not available (outdated or unavailable)
      if (info.state !== "available" && coderConfigRef.current != null) {
        onCoderConfigChangeRef.current(null);
      }
    } catch (error) {
      // A lost connection says nothing about the CLI: keep the info and the user's Coder config.
      if (seq !== latestAuthSeqRef.current || isConnectionLostError(error)) {
        return;
      }

      setCoderInfo({
        state: "unavailable",
        reason: { kind: "error", message: "Failed to fetch" },
      });
      // Clear Coder config on fetch failure
      if (coderConfigRef.current != null) {
        onCoderConfigChangeRef.current(null);
      }
    }
  }, [api]);

  // Fetch Coder info on mount
  useEffect(() => {
    void fetchCoderInfo();
  }, [fetchCoderInfo]);

  // Re-check Coder auth on window focus — catches `coder login` done externally.
  // Backend doesn't cache whoami failures, so this re-runs the CLI check only
  // when logged out. Once logged in, the cached result returns instantly.
  useEffect(() => {
    if (coderInfoRefreshPolicy !== "mount-and-focus") {
      return;
    }

    const onFocus = () => {
      void fetchCoderInfo();
    };

    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [coderInfoRefreshPolicy, fetchCoderInfo]);

  // Fetch templates when Coder is enabled
  useEffect(() => {
    if (!enabled || coderInfo?.state !== "available") {
      templatesShownRef.current = false;
      setTemplates([]);
      setTemplatesError(null);
      setLoadingTemplates(false);
      return;
    }
    // Offline, keep the shown templates: the reconnect reloads them.
    if (!api) return;

    let mounted = true;
    // Only the first load shows "loading": a reload keeps the shown templates.
    if (!templatesShownRef.current) setLoadingTemplates(true);
    setTemplatesError(null);

    api.coder
      .listTemplates()
      .then((result) => {
        if (!mounted) return;
        if (result.ok) {
          templatesShownRef.current = true;
          setTemplates(result.templates);
          setTemplatesError(null);
          // Auto-select first template if none selected
          const autoConfig = buildAutoSelectedTemplateConfig(
            coderConfigRef.current,
            result.templates
          );
          if (autoConfig) {
            onCoderConfigChange(autoConfig);
          }
        } else {
          setTemplates([]);
          setTemplatesError(result.error);
        }
      })
      .catch((error) => {
        if (!mounted || isConnectionLostError(error)) return;
        setTemplates([]);
        setTemplatesError(formatCoderListError(error));
      })
      .finally(() => {
        if (mounted) {
          setLoadingTemplates(false);
        }
      });

    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentionally only re-fetch on enable/state changes, not on coderConfig changes
  }, [api, enabled, coderInfo?.state]);

  // Fetch existing workspaces when Coder is enabled
  useEffect(() => {
    if (!enabled || coderInfo?.state !== "available") {
      workspacesShownRef.current = false;
      setExistingWorkspaces([]);
      setWorkspacesError(null);
      setLoadingWorkspaces(false);
      return;
    }
    // Offline, keep the shown workspaces: the reconnect reloads them.
    if (!api) return;

    let mounted = true;
    // Only the first load shows "loading": a reload keeps the shown workspaces.
    if (!workspacesShownRef.current) setLoadingWorkspaces(true);
    setWorkspacesError(null);

    api.coder
      .listWorkspaces()
      .then((result) => {
        if (!mounted) return;
        if (result.ok) {
          workspacesShownRef.current = true;
          setExistingWorkspaces(result.workspaces);
          setWorkspacesError(null);
        } else {
          // Users reported "No workspaces found" even when the CLI failed; surface the error.
          setExistingWorkspaces([]);
          setWorkspacesError(result.error);
        }
      })
      .catch((error) => {
        if (!mounted || isConnectionLostError(error)) return;
        setExistingWorkspaces([]);
        setWorkspacesError(formatCoderListError(error));
      })
      .finally(() => {
        if (mounted) {
          setLoadingWorkspaces(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [api, enabled, coderInfo?.state]);

  // Fetch presets when template changes (only for "new" mode)
  useEffect(() => {
    if (!enabled || !coderConfig?.template || coderConfig.existingWorkspace) {
      shownPresetsKeyRef.current = null;
      setPresets([]);
      setPresetsError(null);
      setLoadingPresets(false);
      return;
    }
    // Capture template/org at request time to detect stale responses
    const templateAtRequest = coderConfig.template;
    const orgAtRequest = coderConfig.templateOrg;
    // Only another template shows "loading": a reload (reconnect) keeps the shown presets.
    const presetsKey = JSON.stringify([templateAtRequest, orgAtRequest]);
    if (shownPresetsKeyRef.current !== presetsKey) {
      // The shown presets belong to another template: never offer them, offline either.
      shownPresetsKeyRef.current = null;
      setPresets([]);
      setLoadingPresets(api != null);
    }
    // Offline, keep the shown presets of this template: the reconnect reloads them.
    if (!api) return;

    let mounted = true;
    setPresetsError(null);

    api.coder
      .listPresets({ template: templateAtRequest, org: orgAtRequest })
      .then((result) => {
        if (!mounted) {
          return;
        }

        // Stale response guard: if user changed template/org while request was in-flight, ignore this response
        if (!isTemplateSelected(coderConfigRef.current, templateAtRequest, orgAtRequest)) {
          return;
        }

        if (result.ok) {
          shownPresetsKeyRef.current = presetsKey;
          setPresets(result.presets);
          setPresetsError(null);

          // Presets rules (per spec):
          // - 0 presets: no dropdown
          // - 1 preset: auto-select silently
          // - 2+ presets: dropdown shown, auto-select default if exists, otherwise user must pick
          // Use ref to get current config (avoids stale closure if user changed config during fetch)
          const currentConfig = coderConfigRef.current;
          if (currentConfig && !currentConfig.existingWorkspace) {
            if (result.presets.length === 1) {
              const onlyPreset = result.presets[0];
              if (onlyPreset && currentConfig.preset !== onlyPreset.name) {
                onCoderConfigChange({ ...currentConfig, preset: onlyPreset.name });
              }
            } else if (result.presets.length >= 2 && !currentConfig.preset) {
              // Auto-select default preset if available, otherwise first preset
              // This keeps UI and config in sync (UI falls back to first preset for display)
              const defaultPreset = result.presets.find((p) => p.isDefault);
              const presetToSelect = defaultPreset ?? result.presets[0];
              if (presetToSelect) {
                onCoderConfigChange({ ...currentConfig, preset: presetToSelect.name });
              }
            } else if (result.presets.length === 0 && currentConfig.preset) {
              onCoderConfigChange({ ...currentConfig, preset: undefined });
            }
          }
        } else {
          setPresets([]);
          setPresetsError(result.error);
        }
      })
      .catch((error) => {
        if (!mounted || isConnectionLostError(error)) {
          return;
        }
        if (!isTemplateSelected(coderConfigRef.current, templateAtRequest, orgAtRequest)) {
          return;
        }
        setPresets([]);
        setPresetsError(formatCoderListError(error));
      })
      .finally(() => {
        // Only clear loading for the active request (not stale ones)
        if (
          mounted &&
          isTemplateSelected(coderConfigRef.current, templateAtRequest, orgAtRequest)
        ) {
          setLoadingPresets(false);
        }
      });

    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Only re-fetch on template/org/existingWorkspace changes, not on preset changes (would cause loop)
  }, [
    api,
    enabled,
    coderConfig?.template,
    coderConfig?.templateOrg,
    coderConfig?.existingWorkspace,
  ]);

  // Handle enabled toggle
  const handleSetEnabled = useCallback(
    (newEnabled: boolean) => {
      if (newEnabled) {
        // Initialize config for new workspace mode (workspaceName omitted; backend derives)
        const firstTemplate = templates[0];
        onCoderConfigChange({
          existingWorkspace: false,
          template: firstTemplate?.name,
          templateOrg: firstTemplate?.organizationName,
        });
      } else {
        onCoderConfigChange(null);
      }
    },
    [templates, onCoderConfigChange]
  );

  return {
    enabled,
    setEnabled: handleSetEnabled,
    coderInfo,
    coderConfig,
    setCoderConfig: onCoderConfigChange,
    templates,
    templatesError,
    presets,
    presetsError,
    existingWorkspaces,
    workspacesError,
    loadingTemplates,
    loadingPresets,
    loadingWorkspaces,
  };
}
