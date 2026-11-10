import { useCallback } from "react";
import { useReasoningMode } from "./useReasoningMode";
import { useThinkingLevel } from "./useThinkingLevel";
import { normalizeSelectedModel } from "@/common/utils/ai/models";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import {
  type RuntimeMode,
  type ParsedRuntime,
  type CoderWorkspaceConfig,
  type SshWorkspaceIsolation,
  buildRuntimeString,
  RUNTIME_MODE,
  CODER_RUNTIME_PLACEHOLDER,
} from "@/common/types/runtime";
import type { RuntimeChoice } from "@/browser/utils/runtimeUi";
import {
  DEFAULT_ISOLATION,
  nearestSupportedIsolation,
  runtimeIdFromIsolation,
  type IsolationChoice,
} from "@/common/types/isolation";
import {
  readOptionField,
  readSshOptionDefaults,
  type RuntimeOptionDefaults,
  updateRuntimeOptionDefaults,
  useRuntimeOptionDefaults,
  writeSshOptionDefaults,
} from "@/browser/utils/runtimeOptionDefaults";
import { useAppConfig, useUserPreferences } from "@/browser/stores/AppConfigStore";
import { getCreationDraftStore, useCreationDraft } from "@/browser/stores/CreationDraftStore";
import type { OpenAIReasoningMode, ThinkingLevel } from "@/common/types/thinking";
import { normalizeAgentId } from "@/common/utils/agentIds";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

/**
 * A creation draft's workspace settings: its own choices (CreationDraftStore), else defaults.
 */
export interface DraftWorkspaceSettings {
  // Model & AI settings (synced with global state)
  model: string;
  thinkingLevel: ThinkingLevel;
  reasoningMode: OpenAIReasoningMode;
  agentId: string;

  // Workspace creation settings (project-specific)
  /**
   * Currently selected runtime for this workspace creation.
   * Uses discriminated union so SSH has host, Docker has image, etc.
   */
  selectedRuntime: ParsedRuntime;
  /** Settings default (project override, else global) that initializes the selection. */
  defaultIsolation: IsolationChoice;
  trunkBranch: string;
}

interface SshRuntimeConfig {
  host: string;
  coder?: CoderWorkspaceConfig;
  workspaceIsolation?: SshWorkspaceIsolation;
  projectDir?: string;
}

interface SshRuntimeState {
  host: string;
  coderEnabled: boolean;
  coderConfig: CoderWorkspaceConfig | null;
}

interface RememberedRuntimeValues {
  ssh: SshRuntimeConfig;
  sshProjectDir: string;
  dockerImage: string;
  dockerShareCredentials: boolean;
  devcontainerConfigPath: string;
  devcontainerShareCredentials: boolean;
}

/** Stable fallback for Coder config to avoid new object on every render */
const DEFAULT_CODER_CONFIG: CoderWorkspaceConfig = { existingWorkspace: false };
function coerceAgentId(value: unknown): string {
  return normalizeAgentId(value, WORKSPACE_DEFAULTS.agentId);
}

const buildRuntimeForMode = (
  mode: RuntimeMode,
  sshConfig: SshRuntimeConfig,
  dockerImage: string,
  dockerShareCredentials: boolean,
  devcontainerConfigPath: string,
  devcontainerShareCredentials: boolean
): ParsedRuntime => {
  switch (mode) {
    case RUNTIME_MODE.LOCAL:
      return { mode: "local" };
    case RUNTIME_MODE.SSH: {
      // Use placeholder when Coder is enabled with no explicit SSH host
      // This ensures the runtime string round-trips correctly for Coder-only users
      const effectiveHost =
        sshConfig.coder && !sshConfig.host.trim() ? CODER_RUNTIME_PLACEHOLDER : sshConfig.host;

      return {
        mode: "ssh",
        host: effectiveHost,
        coder: sshConfig.coder,
        ...(sshConfig.workspaceIsolation === "none"
          ? { workspaceIsolation: "none" as const, projectDir: sshConfig.projectDir ?? "" }
          : {}),
      };
    }
    case RUNTIME_MODE.DOCKER:
      return { mode: "docker", image: dockerImage, shareCredentials: dockerShareCredentials };
    case RUNTIME_MODE.DEVCONTAINER:
      return {
        mode: "devcontainer",
        configPath: devcontainerConfigPath,
        shareCredentials: devcontainerShareCredentials,
      };
    case RUNTIME_MODE.WORKTREE:
    default:
      return { mode: "worktree" };
  }
};

