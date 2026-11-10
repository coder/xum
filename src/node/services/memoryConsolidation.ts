/**
 * Memory-consolidation runner — the "dream" agent (issue #3534).
 *
 * Deep module: given a model + scope context, runs a headless agent loop
 * (direct streamText, same seam as workspaceTitleGenerator — no StreamManager,
 * no chat history, no UI events) whose only tool is a guarded memory tool.
 *
 * Rails live HERE in code, not in the agent prompt:
 * - scope restriction: by default consolidates workspace + global, plus project
 *   when the run has a single stable project identity; a caller can narrow it
 *   (`writableScopes`), as the harvest analyzer does to workspace only
 * - secret check (opt-in): a create/str_replace/insert whose new text holds a
 *   credential shape is rejected, so a model that copied tool output cannot
 *   persist it
 * - pin protection: pinned files may be edited, never deleted or renamed —
 *   including via a delete/rename of an ancestor directory (subtree check)
 * - op budget: at most MEMORY_CONSOLIDATION_OP_BUDGET mutating commands per
 *   run (reads unlimited), or the user's dream edit limit for an organizer run, never more than
 *   MEMORY_DREAM_EDIT_LIMIT_MAX. Budget is consumed by accepted mutations only
 *   (applied, dry-run, and dispatch failures); guard rejections do not
 *   consume it — runaway retries are bounded by the step ceiling instead.
 * - dry-run: mutations are journaled as proposed but not applied
 *
 * Every mutating command is journaled ({command, path, applied, rejected})
 * for the audit trail that feeds the Memory tab's "last consolidated" line.
 * Refused commands spend no budget, so their rows are capped
 * (MEMORY_CONSOLIDATION_JOURNAL_MAX_ENTRIES) and so is a path's length.
 * Global-scope writes are intentionally permitted (merging into global files
 * is core consolidation work); they remain auditable in the journal via the
 * /memories/global/ path prefix.
 *
 * TODO(#3534, phase 2): net-shrink enforcement needs a byte-size API on
 * MemoryService; until then the journal is the only post-run signal.
 */
import {
  tool,
  streamText,
  stepCountIs,
  type LanguageModel,
  type StopCondition,
  type Tool,
  type ToolSet,
} from "ai";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";

import assert from "@/common/utils/assert";
import {
  MEMORY_CONSOLIDATION_JOURNAL_MAX_ENTRIES,
  MEMORY_CONSOLIDATION_MAX_STEPS,
  MEMORY_CONSOLIDATION_OP_BUDGET,
  MEMORY_DREAM_EDIT_LIMIT_MAX,
  MEMORY_CONSOLIDATION_PATH_MAX_CHARS,
  type MemoryScope,
} from "@/common/constants/memory";
import type { MemoryToolResult } from "@/common/types/tools";
import {
  MemoryConsolidationOpSchema,
  type MemoryConsolidationOp,
} from "@/common/orpc/schemas/memory";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { getErrorMessage } from "@/common/utils/errors";
import { accumulateStepsProviderMetadata } from "@/common/utils/tokens/usageHelpers";
import { createSpendMeter } from "@/node/services/memoryDreamSpend";
import {
  memoryLogicalKey,
  type MemoryMetaEntry,
  type MemoryMetaService,
} from "@/node/services/memoryMeta";
import { containsSecretLike, redactSecretLike } from "@/node/services/memorySecretRedaction";
import { parseMemoryPath, type MemoryScopeContext } from "@/node/services/memoryService";
import type { MemoryService, MemoryWriteOptions } from "@/node/services/memoryService";
import { executeMemoryCommand, type MemoryCommandInput } from "@/node/services/tools/memory";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";

// Re-exported for journal consumers; defined next to the oRPC schema so the
// wire shape and the node shape can never drift (z.infer single source).
export type { MemoryConsolidationOp };

export interface MemoryConsolidationResult {
  ops: MemoryConsolidationOp[];
  /** The model's one-line closing summary (best-effort). */
  summary: string;
  budgetExhausted: boolean;
  /** Token cost of the run; undefined when the provider reported none. */
  usage?: { inputTokens: number; outputTokens: number };
  /** USD the run's steps cost, as priced from what each reported. */
  spentUsd: number;
  /** Set when the cost ceiling ended the run before the model finished: see SpendMeter. */
  note?: string;
  /**
   * Fatal stream error (provider failure or abort/timeout). When set, the
   * pass did NOT complete — callers must not treat the memory state as
   * consolidated (no journal record, no debounce anchor).
   */
  streamError?: string;
}

