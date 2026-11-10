import * as path from "path";
import { pathToFileURL } from "url";
import { LAYOUT_AUDIT_BUDGET_MS } from "@/common/constants/artifactLayoutAudit";
import type { LayoutAuditReport } from "@/common/types/artifactLayoutAudit";
import type { Runtime } from "@/node/runtime/Runtime";
import type { AvailableArtifactsLocation } from "@/node/services/artifactsOperations";
import { getToolEnvPath } from "@/node/services/hooks";
import { runLayoutPasses } from "@/node/services/layoutAudit/agentBrowserLayoutRun";
import { LAYOUT_AUDIT_PAGE_SCRIPT } from "@/node/services/layoutAudit/layoutAuditPageScript.generated";
import { withLayoutMemory } from "@/node/services/layoutAudit/layoutFingerprints";
import { buildLayoutReport } from "@/node/services/layoutAudit/layoutReport";
import {
  failedOutcomes,
  type ViewportOutcome,
} from "@/node/services/layoutAudit/viewportOutcome";
import { log } from "@/node/services/log";
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
  /** Time for the whole audit, run and close. Production leaves it unset. */
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

async function auditOutcomes(
  input: ArtifactLayoutInput,
  deadlineMs: number
): Promise<ViewportOutcome[]> {
  // The same gate as the probe: the benchmark kill switch also keeps a trusted project's
  // tool_env from running.
  const trusted = input.trusted === true && !projectAutomationDisabled();
  return runLayoutPasses({
    runtime: input.runtime,
    cwd: input.cwd,
    toolEnvPath: trusted ? await getToolEnvPath(input.runtime, input.cwd) : null,
    fileUrl: await artifactFileUrl(input.location, input.relPath),
    pageScript: LAYOUT_AUDIT_PAGE_SCRIPT,
    deadlineMs,
    abortSignal: input.abortSignal,
  });
}

/**
 * Checks a just-published HTML artifact at 390, 768 and 1440 px in agent-browser and says what
 * is broken. Returns undefined for every other kind, so the caller needs no branch.
 *
 * Never throws and never fails the publish: whatever goes wrong becomes `checked: false`, which
 * the agent must not read as "clean". Findings of the same path are compared with the last
 * complete check of it, so the agent can tell a new issue from one it already saw and could not
 * fix. The audit only reports. Nothing here wakes or re-prompts the agent.
 */
export async function checkArtifactLayout(
  input: ArtifactLayoutInput
): Promise<LayoutAuditReport | undefined> {
  if (input.kind !== "html") return undefined;
  // Counted from here, so a publish that waits for an earlier audit of the same path also
  // stays inside one budget.
  const deadlineMs = Date.now() + (input.budgetMs ?? LAYOUT_AUDIT_BUDGET_MS);
  try {
    return await withLayoutMemory(input.sessionDir, input.relPath, async (memory) => {
      const { report, next } = buildLayoutReport(
        await auditOutcomes(input, deadlineMs),
        memory.previous
      );
      // "Persistent" means the agent was shown the issue on an earlier publish. A cancelled
      // call's report was probably never delivered, so it leaves the memory alone.
      if (input.abortSignal?.aborted !== true) memory.commit(next);
      return report;
    });
  } catch (error) {
    log.debug("layout audit failed", { error });
    return buildLayoutReport(failedOutcomes("browser-failed"), {}).report;
  }
}
