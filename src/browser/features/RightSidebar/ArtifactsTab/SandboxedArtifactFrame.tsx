import { useEffect, useRef, useState, type RefObject } from "react";
import { useTheme } from "@/browser/contexts/ThemeContext";
import {
  toWorkspaceSelection,
  useOptionalWorkspaceMetadata,
  useWorkspaceActionsOptional,
} from "@/browser/contexts/WorkspaceContext";
import { isLightThemeMode } from "@/browser/utils/highlighting/shiki-shared";
import { matchesKeybind } from "@/browser/utils/ui/keybinds";
import { useAppConfig, useUserPreferences } from "@/browser/stores/AppConfigStore";
import type { Keybind } from "@/common/types/keybind";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { WORKSPACE_TURN_TASK_TAGS } from "@/constants/workspaceTags";
import { ARTIFACT_CLICK_SEND_WINDOW_MS } from "@/common/constants/artifactInteractions";
import { getErrorMessage } from "@/common/utils/errors";
import { cn } from "@/common/lib/utils";
import { createArtifactAssetLoader, type ArtifactAssetReader } from "./artifactAssets";
import {
  ARTIFACT_FRAME_CHORDS,
  ARTIFACT_FRAME_INTERRUPT_KEYS,
  acceptArtifactFrameMessage,
  artifactBackdropColor,
  buildArtifactBridgeScript,
  createBridgeRateLimiter,
  postArtifactAnnotateMode,
  postArtifactTheme,
  type ArtifactAppearance,
  type ArtifactFrameChord,
  type ArtifactFrameInterruptKey,
  type ArtifactFrameToHostMessage,
  type ArtifactTheme,
} from "./artifactBridge";
import { buildArtifactCsp } from "./artifactCsp";
import {
  buildSandboxedSvgDocument,
  finalizeSandboxedDocument,
  inlineArtifactHtmlAssets,
  isUnstyledHtmlDocument,
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
  /** The page takes the theme's color scheme (isUnstyledHtmlDocument), so no white backdrop. */
  followsColorScheme: boolean;
}

/**
 * Whether the user's focus is in `frame`. Browsers leave focus on a frame that a `hidden`
 * ancestor stopped rendering, so that focus does not count.
 */
function frameHasFocus(frame: HTMLIFrameElement | null): frame is HTMLIFrameElement {
  return frame != null && document.activeElement === frame && frame.checkVisibility();
}

/**
 * SECURITY AUDIT: gate for `window.xum.openWorkspace`, the frame's "C" (annotate) key and a
 * `window.xum.send` that skips the confirm strip. The artifact's script can post any of them at
 * any time, so the host honours them only while the user's
 * own click or key press inside `frame` is live: focus is on the iframe (a click or Tab into a
 * frame moves the app's activeElement to it; focus on a hidden frame does not count), and the app
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
  return frameHasFocus(frame) && activation?.isActive === true;
}

/**
 * Replays a chord pressed inside `frame` as a keydown on the frame element, so the app's one
 * handler for it applies its own rules: WorkspaceShell's useRightSidebarToggleKey for
 * TOGGLE_RIGHT_SIDEBAR, useArtifactsTabKey for OPEN_ARTIFACTS_TAB, the main pane's Agent interface
 * view handler for TOGGLE_AGENT_INTERFACE_VIEW (from the main pane's status page only, the one
 * frame that forwards it). All keep the dialog block (Artifacts fullscreen is a modal dialog); the
 * sidebar ones also move focus to the toggle after a collapse.
 *
 * SECURITY AUDIT: the artifact's script can post the message without a key press, and can move
 * focus into its own frame with window.focus(). The host honours it only during the user's own
 * key press in the visible frame (hasLiveUserGesture), and the replayed event matches only the
 * named chord's keybind. Otherwise a timer could flip the main pane's view, or the right sidebar
 * under a main-pane status page, over and over, rewriting the stored view choice each time.
 */
function replayFrameSidebarKey(
  frame: HTMLIFrameElement | null,
  message: { chord: ArtifactFrameChord; ctrlKey: boolean; metaKey: boolean }
): void {
  replayKeybindOnFrame(frame, ARTIFACT_FRAME_CHORDS[message.chord], {
    shiftKey: true,
    ctrlKey: message.ctrlKey,
    metaKey: message.metaKey,
  });
}

