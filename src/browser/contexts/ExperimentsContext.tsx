import React, { createContext, useContext, useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";

interface ExperimentsContextValue {
  designRevision: number;
  /** Whether the backend perf flight recorder is collecting (renderer collects only then). */
  perfFlightRecorderCollecting: boolean;
}

const ExperimentsContext = createContext<ExperimentsContextValue | null>(null);

/** Provider for the backend Claude Design and perf flight recorder status streams. */
export function ExperimentsProvider(props: { children: React.ReactNode }) {
  const apiState = useAPI();
  const [designRevision, setDesignRevision] = useState(0);
  const [perfFlightRecorderCollecting, setPerfFlightRecorderCollecting] = useState(false);

  useEffect(() => {
    if (!apiState.api) {
      setPerfFlightRecorderCollecting(false);
      return;
    }

    const api = apiState.api;
    const controller = new AbortController();
    let cancelled = false;

    const followDesign = async () => {
      let revision = -1;
      try {
        const stream = await api.experiments.onDesignChange(undefined, {
          signal: controller.signal,
        });
        for await (const snapshot of stream) {
          if (cancelled) break;
          if (snapshot.revision < revision) continue;
          revision = snapshot.revision;
          setDesignRevision(snapshot.revision);
        }
      } catch {
        // Keep credential controls accessible on a lost connection; reconnect
        // establishes a fresh subscription and revision domain.
      }
    };
    // The perf flight recorder follows backend status, so a toggle made through the
    // CLI or another client starts or stops this renderer's collection live.
    const followPerfFlightRecorder = async () => {
      try {
        const stream = await api.experiments.onPerfFlightRecorderChange(undefined, {
          signal: controller.signal,
        });
        for await (const status of stream) {
          if (cancelled) break;
          setPerfFlightRecorderCollecting(status.state === "collecting");
        }
      } catch {
        // Fall through: without the authoritative status the renderer must not collect.
      }
      if (!cancelled) setPerfFlightRecorderCollecting(false);
    };
    followDesign().catch(() => undefined);
    followPerfFlightRecorder().catch(() => undefined);

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [apiState.api]);

  return (
    <ExperimentsContext.Provider
      value={{
        designRevision,
        perfFlightRecorderCollecting,
      }}
    >
      {props.children}
    </ExperimentsContext.Provider>
  );
}

/** True while the backend perf flight recorder collects; the renderer side follows it. */
export function usePerfFlightRecorderCollecting(): boolean {
  return useContext(ExperimentsContext)?.perfFlightRecorderCollecting ?? false;
}

/** Settings revisions also cover sibling Disconnect, source, and allowlist changes. */
export function useClaudeDesignRevision(): number {
  return useContext(ExperimentsContext)?.designRevision ?? 0;
}
