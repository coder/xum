import type { AppConfigSnapshot } from "xum/browser/stores/AppConfigStore";
import { syncPersistedStateFromBackend } from "xum/browser/hooks/usePersistedState";
import { AGENT_AI_DEFAULTS_KEY } from "xum/common/constants/storage";
import { normalizeAgentAiDefaults } from "xum/common/types/agentAiDefaults";

/**
 * Seeds the localStorage keys shared chat components read for backend preferences (#4972, #4962).
 * Desktop hydrates them in UserPreferencesContext / WorkspaceContext; the webview has neither, so
 * it mirrors the (host-projected) app config snapshot instead. One-way: the webview never writes
 * preferences back (config.saveConfig is blocked by the host allowlist).
 */
export function seedWebviewPreferences(snapshot: AppConfigSnapshot | null): void {
  // null (no config from the current server) removes the key, so the defaults apply.
  syncPersistedStateFromBackend(
    AGENT_AI_DEFAULTS_KEY,
    snapshot === null ? undefined : normalizeAgentAiDefaults(snapshot.agentAiDefaults)
  );
}
