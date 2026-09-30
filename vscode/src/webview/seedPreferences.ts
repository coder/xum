import type { AppConfigSnapshot } from "xum/browser/stores/AppConfigStore";
import { syncPersistedStateFromBackend } from "xum/browser/hooks/usePersistedState";
import {
  AGENT_AI_DEFAULTS_KEY,
  BASH_COLLAPSED_SUMMARY_MODE_KEY,
  TRANSCRIPT_DENSITY_KEY,
} from "xum/common/constants/storage";
import { normalizeAgentAiDefaults } from "xum/common/types/agentAiDefaults";

/**
 * Seeds the localStorage keys shared chat components read for backend preferences (#4972, #4962).
 * Desktop hydrates them in UserPreferencesContext / WorkspaceContext; the webview has neither, so
 * it mirrors the (host-projected) app config snapshot instead. One-way: the webview never writes
 * preferences back (config.saveConfig is blocked by the host allowlist).
 */
export function seedWebviewPreferences(snapshot: AppConfigSnapshot | null): void {
  // null (no config from the current server) removes every key, so the defaults apply.
  // An unset mode or density removes its key too, so it falls back to the default.
  syncPersistedStateFromBackend(BASH_COLLAPSED_SUMMARY_MODE_KEY, snapshot?.bashCollapsedSummaryMode);
  syncPersistedStateFromBackend(TRANSCRIPT_DENSITY_KEY, snapshot?.transcriptDensity);
  syncPersistedStateFromBackend(
    AGENT_AI_DEFAULTS_KEY,
    snapshot === null ? undefined : normalizeAgentAiDefaults(snapshot.agentAiDefaults)
  );
}