const isSshNone = (runtime: ParsedRuntime): boolean =>
  runtime.mode === RUNTIME_MODE.SSH && runtime.workspaceIsolation === "none";

// Takes the previous selection as primitives: passing the selected runtime object into a call from
// the setter makes React Compiler treat it as mutable and drop the selection's memoization.
const mergeRememberedRuntimeConfig = (
  nextRuntime: ParsedRuntime,
  previousMode: RuntimeMode,
  previousWasSshNone: boolean,
  remembered: RememberedRuntimeValues
): ParsedRuntime => {
  // Entering SSH+None (from any other pair) refills the remembered directory; edits within
  // SSH+None keep what the user typed, even an empty field.
  if (
    nextRuntime.mode === RUNTIME_MODE.SSH &&
    isSshNone(nextRuntime) &&
    !previousWasSshNone &&
    !nextRuntime.projectDir?.trim() &&
    remembered.sshProjectDir.trim()
  ) {
    nextRuntime = { ...nextRuntime, projectDir: remembered.sshProjectDir };
  }

  if (nextRuntime.mode === previousMode) {
    return nextRuntime;
  }

  switch (nextRuntime.mode) {
    case RUNTIME_MODE.SSH:
      return {
        ...nextRuntime,
        host:
          !nextRuntime.host.trim() && remembered.ssh.host.trim()
            ? remembered.ssh.host
            : nextRuntime.host,
        coder:
          nextRuntime.coder === undefined && remembered.ssh.coder != null
            ? remembered.ssh.coder
            : nextRuntime.coder,
      };
    case RUNTIME_MODE.DOCKER:
      return {
        ...nextRuntime,
        image:
          !nextRuntime.image.trim() && remembered.dockerImage.trim()
            ? remembered.dockerImage
            : nextRuntime.image,
        shareCredentials:
          nextRuntime.shareCredentials === undefined && remembered.dockerShareCredentials
            ? remembered.dockerShareCredentials
            : nextRuntime.shareCredentials,
      };
    case RUNTIME_MODE.DEVCONTAINER:
      return {
        ...nextRuntime,
        configPath:
          !nextRuntime.configPath.trim() && remembered.devcontainerConfigPath.trim()
            ? remembered.devcontainerConfigPath
            : nextRuntime.configPath,
        shareCredentials:
          nextRuntime.shareCredentials === undefined && remembered.devcontainerShareCredentials
            ? remembered.devcontainerShareCredentials
            : nextRuntime.shareCredentials,
      };
    default:
      return nextRuntime;
  }
};

const buildRuntimeFromChoice = (choice: RuntimeChoice): ParsedRuntime => {
  switch (choice) {
    case "coder":
      return { mode: RUNTIME_MODE.SSH, host: CODER_RUNTIME_PLACEHOLDER };
    case RUNTIME_MODE.LOCAL:
      return { mode: RUNTIME_MODE.LOCAL };
    case RUNTIME_MODE.WORKTREE:
      return { mode: RUNTIME_MODE.WORKTREE };
    case RUNTIME_MODE.SSH:
      return { mode: RUNTIME_MODE.SSH, host: "" };
    case RUNTIME_MODE.DOCKER:
      return { mode: RUNTIME_MODE.DOCKER, image: "" };
    case RUNTIME_MODE.DEVCONTAINER:
      return { mode: RUNTIME_MODE.DEVCONTAINER, configPath: "" };
  }
};

interface SettingsDefaultIsolation {
  isolation: IsolationChoice;
  runtimeChoice: RuntimeChoice;
  sshIsolation: SshWorkspaceIsolation | undefined;
}

/**
 * The Settings default for new workspaces in a project: its override, else the global default.
 * The backend migrates legacy defaultRuntime into defaultIsolation; a pair with no backend yet
 * falls back to the nearest one on the same project isolation. This is its own hook because
 * React Compiler treats hook results as frozen: computed inline, the calls below made it drop
 * the memoized default runtime on every keystroke (#5937, useDraftWorkspaceSettings.compiler.test).
 */
function useSettingsDefaultIsolation(projectPath: string): SettingsDefaultIsolation {
  const { userProjects } = useProjectContext();
  const projectConfig = userProjects.get(projectPath);
  const globalDefaultIsolation = useAppConfig((config) => config.defaultIsolation);
  const hasProjectRuntimeOverrides =
    projectConfig?.runtimeOverridesEnabled === true ||
    Boolean(projectConfig?.runtimeEnablement) ||
    projectConfig?.defaultIsolation !== undefined;
  const isolation = nearestSupportedIsolation(
    (hasProjectRuntimeOverrides ? projectConfig?.defaultIsolation : undefined) ??
      globalDefaultIsolation ??
      DEFAULT_ISOLATION
  );
  return {
    isolation,
    runtimeChoice: runtimeIdFromIsolation(isolation) ?? RUNTIME_MODE.WORKTREE,
    sshIsolation:
      isolation.project === "ssh" && isolation.workspace === "none" ? "none" : undefined,
  };
}

