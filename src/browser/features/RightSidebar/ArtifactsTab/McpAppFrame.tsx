import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { useAPI } from "@/browser/contexts/API";
import { useTheme } from "@/browser/contexts/ThemeContext";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { isLightThemeMode } from "@/browser/utils/highlighting/shiki-shared";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { ARTIFACTS_ALLOW_CDN_SCRIPTS_KEY } from "@/common/constants/storage";
import type { McpAppView } from "@/common/orpc/schemas/mcpApps";
import { getErrorMessage } from "@/common/utils/errors";
import { createBridgeRateLimiter, passesFrameGate } from "./artifactBridge";
import { finalizeSandboxedDocument, parseArtifactHtml } from "./artifactDocument";
import { buildMcpAppCsp, grantMcpAppCsp, MCP_APP_PREAMBLE_SCRIPT } from "./mcpAppCsp";
import {
  createMcpAppHost,
  type McpAppConsentRequest,
  type McpAppHost,
  type McpAppHostContext,
} from "./mcpAppHost";
import { closeMcpAppView, type McpAppViewRef } from "./mcpAppViewsStore";
import { newConfirmPromptId, useConfirmArmed } from "./confirmArming";
import { FrameNavigatedNotice, useFrameNavigationGuard } from "./frameNavigationGuard";
import { ARTIFACT_IFRAME_SANDBOX } from "./SandboxedArtifactFrame";
import { Notice, NoteBar } from "./SourceText";

// Spec style variable -> the app's CSS variable it is read from (globals.css). Values are
// sent to the view as data; the host never injects CSS into the frame.
const STYLE_VARIABLES: Record<string, string> = {
  "--color-background-primary": "--color-background",
  "--color-background-secondary": "--color-background-secondary",
  "--color-text-primary": "--color-foreground",
  "--color-text-secondary": "--color-muted",
  "--color-border-primary": "--color-border",
  "--color-border-secondary": "--color-border-light",
  "--color-text-info": "--color-accent",
  "--color-text-danger": "--color-danger",
  "--color-text-success": "--color-success",
  "--font-sans": "--font-primary",
  "--font-mono": "--font-monospace",
  "--border-radius-md": "--radius",
};

/**
 * The spec's responsive hint: the desktop app, a phone (the same narrow touch query the
 * workspace shell uses), or any other browser.
 */
function hostPlatform(): McpAppHostContext["platform"] {
  if (isDesktopMode()) return "desktop";
  return window.matchMedia("(max-width: 768px) and (pointer: coarse)").matches ? "mobile" : "web";
}

function readStyleVariables(): Record<string, string> {
  const computed = window.getComputedStyle(document.documentElement);
  const variables: Record<string, string> = {};
  for (const [specName, appName] of Object.entries(STYLE_VARIABLES)) {
    const value = computed.getPropertyValue(appName).trim();
    if (value) variables[specName] = value;
  }
  return variables;
}

/**
 * The arguments an allowed tool call sends, in full; null when there are none. Never truncated:
 * the host declines calls whose arguments are too large to review (mcpAppHost.ts).
 */
function consentArgsJson(args: Record<string, unknown>): string | null {
  if (Object.keys(args).length === 0) return null;
  return JSON.stringify(args, null, 2);
}

interface Loaded {
  toolCallId: string;
  view: McpAppView | null;
  error: string | null;
}

interface PendingConsent {
  id: number;
  request: McpAppConsentRequest;
  resolve: (allowed: boolean) => void;
}

/** Question and confirm/decline labels of the host strip for one request. */
function consentText(request: McpAppConsentRequest): [string, string, string] {
  switch (request.kind) {
    case "tool":
      // The view chooses the tool name, so it is shown escaped (escapeControls); the call
      // itself still uses the name as given.
      return [
        `Allow ${escapeControls(request.toolName, NAME_CONTROLS)} from ${request.serverName}?`,
        "Allow",
        "Deny",
      ];
    case "link":
      return [`Open a link to ${request.host}?`, "Open", "Cancel"];
    case "message":
      return ["Insert into message?", "Insert", "Dismiss"];
  }
}

