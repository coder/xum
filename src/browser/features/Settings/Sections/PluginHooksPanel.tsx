import React, { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { Button } from "@/browser/components/Button/Button";
import { cn } from "@/common/lib/utils";
import { cursorHookNotAppliedReason, effectiveHookTimeoutSeconds } from "@/constants/pluginHooks";
import type {
  AgentPluginCapabilityChange,
  AgentPluginHook,
  AgentPluginHooks,
  PluginHookHandler,
  PluginHookReviewState,
  PluginHookStatus,
} from "@/common/orpc/schemas/agentPlugins";
import { showInvisibleControls, showOneLineControls } from "@/common/utils/agentPluginReviewText";
import { getErrorMessage } from "@/common/utils/errors";

/** One-line handler summary, shared by the consent preview and the review panel. */
export function describePluginHookHandler(handler: PluginHookHandler): string {
  if (handler.type === "cursor-command") {
    return `command ${showOneLineControls(handler.command)}, ${describeHookTimeout(handler.timeoutSeconds)}`;
  }
  if (handler.type === "cursor-prompt") return "prompt hook";
  if (handler.type !== "mcp_tool") return `${handler.type}: ${handler.summary}`;
  const summary = `MCP tool ${handler.server} / ${handler.tool}, ${describeHookTimeout(handler.timeoutSeconds)}`;
  return summary + describeStatusMessage(handler.statusMessage);
}

/**
 * Codex lists the status message with the hook (discovery.rs). The user sees it while the hook
 * runs, so it is part of what they review (Codex PRRT_kwDOPxxmWM6rQdyp). React escapes it.
 */
function describeStatusMessage(statusMessage: string | undefined): string {
  return statusMessage !== undefined ? `, status "${statusMessage}"` : "";
}

/**
 * The timeout the call runs with (the runner caps it), not the parsed value: 2^64 must not show
 * as a 20-digit timeout. The declared value is part of what the user trusts (and of the hash),
 * so a changed hook may differ only there: a capped one also names what it declares.
 */
function describeHookTimeout(declaredSeconds: number | undefined): string {
  const seconds = effectiveHookTimeoutSeconds(declaredSeconds);
  if (declaredSeconds === undefined) return `default timeout ${seconds}s`;
  return declaredSeconds === seconds
    ? `timeout ${seconds}s`
    : `timeout ${seconds}s (declares ${declaredSeconds > 1e9 ? "over 10^9" : declaredSeconds}s, capped)`;
}

/** Shown characters of a hook's input: the review renders before the user trusts anything. */
export const PLUGIN_HOOK_INPUT_DISPLAY_MAX_CHARS = 16 * 1024;

/** The hook input as the review shows it; `full` is set only when `shown` is cut. */
export interface PluginHookInputView {
  shown: string;
  /** The complete input as compact JSON, for "Show full input"; null when nothing was cut. */
  full: string | null;
}

/**
 * The hook input as the review shows it, size-bounded. The input is plugin-controlled and can be
 * near the hooks-file limit: pretty-printing deeply nested values amplifies it many times over
 * (about 12 MB for a 200 KiB input), which can freeze the renderer. Small inputs are
 * pretty-printed, larger ones stay compact, and the shown text is cut with a note. The hash and
 * the trust decision cover the full definition, so a cut input also returns its full compact
 * JSON: the review must offer it before Trust (a plugin can pad the input and hide arguments after
 * the cut). Compact JSON is bounded by the hooks-file limit, so showing it in full stays cheap.
 */
export function formatPluginHookInput(input: Record<string, unknown>): PluginHookInputView {
  const compact = JSON.stringify(input);
  // Pretty-print only while even the deepest indentation keeps the text small.
  const full = compact.length <= 2048 ? JSON.stringify(input, null, 2) : compact;
  const view = cutReviewText(full);
  return { shown: view.shown, full: view.cut ? compact : null };
}

/**
 * A review text as the renderer first shows it: cut at the display bound with a note. `cut` means
 * the review must offer the full text before the user can approve it (#6629, as for hook input).
 */
export function cutReviewText(full: string): { shown: string; cut: boolean } {
  if (full.length <= PLUGIN_HOOK_INPUT_DISPLAY_MAX_CHARS) return { shown: full, cut: false };
  let shown = full.slice(0, PLUGIN_HOOK_INPUT_DISPLAY_MAX_CHARS);
  // Never end on half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(shown)) shown = shown.slice(0, -1);
  return { shown: `${shown}\n…truncated (${kilobytes(full)} KB)`, cut: true };
}

export function kilobytes(text: string): number {
  return Math.ceil(text.length / 1024);
}

const PLUGIN_HOOK_STATUS_NOTE: Record<PluginHookStatus, string | null> = {
  runnable: null,
  "unsupported-handler": "Never runs: Xum runs only mcp_tool hooks.",
  "ignored-event": "Never runs: Xum does not use this event.",
  "claude-plugin": "Never runs: Xum does not run Claude Code plugin hooks.",
};

type CursorHookHandler = Extract<PluginHookHandler, { type: "cursor-command" | "cursor-prompt" }>;

export function isCursorHookHandler(handler: PluginHookHandler): handler is CursorHookHandler {
  return handler.type === "cursor-command" || handler.type === "cursor-prompt";
}

export const CURSOR_HOOK_REMOTE_NOTE =
  "Does not run in remote workspaces (SSH, Docker and devcontainer).";

export function hookStatusNote(
  hook: Pick<AgentPluginHook, "event" | "matcher" | "handler" | "status">
): string | null {
  if (!isCursorHookHandler(hook.handler)) return PLUGIN_HOOK_STATUS_NOTE[hook.status];
  const reason = cursorHookNotAppliedReason(hook);
  return reason === undefined ? null : `Never runs: ${reason}.`;
}

interface PluginHookReviewDetail extends PluginHookInputView {
  noun: "input" | "entry";
}

/**
 * The hashed part of a hook that its one-line summary leaves out: an mcp_tool input, or a Cursor
 * entry exactly as declared (unknown fields and clamped values included, RFC 5.1), so two entries
 * with different hashes never look the same. Controls are marked before the cut, so the shown
 * text stays bounded.
 */
export function hookReviewDetail(handler: PluginHookHandler): PluginHookReviewDetail | null {
  if (handler.type === "mcp_tool") {
    if (Object.keys(handler.input).length === 0) return null;
    return { noun: "input", ...formatPluginHookInput(handler.input) };
  }
  if (!isCursorHookHandler(handler)) return null;
  const declared = showInvisibleControls(handler.declared);
  const view = cutReviewText(declared);
  return { noun: "entry", shown: view.shown, full: view.cut ? declared : null };
}

const REVIEW_LABEL: Record<PluginHookReviewState, { text: string; className: string }> = {
  trusted: { text: "trusted", className: "text-accent-text" },
  disabled: { text: "turned off", className: "text-muted" },
  new: { text: "needs review", className: "text-warning" },
  changed: { text: "changed, needs review", className: "text-warning" },
};

/**
 * Settings review of a managed plugin's Codex-format hooks (hooks.json). Codex trusts each hook
 * by the hash of its exact definition: a hook runs only while trusted and unchanged.
 */
/**
 * The review's first line. A Claude Code plugin's hooks never run and offer no trust control, so
 * the trust promise would be false for every row of such a plugin.
 */
function hooksIntro(data: AgentPluginHooks | null): string {
  const neverRun =
    data !== null &&
    data.hooks.length > 0 &&
    data.hooks.every((hook) => hook.status !== "runnable");
  return neverRun
    ? "Hooks from hooks.json. Xum never runs these hooks."
    : "Hooks from hooks.json. A hook runs only after you trust it, and only while it stays unchanged.";
}

const HookReviewDetailText: React.FC<{
  detail: PluginHookReviewDetail;
  expanded: boolean;
  onExpand: () => void;
}> = (props) => (
  <>
    <pre className="text-muted bg-background rounded p-1 font-mono break-all whitespace-pre-wrap">
      {props.expanded && props.detail.full !== null ? props.detail.full : props.detail.shown}
    </pre>
    {props.detail.full !== null && !props.expanded && (
      <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={props.onExpand}>
        Show full {props.detail.noun} ({kilobytes(props.detail.full)} KB)
      </Button>
    )}
  </>
);

export function cutReviewTextKeys(changes: readonly AgentPluginCapabilityChange[]): string[] {
  return changes.flatMap((change, index) =>
    (["before", "after"] as const).flatMap((field) => {
      const text = change[field];
      return text !== undefined && cutReviewText(text).cut ? [`${index}:${field}`] : [];
    })
  );
}

/**
 * Which cut texts of a row list the user expanded (#6629). Keys are valid only for the list they
 * were expanded in: a new review or preview (same plugin, other rows) starts with nothing expanded.
 */
export function useCutTextExpansion(changes: readonly AgentPluginCapabilityChange[]) {
  const [expansion, setExpansion] = useState<{
    changes: readonly AgentPluginCapabilityChange[] | null;
    keys: ReadonlySet<string>;
  }>({ changes: null, keys: new Set() });
  const keys = expansion.changes === changes ? expansion.keys : new Set<string>();
  return {
    isExpanded: (key: string) => keys.has(key),
    mustExpand: cutReviewTextKeys(changes).filter((key) => !keys.has(key)),
    expand: (key: string) =>
      setExpansion((previous) => ({
        changes,
        keys: new Set(previous.changes === changes ? previous.keys : []).add(key),
      })),
  };
}
export type CutTextExpansion = ReturnType<typeof useCutTextExpansion>;

/** One review row: its summary and its before/after texts. */
export const ReviewChangeRow: React.FC<{
  change: AgentPluginCapabilityChange;
  index: number;
  isExpanded: (key: string) => boolean;
  onExpand: (key: string) => void;
}> = (props) => {
  const fields = (["before", "after"] as const).flatMap((field) => {
    const text = props.change[field];
    return text !== undefined ? [{ field, text, key: `${props.index}:${field}` }] : [];
  });
  return (
    <li className="text-xs">
      <span className="text-foreground break-words">{props.change.summary}</span>
      {fields.length > 0 && (
        <dl className="mt-1 space-y-1">
          {fields.map((item) => (
            <ReviewTextField
              key={item.field}
              label={item.field === "before" ? "Before" : "After"}
              text={item.text}
              expanded={props.isExpanded(item.key)}
              onExpand={() => props.onExpand(item.key)}
            />
          ))}
        </dl>
      )}
    </li>
  );
};

/**
 * One before/after text of a review row (#6629). A long text is cut at the display bound, and the
 * user must show all of it before confirming: a plugin can pad a definition and hide the part that
 * matters after the cut.
 */
const ReviewTextField: React.FC<{
  label: string;
  text: string;
  expanded: boolean;
  onExpand: () => void;
}> = (props) => {
  const view = cutReviewText(props.text);
  return (
    <div className="flex gap-2">
      <dt className="text-muted w-10 shrink-0 text-[11px]">{props.label}</dt>
      <dd className="bg-modal-bg border-border-medium min-w-0 flex-1 rounded border px-2 py-1 font-mono text-[11px] break-words whitespace-pre-wrap">
        {view.cut && !props.expanded ? view.shown : props.text}
        {view.cut && !props.expanded && (
          <Button
            variant="outline"
            size="sm"
            className="mt-1 h-7 px-2 font-sans text-xs"
            onClick={props.onExpand}
          >
            Show full text ({kilobytes(props.text)} KB)
          </Button>
        )}
      </dd>
    </div>
  );
};

const NO_FILE_CHANGES: readonly AgentPluginCapabilityChange[] = [];

export const PluginHooksPanel: React.FC<{ name: string; onClose: () => void }> = (props) => {
  const { api } = useAPI();
  const [data, setData] = useState<AgentPluginHooks | null>(null);
  // The last load's error and the last decision's error, apart: a successful reload clears only
  // its own (Codex PRRT_kwDOPxxmWM6rgooW), and a refused decision stays visible after its reload.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  // Hooks (key and hash) whose cut input the user expanded. Keyed by the hash too: a changed
  // definition must be expanded again before it can be trusted.
  const [expandedInputs, setExpandedInputs] = useState<ReadonlySet<string>>(() => new Set());
  const name = props.name;
  const fileReview = data?.fileReview;
  const fileExpansion = useCutTextExpansion(fileReview?.changes ?? NO_FILE_CHANGES);

  useEffect(() => {
    let ignore = false;
    if (!api) return;
    api.agentPlugins.getHooks({ name }).then(
      (result) => {
        if (ignore) return;
        // A failed reload clears the list: after a decision, the old review states are stale.
        setData(result.success ? result.data : null);
        setLoadError(result.success ? null : result.error);
        setBusy(false);
      },
      (err: unknown) => {
        if (ignore) return;
        setData(null);
        setLoadError(getErrorMessage(err));
        setBusy(false);
      }
    );
    return () => {
      ignore = true;
    };
  }, [api, name, loadAttempt]);

  const decide = async (hook: AgentPluginHook, state: "trusted" | "disabled") => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      // The hash is the one on screen: the backend refuses it if the hook changed since.
      const result = await api.agentPlugins.setHookTrust({
        name,
        key: hook.key,
        hash: hook.hash,
        state,
        // The files on screen: the backend refuses the trust if they changed since.
        ...(fileReview !== undefined ? { fileReviewDigest: fileReview.digest } : {}),
      });
      if (!result.success) setError(result.error);
    } catch (err) {
      setError(getErrorMessage(err));
    }
    // Reload either way: a refusal means the definition changed and must be shown again.
    setLoadAttempt((attempt) => attempt + 1);
  };

  return (
    <div className="border-border-medium bg-background-secondary mt-2 space-y-3 rounded-md border p-3">
      <p className="text-foreground text-xs">{hooksIntro(data)}</p>
      {busy && (
        <p role="status" className="text-muted text-xs">
          Loading hooks…
        </p>
      )}
      {[loadError, error].map(
        (message, index) =>
          message && (
            <p key={index} role="alert" className="text-destructive text-xs break-words">
              {message}
            </p>
          )
      )}
      {fileReview !== undefined && (
        <div>
          <h4 className="text-foreground mb-1 text-xs font-medium">
            Files ({fileReview.changes.length})
          </h4>
          <p className="text-muted mb-1 text-xs">
            Read every file before you trust this plugin&apos;s first hook: a command hook can run
            any of them.
          </p>
          <ul className="space-y-2">
            {fileReview.changes.map((change, index) => (
              <ReviewChangeRow
                key={`${index}:${change.summary}`}
                change={change}
                index={index}
                isExpanded={fileExpansion.isExpanded}
                onExpand={fileExpansion.expand}
              />
            ))}
          </ul>
        </div>
      )}
      {data?.hooks.length === 0 && <p className="text-muted text-xs">No hooks.json hooks.</p>}
      {data && data.hooks.length > 0 && (
        <ul className="space-y-2">
          {data.hooks.map((hook) => {
            const label = REVIEW_LABEL[hook.review];
            const note = hookStatusNote(hook);
            const summary = describePluginHookHandler(hook.handler);
            const detail = hookReviewDetail(hook.handler);
            const expandKey = `${hook.key}\0${hook.hash}`;
            const expanded = expandedInputs.has(expandKey);
            // Trust covers the full definition: it waits until the user can have read all of it.
            // The first trust of a command hook covers the files too (D30).
            const filesUnread =
              hook.handler.type === "cursor-command" && fileExpansion.mustExpand.length > 0;
            const mustExpand = detail?.full != null && !expanded;
            return (
              <li
                key={hook.key}
                className="border-border-light space-y-1 rounded border p-2 text-xs"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-foreground font-mono break-all">
                    {showOneLineControls(hook.event)}
                  </span>
                  {hook.matcher !== undefined && (
                    <span className="text-muted font-mono break-all">
                      matcher {showOneLineControls(hook.matcher)}
                    </span>
                  )}
                  {note === null && <span className={label.className}>{label.text}</span>}
                </div>
                <p className="text-foreground font-mono break-all">{summary}</p>
                {detail !== null && (
                  <HookReviewDetailText
                    detail={detail}
                    expanded={expanded}
                    onExpand={() =>
                      setExpandedInputs((previous) => new Set(previous).add(expandKey))
                    }
                  />
                )}
                <p className="text-muted break-all">{showOneLineControls(hook.source)}</p>
                {isCursorHookHandler(hook.handler) && (
                  <p className="text-muted">{CURSOR_HOOK_REMOTE_NOTE}</p>
                )}
                {note !== null ? (
                  <p className="text-muted">{note}</p>
                ) : (
                  <>
                    {hook.review === "changed" && (
                      <p className="text-warning">
                        This hook changed since your last decision. Read it again before you trust
                        it.
                      </p>
                    )}
                    {mustExpand && hook.review !== "trusted" && (
                      <p className="text-muted">
                        Show the full {detail.noun} to review it before trusting.
                      </p>
                    )}
                    {filesUnread && hook.review !== "trusted" && (
                      <p className="text-muted">
                        Show the full text of each file above to review it before trusting.
                      </p>
                    )}
                    {hook.handler.type === "cursor-command" && hook.review !== "trusted" && (
                      <p className="text-muted">
                        Once trusted, this hook runs a command in your workspace.
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {hook.review !== "trusted" && (
                        <Button
                          size="sm"
                          className={cn("h-7 px-2 text-xs")}
                          disabled={busy || mustExpand || filesUnread}
                          onClick={() => void decide(hook, "trusted")}
                          aria-label={`Trust ${hook.event} hook ${summary}`}
                        >
                          Trust
                        </Button>
                      )}
                      {hook.review !== "disabled" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={busy}
                          onClick={() => void decide(hook, "disabled")}
                          aria-label={`Turn off ${hook.event} hook ${summary}`}
                        >
                          Turn off
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {data && data.warnings.length > 0 && (
        <ul className="text-warning space-y-1 text-xs">
          {data.warnings.map((warning) => (
            <li key={warning} className="break-words">
              {/* A warning quotes plugin text (paths, event names): its controls are marked. */}
              {showOneLineControls(warning)}
            </li>
          ))}
        </ul>
      )}
      <Button variant="ghost" size="sm" disabled={busy} onClick={props.onClose}>
        Close
      </Button>
    </div>
  );
};
