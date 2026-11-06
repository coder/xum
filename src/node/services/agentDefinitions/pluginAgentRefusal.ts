/**
 * Why `task` refuses a plugin agent that Xum loads (RFC plugin install methods, A4). Without
 * these, every refusal reads as "unknown agentId" and the model cannot tell a missing agent from
 * one the user can repair.
 */
export type PluginAgentRefusalReason =
  | "not-reviewed"
  | "ambiguous-file"
  | "folder-unreachable"
  | "invalid-definition";

/**
 * `detail` depends on the reason: the file names that claim the ID (`ambiguous-file`), the
 * workspace's runtime kind (`folder-unreachable`), or the parse or read error
 * (`invalid-definition`). `not-reviewed` has none.
 */
const REASON_TEXT: Record<PluginAgentRefusalReason, (subject: string, detail: string) => string> = {
  "not-reviewed": (subject) =>
    `${subject} has not been reviewed on this install. Open Settings → Plugins and select Review on the plugin.`,
  "ambiguous-file": (subject, detail) =>
    `${subject} does not load: more than one file in its agents folder claims this ID (${detail}). Keep one of them.`,
  "folder-unreachable": (subject, detail) =>
    `${subject} needs its plugin folder, which this workspace cannot read (runtime: ${detail}). Run it from a local or worktree workspace.`,
  "invalid-definition": (subject, detail) => `${subject} cannot be loaded: ${detail}`,
};

export class PluginAgentRefusalError extends Error {
  constructor(
    readonly reason: PluginAgentRefusalReason,
    readonly agentId: string,
    readonly pluginName: string,
    readonly detail: string
  ) {
    super(REASON_TEXT[reason](`plugin agent ${agentId} of ${pluginName}`, detail));
    this.name = "PluginAgentRefusalError";
  }
}

/** The refusal as the model, the spawn error and the composition inspector show it. */
export function formatPluginAgentRefusal(error: PluginAgentRefusalError): string {
  return `${error.reason}: ${error.message}`;
}