/** Scopes a consolidation run can be allowed to modify; the session scope is never one of them. */
type WritableMemoryScope = Exclude<MemoryScope, "session">;

const CANCELLED_PASS_ERROR = "Consolidation pass was cancelled";
const DEFAULT_WRITABLE_SCOPES: readonly WritableMemoryScope[] = ["workspace", "global", "project"];
const LIST_FORMAT = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
const MUTATING_COMMANDS = MemoryConsolidationOpSchema.shape.command.options;
const JOURNAL_FULL_NOTE = "The journal is full; later refusals of this run are not recorded.";

interface MutationTarget {
  command: MemoryConsolidationOp["command"];
  path: string;
  newPath?: string;
}

/** Classify a memory command: mutation target paths, or null for reads. */
function classifyMutation(input: MemoryCommandInput): MutationTarget | null {
  switch (input.command) {
    case "view":
      return null;
    case "rename": {
      const oldPath = input.old_path ?? input.path;
      // Missing args fall through to executeMemoryCommand's validation errors.
      if (oldPath == null || input.new_path == null) return null;
      return { command: "rename", path: oldPath, newPath: input.new_path };
    }
    default:
      if (input.path == null) return null;
      return { command: input.command, path: input.path };
  }
}

/** The text a mutating command would add to memory, or null when it adds none (delete, rename). */
function newTextOf(input: MemoryCommandInput): string | null {
  switch (input.command) {
    case "create":
      return input.file_text ?? null;
    case "str_replace":
      return input.new_str ?? null;
    case "insert":
      return input.insert_text ?? null;
    default:
      return null;
  }
}

/**
 * Run-scoped mutation budget. Check + reservation happen in ONE synchronous
 * call (tryConsume): the AI SDK runs parallel tool calls concurrently, so an
 * await between check and increment would let two calls at budget-1 both
 * pass. Shared so the refine pass (r11) can charge memory AND skill mutations
 * against a single budget.
 */
export interface MutationBudget {
  readonly limit: number;
  used(): number;
  /** Reserve one mutation; false when the budget is exhausted. */
  tryConsume(): boolean;
}

export function createMutationBudget(limit: number, alreadyUsed = 0): MutationBudget {
  // `alreadyUsed` lets a retry of the same unit of work (an analyzer epoch) resume the budget the
  // earlier attempt spent instead of getting a fresh one. Only a whole, non-negative count can be
  // resumed. A negative one would add to the limit (-100 allowed `limit` + 100 mutations) and NaN
  // would never reach it, so anything else starts the count over: the run still cannot make more
  // than `limit` mutations.
  let used = Number.isInteger(alreadyUsed) && alreadyUsed >= 0 ? alreadyUsed : 0;
  return {
    limit,
    used: () => used,
    tryConsume: () => {
      if (used >= limit) return false;
      used++;
      return true;
    },
  };
}

/**
 * Non-mutating validation for staged (dry-run) mutations, mirroring what the
 * real write path enforces: executeMemoryCommand's required-arg checks (same
 * error strings), then MemoryService.validateMutation, which simulates the
 * RESULTING file against the write cap (reading the current target for
 * state-dependent commands — a small insert into a near-cap file must fail
 * staging even though the new text alone is tiny) plus the occurrence,
 * exists/type, and containment checks the real command runs. `options` are
 * the write's own rails: a guarded run's dry run must refuse the resulting
 * file the real write would, or the preview shows as accepted an edit that
 * apply mode refuses.
 */
