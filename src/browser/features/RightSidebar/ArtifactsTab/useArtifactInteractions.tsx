import { useEffect, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { isAbortError } from "@/browser/utils/isAbortError";
import { getErrorMessage } from "@/common/utils/errors";
import { ArtifactSendStrip, type PendingArtifactSend } from "./ArtifactSendStrip";
import type { ArtifactInteractionHandlers } from "./artifactInteractions";

/** The artifact on screen: `version` null is the live file, `latestVersion` its newest copy. */
export interface ArtifactInteractionTarget {
  path: string;
  version: number | null;
  latestVersion: number | null;
}

/**
 * Host side of artifact interactions for the Artifacts panel (M5b): one pending confirm strip per
 * artifact (sends arriving while it is shown are ignored), the persisted `window.xum.state` of the displayed version,
 * and the handlers the viewer passes to the frame. Returns `handlers: undefined` when nothing
 * interactive is selected (pinned files, MCP Apps views).
 */
export function useArtifactInteractions(
  workspaceId: string,
  target: ArtifactInteractionTarget | null
): { handlers: ArtifactInteractionHandlers | undefined; strip: React.ReactNode } {
  const { api } = useAPI();
  const [pendingByPath, setPendingByPath] = useState<ReadonlyMap<string, PendingArtifactSend>>(
    () => new Map()
  );
  // Per-target `setState` writes: one request in flight, newer states replace the queued one, so
  // concurrent saves cannot land out of order and the last state the frame sent wins.
  const stateWritesRef = useRef(new Map<string, { queued: { state: unknown } | null }>());
  // Paths with a shown strip, updated synchronously so back-to-back sends see it.
  const pendingPathsRef = useRef(new Set<string>());
  const [sendState, setSendState] = useState<{
    path: string;
    sending: boolean;
    error: string | null;
  }>({ path: "", sending: false, error: null });
  // A live view's state follows the newest stored version, so a new version reloads it.
  const stateKey =
    target == null
      ? null
      : `${target.path}\u0000${target.version ?? `live:${target.latestVersion ?? 0}`}`;
  const [loadedState, setLoadedState] = useState<{ key: string; state: unknown } | null>(null);

  const path = target?.path ?? null;
  const version = target?.version ?? null;
  useEffect(() => {
    if (!api || path == null || stateKey == null) return;
    const controller = new AbortController();
    api.artifacts
      .getState({ workspaceId, path, version }, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setLoadedState({ key: stateKey, state: result.success ? result.data.state : null });
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted) return;
        setLoadedState({ key: stateKey, state: null });
      });
    return () => controller.abort();
  }, [api, workspaceId, path, version, stateKey]);

  if (target == null || !api) return { handlers: undefined, strip: null };

  const handlers: ArtifactInteractionHandlers = {
    requestSend: (text, data) => {
      // A shown strip is never replaced, also while its send is in flight: the frame could
      // otherwise swap the text between the user's pointerdown and click, and the earlier send's
      // success would clear the newer prompt. The artifact can send again after Send or Dismiss.
      if (pendingPathsRef.current.has(target.path)) return;
      pendingPathsRef.current.add(target.path);
      // The version shown when the artifact asked, not whichever one is selected at Send time. A
      // live view is pinned to its newest stored version now: null would resolve at Send time and
      // credit a version published while the strip was open.
      const version = target.version ?? target.latestVersion;
      setPendingByPath((prev) => new Map(prev).set(target.path, { text, data, version }));
      setSendState({ path: target.path, sending: false, error: null });
    },
    initialState: loadedState?.key === stateKey ? loadedState.state : undefined,
    setState: (state) => {
      const writes = stateWritesRef.current;
      const writePath = target.path;
      const writeVersion = target.version;
      const key = `${writePath}\u0000${writeVersion ?? "live"}`;
      const active = writes.get(key);
      if (active != null) {
        active.queued = { state };
        return;
      }
      const entry: { queued: { state: unknown } | null } = { queued: null };
      writes.set(key, entry);
      const write = (next: unknown) => {
        // Best effort: a failed save does not stop the queue; the frame keeps its own copy.
        const settle = () => {
          const queued = entry.queued;
          if (queued == null) {
            writes.delete(key);
            return;
          }
          entry.queued = null;
          write(queued.state);
        };
        api.artifacts
          .setState({ workspaceId, path: writePath, version: writeVersion, state: next })
          .then(settle, settle);
      };
      write(state);
    },
  };

  const pending = pendingByPath.get(target.path);
  const clearPending = (forPath: string) => {
    pendingPathsRef.current.delete(forPath);
    setPendingByPath((prev) => {
      const next = new Map(prev);
      next.delete(forPath);
      return next;
    });
  };
  const send = () => {
    if (pending == null) return;
    const forPath = target.path;
    setSendState({ path: forPath, sending: true, error: null });
    api.artifacts
      .sendInteraction({
        workspaceId,
        path: forPath,
        version: pending.version,
        text: pending.text,
        ...(pending.data !== undefined ? { data: pending.data } : {}),
      })
      .then((result) => {
        if (result.success) {
          clearPending(forPath);
          setSendState({ path: forPath, sending: false, error: null });
        } else {
          setSendState({ path: forPath, sending: false, error: result.error });
        }
      })
      .catch((error: unknown) => {
        setSendState({ path: forPath, sending: false, error: getErrorMessage(error) });
      });
  };
  const ownState = sendState.path === target.path ? sendState : { sending: false, error: null };
  const strip =
    pending == null ? null : (
      <ArtifactSendStrip
        pending={pending}
        sending={ownState.sending}
        error={ownState.error}
        onSend={send}
        onDismiss={() => clearPending(target.path)}
      />
    );
  return { handlers, strip };
}
