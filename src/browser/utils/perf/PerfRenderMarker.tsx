import React, { useLayoutEffect, useRef } from "react";
import { recordSyntheticReactRenderSample } from "./reactProfileCollector";

/**
 * Records production-bundle render timings for perf scenarios.
 *
 * React's Profiler callbacks are unavailable in the production bundle used by
 * Electron perf tests, so render-sensitive subtrees opt into this lightweight
 * marker instead. It is inert unless MUX_PROFILE_REACT=1.
 */
export function usePerfRenderMarker(id: string): void {
  const renderStartTimeRef = useRef(performance.now());
  renderStartTimeRef.current = performance.now();
  const hasProfiledMountRef = useRef(false);

  useLayoutEffect(() => {
    if (window.api?.enableReactPerfProfile !== true) {
      return;
    }

    const commitTime = performance.now();
    const actualDuration = Math.max(0, commitTime - renderStartTimeRef.current);
    const phase = hasProfiledMountRef.current ? "update" : "mount";
    hasProfiledMountRef.current = true;

    recordSyntheticReactRenderSample({
      id,
      phase,
      actualDuration,
      baseDuration: actualDuration,
      startTime: renderStartTimeRef.current,
      commitTime,
    });
  });
}

export function PerfRenderMarker(props: {
  id: string;
  children: React.ReactNode;
}): React.ReactElement {
  usePerfRenderMarker(props.id);
  return <>{props.children}</>;
}
