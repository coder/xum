/**
 * Goal status board (experiment: "artifacts").
 *
 * While a workspace has a goal, the HOST keeps `$XUM_SCRATCH_DIR/artifacts/goal.status.html`
 * current: objective, status, budget burn, the todo checklist, and PR checks/review threads.
 * It is refreshed when a goal is set, replaced, edited or completed, when a goal continuation
 * turn starts, and after successful todo_write/propose_plan calls. When the last goal is cleared
 * the board says "No active goal" (a write, not a delete: deletes would need their own
 * containment). It is a live file: no artifact versions are published for it.
 *
 * Board errors never affect turns: every refresh runs in the background, failures are logged at
 * debug level, and the PR section degrades to "PR status unavailable".
 */
import * as path from "path";
import type { TodoItem } from "@/common/types/tools";
import type { GoalRecordV1 } from "@/common/types/goal";
import type { WorkspaceService } from "@/node/services/workspaceService";
import { assert } from "@/common/utils/assert";
import { shescape } from "@/node/runtime/streamUtils";
import { readTodosForSessionDir } from "@/node/services/todos/todoStorage";
import { projectAutomationDisabled } from "@/node/utils/projectAutomation";
import { resolveArtifactsLocation, writeArtifactAtLocation } from "./artifactsOperations";
import { log } from "./log";

export const GOAL_STATUS_BOARD_FILE = "goal.status.html";
/** Each gh call is bounded; the board is never worth a slow turn. */
export const GOAL_BOARD_GH_TIMEOUT_SECONDS = 10;

export interface GoalBoardPrStatus {
  number: number;
  url: string;
  /**
   * Only SUCCESS counts as passed. NEUTRAL/SKIPPED are non-blocking on GitHub, so they are
   * shown as skipped; STALE and unknown conclusions are not a result yet, so they are pending.
   */
  checks: { passed: number; failed: number; pending: number; skipped: number };
  /** null when the review-thread query failed. */
  unresolvedThreads: { count: number; atLeast: boolean } | null;
}

/** `none`: the branch has no PR (section omitted). `unavailable`: gh failed. */
export type GoalBoardPrSection =
  | { kind: "none" }
  | { kind: "unavailable" }
  | { kind: "pr"; status: GoalBoardPrStatus };

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const STATUS_LABELS: Record<GoalRecordV1["status"], string> = {
  active: "Active",
  paused: "Paused",
  budget_limited: "Budget limit reached",
  complete: "Complete",
};

const TODO_LABELS: Record<TodoItem["status"], string> = {
  completed: "Done",
  in_progress: "In progress",
  pending: "To do",
};

function meter(fraction: number): string {
  const percent = Math.round(Math.min(Math.max(fraction, 0), 1) * 100);
  return `<div class="meter" role="presentation"><div style="width:${percent}%"></div></div>`;
}

function renderPrSection(pr: GoalBoardPrSection): string {
  if (pr.kind === "none") return "";
  if (pr.kind === "unavailable") {
    return `<section><h2>Pull request</h2><p class="muted">PR status unavailable</p></section>`;
  }
  const { number, url, checks, unresolvedThreads } = pr.status;
  const total = checks.passed + checks.failed + checks.pending + checks.skipped;
  const ci =
    total === 0
      ? "No checks reported"
      : checks.failed > 0
        ? "Failing"
        : checks.pending > 0
          ? "Pending"
          : checks.passed > 0
            ? "Passing"
            : "Skipped";
  const ciClass =
    checks.failed > 0 ? "bad" : checks.pending > 0 ? "warn" : checks.passed > 0 ? "ok" : "";
  const skipped = checks.skipped > 0 ? `, ${checks.skipped} skipped` : "";
  const threads =
    unresolvedThreads == null
      ? "unavailable"
      : `${unresolvedThreads.count}${unresolvedThreads.atLeast ? "+" : ""}`;
  return `<section><h2>Pull request</h2>
<p><strong>#${number}</strong> <span class="muted url">${escapeHtml(url)}</span></p>
<dl>
<dt>Last CI run</dt><dd><span class="pill ${ciClass}">${ci}</span> <span class="muted">${checks.passed} passed, ${checks.failed} failed, ${checks.pending} pending${skipped}</span></dd>
<dt>Open review threads</dt><dd>${threads}</dd>
</dl></section>`;
}

