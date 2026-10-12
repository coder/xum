import React, { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { Button } from "@/browser/components/Button/Button";
import { cn } from "@/common/lib/utils";
import type {
  AgentPluginHook,
  AgentPluginHooks,
  PluginHookHandler,
  PluginHookReviewState,
  PluginHookStatus,
} from "@/common/orpc/schemas/agentPlugins";
import { getErrorMessage } from "@/common/utils/errors";

/** One-line handler summary, shared by the consent preview and the review panel. */
export function describePluginHookHandler(handler: PluginHookHandler): string {
  return handler.type === "mcp_tool"
    ? // The timeout is part of what the user trusts (and of the hash): a changed hook may differ
      // only there.
      `MCP tool ${handler.server} / ${handler.tool}, timeout ${handler.timeoutSeconds}s`
    : `${handler.type}: ${handler.summary}`;
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
  if (full.length <= PLUGIN_HOOK_INPUT_DISPLAY_MAX_CHARS) return { shown: full, full: null };
  let shown = full.slice(0, PLUGIN_HOOK_INPUT_DISPLAY_MAX_CHARS);
  // Never end on half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(shown)) shown = shown.slice(0, -1);
  return { shown: `${shown}\n…truncated (${kilobytes(full)} KB)`, full: compact };
}

function kilobytes(text: string): number {
  return Math.ceil(text.length / 1024);
}

/** Why a hook can never run; null for a runnable hook. */
export const PLUGIN_HOOK_STATUS_NOTE: Record<PluginHookStatus, string | null> = {
  runnable: null,
  "unsupported-handler": "Never runs: Xum runs only mcp_tool hooks.",
  "ignored-event": "Never runs: Xum does not use this event.",
};

const REVIEW_LABEL: Record<PluginHookReviewState, { text: string; className: string }> = {
  trusted: { text: "trusted", className: "text-accent" },
  disabled: { text: "turned off", className: "text-muted" },
  new: { text: "needs review", className: "text-warning" },
  changed: { text: "changed, needs review", className: "text-warning" },
};

/**
 * Settings review of a managed plugin's Codex-format hooks (hooks.json). Codex trusts each hook
 * by the hash of its exact definition: a hook runs only while trusted and unchanged.
 */
export const PluginHooksPanel: React.FC<{ name: string; onClose: () => void }> = (props) => {
  const { api } = useAPI();
  const [data, setData] = useState<AgentPluginHooks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  // Hooks (key and hash) whose cut input the user expanded. Keyed by the hash too: a changed
  // definition must be expanded again before it can be trusted.
  const [expandedInputs, setExpandedInputs] = useState<ReadonlySet<string>>(() => new Set());
  const name = props.name;

  useEffect(() => {
    let ignore = false;
    if (!api) return;
    api.agentPlugins.getHooks({ name }).then(
      (result) => {
        if (ignore) return;
        // A failed reload clears the list: after a decision, the old review states are stale.
        setData(result.success ? result.data : null);
        if (!result.success) setError(result.error);
        setBusy(false);
      },
      (err: unknown) => {
        if (ignore) return;
        setData(null);
        setError(getErrorMessage(err));
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
      <p className="text-foreground text-xs">
        Hooks from hooks.json. A hook runs only after you trust it, and only while it stays
        unchanged.
      </p>
      {busy && (
        <p role="status" className="text-muted text-xs">
          Loading hooks…
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs break-words">
          {error}
        </p>
      )}
      {data?.hooks.length === 0 && <p className="text-muted text-xs">No hooks.json hooks.</p>}
      {data && data.hooks.length > 0 && (
        <ul className="space-y-2">
          {data.hooks.map((hook) => {
            const label = REVIEW_LABEL[hook.review];
            const note = PLUGIN_HOOK_STATUS_NOTE[hook.status];
            const summary = describePluginHookHandler(hook.handler);
            const input = hook.handler.type === "mcp_tool" ? hook.handler.input : {};
            const inputView = formatPluginHookInput(input);
            const expandKey = `${hook.key}\0${hook.hash}`;
            const expanded = expandedInputs.has(expandKey);
            // Trust covers the full definition: it waits until the user can have read all of it.
            const mustExpand = inputView.full !== null && !expanded;
            return (
              <li
                key={hook.key}
                className="border-border-light space-y-1 rounded border p-2 text-xs"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-foreground font-mono">{hook.event}</span>
                  {hook.matcher !== undefined && (
                    <span className="text-muted font-mono break-all">matcher {hook.matcher}</span>
                  )}
                  {note === null && <span className={label.className}>{label.text}</span>}
                </div>
                <p className="text-foreground font-mono break-all">{summary}</p>
                {Object.keys(input).length > 0 && (
                  <pre className="text-muted bg-background rounded p-1 font-mono break-all whitespace-pre-wrap">
                    {expanded && inputView.full !== null ? inputView.full : inputView.shown}
                  </pre>
                )}
                {mustExpand && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() =>
                      setExpandedInputs((previous) => new Set(previous).add(expandKey))
                    }
                  >
                    Show full input ({kilobytes(inputView.full ?? "")} KB)
                  </Button>
                )}
                <p className="text-muted break-all">{hook.source}</p>
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
                        Show the full input to review it before trusting.
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {hook.review !== "trusted" && (
                        <Button
                          size="sm"
                          className={cn("h-7 px-2 text-xs")}
                          disabled={busy || mustExpand}
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
              {warning}
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
