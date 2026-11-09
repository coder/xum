import type { AgentPluginUpdateReview } from "@/common/orpc/schemas/agentPlugins";
import type { BackupPluginEntry } from "@/common/orpc/schemas/backup";

/**
 * Intents for the Settings → Plugins section, published by command-palette
 * actions that run outside the section's React tree.
 *
 * Two delivery paths cover both palette contexts:
 * - section not mounted yet: the intent is buffered and consumed by the
 *   section's mount effect after palette navigation;
 * - section already mounted: same-route navigation preserves the component,
 *   so the mounted section's subscription receives the intent directly.
 *
 * Module-level (not persisted) on purpose: intents are meaningful only for
 * the palette invocation that just happened.
 */

export type PluginsSectionIntent =
  /** Expand the Add Plugin form. */
  | { type: "open-add-panel" }
  /** Review additional skills/MCP from a managed installed tree. */
  | { type: "manage-components"; name: string }
  /** Open the hooks.json hook review (trust / turn off) for a managed plugin. */
  | { type: "review-hooks"; name: string }
  /** Open the component review (skills and MCP servers not reviewed on this install, #6498). */
  | { type: "review-components"; name: string }
  /** Open the uninstall confirmation for a managed plugin. */
  | { type: "confirm-uninstall"; name: string }
  /** Show the in-place update review for a capability-changing update the palette previewed. */
  | { type: "review-update"; review: AgentPluginUpdateReview }
  /** Backend plugin state changed outside the section (e.g. palette Update All); re-query. */
  | { type: "refresh" }
  /**
   * Reinstall the plugins a settings backup lists, one install review each (Settings → Backup).
   * Only the plugins this machine lacks: nothing installs until the user confirms each preview.
   */
  | { type: "install-from-backup"; entries: readonly BackupPluginEntry[] };

let pendingIntent: PluginsSectionIntent | null = null;
const listeners = new Set<(intent: PluginsSectionIntent) => void>();

export function publishPluginsSectionIntent(intent: PluginsSectionIntent): void {
  if (listeners.size > 0) {
    for (const listener of listeners) {
      listener(intent);
    }
    return;
  }
  // No mounted section: buffer the latest intent for the upcoming mount.
  pendingIntent = intent;
}

/**
 * Read the buffered intent without clearing it (mount path). A state initializer must stay pure:
 * StrictMode runs it twice and keeps the second result, so a read that cleared the buffer handed
 * the mounting section null. The buffer clears when the mounted section subscribes.
 */
export function peekPendingPluginsSectionIntent(): PluginsSectionIntent | null {
  return pendingIntent;
}

/** Consume the buffered intent; returns null when none is pending. */
export function consumePendingPluginsSectionIntent(): PluginsSectionIntent | null {
  const intent = pendingIntent;
  pendingIntent = null;
  return intent;
}

/** Subscribe a mounted section; returns an unsubscribe. */
export function subscribePluginsSectionIntents(
  listener: (intent: PluginsSectionIntent) => void
): () => void {
  listeners.add(listener);
  // The subscribing section already read the buffered intent at mount (peek above). Only the
  // Plugins section subscribes, so nothing else is waiting for it: a second subscriber would
  // find the buffer cleared.
  pendingIntent = null;
  return () => {
    listeners.delete(listener);
  };
}