/**
 * Light palette by default. Dark follows the app theme when the artifact frame's bridge set
 * `data-xum-theme` on the root (artifactBridge.ts), and the OS preference only when it did not
 * (for example when the file is opened outside Xum).
 */
const BOARD_DARK_PALETTE =
  "color-scheme:dark;--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--border:#3d444d;--track:#21262d;--accent:#4493f8;--ok:#3fb950;--warn:#d29922;--bad:#f85149";

function renderBoardDocument(header: string, body: string, updatedAtMs: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Goal status</title>
<style>
:root{color-scheme:light;--bg:#ffffff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--track:#eff2f5;--accent:#0969da;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e}
:root[data-xum-theme=dark]{${BOARD_DARK_PALETTE}}
@media (prefers-color-scheme: dark){:root:not([data-xum-theme]){${BOARD_DARK_PALETTE}}}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
main{max-width:720px;margin:0 auto}
header{display:flex;flex-wrap:wrap;align-items:center;gap:8px;justify-content:space-between}
h1{font-size:18px;margin:0}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 8px}
section{border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:12px}
.objective,.summary{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
.summary{margin-top:8px;color:var(--muted)}
.pill{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:0 8px;font-size:12px}
.accent{color:var(--accent)}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.muted{color:var(--muted)}
.url{overflow-wrap:anywhere}
dl{display:grid;grid-template-columns:minmax(0,auto) minmax(0,1fr);gap:4px 12px;margin:0}
dt{color:var(--muted)}dd{margin:0;min-width:0}
.meter{height:6px;border-radius:3px;background:var(--track);overflow:hidden;margin-top:4px}
.meter>div{height:100%;background:var(--accent)}
.todos{list-style:none;margin:0;padding:0}
.todos li{display:flex;gap:8px;align-items:flex-start;padding:2px 0;overflow-wrap:anywhere}
.box{flex:none;width:12px;height:12px;margin-top:4px;border:1.5px solid var(--muted);border-radius:3px}
.completed .box{background:var(--ok);border-color:var(--ok)}
.completed span:last-child{color:var(--muted);text-decoration:line-through}
.in_progress .box{border-color:var(--accent);background:linear-gradient(90deg,var(--accent) 50%,transparent 50%)}
footer{margin-top:12px;font-size:12px;color:var(--muted)}
</style>
</head>
<body>
<main>
<header><h1>Goal status</h1>${header}</header>
${body}
<footer>Updated ${escapeHtml(new Date(updatedAtMs).toISOString())}. Xum maintains this file; edits are overwritten.</footer>
</main>
</body>
</html>
`;
}

/**
 * Static, self-contained HTML: inline CSS, no scripts, every interpolated string escaped.
 * A null goal (the last goal was cleared) renders a "No active goal" board.
 */
export function renderGoalStatusBoardHtml(input: {
  goal: GoalRecordV1 | null;
  todos: TodoItem[];
  pr: GoalBoardPrSection;
  updatedAtMs: number;
}): string {
  const { goal, todos } = input;
  if (goal == null) {
    return renderBoardDocument(
      `<span class="pill">No active goal</span>`,
      `<section><p class="muted">No active goal. This board updates when a new goal is set.</p></section>`,
      input.updatedAtMs
    );
  }
  const statusClass =
    goal.status === "complete"
      ? "ok"
      : goal.status === "active"
        ? "accent"
        : goal.status === "budget_limited"
          ? "bad"
          : "warn";
  const spent =
    goal.budgetCents == null
      ? `${formatCents(goal.costCents)} spent (no budget)`
      : `${formatCents(goal.costCents)} of ${formatCents(goal.budgetCents)}`;
  const turns =
    goal.turnCap == null
      ? `${goal.turnsUsed} used (no cap)`
      : `${goal.turnsUsed} of ${goal.turnCap}`;
  const done = todos.filter((todo) => todo.status === "completed").length;
  const checklist =
    todos.length === 0
      ? `<p class="muted">No checklist yet.</p>`
      : `<ul class="todos">${todos
          .map(
            (todo) =>
              `<li class="${todo.status}"><span class="box" aria-label="${TODO_LABELS[todo.status]}"></span><span>${escapeHtml(todo.content)}</span></li>`
          )
          .join("")}</ul>`;
  const summary =
    goal.completionSummary != null
      ? `<p class="summary">${escapeHtml(goal.completionSummary)}</p>`
      : "";
  return renderBoardDocument(
    `<span class="pill ${statusClass}">${STATUS_LABELS[goal.status]}</span>`,
    `<section><h2>Objective</h2><p class="objective">${escapeHtml(goal.objective)}</p>${summary}</section>
<section><h2>Budget</h2><dl>
<dt>Spent</dt><dd>${spent}${goal.budgetCents != null && goal.budgetCents > 0 ? meter(goal.costCents / goal.budgetCents) : ""}</dd>
<dt>Turns</dt><dd>${turns}${goal.turnCap != null ? meter(goal.turnsUsed / goal.turnCap) : ""}</dd>
</dl></section>
<section><h2>Checklist${todos.length > 0 ? ` <span class="muted">${done}/${todos.length}</span>` : ""}</h2>${checklist}</section>
${renderPrSection(input.pr)}`,
    input.updatedAtMs
  );
}

/** Runs a script in the workspace (runtime + checkout cwd); stdout, or null on any failure. */
export type GoalBoardBashRunner = (
  workspaceId: string,
  script: string,
  timeoutSecs: number
) => Promise<string | null>;

const PR_VIEW_SCRIPT = `if out=$(gh pr view --json number,url,statusCheckRollup 2>/dev/null); then printf '%s\\n' "$out"; exit 0; fi
if gh pr view --json number 2>&1 | grep -q 'no pull requests found'; then echo '{"no_pr":true}'; exit 0; fi
exit 1`;

const REVIEW_THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){totalCount nodes{isResolved}}}}}";

/** Completed but non-blocking on GitHub: neither a pass nor a failure. */
const SKIPPED_CONCLUSIONS = new Set(["NEUTRAL", "SKIPPED"]);

const FAILED_CONCLUSIONS = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
]);

/** Classify statusCheckRollup items: CheckRuns carry status/conclusion, StatusContexts state. */
export function summarizeChecks(raw: unknown): GoalBoardPrStatus["checks"] {
  const checks = { passed: 0, failed: 0, pending: 0, skipped: 0 };
  if (!Array.isArray(raw)) return checks;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const state = typeof record.state === "string" ? record.state.toUpperCase() : null;
    const status = typeof record.status === "string" ? record.status.toUpperCase() : null;
    const conclusion =
      typeof record.conclusion === "string" && record.conclusion !== ""
        ? record.conclusion.toUpperCase()
        : null;
    if (state != null && status == null) {
      if (state === "SUCCESS") checks.passed++;
      else if (FAILED_CONCLUSIONS.has(state)) checks.failed++;
      else checks.pending++;
    } else if (status !== "COMPLETED" || conclusion == null) {
      checks.pending++;
    } else if (conclusion === "SUCCESS") {
      checks.passed++;
    } else if (FAILED_CONCLUSIONS.has(conclusion)) {
      checks.failed++;
    } else if (SKIPPED_CONCLUSIONS.has(conclusion)) {
      checks.skipped++;
    } else {
      // STALE and conclusions this code does not know yet: fail closed, never "passed".
      checks.pending++;
    }
  }
  return checks;
}

function parseJsonObject(output: string): Record<string, unknown> | null {
  // Login shells can print banners first: parse from the first line that starts an object.
  const start = output.search(/^\{/m);
  if (start === -1) return null;
  try {
    const parsed: unknown = JSON.parse(output.slice(start));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function fetchGoalBoardPrSection(
  workspaceId: string,
  runBash: GoalBoardBashRunner
): Promise<GoalBoardPrSection> {
  const view = await runBash(workspaceId, PR_VIEW_SCRIPT, GOAL_BOARD_GH_TIMEOUT_SECONDS);
  const parsed = view == null ? null : parseJsonObject(view);
  if (parsed == null) return { kind: "unavailable" };
  if (parsed.no_pr === true) return { kind: "none" };
  const number = parsed.number;
  const url = parsed.url;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || typeof url !== "string") {
    return { kind: "unavailable" };
  }
  const repo = /^https:\/\/[^/]+\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/\d+/.exec(url);
  let unresolvedThreads: GoalBoardPrStatus["unresolvedThreads"] = null;
  if (repo) {
    const script =
      `gh api graphql -f query=${shescape.quote(REVIEW_THREADS_QUERY)}` +
      ` -F owner=${shescape.quote(repo[1])} -F name=${shescape.quote(repo[2])} -F number=${number}` +
      ` --jq '.data.repository.pullRequest.reviewThreads | {total: .totalCount, seen: (.nodes | length), unresolved: ([.nodes[] | select(.isResolved | not)] | length)}'`;
    const threads = await runBash(workspaceId, script, GOAL_BOARD_GH_TIMEOUT_SECONDS);
    const counts = threads == null ? null : parseJsonObject(threads);
    if (
      counts != null &&
      typeof counts.unresolved === "number" &&
      typeof counts.total === "number" &&
      typeof counts.seen === "number"
    ) {
      // Only the first 100 threads are fetched; more than that makes the count a lower bound.
      unresolvedThreads = { count: counts.unresolved, atLeast: counts.total > counts.seen };
    }
  }
  return {
    kind: "pr",
    status: { number, url, checks: summarizeChecks(parsed.statusCheckRollup), unresolvedThreads },
  };
}

/**
 * Adapts WorkspaceService.executeBash for the board's gh probes. `gh pr view` without an
 * argument resolves the PR from the current branch, so it must run inside a checkout:
 * multi-project script mode otherwise runs at the shared container root, outside every repo.
 * repo-root runs it in the primary project's checkout.
 */
export function createWorkspaceBoardBashRunner(
  executeBash: WorkspaceService["executeBash"]
): GoalBoardBashRunner {
  return async (workspaceId, script, timeoutSecs) => {
    // executeBash sources a trusted project's .xum/tool_env. Under the project-automation kill
    // switch (config-trusted dataset repos) a background refresh must not run repo code, so the
    // board shows the PR status as unavailable instead.
    if (projectAutomationDisabled()) return null;
    const result = await executeBash(workspaceId, script, {
      timeout_secs: timeoutSecs,
      cwdMode: "repo-root",
    });
    return result.success && result.data.success ? result.data.output : null;
  };
}

type BoardWorkspaceMetadata = Parameters<typeof resolveArtifactsLocation>[2];

export interface GoalStatusBoardDeps {
  sessionsDir: string;
  isArtifactsEnabled: () => boolean;
  getWorkspaceMetadata: (workspaceId: string) => Promise<BoardWorkspaceMetadata | null>;
  runBash: GoalBoardBashRunner;
  /**
   * True while the workspace is being removed. Checked again right before the write, after the
   * slow todo/gh reads, so a refresh never recreates data that removal just deleted.
   */
  isWorkspaceRemoving?: (workspaceId: string) => boolean;
  now?: () => number;
  /** Waits between runtime board writes (see write()); defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to writeArtifactAtLocation. */
  writeArtifact?: typeof writeArtifactAtLocation;
  /**
   * Defaults to resolveArtifactsLocation, which runs the scratch mkdir on SSH and Docker
   * runtimes (like the Artifacts tab and agent turns) before a runtime location is usable.
   */
  resolveLocation?: typeof resolveArtifactsLocation;
}

export class GoalStatusBoardService {
  /** Latest goal waiting to be rendered, per workspace (refreshes coalesce); null = no goal. */
  private readonly pending = new Map<string, GoalRecordV1 | null>();
  private readonly running = new Map<string, Promise<void>>();
  /** Last goal handed to requestRefresh, so todo changes can re-render without a goal event. */
  private readonly lastGoal = new Map<string, GoalRecordV1>();
  /** Host time (ms) at which the last runtime board write finished, per workspace. */
  private readonly lastRuntimeWriteDoneMs = new Map<string, number>();

  constructor(private readonly deps: GoalStatusBoardDeps) {}

  /**
   * Schedule a board refresh for this goal state (null: the last goal was cleared). Never throws
   * and never blocks the caller's turn; concurrent requests coalesce so only the newest goal
   * state is written last.
   */
  requestRefresh(workspaceId: string, goal: GoalRecordV1 | null): void {
    assert(workspaceId.length > 0, "workspaceId must not be empty");
    if (goal == null) this.lastGoal.delete(workspaceId);
    else this.lastGoal.set(workspaceId, goal);
    if (!this.deps.isArtifactsEnabled()) return;
    this.pending.set(workspaceId, goal);
    if (!this.running.has(workspaceId)) this.startDrain(workspaceId);
  }

  /**
   * todo_write/propose_plan succeeded: re-render the checklist with the last known goal. Without
   * this the board kept the pre-turn todo states for the whole turn. No goal known, no board.
   */
  handleTodosChanged(workspaceId: string): void {
    const goal = this.lastGoal.get(workspaceId);
    if (goal != null) this.requestRefresh(workspaceId, goal);
  }

  private startDrain(workspaceId: string): void {
    const run = this.drain(workspaceId).finally(() => {
      this.running.delete(workspaceId);
      // A request that landed after the drain's last check but before this callback.
      if (this.pending.has(workspaceId)) this.startDrain(workspaceId);
    });
    this.running.set(workspaceId, run);
  }

  /** Resolves once no refresh is running for the workspace (tests and shutdown). */
  async whenIdle(workspaceId: string): Promise<void> {
    while (this.running.has(workspaceId)) {
      await this.running.get(workspaceId);
    }
  }

  private async drain(workspaceId: string): Promise<void> {
    for (;;) {
      const goal = this.pending.get(workspaceId);
      // undefined: nothing queued. null is a real request (render "No active goal").
      if (goal === undefined) return;
      this.pending.delete(workspaceId);
      try {
        await this.write(workspaceId, goal);
      } catch (error) {
        log.debug("Goal status board refresh failed", { workspaceId, error });
      }
    }
  }

  private isRemoving(workspaceId: string): boolean {
    return this.deps.isWorkspaceRemoving?.(workspaceId) ?? false;
  }

  private async write(workspaceId: string, goal: GoalRecordV1 | null): Promise<void> {
    if (!this.deps.isArtifactsEnabled() || this.isRemoving(workspaceId)) return;
    const metadata = await this.deps.getWorkspaceMetadata(workspaceId);
    if (metadata == null) return;
    const resolveLocation = this.deps.resolveLocation ?? resolveArtifactsLocation;
    const location = await resolveLocation(this.deps.sessionsDir, workspaceId, metadata);
    if (location.kind === "unavailable") return;
    // No goal: no checklist or PR section, so no todo read and no gh calls.
    const [todos, pr] =
      goal == null
        ? [[], { kind: "none" as const }]
        : await Promise.all([
            readTodosForSessionDir(path.join(this.deps.sessionsDir, workspaceId)),
            fetchGoalBoardPrSection(workspaceId, this.deps.runBash).catch(
              (): GoalBoardPrSection => ({ kind: "unavailable" })
            ),
          ]);
    const now = this.deps.now ?? Date.now;
    if (location.kind === "runtime") {
      // Runtime listings report whole-second mtimes and the panel re-reads a file only when its
      // listed mtime changes, so a second write in the same second (a todo burst, a transition
      // plus its continuation) stayed invisible. Start the next write a full second after the
      // last one finished: the remote clock's sub-second phase differs from the host's, so only
      // a whole interval of elapsed time guarantees a later remote second (rounding up to the
      // next host second could be a few ms). Requests that arrive meanwhile coalesce into it,
      // so this is still one write.
      const lastDoneMs = this.lastRuntimeWriteDoneMs.get(workspaceId);
      if (lastDoneMs !== undefined) {
        const waitMs = lastDoneMs + 1000 - now();
        if (waitMs > 0) {
          await (this.deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
            waitMs
          );
        }
      }
    }
    // The reads above can take up to two gh timeouts; removal may have started meanwhile.
    // The writers also refuse to recreate a deleted scratch/session dir (artifactStore.ts),
    // which covers a removal that finished between this check and the write.
    if (
      this.isRemoving(workspaceId) ||
      (await this.deps.getWorkspaceMetadata(workspaceId)) == null
    ) {
      return;
    }
    const html = renderGoalStatusBoardHtml({
      goal,
      todos,
      pr,
      updatedAtMs: now(),
    });
    await (this.deps.writeArtifact ?? writeArtifactAtLocation)(
      location,
      GOAL_STATUS_BOARD_FILE,
      html
    );
    if (location.kind === "runtime") {
      this.lastRuntimeWriteDoneMs.set(workspaceId, now());
    }
  }
}