function McpAppViewHeader(props: { serverName: string; onClose: () => void }) {
  return (
    <div className="border-border-light flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[11px]">
      <span className="text-muted min-w-0 flex-1 truncate">
        App view from <span className="text-foreground">{props.serverName}</span>
      </span>
      <TooltipIfPresent tooltip="Close view">
        <button
          type="button"
          aria-label="Close view"
          onClick={props.onClose}
          className="text-muted hover:text-foreground flex h-5 w-5 items-center justify-center rounded"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </TooltipIfPresent>
    </div>
  );
}

/**
 * An MCP Apps view (artifacts experiment) in the Artifacts tab: the server's ui:// HTML in the
 * same sandbox as HTML artifacts, talking JSON-RPC to the host (mcpAppHost.ts).
 *
 * SECURITY AUDIT: a single opaque-origin srcdoc iframe (sandbox exactly "allow-scripts", never
 * allow-same-origin). The spec's double-iframe proxy exists so web hosts can give a view an
 * origin other than their own; a sandboxed srcdoc frame already has a unique opaque origin, so
 * it cannot reach the app's DOM, storage, cookies or API, and no proxy frame is needed (the
 * desktop-host model). Messages are accepted only from this frame's window, rate limited and
 * zod-validated; tool calls go only to the view's own server through the backend, which
 * enforces visibility and consent.
 */