/**
 * Replays a stream-interrupt key pressed inside `frame` as a keydown on the frame element, so
 * the chat's interrupt handler (useAIViewKeybinds) applies its own rules (compaction, a pending
 * question). Only for the active keybind (`active`, from the Vim setting).
 *
 * SECURITY AUDIT: the artifact's script can post the message at any time, and a page that did
 * so on a timer would stop every turn while its frame shows. So, as for chords, the host honours
 * it only during the user's own gesture in the visible frame (hasLiveUserGesture). Escape grants
 * no user activation (HTML), so a lone Escape interrupts only shortly after the user's last
 * click or key in the page; Ctrl+C grants it itself.
 */
function replayFrameInterruptKey(
  frame: HTMLIFrameElement | null,
  keybind: ArtifactFrameInterruptKey,
  active: ArtifactFrameInterruptKey | undefined
): void {
  if (keybind !== active) return;
  const target: Keybind = ARTIFACT_FRAME_INTERRUPT_KEYS[keybind];
  replayKeybindOnFrame(frame, target, {
    shiftKey: false,
    ctrlKey: target.ctrl === true,
    metaKey: false,
  });
}

function replayKeybindOnFrame(
  frame: HTMLIFrameElement | null,
  keybind: Keybind,
  modifiers: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }
): void {
  if (!hasLiveUserGesture(frame) || frame == null) return;
  const event = new KeyboardEvent("keydown", {
    key: keybind.key,
    ...modifiers,
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
  { type: "key" } | { type: "sidebarKey" } | { type: "interruptKey" }
>;

/** The host side of the keys a frame forwards: keys typed in the frame never reach the app. */
function handleFrameKeyMessage(
  message: ArtifactFrameKeyMessage,
  frame: HTMLIFrameElement | null,
  handlers: {
    onFrameKey: ((key: ArtifactFrameKey) => void) | undefined;
    /** Set only for the main pane's status page (SandboxedArtifactFrame's mainPaneInterruptKey). */
    mainPaneInterruptKey: ArtifactFrameInterruptKey | undefined;
  }
): void {
  if (message.type === "sidebarKey") {
    // Any other frame's shim never forwards the view switch: its page's own script posted it.
    if (message.chord === "agentInterface" && handlers.mainPaneInterruptKey === undefined) return;
    replayFrameSidebarKey(frame, message);
    return;
  }
  if (message.type === "interruptKey") {
    replayFrameInterruptKey(frame, message.keybind, handlers.mainPaneInterruptKey);
    return;
  }
  const { onFrameKey } = handlers;
  // "C" (the annotate shortcut) can turn annotate mode on, so, like openWorkspace, it needs the
  // user's own key press in this frame: the artifact's script could post it at any time.
  // "Escape" and "F" only ever exit, so they need no gesture.
  if (message.key === "C" && !hasLiveUserGesture(frame)) return;
  onFrameKey?.(message.key);
}

type FrameDocument = Pick<BuiltDocument, "srcDoc" | "notices" | "error" | "followsColorScheme">;

/**
 * The sandboxed srcdoc for an HTML/SVG artifact. `bridgeScript` is told whether the page takes
 * the theme's color scheme (an HTML page without styles of its own, isUnstyledHtmlDocument).
 */
async function buildFrameDocument(input: {
  kind: "html" | "svg";
  content: string;
  path: string;
  allowCdn: boolean;
  read: ArtifactAssetReader | null;
  bridgeScript: (followsColorScheme: boolean) => string;
}): Promise<FrameDocument> {
  const csp = buildArtifactCsp({ allowCdn: input.allowCdn });
  if (input.kind === "svg") {
    const options = { csp, bridgeScript: input.bridgeScript(false) };
    const srcDoc = buildSandboxedSvgDocument(input.content, options);
    return { srcDoc, notices: [], error: null, followsColorScheme: false };
  }
  const doc = parseArtifactHtml(input.content);
  const followsColorScheme = isUnstyledHtmlDocument(doc);
  const options = { csp, bridgeScript: input.bridgeScript(followsColorScheme) };
  const loader = createArtifactAssetLoader(input.path, input.read ?? (() => Promise.resolve(null)));
  try {
    const notices = await inlineArtifactHtmlAssets(doc, loader, { allowCdn: input.allowCdn });
    return {
      srcDoc: finalizeSandboxedDocument(doc, options),
      notices,
      error: null,
      followsColorScheme,
    };
  } catch (error) {
    return { srcDoc: null, notices: [], error: getErrorMessage(error), followsColorScheme };
  }
}

/** The frame's window while it still shows our srcdoc; null after it navigated away. */
function liveFrameWindow(
  navigatedRef: RefObject<boolean>,
  frameRef: RefObject<HTMLIFrameElement | null>
): Window | null | undefined {
  return navigatedRef.current ? null : frameRef.current?.contentWindow;
}

/**
 * A page with the theme's scheme paints no canvas of its own, so the backdrop shows: the pane
 * surface (main pane and right sidebar alike), so the page sits seamlessly in the pane. Any other
 * page gets the color it reports (backdropColor), or the browser's default white canvas once it
 * reports none. Before its first report the frame stays clear and the pane shows through, so a
 * dark page does not load over a white flash.
 */
function frameClassName(
  followsColorScheme: boolean,
  annotating: boolean,
  backdropColor: string | null | undefined
): string {
  return cn(
    "min-h-0 w-full flex-1 border-0",
    followsColorScheme ? "bg-surface-primary" : backdropColor === null && "bg-white",
    annotating && "cursor-crosshair"
  );
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
  /**
   * Set only for the main pane's status page, which takes the chat's place: the chat's
   * stream-interrupt keybind, which the frame replays (replayFrameInterruptKey). That frame also
   * forwards the view switch chord, since it shows only while the switch exists.
   */
  mainPaneInterruptKey?: ArtifactFrameInterruptKey;
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
  const { kind, content, path, mainPaneInterruptKey } = props;
  const forwardsViewSwitch = mainPaneInterruptKey !== undefined;
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
  // The canvas color the frame last reported (the bridge's backdrop message): undefined until
  // its first report, null when it paints none. It outlives the document that reported it: a
  // rewritten or reloaded page keeps the previous color until it reports its own (the bridge
  // always reports after load), so a dark page is not followed by a flash of frameClassName's
  // white.
  const [backdropColor, setBackdropColor] = useState<string | null | undefined>(undefined);
  const liveWindow = () => liveFrameWindow(navigatedRef, frameRef);

  useEffect(() => {
    if (waitingForState) return;
    let cancelled = false;
    buildFrameDocument({
      kind,
      content,
      path,
      allowCdn,
      read,
      bridgeScript: (followsColorScheme) =>
        buildArtifactBridgeScript(
          initialTheme,
          state,
          initialAppearance,
          followsColorScheme,
          forwardsViewSwitch
        ),
    })
      .then((frameDocument) => {
        if (!cancelled) setBuilt({ content, allowCdn, state, ...frameDocument });
      })
      .catch((error: unknown) => {
        console.error("[Artifacts] building the frame document failed:", getErrorMessage(error));
      });
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
    forwardsViewSwitch,
  ]);

  // Bridge, host side: only messages from this frame's window, rate limited, schema-valid.
  const onFrameKey = props.onFrameKey;
  const interactions = props.interactions;
  const onAnnotate = props.onAnnotate;
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = acceptArtifactFrameMessage(
        event,
        liveFrameWindow(navigatedRef, frameRef),
        allowMessage
      );
      if (message == null) return;
      switch (message.type) {
        case "key":
        case "sidebarKey":
        case "interruptKey":
          handleFrameKeyMessage(message, frameRef.current, { onFrameKey, mainPaneInterruptKey });
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
        case "backdrop": {
          setBackdropColor(artifactBackdropColor(message.color));
          break;
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [
    allowMessage,
    onFrameKey,
    mainPaneInterruptKey,
    interactions,
    onAnnotate,
    navigatedRef,
    openWorkspace,
  ]);

  const annotating = onAnnotate != null;
  useEffect(() => {
    postArtifactAnnotateMode(liveFrameWindow(navigatedRef, frameRef), annotating);
  }, [annotating, navigatedRef]);

  // Keep the artifact's view of the theme current without reloading it.
  useEffect(() => {
    postArtifactTheme(liveFrameWindow(navigatedRef, frameRef), theme, {
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
        className={frameClassName(current.followsColorScheme, annotating, backdropColor)}
        // SECURITY AUDIT: the frame's script picks this color. It only ever reaches this one CSS
        // property through React's style object, bounded in length, limited to a plain computed
        // color (no var(), url() or keywords) and checked with CSS.supports
        // (artifactBackdropColor). WebKit shows the iframe element's background wherever the
        // page's canvas is not painted (overscroll, a frame that just grew), so it must match
        // the page's own background, not frameClassName's white.
        style={{ backgroundColor: backdropColor ?? undefined }}
        data-testid="artifact-frame"
      />
    </div>
  );
}
