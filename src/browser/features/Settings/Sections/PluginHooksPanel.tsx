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
      `MCP tool ${handler.server} / ${handler.tool}, ${
        handler.timeoutSeconds === undefined
          ? "default timeout"
          : `timeout ${handler.timeoutSeconds}s`
      }`
    : `${handler.type}: ${handler.summary}`;
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
                    {JSON.stringify(input, null, 2)}
                  </pre>
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
                    <div className="flex flex-wrap gap-2">
                      {hook.review !== "trusted" && (
                        <Button
                          size="sm"
                          className={cn("h-7 px-2 text-xs")}
                          disabled={busy}
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