/**
 * Hook to manage all draft workspace settings with centralized persistence
 * Loads saved preferences when projectPath changes, persists all changes automatically
 *
 * @param projectPath - Path to the project (used as key prefix for localStorage)
 * @param branches - Available branches (used to set default trunk branch)
 * @param recommendedTrunk - Backend-recommended trunk branch
 * @returns Settings object and setters
 */
/**
 * The draft owns its choices; project defaults only fill what it has not chosen (undefined or
 * null).
 */
function useDraftChoices(draftId: string) {
  const draft = useCreationDraft(draftId).draft;
  const execution = draft?.execution ?? null;
  return { model: draft?.ai.model, agentId: execution?.agent?.id, execution };
}

export function useDraftWorkspaceSettings(
  projectPath: string,
  branches: string[],
  recommendedTrunk: string | null,
  draftId: string
): {
  settings: DraftWorkspaceSettings;
  /** Restores prior Coder selections when re-entering Coder mode. */
  coderConfigFallback: CoderWorkspaceConfig;
  /** Preserves the last SSH host when leaving Coder so the input stays populated. */
  sshHostFallback: string;
  /** Set the currently selected runtime (discriminated union) */
  setSelectedRuntime: (runtime: ParsedRuntime) => void;
  setTrunkBranch: (branch: string) => void;
  getRuntimeString: () => string | undefined;
} {
  // Global AI settings (read-only from global state)
  const [thinkingLevel] = useThinkingLevel();
  const [reasoningMode] = useReasoningMode();

  const globalDefaultAgentId =
    useUserPreferences((preferences) => preferences.ai?.globalDefaults?.agentId) ??
    WORKSPACE_DEFAULTS.agentId;
  const choices = useDraftChoices(draftId);
  const execution = choices.execution;
  // Not the project's stored agent: it is a stale leftover nothing writes anymore, and new chats
  // follow the Settings default agent, matching the picker (scopedAiDefaults).
  const agentId =
    typeof choices.agentId === "string" && choices.agentId.trim().length > 0
      ? coerceAgentId(choices.agentId)
      : coerceAgentId(globalDefaultAgentId);

  const defaultModelPref = useAppConfig((config) => config.defaultModel) ?? "";
  // normalizeSelectedModel (not normalizeToCanonical) to preserve explicit
  // gateway routing choices like "openrouter:openai/gpt-5".
  const defaultModel = normalizeSelectedModel(defaultModelPref).trim() || WORKSPACE_DEFAULTS.model;

  const projectModel = useUserPreferences(
    (preferences) => preferences.ai?.projectDefaults?.[projectPath]?.model
  );
  // An unset draft model shows its project's default, like the model selector (scopedAiDefaults).
  const modelOverride = choices.model ?? projectModel;
  const model = normalizeSelectedModel(
    typeof modelOverride === "string" && modelOverride.trim().length > 0
      ? modelOverride.trim()
      : defaultModel
  );

  // A stored trunk that is not (or no longer) a branch falls back to the recommendation
  // without writing it: only an explicit pick goes into the draft.
  const projectTrunkBranch = useUserPreferences(
    (preferences) => preferences.workspaceCreation?.byProject?.[projectPath]?.trunkBranch
  );
  const storedTrunkBranch = execution?.trunkBranch ?? projectTrunkBranch;
  const trunkBranch =
    branches.length > 0 && (!storedTrunkBranch || !branches.includes(storedTrunkBranch))
      ? (recommendedTrunk ?? branches[0])
      : (storedTrunkBranch ?? "");
  const setTrunkBranch = (branch: string) =>
    getCreationDraftStore().updateExecution(draftId, { trunkBranch: branch || null });

  type LastRuntimeConfigs = RuntimeOptionDefaults;

  const lastRuntimeConfigs = useRuntimeOptionDefaults(projectPath);

  const settingsDefault = useSettingsDefaultIsolation(projectPath);

  const readRuntimeConfigFlag = (
    configs: LastRuntimeConfigs,
    mode: RuntimeMode,
    field: string
  ): boolean => {
    const modeConfig = configs[mode];
    if (!modeConfig || typeof modeConfig !== "object" || Array.isArray(modeConfig)) {
      return false;
    }

    return (modeConfig as Record<string, unknown>)[field] === true;
  };

  // Hide Coder-specific persistence fields behind helpers so callsites stay clean.
  const readSshRuntimeState = (configs: LastRuntimeConfigs): SshRuntimeState => {
    return readSshOptionDefaults(configs, "");
  };

  const readSshRuntimeConfig = (configs: LastRuntimeConfigs): SshRuntimeConfig => {
    const sshState = readSshRuntimeState(configs);

    return {
      host: sshState.host,
      coder: sshState.coderEnabled && sshState.coderConfig ? sshState.coderConfig : undefined,
    };
  };

  const lastSshState = readSshRuntimeState(lastRuntimeConfigs);

  // Preserve the last SSH host when switching out of Coder so the input stays populated.
  const sshHostFallback = lastSshState.host;

  // Restore prior Coder selections when switching back into Coder mode.
  const coderConfigFallback = lastSshState.coderConfig ?? DEFAULT_CODER_CONFIG;
  const lastSsh = readSshRuntimeConfig(lastRuntimeConfigs);
  const lastSshProjectDir = readOptionField(lastRuntimeConfigs, RUNTIME_MODE.SSH, "projectDir", "");
  const lastDockerImage = readOptionField(lastRuntimeConfigs, RUNTIME_MODE.DOCKER, "image", "");
  const lastShareCredentials = readRuntimeConfigFlag(
    lastRuntimeConfigs,
    RUNTIME_MODE.DOCKER,
    "shareCredentials"
  );
  const lastDevcontainerConfigPath = readOptionField(
    lastRuntimeConfigs,
    RUNTIME_MODE.DEVCONTAINER,
    "configPath",
    ""
  );
  const lastDevcontainerShareCredentials = readRuntimeConfigFlag(
    lastRuntimeConfigs,
    RUNTIME_MODE.DEVCONTAINER,
    "shareCredentials"
  );

  const setLastRuntimeConfig = useCallback(
    // eslint-disable-next-line local/no-object-parameters -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
    (mode: RuntimeMode, field: string, value: string | boolean | object | null) => {
      updateRuntimeOptionDefaults(projectPath, (prev) => {
        const existing = prev[mode];
        const existingObj =
          existing && typeof existing === "object" && !Array.isArray(existing)
            ? (existing as Record<string, unknown>)
            : {};

        return { ...prev, [mode]: { ...existingObj, [field]: value } };
      });
    },
    [projectPath]
  );

  // Persist SSH config while keeping the legacy field shape hidden from callsites.
  const writeSshRuntimeConfig = useCallback(
    (config: SshRuntimeConfig) => {
      updateRuntimeOptionDefaults(projectPath, (prev) =>
        writeSshOptionDefaults(prev, {
          host: config.host,
          coderEnabled: config.coder !== undefined,
          coderConfig: config.coder ?? null,
        })
      );
    },
    [projectPath]
  );

  const settingsDefaultRuntime = settingsDefault.runtimeChoice;
  const defaultSshIsolation = settingsDefault.sshIsolation;
  const parsedDefault = buildRuntimeFromChoice(settingsDefaultRuntime);
  const defaultRuntimeMode: RuntimeMode = parsedDefault?.mode ?? RUNTIME_MODE.WORKTREE;

  const coderDefaultFromString =
    parsedDefault?.mode === RUNTIME_MODE.SSH && parsedDefault.host === CODER_RUNTIME_PLACEHOLDER;

  const defaultSshHost =
    parsedDefault?.mode === RUNTIME_MODE.SSH && parsedDefault.host.trim()
      ? parsedDefault.host
      : lastSsh.host;

  // When the settings default says "Coder", reuse the saved config even if last-used SSH disabled it.
  // When settings say plain "ssh", don't reattach the last-used coder config.
  const defaultSshCoder = coderDefaultFromString
    ? (lastSshState.coderConfig ?? DEFAULT_CODER_CONFIG)
    : settingsDefaultRuntime === RUNTIME_MODE.SSH
      ? undefined
      : lastSsh.coder;

  const defaultDockerImage =
    parsedDefault?.mode === RUNTIME_MODE.DOCKER && parsedDefault.image.trim()
      ? parsedDefault.image
      : lastDockerImage;

  const defaultDevcontainerConfigPath =
    parsedDefault?.mode === RUNTIME_MODE.DEVCONTAINER && parsedDefault.configPath.trim()
      ? parsedDefault.configPath
      : lastDevcontainerConfigPath;

  // The default runtime and every input it reads (from parsedDefault on) come after the last
  // value hook: React Compiler assumes buildRuntimeForMode may mutate its inputs, and a
  // cache spanning a hook is dropped, so with no pick `selectedRuntime` and
  // `setSelectedRuntime` changed on every keystroke and re-rendered CreationControls (#5937).
  // useDraftWorkspaceSettings.compiler.test.tsx guards their identity.
  // Uses discriminated union: SSH has host, Docker has image.
  const defaultRuntime = buildRuntimeForMode(
    defaultRuntimeMode,
    {
      host: defaultSshHost,
      coder: defaultSshCoder,
      workspaceIsolation: defaultSshIsolation,
      projectDir: lastSshProjectDir,
    },
    defaultDockerImage,
    lastShareCredentials,
    defaultDevcontainerConfigPath,
    lastDevcontainerShareCredentials
  );
  // Until the draft holds a pick it follows the defaults, so options that load after mount apply.
  const selectedRuntime: ParsedRuntime = execution?.runtime ?? defaultRuntime;

  const selectedMode = selectedRuntime.mode;
  const selectedIsSshNone =
    selectedRuntime.mode === RUNTIME_MODE.SSH && selectedRuntime.workspaceIsolation === "none";
  const lastSshHost = lastSsh.host;
  const lastSshCoder = lastSsh.coder;

  // Setter for selected runtime (also persists host/image/coder for future mode switches)
  const setSelectedRuntime = (runtime: ParsedRuntime) => {
    // Construct remembered values only when the user changes runtimes. Keeping
    // this object off the render path lets React Compiler retain the setter
    // identity while unrelated ChatInput draft text changes.
    const mergedRuntime = mergeRememberedRuntimeConfig(runtime, selectedMode, selectedIsSshNone, {
      ssh: { host: lastSshHost, coder: lastSshCoder },
      sshProjectDir: lastSshProjectDir,
      dockerImage: lastDockerImage,
      dockerShareCredentials: lastShareCredentials,
      devcontainerConfigPath: lastDevcontainerConfigPath,
      devcontainerShareCredentials: lastDevcontainerShareCredentials,
    });

    getCreationDraftStore().updateExecution(draftId, { runtime: mergedRuntime });

    // Persist host/image/coder so they're remembered when switching modes.
    // Avoid wiping the remembered value when the UI switches modes with an empty field.
    // Avoid persisting the Coder placeholder as the remembered SSH host.
    if (mergedRuntime.mode === RUNTIME_MODE.SSH) {
      writeSshRuntimeConfig({ host: mergedRuntime.host, coder: mergedRuntime.coder });
      if (mergedRuntime.projectDir?.trim()) {
        setLastRuntimeConfig(RUNTIME_MODE.SSH, "projectDir", mergedRuntime.projectDir);
      }
    } else if (mergedRuntime.mode === RUNTIME_MODE.DOCKER) {
      if (mergedRuntime.image.trim()) {
        setLastRuntimeConfig(RUNTIME_MODE.DOCKER, "image", mergedRuntime.image);
      }
      if (mergedRuntime.shareCredentials !== undefined) {
        setLastRuntimeConfig(
          RUNTIME_MODE.DOCKER,
          "shareCredentials",
          mergedRuntime.shareCredentials
        );
      }
    } else if (mergedRuntime.mode === RUNTIME_MODE.DEVCONTAINER) {
      if (mergedRuntime.configPath.trim()) {
        setLastRuntimeConfig(RUNTIME_MODE.DEVCONTAINER, "configPath", mergedRuntime.configPath);
      }
      if (mergedRuntime.shareCredentials !== undefined) {
        setLastRuntimeConfig(
          RUNTIME_MODE.DEVCONTAINER,
          "shareCredentials",
          mergedRuntime.shareCredentials
        );
      }
    }
  };

  // Helper to get runtime string for IPC calls
  const getRuntimeString = (): string | undefined => {
    return buildRuntimeString(selectedRuntime);
  };

  return {
    settings: {
      model,
      thinkingLevel,
      reasoningMode,
      agentId,
      selectedRuntime,
      // Defaults must stay explicit and sticky; last-used SSH state should only seed inputs.
      defaultIsolation: settingsDefault.isolation,
      trunkBranch,
    },
    coderConfigFallback,
    sshHostFallback,
    setSelectedRuntime,
    setTrunkBranch,
    getRuntimeString,
  };
}