async function validateMutationForStaging(
  memoryService: MemoryService,
  ctx: MemoryScopeContext,
  input: MemoryCommandInput,
  options: MemoryWriteOptions
): Promise<string | null> {
  switch (input.command) {
    case "create": {
      if (input.path == null || input.file_text == null) {
        return "create requires 'path' and 'file_text'";
      }
      const result = await memoryService.validateMutation(
        ctx,
        {
          command: "create",
          path: input.path,
          file_text: input.file_text,
        },
        options
      );
      return result.ok ? null : result.error;
    }
    case "str_replace": {
      if (input.path == null || input.old_str == null) {
        return "str_replace requires 'path' and 'old_str'";
      }
      const result = await memoryService.validateMutation(
        ctx,
        {
          command: "str_replace",
          path: input.path,
          old_str: input.old_str,
          new_str: input.new_str ?? "",
        },
        options
      );
      return result.ok ? null : result.error;
    }
    case "insert": {
      if (input.path == null || input.insert_line == null || input.insert_text == null) {
        return "insert requires 'path', 'insert_line' and 'insert_text'";
      }
      const result = await memoryService.validateMutation(
        ctx,
        {
          command: "insert",
          path: input.path,
          insert_line: input.insert_line,
          insert_text: input.insert_text,
        },
        options
      );
      return result.ok ? null : result.error;
    }
    case "delete": {
      if (input.path == null) return "delete requires 'path'";
      const result = await memoryService.validateMutation(ctx, {
        command: "delete",
        path: input.path,
      });
      return result.ok ? null : result.error;
    }
    case "rename": {
      // classifyMutation already required these (same old_path ?? path rule).
      const oldPath = input.old_path ?? input.path;
      if (oldPath == null || input.new_path == null) {
        return "rename requires 'old_path' (or 'path') and 'new_path'";
      }
      const result = await memoryService.validateMutation(
        ctx,
        { command: "rename", path: oldPath, new_path: input.new_path },
        options
      );
      return result.ok ? null : result.error;
    }
    default:
      return null;
  }
}

/** What one run may do to memory: the options `createConsolidationMemoryTool` resolves for its guard. */
interface MutationRails {
  memoryService: MemoryService;
  metaService: MemoryMetaService;
  ctx: MemoryScopeContext;
  writableScopes: readonly WritableMemoryScope[];
  /** Project memory stays unavailable without a single stable project identity, even when listed. */
  projectAvailable: boolean;
  deniedCommands?: ReadonlyArray<MemoryConsolidationOp["command"]>;
  rejectSecretLike?: boolean;
}

/** Whether a run may modify `scope`. */
function isWritableScope(
  scope: MemoryScope | null,
  rails: Pick<MutationRails, "writableScopes" | "projectAvailable">
): boolean {
  return (
    scope !== null &&
    scope !== "session" &&
    rails.writableScopes.includes(scope) &&
    (scope !== "project" || rails.projectAvailable)
  );
}

function scopeRejection(
  virtualPath: string,
  rails: Pick<MutationRails, "writableScopes" | "projectAvailable">
): string {
  const modifiable = rails.writableScopes
    .filter((scope) => scope !== "project" || rails.projectAvailable)
    .map((scope) => `/memories/${scope}/...`);
  const projectNote =
    rails.writableScopes.includes("project") && !rails.projectAvailable
      ? "project memory is available only for single-project runs; "
      : "";
  return `Consolidation may not modify ${virtualPath}: ${projectNote}this run can modify ${LIST_FORMAT.format(modifiable)}.`;
}

/**
 * Why a run that rejects credentials may not write what `input` adds, or null when it may. The
 * note is journaled into the sidecar record, so it never quotes the rejected text.
 */
function secretRejection(target: MutationTarget, input: MemoryCommandInput): string | null {
  const text = newTextOf(input);
  if (text !== null && containsSecretLike(text)) {
    return `${target.path} was not changed: the new text contains a credential-like value (a key, token, password or private key). Memory must never hold secrets; say what the credential is for and where it lives, and leave the value out.`;
  }
  // A file name is text too: `sk-ant-....md` stores the key in the directory listing. A delete
  // names an existing file and adds nothing, so it stays open; a rename adds only its new name.
  const addedName = target.command === "rename" ? target.newPath : target.path;
  if (target.command !== "delete" && addedName != null && containsSecretLike(addedName)) {
    return "The path contains a credential-like value, so it was not used. Name the file for what it holds, not for a key, token or password.";
  }
  return null;
}

/**
 * The note for a denied command. It names what the run may still use rather than describing the
 * denial as "adding" or "editing": a run that is denied `insert` still adds, through the others.
 */
function deniedCommandRejection(
  command: MemoryConsolidationOp["command"],
  denied: ReadonlyArray<MemoryConsolidationOp["command"]>
): string {
  const allowed = MUTATING_COMMANDS.filter((candidate) => !denied.includes(candidate));
  return `This run may not use ${command}; it can change memory only with ${LIST_FORMAT.format(allowed)}.`;
}

/**
 * Why a path (or rename target) is too long to use, or null. First of the rails, before the path is
 * parsed: its note must not quote it, and a row for it is journaled clipped (see refusalRow).
 */
