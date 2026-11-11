import * as path from "path";
import { pathToFileURL } from "url";
import { LAYOUT_AUDIT_BUDGET_MS } from "@/common/constants/artifactLayoutAudit";
import type { LayoutAuditReport } from "@/common/types/artifactLayoutAudit";
import type { Runtime } from "@/node/runtime/Runtime";
import type { AvailableArtifactsLocation } from "@/node/services/artifactsOperations";
import { getToolEnvPath } from "@/node/services/hooks";
import { runLayoutPasses } from "@/node/services/layoutAudit/agentBrowserLayoutRun";
import { LAYOUT_AUDIT_PAGE_SCRIPT } from "@/node/services/layoutAudit/layoutAuditPageScript.generated";
import { startLayoutAudit } from "@/node/services/layoutAudit/layoutFingerprints";
import { buildLayoutReport } from "@/node/services/layoutAudit/layoutReport";
import { failedOutcomes, type ViewportOutcome } from "@/node/services/layoutAudit/viewportOutcome";
import { log } from "@/node/services/log";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { projectAutomationDisabled } from "@/node/utils/projectAutomation";

export interface ArtifactLayoutInput {
  /** The published kind, an override included. Only "html" is audited. */
  kind: string;
  runtime: Runtime;
  /** The bash tool's cwd: tool_env is looked up and sourced here. */
  cwd: string;
  /** Source `.xum/tool_env` like the bash tool does. Repo-controlled code: trusted projects only. */
  trusted?: boolean;
  /** The artifacts dir, in the namespace of the machine that runs the browser. */
  location: AvailableArtifactsLocation;
  /** POSIX path relative to the artifacts dir. */
  relPath: string;
  /** Host session dir: with `relPath` it names the artifact the fix-loop memory is kept for. */
  sessionDir: string;
  abortSignal?: AbortSignal;
  /** Time for the whole audit, run and close, from when it starts. Production leaves it unset. */
  budgetMs?: number;
}

const HOME_RELATIVE = /^~(\/|$)/;

/** Each segment is percent-encoded, so a name with a space, `#` or `?` stays one file. */
function posixFileUrl(absolutePath: string): string {
  return `file://${absolutePath.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Where the browser finds the file. A host dir is the same path in the namespace of the exec
 * (local and worktree run on the host, a dev container mounts it at the same path). A runtime
 * dir is POSIX and, over SSH, may start with `~`.
 */
async function artifactFileUrl(
  location: AvailableArtifactsLocation,
  relPath: string
): Promise<string> {
  if (location.kind === "host") {
    return pathToFileURL(path.join(location.dir, ...relPath.split("/"))).href;
  }
  const dir = HOME_RELATIVE.test(location.dir)
    ? await location.runtime.resolvePath(location.dir)
    : location.dir;
  return posixFileUrl(`${dir.replace(/\/+$/, "")}/${relPath}`);
}

/**
 * Everything before the browser runs (the tool_env lookup, and over SSH the home directory) can
 * hang on a dead connection. It gets the audit's deadline and its cancel like the run does: a
 * setup that loses the race is not checked at any width, and its late result or failure is
 * ignored.
 */
async function auditOutcomes(
  input: ArtifactLayoutInput,
  deadlineMs: number
): Promise<ViewportOutcome[]> {
  // The same gate as the probe: the benchmark kill switch also keeps a trusted project's
  // tool_env from running.
  const trusted = input.trusted === true && !projectAutomationDisabled();
  const setup = await raceWithAbortAndTimeout(
    Promise.all([
      trusted ? getToolEnvPath(input.runtime, input.cwd) : null,
      artifactFileUrl(input.location, input.relPath),
    ]),
    { signal: input.abortSignal, timeoutMs: Math.max(deadlineMs - Date.now(), 0) }
  );
  if (setup.kind !== "ok") return failedOutcomes(setup.kind);
  const [toolEnvPath, fileUrl] = setup.value;
  return runLayoutPasses({
    runtime: input.runtime,
    cwd: input.cwd,
    toolEnvPath,
    fileUrl,
    pageScript: LAYOUT_AUDIT_PAGE_SCRIPT,
    deadlineMs,
    abortSignal: input.abortSignal,
    // The page runs under the same macOS agent sandbox as the agent's bash, which does not open
    // Xum's session folders: read access to the artifacts folder (the page and the files it loads
    // by relative path), nothing more. A runtime location is not on this machine.
    sandboxReadPaths: input.location.kind === "host" ? [input.location.dir] : undefined,
  });
}

/** Never throws: whatever goes wrong with the audit's work is one more way to be "not checked". */
async function outcomesOrFailed(input: ArtifactLayoutInput): Promise<ViewportOutcome[]> {
  try {
    return await auditOutcomes(input, Date.now() + (input.budgetMs ?? LAYOUT_AUDIT_BUDGET_MS));
  } catch (error) {
    log.debug("layout audit failed", { error });
    return failedOutcomes("browser-failed");
  }
}

/**
 * Checks a just-published HTML artifact at 390, 768 and 1440 px in agent-browser and says what
 * is broken. Returns undefined for every other kind, so the caller needs no branch.
 *
 * Never throws and never fails the publish: whatever goes wrong becomes `checked: false`, which
 * the agent must not read as "clean". Findings of the same path are compared with the last
 * complete check of it, so the agent can tell a new issue from one it already saw and could not
 * fix. The audit only reports. Nothing here wakes or re-prompts the agent.
 *
 * Overlapping publishes of one path run at the same time, each with its own budget from its own
 * start. The memory commit is the only thing that is ordered: by start, not by finish. Every
 * audit that starts finishes exactly once, whatever happened to its work: the ordering state of
 * its path lives until then.
 */
export async function checkArtifactLayout(
  input: ArtifactLayoutInput
): Promise<LayoutAuditReport | undefined> {
  if (input.kind !== "html") return undefined;
  const turn = startLayoutAudit(input.sessionDir, input.relPath);
  const outcomes = await outcomesOrFailed(input);
  try {
    // "Persistent" means the agent was shown the issue on an earlier publish. A cancelled
    // call's report was probably never delivered, so it leaves the memory alone. So does a
    // check in which no width completed: it learned nothing, and committing it would still
    // push another path out of the bounded memory.
    return turn.finish(
      (previous) => buildLayoutReport(outcomes, previous),
      input.abortSignal?.aborted !== true &&
        outcomes.some((outcome) => outcome.status === "complete")
    );
  } catch (error) {
    log.debug("layout audit report failed", { error });
    return buildLayoutReport(failedOutcomes("browser-failed"), {}).report;
  }
}
