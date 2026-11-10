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
/**
 * Safety cap on the user's dream edit limit: the most mutating commands one organizer run can
 * make, also when the user chose unlimited (0 or an empty field). Memory contents are untrusted
 * model input, so without a cap a misbehaving organizer could make any number of accepted writes
 * in one run, and every accepted write is a journal row that is saved in memory-consolidation.json
 * and returned over IPC (Codex review of #8096). The maintainer chose 1000: far more than one
 * cleanup needs (about 200 oversized files split at roughly 5 edits each). One run's journal
 * then holds at most 1032 rows (1000 accepted, 32 refused), each row's text at most two paths of
 * MEMORY_CONSOLIDATION_PATH_MAX_CHARS and a note of MEMORY_CONSOLIDATION_NOTE_MAX_CHARS: about
 * 2.2 MB for one record with ASCII text, at most about 12.8 MB if JSON escapes every character,
 * and far less for real records. MEMORY_DREAM_MAX_STEPS bounds the run's steps separately.
 */
export const MEMORY_DREAM_EDIT_LIMIT_MAX = 1000;
/** Generous step ceiling for the consolidation stream (reads + budgeted mutations). */
export const MEMORY_CONSOLIDATION_MAX_STEPS = 32;
/**
 * Most steps one organizer run takes, whatever the user's edit limit: no setting raises it. The
 * run's step ceiling is 4 steps for each edit of the limit, never below
 * MEMORY_CONSOLIDATION_MAX_STEPS and never above this. Read-only calls spend no edit, so without
 * it an unlimited run (or a limit of 1000) could take 4000 model requests, and the cost ceiling is
 * optional (Codex review of #8096). The maintainer chose 400; one step can make several parallel
 * edits, so a run can still spend a large limit within it.
 */
export const MEMORY_DREAM_MAX_STEPS = 400;
/**
 * Rows of one run's journal that the guarded memory tool fills with refused commands (out of scope,
 * denied, credential-like, over budget). A refusal spends no budget, and one step can issue many
 * parallel calls, so without a bound a misbehaving model grows the journal, which is saved in the
 * run's sidecar record and returned over IPC. 32 is the default organizer's step ceiling: a model
 * that has one command refused per step still gets every refusal journaled. Past it, the last row
 * says the rest are not recorded. Budgeted commands (applied, dry-run, failed) are always
 * journaled, so the cap never hides a change; they are at most the run's budget, which for an
 * organizer run is the user's edit limit and never more than MEMORY_DREAM_EDIT_LIMIT_MAX. One
 * run's journal therefore holds at most that cap plus these 32 rows; the row that says the rest
 * are not recorded is one of the 32.
 */
export const MEMORY_CONSOLIDATION_JOURNAL_MAX_ENTRIES = 32;
/**
 * Longest path (characters, virtual `/memories/...` form) a mutating command may name. The tool
 * schema bounds no length, and the journal stores the path of every row and quotes it in refusal
 * notes. 512 is twice the 255-byte name limit of common filesystems and far above any real memory
 * path (the index shows 200-character descriptions, and names are short); a longer one is refused
 * before it is parsed or journaled in full.
 */
export const MEMORY_CONSOLIDATION_PATH_MAX_CHARS = 512;
/**
 * Longest note (characters) a journal row stores. A failed command's error can be long: a
 * str_replace whose old_str matches many lines of a large file lists every line number, and an
 * organizer run can journal up to MEMORY_DREAM_EDIT_LIMIT_MAX failed edits. A refusal note
 * quotes at most one path of MEMORY_CONSOLIDATION_PATH_MAX_CHARS, but a guarded run's redaction
 * can lengthen it past this cap (a path of `token=a&` segments), so every note over it is cut,
 * with a marker. The tool still returns the whole error to the model.
 */
export const MEMORY_CONSOLIDATION_NOTE_MAX_CHARS = 1024;
/**
 * Memory analyzer (the harvest of one closed or open compaction epoch): mutating memory
 * commands for the whole epoch. All of its transcript chunks, a retry of the epoch, and
 * every later run of the same epoch (an archive after new rows, the compaction that
 * closes it) spend one budget, so a long epoch cannot out-write a short one.
 */
export const MEMORY_ANALYZER_OP_BUDGET = 8;
/** Step ceiling for one analyzer chunk (reads of related memory + budgeted edits). */
export const MEMORY_ANALYZER_MAX_STEPS = 12;
/**
 * Output cap of one model call (one step) of the analyzer and of the organizer. The dream's cost
 * ceiling stops a run only after a step whose measured cost reaches it, so the step in flight
 * can still go past the ceiling. The cap bounds what that step can write, so it applies only to a
 * run that has a ceiling (see SpendMeter.maxOutputTokens). A step that hits it finishes with
 * `length`, and the SDK runs no valid tool call of such a step. A call cut off mid-input comes
 * back to the model as a tool error it can retry from; a stream whose last step still ends at the
 * limit is an incomplete run for both callers (see SpendMeter.endedAtOutputLimit).
 */
export const MEMORY_MAX_OUTPUT_TOKENS_PER_STEP = 4_096;
/** Smallest dream cost ceiling a user can set, in USD: the cent, the unit a stopped run reports in. */
export const MEMORY_DREAM_COST_CEILING_MIN_USD = 0.01;
/**
 * Largest dream cost ceiling a user can set, in USD. Far above what a dream run costs, so it is
 * the same as no ceiling; the cap keeps the saved number short enough that `String()` never
 * prints it in exponent notation (1e+21), which the ceiling field would then read as invalid.
 */
export const MEMORY_DREAM_COST_CEILING_MAX_USD = 100_000;
/**
 * Memory harvest: transcript chunks one epoch's harvest reads. Each chunk is a model call of at
 * most 40,000 characters of transcript, and the per-part caps leave an epoch's total unbounded
 * (thousands of parallel tool calls, or megabytes of pasted text, make hundreds of chunks). 12 is
 * about 480,000 characters, or 120,000 tokens: a context window's worth of rendered transcript,
 * and a run that fits the dream's timeout when each chunk takes under half a minute. Past it the
 * transcript is cut, at its end, and the last chunk says so.
 */
export const MEMORY_HARVEST_MAX_CHUNKS = 12;
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
