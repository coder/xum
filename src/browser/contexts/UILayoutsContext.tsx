import {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAPI } from "@/browser/contexts/API";
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

interface UILayoutsContextValue {
  layoutPresets: LayoutPresetsConfig;
  loaded: boolean;
  loadFailed: boolean;
  refresh: () => Promise<void>;
  saveAll: (next: LayoutPresetsConfig) => Promise<void>;

  applySlotToWorkspace: (workspaceId: string, slot: LayoutSlotNumber) => Promise<void>;

  /** Capture the currently-selected workspace's layout into the given slot. */
  saveCurrentWorkspaceToSlot: (
    workspaceId: string,
    slot: LayoutSlotNumber,
    name?: string | null
  ) => Promise<LayoutPreset>;

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

export function UILayoutsProvider(props: { children: ReactNode }) {
  const { api } = useAPI();

  const [layoutPresets, setLayoutPresets] = useState<LayoutPresetsConfig>(
    DEFAULT_LAYOUT_PRESETS_CONFIG
  );
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  // The mount refresh, config-change refreshes, pre-write fetches, and saves all run
  // concurrently, and the network does not preserve their order. Every request that installs
  // presets takes a generation and only the newest one may apply its result, so an older
  // response cannot land last and reinstate presets a restore or a save already replaced.
  const generationRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    if (!api) {
      setLayoutPresets(DEFAULT_LAYOUT_PRESETS_CONFIG);
      setLoaded(true);
      setLoadFailed(false);
      return;
    }

    try {
      const remote = await api.uiLayouts.getAll();
      if (generation !== generationRef.current) return;
      setLayoutPresets(getLayoutsConfigOrDefault(remote));
      setLoaded(true);
      setLoadFailed(false);
    } catch {
      if (generation !== generationRef.current) return;
      // Keep the presets that last loaded: a transient failure on a later refresh must not
      // blank hotkeys and palette entries. Before the first load the state is already the default.
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
    // A fetch that a restore or refresh overtook may predate the presets now in config, so it is
    // repeated (bounded) rather than becoming the base the write derives from.
    let latest = layoutPresets;
    for (let attempt = 0; attempt < 3; attempt++) {
      const generation = ++generationRef.current;
      try {
        latest = getLayoutsConfigOrDefault(await api.uiLayouts.getAll());
      } catch {
        // Best-effort fallback: don't block writes if the config fetch fails.
        return latest;
      }
      if (generation === generationRef.current) {
        setLayoutPresets(latest);
        setLoaded(true);
        setLoadFailed(false);
        return latest;
      }
    }
    // Every read was overtaken, so none is known to reflect the presets now in config; a write
    // derived from it could still reinstate pre-restore slots. Abort rather than guess.
    throw new Error("Layout presets changed while saving; try again");
  }, [api, layoutPresets]);

  const saveAll = useCallback(
    async (next: LayoutPresetsConfig): Promise<void> => {
      const normalized = normalizeLayoutPresetsConfig(next);

      if (!api) {
        throw new Error("ORPC client not initialized");
      }

      const generation = ++generationRef.current;
      await api.uiLayouts.saveAll({ layoutPresets: normalized });
      if (generation !== generationRef.current) return;
      setLayoutPresets(normalized);
    },
    [api]
  );

  // Presets change behind this provider when a settings restore rewrites config, so hotkeys
  // and palette entries would keep applying the old slots until the app reloaded. The first
  // snapshot is taken only once the subscription is armed: a change landing while it starts
  // would otherwise go unseen, and the older snapshot would stand until the next change.
  useEffect(() => {
    const onConfigChanged = api?.config?.onConfigChanged;
    if (!onConfigChanged) {
      void refresh();
      return;
    }

    const abortController = new AbortController();
    const { signal } = abortController;
    let iterator: AsyncIterator<unknown> | null = null;

    const runSubscription = async () => {
      let subscribed: AsyncIterator<unknown>;
      let nextEvent: Promise<IteratorResult<unknown>>;
      try {
        subscribed = await onConfigChanged(undefined, { signal });
        if (signal.aborted) {
          void subscribed.return?.();
          return;
        }
        iterator = subscribed;
        // A generator-backed subscription registers its listener on the first pull.
        nextEvent = subscribed.next();
      } catch {
        // Without a listener later changes go unseen, but the presets still load once.
        if (!signal.aborted) void refresh();
        return;
      }

      // Not awaited: a change arriving during this snapshot refreshes concurrently, and the
      // generation guard keeps the older response from landing last.
      void refresh();
      try {
        while (!signal.aborted) {
          const event = await nextEvent;
          if (event.done || signal.aborted) break;
          nextEvent = subscribed.next();
          await refresh();
        }
      } catch {
        // Config subscriptions are cancelled during unmounts and API reconnects.
      }
    };

    void runSubscription();

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api, refresh]);

  const applySlotToWorkspace = useCallback(
    async (workspaceId: string, slot: LayoutSlotNumber): Promise<void> => {
      const preset = getPresetForSlot(layoutPresets, slot);
      if (!preset) {
        return;
      }

      await applyLayoutPresetToWorkspace(api ?? null, workspaceId, preset);
    },
    [api, layoutPresets]
  );

  const saveCurrentWorkspaceToSlot = useCallback(
    async (
      workspaceId: string,
      slot: LayoutSlotNumber,
      name?: string | null
    ): Promise<LayoutPreset> => {
      assert(
        typeof workspaceId === "string" && workspaceId.length > 0,
        "workspaceId must be non-empty"
      );

      const base = await getConfigForWrite();
      const existingPreset = getPresetForSlot(base, slot);

      const trimmedName = name?.trim();
      const resolvedName =
        trimmedName && trimmedName.length > 0
          ? trimmedName
          : (existingPreset?.name ?? `Slot ${slot}`);

      const preset = createPresetFromCurrentWorkspace(
        workspaceId,
        resolvedName,
        existingPreset?.id
      );
      await saveAll(updateSlotPreset(base, slot, preset));
      return preset;
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
