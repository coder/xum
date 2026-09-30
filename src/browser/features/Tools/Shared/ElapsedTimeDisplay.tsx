import React, { useEffect, useRef } from "react";

interface ElapsedTimeDisplayProps {
  startedAt: number | undefined;
  isActive: boolean;
  prefix?: string;
  separator?: string;
}

/**
 * Shared elapsed time display for tool headers.
 * Keeps requestAnimationFrame + per-second updates at the leaf so parent tool calls do not re-render.
 *
 * Renders nothing until `startedAt` is known: for tool calls, that is when execute()
 * actually begins running. Parallel tool calls run sequentially, so a queued call has
 * no start time yet and must not show a ticking timer (it could exceed its own timeout).
 */
export const ElapsedTimeDisplay: React.FC<ElapsedTimeDisplayProps> = ({
  startedAt,
  isActive,
  prefix = "",
  separator = " • ",
}) => {
  const elapsedRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
  const baseStart = useRef(startedAt ?? Date.now());

  useEffect(() => {
    if (!isActive || startedAt === undefined) {
      elapsedRef.current = 0;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      return;
    }

    baseStart.current = startedAt;
    let lastSecond = -1;

    const tick = () => {
      const now = Date.now();
      const elapsed = now - baseStart.current;
      const currentSecond = Math.floor(elapsed / 1000);

      // Only update when second changes to minimize renders
      if (currentSecond !== lastSecond) {
        lastSecond = currentSecond;
        elapsedRef.current = elapsed;
        forceUpdate();
      }

      frameRef.current = requestAnimationFrame(tick);
    };

    tick();

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [isActive, startedAt]);

  if (!isActive || startedAt === undefined || elapsedRef.current === 0) {
    return null;
  }

  return (
    <>
      {separator}
      {prefix}
      {Math.round(elapsedRef.current / 1000)}s
    </>
  );
};
