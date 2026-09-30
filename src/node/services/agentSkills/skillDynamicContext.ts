import assert from "@/common/utils/assert";

/**
 * Dynamic context injection for agent skills (Claude Code-compatible).
 *
 * A SKILL.md body line whose entire content is a !`command` directive is executed
 * in the workspace and replaced with the command's output before the model sees
 * the skill. This only happens behind the default-off "skill-dynamic-context"
 * experiment and only for user-initiated skill invocations (see agentSession).
 *
 * Directive syntax (whole-line only):
 * - Optional leading whitespace, then !`command`, optional trailing whitespace.
 * - Backticks cannot be nested: the command is everything between the first
 *   backtick pair, so it can never contain a backtick or a newline.
 * - Mid-line/inline directives are intentionally NOT supported: whole-line
 *   matching keeps the feature predictable and makes false positives (prose or
 *   code samples that merely mention !`...`) far less likely.
 * - Like $ARGUMENTS substitution, matching is a plain line scan with no markdown
 *   parsing — a whole-line directive inside a fenced example block still runs.
 *   This keeps behavior predictable at the cost of requiring skill authors to
 *   indent or annotate examples they do not want executed.
 *
 * Execution is dependency-injected (`execute`) so the transformation logic is
 * pure and testable without a runtime.
 */

/**
 * Maximum number of directives executed per skill body. Further directive lines
 * are left as literal text with a bracketed note. Bounds load and keeps a
 * malicious/buggy skill from turning materialization into a long batch job.
 */
export const MAX_SKILL_DYNAMIC_COMMANDS = 10;

/** Per-command timeout. Directives are meant for quick context (git status, etc.). */
export const SKILL_DYNAMIC_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Per-command output cap in bytes (UTF-8). Skill snapshots go straight into model
 * context, so unbounded output would blow the token budget of a single message.
 */
export const SKILL_DYNAMIC_OUTPUT_CAP_BYTES = 16 * 1024;

/**
 * Whole-line directive: optional surrounding whitespace, !`command`.
 * Applied per line (after splitting on \n), so `\s*$` also tolerates a
 * trailing \r from CRLF bodies. `[^`]+` forbids nested backticks and empty
 * commands (an empty !`` stays literal text).
 */
const SKILL_DYNAMIC_DIRECTIVE_RE = /^\s*!`([^`]+)`\s*$/;

export interface SkillDynamicExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type SkillDynamicExecute = (command: string) => Promise<SkillDynamicExecResult>;

/** Longest backtick run + 1 (min 3) so the fence can never collide with output content. */
function computeFence(content: string): string {
  const longestRun = content.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  return "`".repeat(Math.max(3, longestRun + 1));
}

/** Truncate to the byte cap, dropping any partially-decoded trailing character. */
function truncateOutput(content: string): { content: string; truncated: boolean } {
  const bytes = Buffer.from(content, "utf-8");
  if (bytes.byteLength <= SKILL_DYNAMIC_OUTPUT_CAP_BYTES) {
    return { content, truncated: false };
  }
  // A cut mid-codepoint decodes to U+FFFD replacement chars at the end; strip them.
  const sliced = bytes
    .subarray(0, SKILL_DYNAMIC_OUTPUT_CAP_BYTES)
    .toString("utf-8")
    .replace(/\uFFFD+$/, "");
  return { content: sliced, truncated: true };
}

function renderOutputBlock(command: string, result: SkillDynamicExecResult): string {
  assert(typeof result.stdout === "string", "dynamic context execute must return string stdout");
  assert(typeof result.stderr === "string", "dynamic context execute must return string stderr");
  assert(
    Number.isInteger(result.exitCode),
    "dynamic context execute must return an integer exitCode"
  );

  // Combine stdout then stderr; trailing whitespace is trimmed per stream so the
  // fenced block stays tight (models don't benefit from trailing newlines).
  const chunks = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(
    (chunk) => chunk.length > 0
  );
  const { content, truncated } = truncateOutput(chunks.join("\n"));

  const lines = [content.length > 0 ? content : "[no output]"];
  if (truncated) {
    lines.push(`[output truncated at ${SKILL_DYNAMIC_OUTPUT_CAP_BYTES / 1024}KB]`);
  }
  if (result.exitCode !== 0) {
    lines.push(`[exit code ${result.exitCode}]`);
  }

  const blockBody = lines.join("\n");
  const fence = computeFence(blockBody);
  // "text" info string + a one-line provenance label; the command can never
  // contain backticks or newlines (regex), so the info string stays well-formed.
  return `${fence}text (output of: ${command})\n${blockBody}\n${fence}`;
}

function renderFailureNote(command: string, reason: string): string {
  // Keep failure notes to a single short line: the skill must still materialize,
  // and the model only needs to know the context is unavailable and why.
  const firstLine = reason.split("\n", 1)[0].slice(0, 200);
  return `[output of: ${command} unavailable: ${firstLine}]`;
}

/**
 * Replace whole-line !`command` directives in a skill body with their output.
 *
 * - Directives run sequentially (deterministic order, bounded load — no parallelism).
 * - Directives past MAX_SKILL_DYNAMIC_COMMANDS stay literal with a bracketed note.
 * - Non-zero exit still injects output, annotated with a final `[exit code N]` line.
 * - Per-command timeout/errors inject a short bracketed note instead of output; a
 *   failing directive must never fail the whole message send.
 *
 * `timeoutMs` is overridable for tests only (same DI-for-testability rationale as
 * `execute`); production callers use the default.
 */
export async function injectSkillDynamicContext(args: {
  body: string;
  execute: SkillDynamicExecute;
  timeoutMs?: number;
}): Promise<{ body: string; injected: boolean }> {
  assert(typeof args.body === "string", "injectSkillDynamicContext requires a string body");
  assert(
    typeof args.execute === "function",
    "injectSkillDynamicContext requires an execute function"
  );
  const timeoutMs = args.timeoutMs ?? SKILL_DYNAMIC_COMMAND_TIMEOUT_MS;
  assert(timeoutMs > 0, "injectSkillDynamicContext requires a positive timeout");

  const lines = args.body.split("\n");
  const outputLines: string[] = [];
  let executedCount = 0;
  let injected = false;

  for (const line of lines) {
    const match = SKILL_DYNAMIC_DIRECTIVE_RE.exec(line);
    if (!match) {
      outputLines.push(line);
      continue;
    }

    injected = true;
    const command = match[1];

    if (executedCount >= MAX_SKILL_DYNAMIC_COMMANDS) {
      // Over the cap: keep the literal directive and explain why it did not run.
      outputLines.push(line);
      outputLines.push(
        `[skill dynamic context: directive limit (${MAX_SKILL_DYNAMIC_COMMANDS}) reached; not executed]`
      );
      continue;
    }
    executedCount += 1;

    // Module-owned timeout race: guarantees materialization can never hang on a
    // misbehaving execute implementation, independent of runtime-level timeouts.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        args.execute(command),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${timeoutMs / 1000}s`)),
            timeoutMs
          );
        }),
      ]);
      outputLines.push(renderOutputBlock(command, result));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      outputLines.push(renderFailureNote(command, reason));
    } finally {
      clearTimeout(timer);
    }
  }

  return { body: outputLines.join("\n"), injected };
}