function pathLengthRejection(target: MutationTarget): string | null {
  const tooLong = [target.path, target.newPath].some(
    (virtualPath) =>
      virtualPath !== undefined && virtualPath.length > MEMORY_CONSOLIDATION_PATH_MAX_CHARS
  );
  return tooLong
    ? `A path may be at most ${MEMORY_CONSOLIDATION_PATH_MAX_CHARS} characters long; use a shorter one.`
    : null;
}

/**
 * The rails that need no I/O: path length, writable scope, denied command and (opt-in) credential
 * check, in that order. Throws on an invalid path (parseMemoryPath); the tool surfaces that as a
 * tool error.
 */
function staticRejection(
  rails: MutationRails,
  target: MutationTarget,
  input: MemoryCommandInput
): string | null {
  const lengthRejection = pathLengthRejection(target);
  if (lengthRejection !== null) return lengthRejection;
  // Whitelist, not blacklist, so scopes added later stay out of bounds by default.
  for (const virtualPath of [target.path, target.newPath]) {
    if (virtualPath == null) continue;
    if (!isWritableScope(parseMemoryPath(virtualPath).scope, rails)) {
      return scopeRejection(virtualPath, rails);
    }
  }
  if (rails.deniedCommands?.includes(target.command) === true) {
    return deniedCommandRejection(target.command, rails.deniedCommands);
  }
  return rails.rejectSecretLike === true ? secretRejection(target, input) : null;
}

/**
 * Why a delete/rename of `key` may not run: it is pinned, or a file under it is (`entries` are the
 * sidecar records by logical key). Deletes/renames may target a directory (MemoryService removes
 * recursively), so without the subtree check `delete dir/` would silently destroy dir/pinned.md.
 */
function pinnedRejection(
  entries: ReadonlyMap<string, MemoryMetaEntry>,
  key: string,
  path: string
): string | null {
  const subtreePrefix = `${key}/`;
  for (const [entryKey, entry] of entries) {
    if (entry.pinned !== true) continue;
    if (entryKey === key || entryKey.startsWith(subtreePrefix)) {
      return `${path} is pinned by the user (directly or via a pinned file inside it); pinned files may be edited but never deleted or renamed.`;
    }
  }
  return null;
}

/** The note that refuses `target` before it runs, or null when every rail lets it through. */
async function mutationRejection(
  rails: MutationRails,
  target: MutationTarget,
  input: MemoryCommandInput
): Promise<string | null> {
  const rejection = staticRejection(rails, target, input);
  if (rejection !== null) return rejection;
  // Pin protection: pinned files are editable but never deleted/renamed. This pre-check gives the
  // model (and dry-run staging) early feedback; the AUTHORITATIVE check runs inside
  // MemoryService's mutation lock against the owner the command's store is actually bound to
  // (`rejectPinned` in the tool): the owner resolved here can differ from the command's when
  // config.json is transiently unreadable in between.
  if (target.command !== "delete" && target.command !== "rename") return null;
  const { scope, relPath } = parseMemoryPath(target.path);
  assert(
    scope === "workspace" || scope === "project" || scope === "global",
    "guard scope check must run first"
  );
  const entries = await rails.metaService.getEntries();
  const key = memoryLogicalKey(scope, relPath, {
    projectPath: rails.ctx.projectPath,
    // Sidecar keys follow the shared store's owner (MemoryService.logicalKeyFor).
    workspaceId:
      rails.ctx.workspaceId === ""
        ? ""
        : rails.memoryService.resolveWorkspaceMemoryOwnerId(rails.ctx.workspaceId),
  });
  return pinnedRejection(entries, key, target.path);
}

type RefusalRow = MemoryConsolidationOp & { note: string };

/**
 * The journal row of a command a rail refused. The journal is persisted, and a refused path (or
 * the note that quotes it) may itself be the credential the guard just refused. A path over the
 * length cap is clipped to it: the row says what was refused, not the megabytes it named.
 */
function refusalRow(
  rails: Pick<MutationRails, "rejectSecretLike">,
  target: MutationTarget,
  note: string
): RefusalRow {
  return {
    ...persistedTarget(rails, target),
    applied: false,
    note: persistedText(rails, note),
  };
}

function persistedText(rails: Pick<MutationRails, "rejectSecretLike">, text: string): string {
  return rails.rejectSecretLike === true ? redactSecretLike(text) : text;
}

/**
 * The target as a journal row stores it, refused or applied: a guarded run's journal must not keep
 * a credential that named a file (a delete or rename of that file included), and a path is clipped
 * to the length cap.
 */
