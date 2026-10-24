import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/browser/contexts/ThemeContext";
import {
  toWorkspaceSelection,
  useOptionalWorkspaceMetadata,
  useWorkspaceActionsOptional,
} from "@/browser/contexts/WorkspaceContext";
import { isLightThemeMode } from "@/browser/utils/highlighting/shiki-shared";
import { matchesKeybind } from "@/browser/utils/ui/keybinds";
import { useAppConfig, useUserPreferences } from "@/browser/stores/AppConfigStore";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { WORKSPACE_TURN_TASK_TAGS } from "@/constants/workspaceTags";
import { ARTIFACT_CLICK_SEND_WINDOW_MS } from "@/common/constants/artifactInteractions";
import { getErrorMessage } from "@/common/utils/errors";
import { createArtifactAssetLoader } from "./artifactAssets";
import {
  ARTIFACT_FRAME_CHORDS,
  acceptArtifactFrameMessage,
  buildArtifactBridgeScript,
  createBridgeRateLimiter,
  postArtifactAnnotateMode,
  postArtifactTheme,
  type ArtifactAppearance,
  type ArtifactFrameChord,
  type ArtifactFrameToHostMessage,
  type ArtifactTheme,
} from "./artifactBridge";
import { buildArtifactCsp } from "./artifactCsp";
import {
  buildSandboxedSvgDocument,
  finalizeSandboxedDocument,
  inlineArtifactHtmlAssets,
  parseArtifactHtml,
} from "./artifactDocument";
import { pickFromFrameAnnotation, type ArtifactAnnotationPick } from "./artifactAnnotation";
import type { ArtifactInteractionHandlers, ArtifactSendOrigin } from "./artifactInteractions";
import { FrameNavigatedNotice, useFrameNavigationGuard } from "./frameNavigationGuard";
import { Notice, SourceText } from "./SourceText";
import { readAppStyleVariables } from "./appStyleVariables";
import { useArtifactAssetReader } from "./useArtifactAssetReader";

/**
 * SECURITY AUDIT: the only value allowed in the iframe's sandbox attribute. Never add
 * allow-same-origin (would give the artifact the app's origin, storage and API), and never
 * allow-top-navigation, allow-popups-to-escape-sandbox or allow-forms.
 */
export const ARTIFACT_IFRAME_SANDBOX = "allow-scripts";

export type ArtifactFrameKey = Extract<ArtifactFrameToHostMessage, { type: "key" }>["key"];

interface BuiltDocument {
  content: string;
  allowCdn: boolean;
  /** The persisted state baked into the shim (compared by identity). */
  state: unknown;
  srcDoc: string | null;
  notices: string[];
  error: string | null;
}

/**
 * SECURITY AUDIT: gate for `window.xum.openWorkspace`, the frame's "C" (annotate) key and a
 * `window.xum.send` that skips the confirm strip. The artifact's script can post any of them at
 * any time, so the host honours them only while the user's
 * own click or key press inside `frame` is live: focus is on the iframe (a click or Tab into a
 * frame moves the app's activeElement to it, and a hidden frame cannot hold focus), and the app
 * has transient user activation (a gesture in a child frame also activates its ancestors). Each check alone is not enough: typing in the
 * composer also activates the app, and focus stays on the frame long after the click.
 * No confirm strip for openWorkspace: a switch sends nothing and reveals nothing to the frame,
 * the user can switch back, and the right sidebar is keyed by workspace, so the switch unmounts
 * this frame. A send skips the strip only through this gate and only once per click
 * (ARTIFACT_CLICK_SEND_WINDOW_MS): the user asked for one click, not two, to send from an
 * artifact. The gate cannot tell a click handler from a timer that fires soon after the click,
 * so the message text is page data the user did not review (the agent is told so).
 */
function hasLiveUserGesture(frame: HTMLIFrameElement | null): boolean {
  const activation = (navigator as Navigator & { userActivation?: { isActive?: boolean } })
    .userActivation;
  return frame != null && document.activeElement === frame && activation?.isActive === true;
}

