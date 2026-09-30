/**
 * Canonical argument-syntax hints for slash commands.
 * Used by: browser ghost-text overlay, ACP available-commands, and error-message usage strings.
 * Keyed by command name (without the leading "/").
 */
export const SLASH_COMMAND_HINTS = {
  compact: "[-t <tokens>] [-m <model>] [continue message]",
  model: "<abbreviation|full-id>",
  fork: "[start message]",
  new: "[start message]",
  idle: "<hours>|off",
  heartbeat: "<minutes>|off",
  goal: "[-b <amount>] [--turns <n>] <objective>|budget <amount>|clear",
  workflow: "<script_path> [json_args]",
} as const satisfies Readonly<Record<string, string>>;