function persistedTarget(
  rails: Pick<MutationRails, "rejectSecretLike">,
  target: MutationTarget
): MutationTarget {
  const stored = (virtualPath: string): string =>
    persistedText(rails, virtualPath).slice(0, MEMORY_CONSOLIDATION_PATH_MAX_CHARS);
  return {
    ...target,
    path: stored(target.path),
    ...(target.newPath !== undefined && { newPath: stored(target.newPath) }),
  };
}

/**
 * Journals that recorded the full note. Kept beside the rows, not read from them: a failed
 * command's note quotes its model-chosen path, so a path ending in the full note would otherwise
 * drop every later refusal. Keyed by the array, so it holds for every tool that shares one; a
 * resumed analyzer attempt starts an empty journal (earlier ops stay apart), and so a fresh cap.
 */
const fullJournals = new WeakSet<MemoryConsolidationOp[]>();

/**
 * Journal a refusal while the journal has room. The refusal that reaches the last slot carries the
 * note that later ones are dropped, and so does the first one after rows of budgeted commands
 * filled the journal past it: those are pushed directly and always (the run's budget bounds them,
 * at most MEMORY_DREAM_EDIT_LIMIT_MAX for an organizer run), so
 * the note is recorded once whatever the order, and the journal holds at most one refusal past
 * the cap. The cap reads the journal itself, so it holds for every tool that shares one (the
 * analyzer's chunks of a run).
 */
function journalRefusal(journal: MemoryConsolidationOp[], row: RefusalRow): void {
  if (fullJournals.has(journal)) return;
  if (journal.length < MEMORY_CONSOLIDATION_JOURNAL_MAX_ENTRIES - 1) {
    journal.push(row);
    return;
  }
  fullJournals.add(journal);
  journal.push({ ...row, note: `${row.note} ${JOURNAL_FULL_NOTE}` });
}

/**
 * Build the guarded memory tool for one consolidation run. Exported separately
 * from runMemoryConsolidation so the rails are testable without a model.
 */
