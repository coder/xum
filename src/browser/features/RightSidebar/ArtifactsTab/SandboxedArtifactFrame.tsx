import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/browser/contexts/ThemeContext";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { isLightThemeMode } from "@/browser/utils/highlighting/shiki-shared";
import { ARTIFACTS_ALLOW_CDN_SCRIPTS_KEY } from "@/common/constants/storage";
import { getErrorMessage } from "@/common/utils/errors";
import { createArtifactAssetLoader } from "./artifactAssets";
import {
  acceptArtifactFrameMessage,
  buildArtifactBridgeScript,
  createBridgeRateLimiter,
  postArtifactAnnotateMode,
  postArtifactTheme,
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
import type { ArtifactInteractionHandlers } from "./artifactInteractions";
import { canBridgeExecutableFrames } from "./executableFrames";
import { FrameNavigatedNotice, useFrameNavigationGuard } from "./frameNavigationGuard";
import { Notice, SourceText } from "./SourceText";
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
  const [allowCdn] = usePersistedState<boolean>(ARTIFACTS_ALLOW_CDN_SCRIPTS_KEY, true, {
    listener: true,
  });
  const { theme: themeMode } = useTheme();
  const theme: ArtifactTheme = isLightThemeMode(themeMode) ? "light" : "dark";
  // Only the theme at mount is baked into the document; later changes travel over the bridge
  // so a theme switch never reloads the artifact.
  const [initialTheme] = useState(theme);
  const [allowMessage] = useState(() => createBridgeRateLimiter());
  const [built, setBuilt] = useState<BuiltDocument | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
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
      bridgeScript: buildArtifactBridgeScript(initialTheme, state),
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
  }, [kind, content, path, allowCdn, initialTheme, read, waitingForState, state]);

  // Bridge, host side: only messages from this frame's window, rate limited, schema-valid.
  // Never outside the desktop app (executableFrames.ts): there a page the frame navigated to
  // could send these too.
  const onFrameKey = props.onFrameKey;
  const interactions = props.interactions;
  const onAnnotate = props.onAnnotate;
  useEffect(() => {
    if (!canBridgeExecutableFrames()) return;
    const handler = (event: MessageEvent) => {
      const message = acceptArtifactFrameMessage(
        event,
        navigatedRef.current ? null : frameRef.current?.contentWindow,
        allowMessage
      );
      if (message == null) return;
      switch (message.type) {
        case "key":
          onFrameKey?.(message.key);
          break;
        case "send":
          // Only fills the host's confirm strip; the user's click sends.
          interactions?.requestSend(message.text, message.data);
          break;
        case "setState":
          interactions?.setState?.(message.state);
          break;
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
  }, [allowMessage, onFrameKey, interactions, onAnnotate, navigatedRef]);

  const annotating = onAnnotate != null;
  useEffect(() => {
    postArtifactAnnotateMode(
      navigatedRef.current ? null : frameRef.current?.contentWindow,
      annotating
    );
  }, [annotating, navigatedRef]);

  // Keep the artifact's view of the theme current without reloading it.
  useEffect(() => {
    postArtifactTheme(navigatedRef.current ? null : frameRef.current?.contentWindow, theme);
  }, [theme, navigatedRef]);

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
          postArtifactTheme(liveWindow(), theme);
          if (annotating) postArtifactAnnotateMode(liveWindow(), true);
        }}
        className={`min-h-0 w-full flex-1 border-0 bg-white ${annotating ? "cursor-crosshair" : ""}`}
        data-testid="artifact-frame"
      />
    </div>
  );
}
