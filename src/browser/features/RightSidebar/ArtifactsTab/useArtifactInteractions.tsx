import { useEffect, useRef, useState } from "react";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import { isAbortError } from "@/browser/utils/isAbortError";
import { KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { getErrorMessage } from "@/common/utils/errors";
import { ArtifactSendStrip, type PendingArtifactSend } from "./ArtifactSendStrip";
import { newConfirmPromptId, useConfirmArmed } from "./confirmArming";
import type { ArtifactInteractionHandlers } from "./artifactInteractions";

/** One artifact's `setState` queue (see stateWrites). */
interface StateWrites {
  queued: { state: unknown } | null;
  drained: Promise<void>;
  /** Set while the queue waits for a connection; sends the queued state through the client. */
  resume: ((client: APIClient) => void) | null;
}

/**
 * Per-artifact `setState` writes (by workspace and path): one request in flight, newer states
 * replace the queued one, so concurrent saves cannot land out of order and the last state the
 * frame sent wins. `drained` settles when the queue empties: a frame rebuild (new version,
 * version switch, Reload) reads the server only after this tab's own writes have landed, so the
 * server stays the one source of truth and no read can return a pre-write state.
 *
 * While Xum reconnects the API is null: writes then wait here, and the next hook that has a
 * client sends them. Module scope, not a ref: the panel unmounts on a tab switch, and a write
 * held by an unmounted panel was lost, so reopening the artifact showed an older state.
 */
const stateWrites = new Map<string, StateWrites>();
/** The client the hooks last saw (null while offline), for a write rejected after a reconnect. */
let connectedClient: APIClient | null = null;

const OFFLINE_SEND_ERROR = "Xum is reconnecting. Send again once it is back.";

/** The artifact on screen: `version` null is the live file, `latestVersion` its newest copy. */
export interface ArtifactInteractionTarget {
  path: string;
  version: number | null;
  latestVersion: number | null;
  /** `latestVersion` is from before a failed refresh: it keys the state, but Send does not use it. */
  latestVersionStale?: boolean;
  /** Bumped when the panel remounts the viewer (Reload): the new frame needs the newest state. */
  reloadTick?: number;
}

/**
 * Host side of artifact interactions for the Artifacts panel (M5b): one pending confirm strip per
 * artifact (sends arriving while it is shown are ignored), the persisted `window.xum.state` of the
 * artifact (one state for all its versions), and the handlers the viewer passes to the frame.
 * Returns `handlers: undefined` when nothing interactive is selected (pinned files, MCP Apps views). `handleKeyDown` runs the strip's
 * shortcuts; the panel calls it for keys pressed inside the panel, and it returns true when it
 * handled the key.
 */
export function useArtifactInteractions(
  workspaceId: string,
  target: ArtifactInteractionTarget | null
): {
  handlers: ArtifactInteractionHandlers | undefined;
  strip: React.ReactNode;
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
} {
  const { api } = useAPI();
  const [pendingByPath, setPendingByPath] = useState<ReadonlyMap<string, PendingArtifactSend>>(
    () => new Map()
  );
  // Sends the writes held while Xum was offline (see stateWrites), on reconnect and on mount.
  useEffect(() => {
    connectedClient = api;
    if (!api) return;
    for (const entry of stateWrites.values()) {
      const resume = entry.resume;
      entry.resume = null;
      resume?.(api);
    }
  }, [api]);
  // Paths with a shown strip, updated synchronously so back-to-back sends see it.
  const pendingPathsRef = useRef(new Set<string>());
  const [sendState, setSendState] = useState<{
    path: string;
    sending: boolean;
    error: string | null;
  }>({ path: "", sending: false, error: null });
  // The state is per artifact, but a new version, a version switch or Reload rebuilds the frame,
  // so the key still changes then: the rebuild must read the newest state, not the first load's.
  const stateKey =
    target == null
      ? null
      : `${target.path}\u0000${target.version ?? `live:${target.latestVersion ?? 0}`}\u0000${target.reloadTick ?? 0}`;
  // `ok` false: the read failed and the frame was built with no state; the next client retries.
  const [loadedState, setLoadedState] = useState<{
    key: string;
    state: unknown;
    ok: boolean;
  } | null>(null);

  const path = target?.path ?? null;
  // Read once per key. A reconnect brings a new client but must not read the state again: the
  // frame owns its state once built, and a new state object would rebuild the frame, dropping
  // whatever the page held.
  // A read the connection drop cut off rejects as an abort and sets nothing, so the frame waits
  // for the new client's read instead of starting empty.
  const stateLoaded = stateKey != null && loadedState?.key === stateKey && loadedState.ok;
  useEffect(() => {
    if (!api || path == null || stateKey == null || stateLoaded) return;
    const controller = new AbortController();
    const pendingWrites = stateWrites.get(`${workspaceId}\u0000${path}`);
    (pendingWrites?.drained ?? Promise.resolve())
      .then(() => {
        if (controller.signal.aborted) return null;
        return api.artifacts.getState({ workspaceId, path }, { signal: controller.signal });
      })
      .then((result) => {
        if (result == null || controller.signal.aborted) return;
        setLoadedState(
          result.success
            ? { key: stateKey, state: result.data.state, ok: true }
            : { key: stateKey, state: null, ok: false }
        );
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted) return;
        setLoadedState({ key: stateKey, state: null, ok: false });
      });
    return () => controller.abort();
  }, [api, workspaceId, path, stateKey, stateLoaded]);

  // Owned here, not by the strip, so the Send shortcut honors the same arming delay as the
  // button (confirmArming.ts).
  const arming = useConfirmArmed(
    target == null ? null : (pendingByPath.get(target.path)?.id ?? null)
  );

  // Not `!api`: the API is null while Xum reconnects, and dropping the handlers then rebuilt the
  // frame without its state. Offline, writes wait in the queue and Send reports the drop.
  if (target == null) {
    return { handlers: undefined, strip: null, handleKeyDown: () => false };
  }

  const handlers: ArtifactInteractionHandlers = {
    requestSend: (text, data) => {
      // A shown strip is never replaced, also while its send is in flight: the frame could
      // otherwise swap the text between the user's pointerdown and click, and the earlier send's
      // success would clear the newer prompt. The artifact can send again after Send or Dismiss.
      if (pendingPathsRef.current.has(target.path)) return;
      pendingPathsRef.current.add(target.path);
      const id = newConfirmPromptId();
      // The version shown when the artifact asked, not whichever one is selected at Send time. A
      // live view is pinned to its newest stored version now: null would resolve at Send time and
      // credit a version published while the strip was open.
      const version =
        target.version ?? (target.latestVersionStale === true ? null : target.latestVersion);
      setPendingByPath((prev) => new Map(prev).set(target.path, { id, text, data, version }));
      setSendState({ path: target.path, sending: false, error: null });
    },
    initialState: loadedState?.key === stateKey ? loadedState.state : undefined,
    setState: (state) => {
      const writes = stateWrites;
      const writePath = target.path;
      const key = `${workspaceId}\u0000${writePath}`;
      const active = writes.get(key);
      if (active != null) {
        active.queued = { state };
        return;
      }
      let markDrained: () => void = () => undefined;
      const drained = new Promise<void>((resolve) => (markDrained = resolve));
      const entry: StateWrites = { queued: { state }, drained, resume: null };
      writes.set(key, entry);
      const writeNext = (client: APIClient | null) => {
        const queued = entry.queued;
        if (queued == null) {
          writes.delete(key);
          markDrained();
          return;
        }
        if (client == null) {
          entry.resume = writeNext;
          return;
        }
        entry.queued = null;
        client.artifacts.setState({ workspaceId, path: writePath, state: queued.state }).then(
          () => writeNext(client),
          (error: unknown) => {
            // A write the connection drop cut off (it rejects as an abort) waits for the next
            // client, unless a newer state replaced it meanwhile. Other failures are best
            // effort, as before: the queue goes on and the frame keeps its own copy.
            if (!isAbortError(error)) {
              writeNext(client);
              return;
            }
            entry.queued ??= queued;
            // The rejection can arrive after the reconnect already resumed the queues.
            writeNext(connectedClient !== client ? connectedClient : null);
          }
        );
      };
      writeNext(api);
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
    if (!api) {
      setSendState({ path: forPath, sending: false, error: OFFLINE_SEND_ERROR });
      return;
    }
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
  // Dismissing while the send is in flight would let a late failure land on a newer strip.
  const dismiss = () => {
    if (!ownState.sending) clearPending(target.path);
  };
  const handleKeyDown = (e: React.KeyboardEvent): boolean => {
    if (pending == null) return false;
    if (matchesKeybind(e, KEYBINDS.SEND_ARTIFACT_MESSAGE)) {
      e.preventDefault();
      // Like the button's press check: an auto-repeat of a chord held since before the strip
      // armed does not send it.
      if (!e.repeat && arming.armed && !ownState.sending) send();
      return true;
    }
    if (matchesKeybind(e, KEYBINDS.DISMISS_ARTIFACT_MESSAGE)) {
      e.preventDefault();
      if (!e.repeat) dismiss();
      return true;
    }
    return false;
  };
  const strip =
    pending == null ? null : (
      <ArtifactSendStrip
        pending={pending}
        arming={arming}
        sending={ownState.sending}
        error={ownState.error}
        onSend={send}
        onDismiss={dismiss}
      />
    );
  return { handlers, strip, handleKeyDown };
}