export function createConsolidationMemoryTool(args: {
  memoryService: MemoryService;
  metaService: MemoryMetaService;
  ctx: MemoryScopeContext;
  dryRun: boolean;
  /** Run-scoped journal; the tool appends every mutating command to it. */
  journal: MemoryConsolidationOp[];
  /** Injectable budget (refine shares one across memory + skill tools). */
  budget?: MutationBudget;
  /**
   * Invoked for every mutation ACCEPTED in dry-run mode (guard + budget
   * passed, nothing applied). The refine staging flow uses this to capture
   * the full command input for a later explicit apply; the plain dream
   * dry-run ignores it.
   */
  onStagedMutation?: (input: MemoryCommandInput, toolCallId: string) => void;
  /**
   * Refine apply only (r55 deletes, r58 inserts): staging-time target
   * fingerprints keyed by toolCallId, re-verified by MemoryService INSIDE
   * its target mutation lock immediately before the write — a delete has no
   * command-level conflict semantics, and an insert's numeric line position
   * silently lands in the wrong place on contents edited after staging.
   */
  expectedTargetFingerprints?: ReadonlyMap<string, string>;
  /**
   * Caller-teardown guard (r59): tool executions receive no hard
   * cancellation, so a run wedged in filesystem I/O is eventually detached
   * by the caller's bounded drain — and would otherwise commit durable
   * memory (and journal into a deleted session directory, recreating it)
   * once the I/O unblocks after workspace teardown. Checked at execute
   * entry AND re-verified by MemoryService inside its target mutation lock
   * immediately before the first durable write.
   */
  abortSignal?: AbortSignal;
  /**
   * Scopes this run may modify (reads are never scope-limited). Default: workspace, global and
   * project, which the dream pass uses. Project memory stays unavailable without a single stable
   * project identity even when listed. The harvest analyzer narrows this to `["workspace"]`, so
   * only the organizer promotes lessons to shared scopes.
   */
  writableScopes?: readonly WritableMemoryScope[];
  /**
   * Commands this run may not use. Default: none, which the dream pass uses. The harvest analyzer
   * denies `delete` and `rename` (only the organizer removes) and `insert`: its line offset comes
   * from an earlier read and goes stale under parallel calls and foreground writers, where
   * `create` and `str_replace` are anchored to content.
   */
  deniedCommands?: ReadonlyArray<MemoryConsolidationOp["command"]>;
  /**
   * Reject a create/str_replace/insert whose new text, or a create/rename whose new file name,
   * holds a credential shape (see `containsSecretLike`). For runs that read tool output and then
   * write memory.
   */
  rejectSecretLike?: boolean;
  /**
   * Lead sentence of the tool description. The command reference is always appended. Default
   * describes the dream pass ("you are consolidating").
   */
  description?: string;
}): { tool: Tool; getMutationCount: () => number; isBudgetExhausted: () => boolean } {
  const { memoryService, metaService, ctx, dryRun, journal } = args;
  const budget = args.budget ?? createMutationBudget(MEMORY_CONSOLIDATION_OP_BUDGET);
  const writableScopes = args.writableScopes ?? DEFAULT_WRITABLE_SCOPES;
  const rails: MutationRails = {
    memoryService,
    metaService,
    ctx,
    writableScopes,
    projectAvailable: ctx.projectPath !== "",
    deniedCommands: args.deniedCommands,
    rejectSecretLike: args.rejectSecretLike,
  };

  const memoryTool = tool({
    description: `${args.description ?? "Manage the persistent memory directory you are consolidating."} ${TOOL_DEFINITIONS.memory.description}`,
    inputSchema: TOOL_DEFINITIONS.memory.schema,
    // toolCallId is threaded into the r2 refinement journal rows so callers
    // (refine, r11) can correlate this run's edits to their journaled ids.
    execute: async (input, { toolCallId }): Promise<MemoryToolResult> => {
      // r59: a cancelled pass must not start new work — the in-service
      // pre-commit recheck (below) is what stops executions that were
      // already in flight when the caller was torn down.
      if (args.abortSignal?.aborted === true) {
        return { success: false, error: CANCELLED_PASS_ERROR };
      }
      const target = classifyMutation(input);
      if (target === null) {
        // Reads (and malformed inputs, which fail validation inside) pass through. A read that
        // stalls in filesystem I/O has nothing to re-check the signal, and the provider loop
        // waits for the tool result: race it, so the run's timeout and removal still end the run.
        const read = await raceWithAbortAndTimeout(
          executeMemoryCommand(memoryService, ctx, input, () => null, toolCallId),
          { signal: args.abortSignal }
        );
        return read.kind === "ok" ? read.value : { success: false, error: CANCELLED_PASS_ERROR };
      }

      let rejection: string | null;
      try {
        rejection = await mutationRejection(rails, target, input);
      } catch (error) {
        // parseMemoryPath throws on invalid paths; surface as a tool error.
        return { success: false, error: getErrorMessage(error) };
      }
      if (rejection !== null) {
        journalRefusal(journal, refusalRow(rails, target, rejection));
        return { success: false, error: rejection };
      }

      // Budget is consumed by every accepted mutation — including dry-run and
      // dispatch failures — so dry-run mirrors a real run (check+reserve
      // atomicity lives in MutationBudget.tryConsume).
      if (!budget.tryConsume()) {
        const note = `Mutation budget exhausted (${budget.limit} per run); stop and summarize.`;
        journalRefusal(journal, refusalRow(rails, target, note));
        return { success: false, error: note };
      }

      if (dryRun) {
        // Validate BEFORE staging: the real write path enforces
        // command-specific required args (executeMemoryCommand) and the
        // memory file cap (MemoryService) — skipping them here let an
        // invalid/oversized proposal be staged, rendered in full into chat,
        // and only rejected by the real handler at /refine apply AFTER the
        // user approved, consuming the staged set as a silent no-op.
        const invalid = await validateMutationForStaging(memoryService, ctx, input, {
          rejectSecretLike: args.rejectSecretLike,
        });
        if (invalid !== null) {
          journal.push({ ...target, applied: false, note: invalid });
          return { success: false, error: invalid };
        }
        journal.push({ ...target, applied: false, note: "dry-run" });
        args.onStagedMutation?.(input, toolCallId);
        return { success: true, output: `[dry-run] recorded ${target.command} ${target.path}` };
      }

      const result = await executeMemoryCommand(memoryService, ctx, input, () => null, toolCallId, {
        expectedTargetFingerprint: args.expectedTargetFingerprints?.get(toolCallId),
        abortSignal: args.abortSignal,
        rejectPinned: true,
        // The pre-check above sees only the new text; this one sees the file the write would leave.
        rejectSecretLike: args.rejectSecretLike,
      });
      journal.push({
        ...persistedTarget(rails, target),
        applied: result.success,
        note: result.success ? undefined : persistedText(rails, result.error),
      });
      return result;
    },
  });
  return {
    tool: memoryTool,
    getMutationCount: () => budget.used(),
    isBudgetExhausted: () => budget.used() >= budget.limit,
  };
}