export function McpAppFrame(props: { workspaceId: string; view: McpAppViewRef }) {
  const { api } = useAPI();
  const [allowCdn] = usePersistedState<boolean>(ARTIFACTS_ALLOW_CDN_SCRIPTS_KEY, true, {
    listener: true,
  });
  const { theme: themeMode } = useTheme();
  const theme: "light" | "dark" = isLightThemeMode(themeMode) ? "light" : "dark";
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [consent, setConsent] = useState<PendingConsent | null>(null);
  // Set synchronously with `consent`, so a request arriving before the re-render sees the strip.
  const consentRef = useRef<PendingConsent | null>(null);
  const consentArming = useConfirmArmed(consent?.id ?? null);
  const [height, setHeight] = useState<number | null>(null);
  const [allowMessage] = useState(() => createBridgeRateLimiter());
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<McpAppHost | null>(null);
  const { workspaceId, view } = props;
  const { toolCallId, serverName, resourceUri } = view;

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    api.mcpApps
      .getView({ workspaceId, toolCallId, serverName, resourceUri }, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setLoaded(
          result.success
            ? { toolCallId, view: result.data, error: null }
            : { toolCallId, view: null, error: result.error }
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoaded({ toolCallId, view: null, error: getErrorMessage(error) });
        }
      });
    return () => controller.abort();
  }, [api, workspaceId, toolCallId, serverName, resourceUri]);

  const current = loaded?.toolCallId === toolCallId ? loaded : null;
  const grant = current?.view ? grantMcpAppCsp(current.view.csp, { allowCdn }) : null;
  const srcDoc =
    current?.view && grant
      ? finalizeSandboxedDocument(parseArtifactHtml(current.view.html), {
          csp: buildMcpAppCsp(grant.granted),
          bridgeScript: MCP_APP_PREAMBLE_SCRIPT,
        })
      : null;
  const guard = useFrameNavigationGuard(srcDoc);
  const { navigatedRef } = guard;
  // The result record binds the view to the call that produced it (server, server-local tool
  // name, sanitized arguments); the card's display values are only a fallback without one.
  const boundServerName = current?.view?.invocation?.serverName ?? serverName;

  // Values the long-lived host reads at message time.
  const latest = useRef({ theme, view, result: current?.view ?? null });
  useEffect(() => {
    latest.current = { theme, view, result: current?.view ?? null };
  });

  useEffect(() => {
    if (srcDoc == null || grant == null || !api || guard.navigated) return;
    const getHostContext = (): McpAppHostContext => ({
      theme: latest.current.theme,
      styles: { variables: readStyleVariables() },
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      containerDimensions: {
        width: containerRef.current?.clientWidth ?? 0,
        maxHeight: containerRef.current?.clientHeight ?? 0,
      },
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      platform: hostPlatform(),
      toolInfo: {
        id: latest.current.view.toolCallId,
        tool: {
          name: latest.current.result?.invocation?.toolName ?? latest.current.view.toolName,
          title: latest.current.view.label,
        },
      },
    });
    const host = createMcpAppHost({
      // Shown in consent prompts: the card's sanitized display key, never the raw bound key
      // (repo-defined keys can carry bidi/control characters). Tool calls use the raw key.
      serverName,
      grantedCsp: grant.granted,
      // Never into a frame that navigated away from the view (frameNavigationGuard.tsx).
      postToView: (message) => {
        if (!navigatedRef.current) frameRef.current?.contentWindow?.postMessage(message, "*");
      },
      getHostContext,
      callTool: async (toolName, args, consented) => {
        const result = await api.mcpApps.callTool({
          workspaceId,
          serverName: boundServerName,
          toolName,
          arguments: args,
          consented,
        });
        if (!result.success) throw new Error(result.error);
        return result.data;
      },
      requestConsent: (request) =>
        new Promise<boolean>((resolve) => {
          // One strip at a time, and a shown strip is never replaced: a frame could otherwise
          // swap it between the user's pointerdown and click. Newer requests are declined.
          if (consentRef.current != null) {
            resolve(false);
            return;
          }
          const pending = { id: newConfirmPromptId(), request, resolve };
          consentRef.current = pending;
          setConsent(pending);
        }),
      insertIntoComposer: (text) =>
        window.dispatchEvent(
          createCustomEvent(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, { text, mode: "append", workspaceId })
        ),
      // The desktop app routes _blank navigations through shell.openExternal.
      openExternalLink: (url) => window.open(url, "_blank", "noopener,noreferrer"),
      onSizeChanged: (size) => {
        if (size.height !== undefined) setHeight(size.height);
      },
      onInitialized: () => {
        const { view: currentView, result } = latest.current;
        host.sendToolInput(
          result?.invocation != null ? result.invocation.arguments : currentView.arguments
        );
        if (currentView.cancelled) host.sendToolCancelled("interrupted");
        else if (result?.resultAvailable) host.sendToolResult(result.result);
      },
      log: (message, data) =>
        console.debug(`[MCP Apps] ${boundServerName}: ${message}`, data ?? ""),
    });
    hostRef.current = host;
    const handler = (event: MessageEvent) => {
      const frameWindow = navigatedRef.current ? null : frameRef.current?.contentWindow;
      if (!passesFrameGate(event, frameWindow, allowMessage)) return;
      void host.handleMessage(event.data);
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      // Best effort when the view is switched away; Close waits for the reply instead.
      void host.teardown("unmount");
      hostRef.current = null;
      consentRef.current?.resolve(false);
      consentRef.current = null;
      setConsent(null);
    };
    // The host lives as long as the document; `grant` is derived from the same inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    srcDoc,
    api,
    workspaceId,
    serverName,
    boundServerName,
    allowMessage,
    guard.navigated,
    navigatedRef,
  ]);

  // Keep the view's theme current without reloading it.
  useEffect(() => {
    hostRef.current?.sendHostContextChanged({ theme, styles: { variables: readStyleVariables() } });
  }, [theme]);

  const settleConsent = (pending: PendingConsent, allowed: boolean) => {
    if (consentRef.current !== pending) return;
    consentRef.current = null;
    setConsent(null);
    pending.resolve(allowed);
  };

  const close = async () => {
    await hostRef.current?.teardown("closed");
    closeMcpAppView(workspaceId, toolCallId);
  };

  const header = <McpAppViewHeader serverName={serverName} onClose={() => void close()} />;

  if (current == null) return <Notice>Loading…</Notice>;
  if (current.view == null || srcDoc == null || grant == null) {
    return (
      <div className="flex min-h-0 flex-col">
        {header}
        <div className="text-danger p-4 text-xs">
          {current.error ?? "The view could not be loaded."}
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      {!current.view.resultAvailable && !view.cancelled && (
        <NoteBar>Result no longer available. The view shows the tool input only.</NoteBar>
      )}
      {grant.notGranted.length > 0 && (
        <NoteBar>Not granted to this view: {grant.notGranted.join(", ")}</NoteBar>
      )}
      {consent != null && (
        <div
          role="alert"
          className="border-border-light bg-background-secondary flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs"
        >
          <div className="text-foreground min-w-0 flex-1 break-words">
            {consentText(consent.request)[0]}
            {consent.request.kind === "tool" && (
              <ConsentArgs json={consentArgsJson(consent.request.args)} />
            )}
            {consent.request.kind === "message" && <ConsentArgs json={consent.request.text} />}
            {consent.request.kind === "link" && <ConsentArgs json={consent.request.url} />}
          </div>
          <button
            type="button"
            // Disabled briefly after the strip appears (confirmArming.ts).
            disabled={!consentArming.armed}
            onPointerDown={consentArming.onPointerDown}
            onClick={(event) => consentArming.guardClick(event, () => settleConsent(consent, true))}
            className="bg-accent text-background rounded px-2 py-0.5 disabled:opacity-50"
          >
            {consentText(consent.request)[1]}
          </button>
          <button
            type="button"
            onClick={() => settleConsent(consent, false)}
            className="border-border-light rounded border px-2 py-0.5"
          >
            {consentText(consent.request)[2]}
          </button>
        </div>
      )}
      {guard.navigated && <FrameNavigatedNotice onReload={guard.reload} />}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-auto">
        {/* SECURITY AUDIT: MCP Apps view sink (see the component comment). sandbox stays exactly
            ARTIFACT_IFRAME_SANDBOX, srcdoc carries the view CSP meta first in <head>, and no
            auth tokens, paths or env are sent to the frame. */}
        {/* Unmounted once navigated: the remote page must not stay loaded. */}
        {!guard.navigated && (
          <iframe
            key={guard.frameKey}
            ref={frameRef}
            title={`${view.label} (${serverName})`}
            sandbox={ARTIFACT_IFRAME_SANDBOX}
            referrerPolicy="no-referrer"
            srcDoc={srcDoc}
            className={
              current.view.prefersBorder === true
                ? "border-border-light block w-full rounded border bg-white"
                : "block w-full border-0 bg-white"
            }
            style={{ height: height ?? "100%" }}
            data-testid="mcp-app-frame"
            // A second load means the view navigated itself away (frameNavigationGuard.tsx).
            onLoad={() => guard.onLoad()}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The tool call's full arguments under the consent question, scrollable, so the user sees
 * everything Allow sends.
 */
/** Bidi format characters, which reorder how the surrounding text displays. */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
/**
 * For one-line names: bidi format characters, C0/C1 control characters and the Unicode line and
 * paragraph separators (the set mcpServerIdentity.ts treats as unsafe), which could reorder,
 * break or hide the question around the name. Backslashes too, so the escaping stays
 * unambiguous: `foo\u202e` (literal text) and `foo` + U+202E must not display alike.
 */
const NAME_CONTROLS = /[\\\p{Cc}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

/**
 * Review-only rendering: the matched characters become visible `\uXXXX` escapes (a matched
 * backslash becomes `\\`), so a view cannot make the text it asks the user to approve display
 * reordered or hidden. The request itself is unchanged.
 */
function escapeControls(text: string, pattern: RegExp = BIDI_CONTROLS): string {
  return text.replace(pattern, (char) =>
    char === "\\" ? "\\\\" : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

function ConsentArgs(props: { json: string | null }) {
  if (props.json == null) return null;
  return (
    <pre
      data-testid="mcp-app-consent-args"
      className="text-muted mt-1 max-h-40 overflow-auto font-mono text-[11px] break-all whitespace-pre-wrap"
    >
      {escapeControls(props.json)}
    </pre>
  );
}
