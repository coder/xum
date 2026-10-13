import {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAPI, useLiveAPI } from "@/browser/contexts/API";
import { isAbortError } from "@/browser/utils/isAbortError";
import assert from "@/common/utils/assert";
import {
  DEFAULT_LAYOUT_PRESETS_CONFIG,
  normalizeLayoutPresetsConfig,
  type LayoutPreset,
  type LayoutPresetsConfig,
  type LayoutSlotNumber,
} from "@/common/types/uiLayouts";
import {
  applyLayoutPresetToWorkspace,
  createPresetFromCurrentWorkspace,
  deleteSlotAndShiftFollowingSlots,
  getLayoutsConfigOrDefault,
  getPresetForSlot,
  updateSlotKeybindOverride,
  updateSlotPreset,
} from "@/browser/utils/uiLayouts";
import type { Keybind } from "@/common/types/keybind";
import type { Result } from "@/common/types/result";

interface UILayoutsContextValue {
  layoutPresets: LayoutPresetsConfig;
  loaded: boolean;
  loadFailed: boolean;
  refresh: () => Promise<void>;
  saveAll: (next: LayoutPresetsConfig) => Promise<void>;

  applySlotToWorkspace: (workspaceId: string, slot: LayoutSlotNumber) => Promise<void>;

  /**
   * Capture the currently-selected workspace's layout into the given slot. Errs (without saving)
   * with a user-facing message when the layout holds no tab a preset can store.
   */
  saveCurrentWorkspaceToSlot: (
    workspaceId: string,
    slot: LayoutSlotNumber,
    name?: string | null
  ) => Promise<Result<LayoutPreset>>;

  renameSlot: (slot: LayoutSlotNumber, newName: string) => Promise<void>;
  deleteSlot: (slot: LayoutSlotNumber) => Promise<void>;
  setSlotKeybindOverride: (slot: LayoutSlotNumber, keybind: Keybind | undefined) => Promise<void>;
}

const UILayoutsContext = createContext<UILayoutsContextValue | null>(null);

export function useUILayouts(): UILayoutsContextValue {
  const ctx = useContext(UILayoutsContext);
  if (!ctx) {
    throw new Error("useUILayouts must be used within UILayoutsProvider");
  }
  return ctx;
}

/** The typed name, else the slot's current name, else "Slot N". */
function resolveSlotName(
  name: string | null | undefined,
  existingName: string | undefined,
  slot: LayoutSlotNumber
): string {
  const trimmedName = name?.trim();
  return trimmedName && trimmedName.length > 0 ? trimmedName : (existingName ?? `Slot ${slot}`);
}