/**
 * What an organizer run's edit limit sets: the memory tool's budget, the line of the run prompt
 * that states it (dream.md names no number, and a user's own dream definition may not either), and
 * the step ceiling. Absent (the debug CLI) is the default limit; `null` is the user's unlimited.
 *
 * Unlimited, and any limit over it, runs at MEMORY_DREAM_EDIT_LIMIT_MAX: memory contents are
 * untrusted model input, so the cap bounds the accepted writes of one run and its journal rows.
 * The preference schema already refuses a larger value; Math.min guards every other caller.
 * The step ceiling is 4 steps for each edit (today's 32 steps for the default 8), never below
 * MEMORY_CONSOLIDATION_MAX_STEPS, so a raised limit can be spent.
 */
export function organizerEditBudget(editLimit: number | null | undefined): {
  budget: MutationBudget;
  promptLine: string;
  stepCeiling: Array<StopCondition<ToolSet>>;
} {
  const limit = Math.min(
    editLimit === undefined
      ? MEMORY_CONSOLIDATION_OP_BUDGET
      : (editLimit ?? Number.POSITIVE_INFINITY),
    MEMORY_DREAM_EDIT_LIMIT_MAX
  );
  return {
    budget: createMutationBudget(limit),
    promptLine: `You have ${limit} mutating commands this run.`,
    stepCeiling: [stepCountIs(Math.max(MEMORY_CONSOLIDATION_MAX_STEPS, 4 * limit))],
  };
}

/**
 * Run one headless consolidation pass. The caller resolves the model and the
 * dream agent body (CLI: built-in definition; app: standard agent resolution)
 * so this module stays independent of agent-resolution plumbing.
 */
