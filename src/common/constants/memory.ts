/**
 * Agent Memory constants (experiment: "memory").
 *
 * Models only ever see virtual paths under the virtual root (e.g.
 * /memories/global/preferences.md). The MemoryService maps each scope to a
 * physical root:
 * - global    -> <xumHome>/memory/global/ (host-local, permanent, shared across projects)
 * - project   -> <xumHome>/memory/project/<project dir>/ (host-local, private
 *                per-project notes; never committed to the repo, survives
 *                workspaces; carried by the settings backup only when the
 *                user opts into the project bundle)
 * - workspace -> <sessionDir>/memory/ of the task-tree OWNER (host-local, deleted
 *                with that workspace; sub-agents share their parent's store)
 * - session   -> <sessionDir>/session-memory/ of the ACTING workspace (host-local,
 *                deleted with that workspace; never shared with the parent or
 *                sub-agents). Token budget keeps its rollover checkpoint here, and
 *                agents see the scope only in token-budget mode.
 */

/** Virtual root prefix all memory paths are expressed under. */
export const MEMORY_VIRTUAL_ROOT = "/memories";

export const MEMORY_SCOPES = ["global", "project", "workspace", "session"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** Scopes every memory caller may use; the session scope needs an explicit opt-in. */
export const SHARED_MEMORY_SCOPES: readonly MemoryScope[] = MEMORY_SCOPES.filter(
  (scope) => scope !== "session"
);

/** Directory of the session scope inside the acting workspace's session dir. */
export const SESSION_MEMORY_DIR_NAME = "session-memory";

/** Virtual directory of the session scope, where token-budget agents keep their checkpoint. */
export const SESSION_MEMORY_VIRTUAL_DIR = `${MEMORY_VIRTUAL_ROOT}/session/`;

export type MemoryAccessLevel = "read" | "readwrite";

/**
 * Per-scope write policy for the memory tool, derived from the agent class:
 * - Exec-like (editing-capable): all scopes read-write.
 * - Plan-like: all scopes read-write; project memory is host-local and never
 *   mutates the checkout.
 * - Explore/read-only: all scopes read-only (view only), except session.
 * Every agent may write its own session scope: it is a private checkpoint that no
 * other agent reads, and read-only agents need it to survive a context rollover.
 */
export type MemoryScopeAccess = Record<MemoryScope, MemoryAccessLevel>;

/** Maximum size of a single memory file (bytes). */
export const MEMORY_MAX_FILE_BYTES = 100 * 1024;

/** Maximum number of files per scope. */
export const MEMORY_MAX_FILES_PER_SCOPE = 1000;

/**
 * Maximum length of a memory file's one-line description in the injected
 * memory index (frontmatter `description`, truncated for prompt budget and
 * index hardening).
 */
export const MEMORY_INDEX_DESCRIPTION_MAX_CHARS = 200;

/**
 * Bytes read from the head of each file when building the memory index.
 * Memory files can be edited outside MemoryService write caps, so index builds
 * must never fully read arbitrarily large files; the frontmatter description
 * must start within this prefix or it degrades to "" (file stays listed).
 */
export const MEMORY_INDEX_DESCRIPTION_PREFIX_BYTES = 4 * 1024;

/** Directory listing depth for `view` on a directory (per Anthropic memory-tool semantics). */
export const MEMORY_VIEW_MAX_DEPTH = 2;

/**
 * Memory consolidation ("dream" agent, issue #3534): maximum mutating memory
 * commands per consolidation run. Reads are unlimited; the budget bounds churn
 * from a misbehaving model.
 */
export const MEMORY_CONSOLIDATION_OP_BUDGET = 8;
/** Generous step ceiling for the consolidation stream (reads + budgeted mutations). */
export const MEMORY_CONSOLIDATION_MAX_STEPS = 32;
/**
 * Memory analyzer (the harvest of one closed compaction epoch): mutating memory
 * commands for the whole epoch. All of its transcript chunks, and a retry of the
 * epoch, spend one budget, so a long epoch cannot out-write a short one.
 */
export const MEMORY_ANALYZER_OP_BUDGET = 8;
/** Step ceiling for one analyzer chunk (reads of related memory + budgeted edits). */
export const MEMORY_ANALYZER_MAX_STEPS = 12;
/**
 * Output cap of one model call (one step) of the analyzer and of the organizer. The dream's cost
 * estimate prices each step's output at this many tokens, and the cap makes that a limit the run
 * cannot exceed, so the estimate stays an upper bound however long a reply the model tries to
 * write. A memory command longer than this is cut off and fails to parse; the model sees the
 * failure and can write it in smaller pieces.
 */
export const MEMORY_MAX_OUTPUT_TOKENS_PER_STEP = 4_096;
/**
 * Smallest dream cost ceiling a user can set, in USD. A run's cost estimate is an upper bound
 * that rarely falls below a cent, so a lower ceiling would only refuse every run.
 */
export const MEMORY_DREAM_COST_CEILING_MIN_USD = 0.01;
/**
 * Largest dream cost ceiling a user can set, in USD. Far above any run's estimate, so it is the
 * same as no ceiling; the cap keeps the saved number short enough that `String()` never prints it
 * in exponent notation (1e+21), which the ceiling field would then read as invalid.
 */
export const MEMORY_DREAM_COST_CEILING_MAX_USD = 100_000;
/** Minimum gap between consolidation runs for one workspace (debounce across triggers). */
export const MEMORY_CONSOLIDATION_DEBOUNCE_MS = 6 * 60 * 60 * 1000;
/** Launch sweep: a workspace qualifies after this much user inactivity. */
export const MEMORY_CONSOLIDATION_IDLE_MS = 24 * 60 * 60 * 1000;
/**
 * Launch sweep: at most this many workspaces consolidate per app launch, so a
 * backlog of idle workspaces can never stampede the provider on startup.
 */
export const MEMORY_CONSOLIDATION_LAUNCH_SWEEP_CAP = 3;
/**
 * Hard wall-clock ceiling per consolidation stream. Without it a half-alive
 * provider stream (keepalives but no progress) would hold the workspace's
 * in-flight lock, and the service-wide dream queue, forever. It starts when the
 * stream starts: time spent waiting behind another workspace's stream does not
 * count.
 */
export const MEMORY_CONSOLIDATION_TIMEOUT_MS = 5 * 60 * 1000;
