import { useRef } from "react";
import { useAPI } from "@/browser/contexts/API";
import { getAppConfigStore, useAppConfig } from "@/browser/stores/AppConfigStore";
import {
  RUNTIME_ENABLEMENT_IDS,
  normalizeRuntimeEnablement,
  type RuntimeEnablement,
  type RuntimeEnablementId,
} from "@/common/types/runtime";

interface RuntimeEnablementState {
  enablement: RuntimeEnablement;
  setRuntimeEnabled: (
    id: RuntimeEnablementId,
    enabled: boolean,
    nextDefaultRuntime?: RuntimeEnablementId | null
  ) => void;
  defaultRuntime: RuntimeEnablementId | null;
  setDefaultRuntime: (id: RuntimeEnablementId | null) => void;
}

function normalizeDefaultRuntime(value: unknown): RuntimeEnablementId | null {
  if (typeof value !== "string") {
    return null;
  }

  return RUNTIME_ENABLEMENT_IDS.includes(value as RuntimeEnablementId)
    ? (value as RuntimeEnablementId)
    : null;
}

export function useRuntimeEnablement(): RuntimeEnablementState {
  const { api } = useAPI();
  const store = getAppConfigStore();
  const rawEnablement = useAppConfig((config) => config.runtimeEnablement);
  const rawDefaultRuntime = useAppConfig((config) => config.defaultRuntime);

  // Normalize persisted values so corrupted/legacy payloads don't break toggles.
  // Stabilize the reference: normalizeRuntimeEnablement returns a fresh object every call,
  // so we use a ref to return the same object when the values haven't changed. This prevents
  // downstream effects from re-running on every render.
  const normalized = normalizeRuntimeEnablement(rawEnablement);
  const enablementRef = useRef(normalized);
  const prevSerializedRef = useRef(JSON.stringify(normalized));
  const currentSerialized = JSON.stringify(normalized);
  if (currentSerialized !== prevSerializedRef.current) {
    enablementRef.current = normalized;
    prevSerializedRef.current = currentSerialized;
  }
  const enablement = enablementRef.current;
  const defaultRuntime = normalizeDefaultRuntime(rawDefaultRuntime);

  const setRuntimeEnabled = (
    id: RuntimeEnablementId,
    enabled: boolean,
    nextDefaultRuntime?: RuntimeEnablementId | null
  ) => {
    const nextMap: RuntimeEnablement = {
      ...enablement,
      [id]: enabled,
    };

    const payload: {
      runtimeEnablement: RuntimeEnablement;
      defaultRuntime?: RuntimeEnablementId | null;
    } = { runtimeEnablement: nextMap };

    if (nextDefaultRuntime !== undefined) {
      payload.defaultRuntime = nextDefaultRuntime;
    }

    store.updateOptimistically(payload);
    api?.config?.updateRuntimeEnablement(payload).catch(() => {
      void store.refresh();
    });
  };

  const setDefaultRuntime = (id: RuntimeEnablementId | null) => {
    store.updateOptimistically({ defaultRuntime: id });
    api?.config?.updateRuntimeEnablement({ defaultRuntime: id }).catch(() => {
      void store.refresh();
    });
  };

  return { enablement, setRuntimeEnabled, defaultRuntime, setDefaultRuntime };
}
