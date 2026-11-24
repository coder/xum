import { formatKeyNames } from "./formatToolInputIssues";

/** The memory tool's operations; shared with the memory schema to spot misrouted memory calls. */
export const MEMORY_TOOL_COMMANDS = [
  "view",
  "create",
  "str_replace",
  "insert",
  "delete",
  "rename",
] as const;

const MEMORY_ARGUMENT_KEYS = [
  "path",
  "old_path",
  "new_path",
  "file_text",
  "old_str",
  "new_str",
  "insert_line",
  "insert_text",
];
const SEARCH_KEYS = [
  "pattern",
  "output_mode",
  "head_limit",
  "glob",
  "include",
  "-n",
  "-i",
  "-A",
  "-B",
  "-C",
];
const EDIT_KEYS = ["old_string", "new_string"];
const READ_KEYS = ["offset", "limit", "file_path"];

const COMMAND_LINE_PREVIEW_MAX_CHARS = 80;

/**
 * `field="<preview>" (N words)`: what the model sent, JSON-quoted and capped so the model can
 * see a cut-off or misrouted value without the error echoing kilobytes of input.
 */
export function describeReceivedCommandLine(field: string, value: string): string {
  const preview =
    value.length > COMMAND_LINE_PREVIEW_MAX_CHARS
      ? `${JSON.stringify(value.slice(0, COMMAND_LINE_PREVIEW_MAX_CHARS))}...`
      : JSON.stringify(value);
  const words = countWords(value);
  return `${field}=${preview} (${words} ${words === 1 ? "word" : "words"})`;
}

function countWords(value: string): number {
  return value.split(/\s+/).filter((word) => word.length > 0).length;
}

function probableToolHint(command: string, foreignKeys: readonly string[]): string | undefined {
  const hasAny = (candidates: readonly string[]) =>
    candidates.some((key) => foreignKeys.includes(key));
  const isMemoryCommand = (MEMORY_TOOL_COMMANDS as readonly string[]).includes(command.trim());
  if (isMemoryCommand && hasAny(MEMORY_ARGUMENT_KEYS)) {
    return "These look like memory tool arguments; if you meant memory, call memory";
  }
  if (hasAny(SEARCH_KEYS)) {
    return "bash has no search parameters; put the whole grep or rg command line in script";
  }
  if (hasAny(EDIT_KEYS)) return "To edit a file, call file_edit_replace_string";
  if (hasAny(READ_KEYS)) return "To read a file, call file_read";
  return undefined;
}

/**
 * Open-weights models trained on the Claude Code harness call bash with `command` plus other
 * tools' keys (`{command: "view", path}` meant for memory), or with `command` cut off after one
 * word (`{command: "cd"}`). Renaming `command` to `script` and stripping the unknown keys ran
 * those as broken scripts: Vim hung until the timeout and `cd` "succeeded" with empty output.
 * Returns the rejection message for such a call, or undefined when the alias may be renamed
 * (a multi-word command line with only bash keys still runs).
 */
export function describeBrokenBashCommandAlias(
  input: Record<string, unknown>,
  bashKeys: ReadonlySet<string>
): string | undefined {
  const command = input.command;
  if (typeof input.script === "string" || typeof command !== "string") return undefined;
  const foreignKeys = Object.keys(input).filter((key) => !bashKeys.has(key));
  const singleWord = countWords(command) === 1;
  if (foreignKeys.length === 0 && !singleWord) return undefined;

  let received = `Received ${describeReceivedCommandLine("command", command)}`;
  if (foreignKeys.length > 0) {
    received += ` and keys bash does not accept: ${formatKeyNames(foreignKeys)}`;
  }
  const hint =
    probableToolHint(command, foreignKeys) ??
    (singleWord
      ? "That looks cut off; if that word really is the whole command, resend it as script"
      : undefined);
  return [
    received,
    hint,
    "bash takes the whole command line in script and has no command parameter",
  ]
    .filter((sentence) => sentence != null)
    .map((sentence) => `${sentence}.`)
    .join(" ");
}