export async function runMemoryConsolidation(args: {
  model: LanguageModel;
  /** Resolved dream agent system prompt body. */
  agentBody: string;
  memoryService: MemoryService;
  metaService: MemoryMetaService;
  ctx: MemoryScopeContext;
  dryRun: boolean;
  /**
   * Archive trigger: instructs the agent that this is the workspace's final
   * pass, so durable lessons must be moved to the narrowest available scope
   * before workspace memory is deleted (PRD #3534).
   */
  finalPass?: boolean;
  abortSignal?: AbortSignal;
  /**
   * Best-effort cost telemetry: headless consolidation bypasses the chat cost
   * pipeline, so the caller records the full stream usage (with cache-token
   * breakdown) into session-usage.json. Invoked after every stream that completed, one cut
   * off at the output limit included, and never after a failed or aborted one.
   * providerMetadata is step-accumulated — Anthropic reports billed
   * cache-write tokens only there, so dropping it would price cache writes
   * as ordinary input.
   */
  recordUsage?: (
    usage: LanguageModelV2Usage,
    providerMetadata?: Record<string, unknown>
  ) => Promise<void>;
  /** Pricing identity of `model`; its long-context threshold sets each step's tier. */
  pricingModel?: string;
  /** The run stops once its measured spend reaches this many USD; none when absent. */
  ceilingUsd?: number;
  /**
   * Mutating commands this run may make: the user's dream edit limit. `null` means unlimited, up
   * to the safety cap MEMORY_DREAM_EDIT_LIMIT_MAX. Absent (the debug CLI) means
   * MEMORY_CONSOLIDATION_OP_BUDGET.
   */
  editLimit?: number | null;
}): Promise<MemoryConsolidationResult> {
  assert(args.agentBody.trim().length > 0, "dream agent body must not be empty");
  const editBudget = organizerEditBudget(args.editLimit);
  const journal: MemoryConsolidationOp[] = [];
  const { tool: memoryTool, isBudgetExhausted } = createConsolidationMemoryTool({
    budget: editBudget.budget,
    memoryService: args.memoryService,
    metaService: args.metaService,
    ctx: args.ctx,
    dryRun: args.dryRun,
    journal,
    // r59: workspace removal aborts this signal — a tool execution wedged in
    // filesystem I/O must not commit durable memory (or recreate the deleted
    // session directory via its journal row) once the I/O unblocks.
    abortSignal: args.abortSignal,
    // What the organizer writes can be promoted to project and global memory, which models of other
    // workspaces read: refuse credential-like text in code, not only by the prompt's instruction.
    rejectSecretLike: true,
  });

  // Whatever the final pass promotes lands where models of unrelated projects read it, so a
  // credential must not travel with it (the dream prompt says the same for the whole pass).
  const finalPassNoSecrets =
    " Never promote a credential or other secret-like value: leave the value out and say what it was for.";
  const finalPassPrompt =
    args.finalPass !== true
      ? ""
      : (args.ctx.projectPath === ""
          ? " This is the FINAL pass for an archived workspace: preserve only cross-project user preferences or environment facts in /memories/global/... before workspace memory is deleted. Project memory is unavailable for this run; do not promote project-specific lessons to global memory."
          : " This is the FINAL pass for an archived workspace: promote durable workspace lessons before workspace memory is deleted. Move repo-specific lessons to /memories/project/... and only cross-project user preferences or environment facts to /memories/global/....") +
        finalPassNoSecrets;

  const meter = createSpendMeter({ pricingModel: args.pricingModel, ceilingUsd: args.ceilingUsd });
  const stream = streamText({
    model: args.model,
    system: args.agentBody,
    prompt:
      `Run a memory-consolidation pass now. ${editBudget.promptLine}` +
      " Survey the memory directories, then apply the highest-value cleanups within budget." +
      finalPassPrompt,
    tools: { memory: memoryTool },
    stopWhen: [...editBudget.stepCeiling, meter.stopIfCeilingReached],
    onStepEnd: meter.recordStep,
    maxOutputTokens: meter.maxOutputTokens,
    abortSignal: args.abortSignal,
  });

  // Drain the stream; tool executions happen as the loop runs. consumeStream
  // (vs. awaiting .text directly) surfaces mid-stream errors via onError
  // below instead of throwing per-part. Array (not a string flag) because TS
  // cannot track assignments inside the callback for narrowing.
  const streamErrors: string[] = [];
  await stream.consumeStream({
    onError: (error) => {
      streamErrors.push(getErrorMessage(error));
    },
  });
  // An abort ends the stream without an error part, so a pass cut short by its timeout or by
  // workspace removal would read as clean and be journaled as a success.
  if (streamErrors.length === 0 && args.abortSignal?.aborted === true) {
    streamErrors.push("memory consolidation was cut short by its timeout or by workspace removal");
  }
  // Set apart from `streamErrors`: only a stream that failed or was aborted has unreliable usage.
  const streamCompleted = streamErrors.length === 0;
  // When the stream's last step hit the output limit, the SDK ran none of its tool calls, yet the
  // stream ends clean: without this the pass would be journaled as a success and the debounce
  // would hold off its retry. An earlier cut-off step does not count: its call comes back to the
  // model as a tool error, and a later step can retry it (the meter keeps only the last step).
  const streamError =
    streamErrors[0] ??
    (streamCompleted && meter.endedAtOutputLimit()
      ? "memory consolidation ended a step at the model's output limit, so its tool call never ran"
      : undefined);
  // The summary is persisted in the sidecar and shown through status IPC: a credential the model
  // repeats from memory in its closing text must not outlive the guarded writes.
  const summary = redactSecretLike(
    streamError === undefined ? (await stream.text).trim() : `stream error: ${streamError}`
  );

  // Cost telemetry: headless runs bypass the chat cost pipeline, so the
  // journal record is the only place token usage is visible. Only awaited on
  // completed streams — after a mid-flight error, totalUsage can stay pending
  // forever (streamManager guards the same promise with withTimeout). A stream
  // cut off at the output limit completed and was billed, so it is recorded too.
  let usage: MemoryConsolidationResult["usage"];
  if (streamCompleted) {
    try {
      // AI SDK 7: top-level `usage` is the all-steps total (old `totalUsage`).
      const totalUsage = await stream.usage;
      usage = {
        inputTokens: totalUsage.inputTokens ?? 0,
        outputTokens: totalUsage.outputTokens ?? 0,
      };
      await args.recordUsage?.(
        totalUsage,
        accumulateStepsProviderMetadata(await stream.steps, args.pricingModel)
      );
    } catch {
      usage = undefined;
    }
  }

  return {
    ops: journal,
    summary,
    // Derived from accepted mutations, not journal length: journaled guard
    // rejections must not report a budget the run never spent (MEM-RPT-01).
    budgetExhausted: isBudgetExhausted(),
    usage,
    spentUsd: meter.spentUsd(),
    note: meter.note(),
    streamError,
  };
}