export function UILayoutsProvider(props: { children: ReactNode }) {
  const { api } = useAPI();
  const liveApi = useLiveAPI();

  const [layoutPresets, setLayoutPresets] = useState<LayoutPresetsConfig>(
    DEFAULT_LAYOUT_PRESETS_CONFIG
  );
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!api) {
      // Keep the shown presets offline (the defaults before the first load): the reconnect
      // reloads them.
      setLoaded(true);
      setLoadFailed(false);
      return;
    }

    try {
      const remote = await api.uiLayouts.getAll();
      setLayoutPresets(getLayoutsConfigOrDefault(remote));
      setLoaded(true);
      setLoadFailed(false);
    } catch (error) {
      // A lost connection is no load failure: keep the shown presets for the reconnect.
      if (isAbortError(error)) return;
      setLayoutPresets(DEFAULT_LAYOUT_PRESETS_CONFIG);
      setLoaded(true);
      setLoadFailed(true);
    }
  }, [api]);

  const getConfigForWrite = useCallback(async (): Promise<LayoutPresetsConfig> => {
    if (!api) {
      return layoutPresets;
    }

    // Always fetch the latest config right before a write.
    //
    // This prevents stale in-memory state (captured by closures) from accidentally overwriting a
    // newer config when multiple writes happen in sequence (e.g., delete layout → clear hotkey).
    try {
      const remote = await api.uiLayouts.getAll();
      const normalized = getLayoutsConfigOrDefault(remote);

      setLayoutPresets(normalized);
      setLoaded(true);
      setLoadFailed(false);

      return normalized;
    } catch {
      // Best-effort fallback: don't block writes if the config fetch fails.
      return layoutPresets;
    }
  }, [api, layoutPresets]);

  const saveAll = useCallback(
    async (next: LayoutPresetsConfig): Promise<void> => {
      const normalized = normalizeLayoutPresetsConfig(next);

      if (!liveApi) {
        throw new Error("ORPC client not initialized");
      }

      await liveApi.uiLayouts.saveAll({ layoutPresets: normalized });
      setLayoutPresets(normalized);
    },
    [liveApi]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const applySlotToWorkspace = useCallback(
    async (workspaceId: string, slot: LayoutSlotNumber): Promise<void> => {
      const preset = getPresetForSlot(layoutPresets, slot);
      if (!preset) {
        return;
      }

      // Offline, the preset is not applied: a terminal list cut off by the lost connection would
      // look empty and drop the layout's terminal tabs.
      await applyLayoutPresetToWorkspace(liveApi, workspaceId, preset);
    },
    [liveApi, layoutPresets]
  );

  const saveCurrentWorkspaceToSlot = useCallback(
    async (
      workspaceId: string,
      slot: LayoutSlotNumber,
      name?: string | null
    ): Promise<Result<LayoutPreset>> => {
      assert(
        typeof workspaceId === "string" && workspaceId.length > 0,
        "workspaceId must be non-empty"
      );

      const base = await getConfigForWrite();
      const existingPreset = getPresetForSlot(base, slot);

      const resolvedName = resolveSlotName(name, existingPreset?.name, slot);

      const result = createPresetFromCurrentWorkspace(
        workspaceId,
        resolvedName,
        existingPreset?.id
      );
      if (!result.success) {
        return result;
      }
      await saveAll(updateSlotPreset(base, slot, result.data));
      return result;
    },
    [getConfigForWrite, saveAll]
  );

  const renameSlot = useCallback(
    async (slot: LayoutSlotNumber, newName: string): Promise<void> => {
      const trimmed = newName.trim();
      if (!trimmed) {
        return;
      }

      const base = await getConfigForWrite();
      const existingPreset = getPresetForSlot(base, slot);
      if (!existingPreset) {
        return;
      }

      await saveAll(updateSlotPreset(base, slot, { ...existingPreset, name: trimmed }));
    },
    [getConfigForWrite, saveAll]
  );

  const deleteSlot = useCallback(
    async (slot: LayoutSlotNumber): Promise<void> => {
      const base = await getConfigForWrite();
      await saveAll(deleteSlotAndShiftFollowingSlots(base, slot));
    },
    [getConfigForWrite, saveAll]
  );

  const setSlotKeybindOverride = useCallback(
    async (slot: LayoutSlotNumber, keybind: Keybind | undefined): Promise<void> => {
      const base = await getConfigForWrite();
      await saveAll(updateSlotKeybindOverride(base, slot, keybind));
    },
    [getConfigForWrite, saveAll]
  );

  const value: UILayoutsContextValue = useMemo(
    () => ({
      layoutPresets,
      loaded,
      loadFailed,
      refresh,
      saveAll,
      applySlotToWorkspace,
      saveCurrentWorkspaceToSlot,
      renameSlot,
      deleteSlot,
      setSlotKeybindOverride,
    }),
    [
      layoutPresets,
      loaded,
      loadFailed,
      refresh,
      saveAll,
      applySlotToWorkspace,
      saveCurrentWorkspaceToSlot,
      renameSlot,
      deleteSlot,
      setSlotKeybindOverride,
    ]
  );

  return <UILayoutsContext.Provider value={value}>{props.children}</UILayoutsContext.Provider>;
}
