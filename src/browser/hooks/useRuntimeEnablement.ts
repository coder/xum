import { useRef } from "react";
import { useAPI } from "@/browser/contexts/API";
import { saveConfigOptimistically, useAppConfig } from "@/browser/stores/AppConfigStore";
import {
  normalizeRuntimeEnablement,
  type RuntimeEnablement,
  type RuntimeEnablementId,
} from "@/common/types/runtime";
import { normalizeIsolationChoice, type IsolationChoice } from "@/common/types/isolation";

interface RuntimeEnablementPatch {
  runtimeEnablement?: RuntimeEnablement;
  defaultIsolation?: IsolationChoice | null;
}

interface RuntimeEnablementState {
  enablement: RuntimeEnablement;
  setRuntimeEnabled: (
    id: RuntimeEnablementId,
    enabled: boolean,
    nextDefaultIsolation?: IsolationChoice | null
  ) => void;
  defaultIsolation: IsolationChoice | null;
  setDefaultIsolation: (choice: IsolationChoice | null) => void;
}

export function useRuntimeEnablement(): RuntimeEnablementState {
  const { api } = useAPI();
  const rawEnablement = useAppConfig((config) => config.runtimeEnablement);
  const rawDefaultIsolation = useAppConfig((config) => config.defaultIsolation);

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
  const defaultIsolation = normalizeIsolationChoice(rawDefaultIsolation) ?? null;

  const persist = (payload: RuntimeEnablementPatch) => {
    saveConfigOptimistically(api, payload, (client) =>
      client.config.updateRuntimeEnablement(payload)
    );
  };

  const setRuntimeEnabled = (
    id: RuntimeEnablementId,
    enabled: boolean,
    nextDefaultIsolation?: IsolationChoice | null
  ) => {
    const nextMap: RuntimeEnablement = {
      ...enablement,
      [id]: enabled,
    };

    const payload: RuntimeEnablementPatch = { runtimeEnablement: nextMap };

    if (nextDefaultIsolation !== undefined) {
      payload.defaultIsolation = nextDefaultIsolation;
    }

    persist(payload);
  };

  const setDefaultIsolation = (choice: IsolationChoice | null) => {
    persist({ defaultIsolation: choice });
  };

  return { enablement, setRuntimeEnabled, defaultIsolation, setDefaultIsolation };
}