/**
 * Replays a chord pressed inside `frame` as a keydown on the frame element, so the app's one
 * handler for it applies its own rules: WorkspaceShell's useRightSidebarToggleKey for
 * TOGGLE_RIGHT_SIDEBAR, useArtifactsTabKey for OPEN_ARTIFACTS_TAB, the main pane's Agent interface
 * view handler for TOGGLE_AGENT_INTERFACE_VIEW. All keep the dialog block (Artifacts fullscreen is
 * a modal dialog); the sidebar ones also move focus to the toggle after a collapse.
 *
 * SECURITY AUDIT: the artifact's script can post the message without a key press. The host
 * honours it only while the frame holds focus (a hidden frame cannot), and the replayed event
 * matches only the named chord's keybind. In the right sidebar's Artifacts tab, the sidebar chords
 * can only collapse the sidebar, which unmounts the frame: OPEN_ARTIFACTS_TAB collapses a sidebar
 * that shows that tab, and where a collapse refuses it selects the tab that already shows. The
 * Agent interface chord only switches the main pane between the status page and the transcript,
 * the same as the visible toggle. Like Escape, they need no live gesture.
 */
function replayFrameSidebarKey(
  frame: HTMLIFrameElement | null,
  message: { chord: ArtifactFrameChord; ctrlKey: boolean; metaKey: boolean }
): void {
  if (frame == null || document.activeElement !== frame) return;
  const keybind = ARTIFACT_FRAME_CHORDS[message.chord];
  const event = new KeyboardEvent("keydown", {
    key: keybind.key,
    shiftKey: true,
    ctrlKey: message.ctrlKey,
    metaKey: message.metaKey,
    bubbles: true,
    cancelable: true,
  });
  // The frame's script can post any modifiers, so the host matches the keybind itself.
  if (!matchesKeybind(event, keybind)) return;
  frame.dispatchEvent(event);
}

/**
 * The origin of a `window.xum.send` from `frame`: "click" during a live user gesture there
 * (hasLiveUserGesture), at most once per ARTIFACT_CLICK_SEND_WINDOW_MS, else "ask" (the strip).
 * `lastClickSendAt` holds when this frame last sent as a click; a "click" result updates it.
 */
function takeFrameSendOrigin(
  frame: HTMLIFrameElement | null,
  lastClickSendAt: { current: number | null },
  now = Date.now()
): ArtifactSendOrigin {
  if (!hasLiveUserGesture(frame)) return "ask";
  const last = lastClickSendAt.current;
  if (last != null && now - last < ARTIFACT_CLICK_SEND_WINDOW_MS) return "ask";
  lastClickSendAt.current = now;
  return "click";
}

type ArtifactFrameKeyMessage = Extract<
  ArtifactFrameToHostMessage,
  { type: "key" } | { type: "sidebarKey" }
>;

/** The host side of the keys a frame forwards: keys typed in the frame never reach the app. */
function handleFrameKeyMessage(
  message: ArtifactFrameKeyMessage,
  frame: HTMLIFrameElement | null,
  onFrameKey: ((key: ArtifactFrameKey) => void) | undefined
): void {
  if (message.type === "sidebarKey") {
    replayFrameSidebarKey(frame, message);
    return;
  }
  // "C" (the annotate shortcut) can turn annotate mode on, so, like openWorkspace, it needs the
  // user's own key press in this frame: the artifact's script could post it at any time.
  // "Escape" and "F" only ever exit, so they need no gesture.
  if (message.key === "C" && !hasLiveUserGesture(frame)) return;
  onFrameKey?.(message.key);
}

/**
 * The workspace an artifact names: a workspace ID (sub-agent task IDs are workspace IDs), or a
 * workspace-turn task handle (`wst_...`), which tags the workspace it created, as the task
 * tool's Open resolves it (TaskToolCall.tsx).
 */
function findArtifactWorkspace(
  workspaces: ReadonlyMap<string, FrontendWorkspaceMetadata> | undefined,
  id: string
): FrontendWorkspaceMetadata | undefined {
  const direct = workspaces?.get(id);
  if (direct != null) return direct;
  for (const metadata of workspaces?.values() ?? []) {
    if (metadata.tags?.[WORKSPACE_TURN_TASK_TAGS.handle] === id) return metadata;
  }
  return undefined;
}

/** Denied until the saved preferences load, so a user who turned CDN scripts off never runs one. */
export function useArtifactsAllowCdnScripts(): boolean {
  const loaded = useAppConfig((config) => config.userPreferences !== undefined);
  const allowed = useUserPreferences((preferences) => preferences.ui?.artifactsAllowCdnScripts);
  return loaded && (allowed ?? true);
}

/**
 * Host side of `window.xum.openWorkspace`: switch the app to the workspace an artifact names,
 * or show a notice when that workspace is not available. Callers check the user's gesture
 * first (hasLiveUserGesture).
 */
