/**
 * Tip carousel for the ChatInput placeholder.
 *
 * The workspace ChatInput uses these strings as a rotating "Type a message..."
 * placeholder so users who never read docs still get passive exposure to
 * slash commands they probably don't know about.
 *
 * The tip rotates on a wall-clock bucket (not per-message, not per-workspace)
 * so switching between chats never reshuffles the visible tip. Two tabs open
 * to two workspaces show the same tip; close and re-open the app inside the
 * same bucket and you still see the same tip. The bucket boundary is the
 * only thing that advances the carousel.
 *
 * Every tip in this list must surface a real, always-available feature:
 * a slash command (registry or built-in skill) that is ungated by experiments
 * (no `experimentGate` on the command definition), a backslash symbol shortcut
 * (see `symbolShortcuts.ts`, which is always on), an always-available global
 * keybind from `KEYBINDS` (ungated by experiments), or a natural-language
 * request for an agent capability that is available with every experiment off.
 * Advertising an unimplemented or feature-flag-locked feature sends the user
 * into an unknown-command / experiment-required dead end the moment they
 * follow the suggestion. When adding a slash-command tip, grep
 * `src/browser/utils/slashCommands/registry.ts` for `experimentGate` to make
 * sure the command you're surfacing isn't gated. Keybind tips are rendered via
 * `formatKeybind` so they stay platform-correct (⌘ on macOS, Ctrl elsewhere).
 * A tip may mention a gated feature only in a variant selected by the caller's
 * experiment state (see `selfExtensionTip`); both variants must keep the list
 * length and order identical so the wall-clock rotation stays aligned.
 */

import { KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";

/** Bucket length for tip rotation. */
const TIP_ROTATION_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes

/**
 * Tip index pinned for Storybook visual snapshots.
 *
 * Without pinning, every story that renders ChatInput would resolve a tip via
 * `floor(NOW / 20min) mod PLACEHOLDER_TIPS.length` — so any reorder of or
 * insertion into PLACEHOLDER_TIPS shifts the displayed tip and cascades into
 * a fresh visual baseline diff on every ChatInput story (currently 100+).
 *
 * Pinning to index 0 means tip-list edits only affect snapshots when the lead
 * tip's text itself changes, which is the rare, intentional case. /orchestrate
 * is the lead tip because it's the only entry-point users have for the
 * unadvertised orchestrate skill — making it the storybook-fixed tip turns
 * every ChatInput snapshot into passive discovery surface for the feature.
 */
const STORYBOOK_PINNED_TIP_INDEX = 0;

export interface PlaceholderTipOptions {
  /** Dynamic Workflows experiment state; selects the `selfExtensionTip` variant. */
  dynamicWorkflows?: boolean;
}

/**
 * Self-extension tip. Users rarely realize Xum can extend and debug itself:
 * it can author skills (`.xum/skills/<name>/SKILL.md`), author durable
 * workflows (built-in `workflow-authoring` skill), and investigate its own
 * behavior from session logs. The durable-workflow clause is shown only when
 * the Dynamic Workflows experiment is on, because `workflow_run` is not
 * registered otherwise and the agent would dead-end after writing the script.
 */
function selfExtensionTip(dynamicWorkflows: boolean): string {
  return dynamicWorkflows
    ? "Ask Xum to write a skill or durable workflow, or to investigate an issue in Xum"
    : "Ask Xum to write a skill, or to investigate an issue in Xum";
}

export function getPlaceholderTips(options?: PlaceholderTipOptions): readonly string[] {
  return [
    "Try /orchestrate to coordinate sub-agents and integrate their patches",
    selfExtensionTip(options?.dynamicWorkflows === true),
    "Try /spawn <task> to offload it to a single sub-agent and preserve context",
    "Try /haiku <msg> to send just this message on a different model",
    "Try /+high <msg> to crank up reasoning for this message only",
    "Try /compact to summarize the conversation when context gets tight",
    "Try /fork <start> to branch this chat into a new workspace",
    "Try /plan to view or edit the current plan inline",
    "Try /clear --soft to reset context while keeping the chat visible",
    "Try /new <start> to start a fresh workspace from the trunk branch",
    "Try /vim to toggle vim keybindings in the chat input",
    "Try \\alpha or \\sum to insert LaTeX-style symbols like α and ∑ as you type",
    // Keybind tip (kept last so it never displaces the Storybook-pinned lead tip).
    `Press ${formatKeybind(KEYBINDS.INCREASE_THINKING)} / ${formatKeybind(KEYBINDS.DECREASE_THINKING)} to raise or lower thinking effort`,
  ];
}

/** Tip list with every experiment off. */
export const PLACEHOLDER_TIPS: readonly string[] = getPlaceholderTips();

/**
 * Detect Storybook runtime via a global flag set by `.storybook/preview.tsx`.
 *
 * We deliberately avoid `import.meta.env` here because this module is
 * transitively imported by Jest-based UI tests (`tests/ui/**`) that run in
 * CommonJS mode and choke on `import.meta`. A plain runtime flag works in
 * every environment: Storybook's preview sets it before any story renders,
 * Jest / Bun tests never touch it, and production builds never see it.
 */
function isStorybookRuntime(): boolean {
  return (globalThis as { __MUX_STORYBOOK__?: boolean }).__MUX_STORYBOOK__ === true;
}

/**
 * Return the tip for the current wall-clock bucket.
 *
 * The bucket index is `floor(Date.now() / 20min)` modulo the tip list, so
 * every caller in the same 20-minute window sees the same tip regardless of
 * workspace, tab, or user-message count.
 *
 * A non-finite or negative clock falls back to the lead tip so the carousel
 * still surfaces a real, discoverable command in degenerate states (clock
 * skew, mocked timers returning weird values, etc.).
 *
 * Under Storybook the tip is fixed (`STORYBOOK_PINNED_TIP_INDEX`) so visual
 * baselines are insulated from tip-list reordering.
 */
export function getPlaceholderTip(options?: PlaceholderTipOptions): string {
  const tips = getPlaceholderTips(options);
  if (isStorybookRuntime()) {
    return tips[STORYBOOK_PINNED_TIP_INDEX];
  }
  const ts = Date.now();
  if (!Number.isFinite(ts) || ts < 0) {
    return tips[0];
  }
  const bucket = Math.floor(ts / TIP_ROTATION_INTERVAL_MS);
  const index = bucket % tips.length;
  return tips[index];
}
