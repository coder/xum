import { WORKSPACE_NAME_GENERATION_TIMEOUT_MS } from "@/constants/terminationTimeouts";
import type { NameGenerationError } from "@/common/types/errors";
import type { Result } from "@/common/types/result";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import type { GenerateWorkspaceIdentityResult } from "@/node/services/workspaceTitleGenerator";

type DraftNaming = Promise<Result<GenerateWorkspaceIdentityResult, NameGenerationError>>;

/**
 * How many creation-form naming requests stay available for a creation to take over. Most never
 * are (the form shows the name, or the message changes); one per open creation form is enough.
 */
const MAX_RETAINED_DRAFT_NAMINGS = 16;

/**
 * The in-process naming state of workspaces: which workspaces a naming request is titling, which
 * creations are still being named, and the creation form's naming requests. WorkspaceService
 * runs the model calls and writes the titles; this class only holds who owns a naming and for
 * how long, so a second naming request or a fork does not race the first.
 */
export class WorkspaceNaming {
  // Tracks in-flight fork auto-title generations so only the first accepted continue
  // message can claim the workspace title.
  private readonly autoTitlingWorkspaces = new Set<string>();
  /**
   * Workspaces create() opened before their generated name existed, until their title and
   * branch are final (startCreationNaming). A fork of one waits for them.
   */
  private readonly pendingCreationNamings = new Map<string, Promise<void>>();
  /**
   * The creation form's naming requests by draftNamingId, oldest first, running or finished. The
   * creation that hands one off takes it over instead of asking the model again. Kept after they
   * finish: the form drops a result that arrives after its hand-off, and the creation request
   * can reach the backend after that result.
   */
  private readonly draftNamings = new Map<string, DraftNaming>();

  /** Claims the workspace's auto-title. Returns false when a naming request already holds it. */
  claimAutoTitle(workspaceId: string): boolean {
    if (this.autoTitlingWorkspaces.has(workspaceId)) return false;
    this.autoTitlingWorkspaces.add(workspaceId);
    return true;
  }

  releaseAutoTitle(workspaceId: string): void {
    this.autoTitlingWorkspaces.delete(workspaceId);
  }

  /**
   * Marks a creation as being named until `final` settles. `final` must not reject: a fork of
   * the workspace waits for it.
   */
  trackCreationNaming(workspaceId: string, final: Promise<unknown>): void {
    const namingFinal = final.then(() => {
      this.pendingCreationNamings.delete(workspaceId);
    });
    this.pendingCreationNamings.set(workspaceId, namingFinal);
  }

  /**
   * Waits, up to the naming deadline, until a creation's naming is final. Returns false when the
   * deadline passes first; true at once when the workspace is not being named.
   */
  async waitForCreationNaming(workspaceId: string): Promise<boolean> {
    const pending = this.pendingCreationNamings.get(workspaceId);
    if (pending === undefined) return true;
    const waited = await raceWithAbortAndTimeout(pending, {
      timeoutMs: WORKSPACE_NAME_GENERATION_TIMEOUT_MS,
    });
    return waited.kind === "ok";
  }

  /** Keeps the form's naming request for a creation to take over; drops the oldest past the cap. */
  retainDraftNaming(draftNamingId: string, generation: DraftNaming): void {
    this.draftNamings.set(draftNamingId, generation);
    if (this.draftNamings.size > MAX_RETAINED_DRAFT_NAMINGS) {
      const [oldest] = this.draftNamings.keys();
      this.draftNamings.delete(oldest);
    }
  }

  /** The creation form's naming request a creation hands off, once: see draftNamings. */
  takeDraftNaming(draftNamingId: string | undefined): DraftNaming | undefined {
    if (draftNamingId === undefined) return undefined;
    const draftNaming = this.draftNamings.get(draftNamingId);
    this.draftNamings.delete(draftNamingId);
    return draftNaming;
  }
}