function useArtifactWorkspaceOpener() {
  // Targets: the app's active workspaces (archived ones are not in the map).
  // Optional contexts: hosts without the workspace shell (the VS Code webview) open nothing.
  const workspaces = useOptionalWorkspaceMetadata()?.workspaceMetadata;
  const setSelectedWorkspace = useWorkspaceActionsOptional()?.setSelectedWorkspace;
  const [openWorkspaceRefused, setOpenWorkspaceRefused] = useState(false);
  const openWorkspace = (workspaceId: string) => {
    const target = findArtifactWorkspace(workspaces, workspaceId);
    if (
      target == null ||
      setSelectedWorkspace == null ||
      isWorkspaceArchived(target.archivedAt, target.unarchivedAt)
    ) {
      setOpenWorkspaceRefused(true);
      return;
    }
    setOpenWorkspaceRefused(false);
    // The same navigation the sidebar and the task tool's Open use.
    setSelectedWorkspace(toWorkspaceSelection(target));
  };
  return { openWorkspace, openWorkspaceRefused };
}

/**
 * HTML and SVG artifacts in a sandboxed iframe (srcdoc + CSP + postMessage bridge).
 * This is the app's only iframe for agent-written content; see artifactCsp.ts,
 * artifactDocument.ts and artifactBridge.ts for the layered rules.
 */
export function SandboxedArtifactFrame(props: {
  /** null: no relative assets (see useArtifactAssetReader). */
  workspaceId: string | null;
  path: string;
  kind: "html" | "svg";
  content: string;
  onFrameKey?: (key: ArtifactFrameKey) => void;
  /** send/setState from the artifact (M5b); without it both are ignored. */
  interactions?: ArtifactInteractionHandlers;
  /** Set only while annotate mode is on: pins clicked inside the frame (M5b). */
  onAnnotate?: (pick: ArtifactAnnotationPick) => void;
}) {
  const read = useArtifactAssetReader(props.workspaceId);
  const allowCdn = useArtifactsAllowCdnScripts();
  const { theme: themeMode } = useTheme();
  const theme: ArtifactTheme = isLightThemeMode(themeMode) ? "light" : "dark";
  // Only the theme at mount is baked into the document; later changes travel over the bridge
  // so a theme switch never reloads the artifact.
  const [initialTheme] = useState(theme);
  // The palette (`--xum-*`) follows the full theme mode: light and flexoki-light differ.
  const currentAppearance = (): ArtifactAppearance => ({
    themeName: themeMode,
    variables: readAppStyleVariables("xum"),
  });
  const [initialAppearance] = useState(currentAppearance);
  const [allowMessage] = useState(() => createBridgeRateLimiter());
  const [built, setBuilt] = useState<BuiltDocument | null>(null);
  const { openWorkspace, openWorkspaceRefused } = useArtifactWorkspaceOpener();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // When this frame last sent without the strip (see ARTIFACT_CLICK_SEND_WINDOW_MS).
  const lastClickSendAtRef = useRef<number | null>(null);
  const { kind, content, path } = props;
  // SECURITY AUDIT: the persisted state goes into the srcdoc, never through postMessage (which
  // must target "*" and could reach a page the frame navigated to). So an interactive artifact
  // is built only once its state is known; `undefined` means it is still loading.
  const initialState = props.interactions?.initialState;
  const waitingForState = props.interactions != null && initialState === undefined;
  const state = initialState ?? null;
  const current =
    built?.content === content && built.allowCdn === allowCdn && built.state === state
      ? built
      : null;
  const guard = useFrameNavigationGuard(current?.srcDoc ?? null);
  const { navigatedRef } = guard;
  // The frame's window while it still shows our srcdoc; null after it navigated away.
  const liveWindow = () => (navigatedRef.current ? null : frameRef.current?.contentWindow);

  useEffect(() => {
    if (waitingForState) return;
    let cancelled = false;
    const options = {
      csp: buildArtifactCsp({ allowCdn }),
      bridgeScript: buildArtifactBridgeScript(initialTheme, state, initialAppearance),
    };
    const finish = (srcDoc: string | null, notices: string[], error: string | null = null) => {
      if (!cancelled) setBuilt({ content, allowCdn, state, srcDoc, notices, error });
    };
    if (kind === "svg") {
      finish(buildSandboxedSvgDocument(content, options), []);
    } else {
      const doc = parseArtifactHtml(content);
      const loader = createArtifactAssetLoader(path, read ?? (() => Promise.resolve(null)));
      inlineArtifactHtmlAssets(doc, loader, { allowCdn })
        .then((notices) => finish(finalizeSandboxedDocument(doc, options), notices))
        .catch((error: unknown) => finish(null, [], getErrorMessage(error)));
    }
    return () => {
      cancelled = true;
    };
  }, [
    kind,
    content,
    path,
    allowCdn,
    initialTheme,
    initialAppearance,
    read,
    waitingForState,
    state,
  ]);

  // Bridge, host side: only messages from this frame's window, rate limited, schema-valid.
  const onFrameKey = props.onFrameKey;
  const interactions = props.interactions;
  const onAnnotate = props.onAnnotate;
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = acceptArtifactFrameMessage(
        event,
        navigatedRef.current ? null : frameRef.current?.contentWindow,
        allowMessage
      );
      if (message == null) return;
      switch (message.type) {
        case "key":
        case "sidebarKey":
          handleFrameKeyMessage(message, frameRef.current, onFrameKey);
          break;
        case "send":
          // A live click or key in this frame sends at once, one message per click; any other
          // send asks in the host's confirm strip.
          interactions?.requestSend(
            message.text,
            message.data,
            takeFrameSendOrigin(frameRef.current, lastClickSendAtRef)
          );
          break;
        case "setState":
          interactions?.setState?.(message.state);
          break;
        case "openWorkspace": {
          // Like send/setState, only for interactive artifacts: pinned checkout files and shelf
          // copies stay read-only. Ignored without a gesture, with no notice, so a script cannot
          // spam the notice either.
          if (interactions == null || !hasLiveUserGesture(frameRef.current)) break;
          openWorkspace(message.workspaceId);
          break;
        }
        case "annotate": {
          // Only honoured while annotate mode is on, whatever the frame claims.
          const frame = frameRef.current;
          if (onAnnotate == null || frame == null) break;
          onAnnotate(pickFromFrameAnnotation(message, frame.getBoundingClientRect()));
          break;
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [allowMessage, onFrameKey, interactions, onAnnotate, navigatedRef, openWorkspace]);

  const annotating = onAnnotate != null;
  useEffect(() => {
    postArtifactAnnotateMode(
      navigatedRef.current ? null : frameRef.current?.contentWindow,
      annotating
    );
  }, [annotating, navigatedRef]);

  // Keep the artifact's view of the theme current without reloading it.
  useEffect(() => {
    postArtifactTheme(navigatedRef.current ? null : frameRef.current?.contentWindow, theme, {
      themeName: themeMode,
      variables: readAppStyleVariables("xum"),
    });
  }, [theme, themeMode, navigatedRef]);

  if (current == null) return <Notice>Loading…</Notice>;
  if (current.error != null) return <div className="text-danger p-4 text-xs">{current.error}</div>;
  if (current.srcDoc == null) {
    return <SourceText content={content} note="Not a valid SVG document; showing the source." />;
  }
  if (guard.navigated) return <FrameNavigatedNotice onReload={guard.reload} />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {current.notices.length > 0 && (
        <ul className="text-muted border-border-light max-h-20 shrink-0 overflow-auto border-b px-3 py-1.5 text-[11px]">
          {current.notices.map((notice) => (
            <li key={notice} className="break-all">
              {notice}
            </li>
          ))}
        </ul>
      )}
      {openWorkspaceRefused && (
        <div
          role="status"
          className="text-muted border-border-light shrink-0 border-b px-3 py-1.5 text-[11px]"
          data-testid="artifact-open-workspace-notice"
        >
          This artifact tried to open a workspace that is not available.
        </div>
      )}
      {/* SECURITY AUDIT: agent-written HTML/SVG sink. sandbox stays exactly
          ARTIFACT_IFRAME_SANDBOX (opaque origin, scripts only), srcdoc always carries the CSP
          meta as the first <head> child, and no auth tokens, paths or env reach the frame. */}
      <iframe
        key={guard.frameKey}
        ref={frameRef}
        title={path}
        sandbox={ARTIFACT_IFRAME_SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={current.srcDoc}
        onLoad={() => {
          // A second load is the frame navigating away: never re-post into it.
          if (!guard.onLoad()) return;
          postArtifactTheme(liveWindow(), theme, currentAppearance());
          if (annotating) postArtifactAnnotateMode(liveWindow(), true);
        }}
        className={`min-h-0 w-full flex-1 border-0 bg-white ${annotating ? "cursor-crosshair" : ""}`}
        data-testid="artifact-frame"
      />
    </div>
  );
}
