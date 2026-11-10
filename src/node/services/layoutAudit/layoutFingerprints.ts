import { createHash } from "crypto";
import type {
  LayoutAuditRule,
  LayoutAuditViewportClass,
} from "@/common/constants/artifactLayoutAudit";

/**
 * Per viewport class, the fingerprints of the issues the agent was SHOWN there that still stood
 * at the last complete pass. A missing class was never completed. A finding is "persistent" when
 * its fingerprint is in the set of its class: the agent saw it on an earlier publish and it is
 * still there.
 */
export type FingerprintSnapshot = Partial<Record<LayoutAuditViewportClass, ReadonlySet<string>>>;

/**
 * Rule plus the FULL selector, hashed: the selector is page-controlled and the model only sees a
 * shortened copy, so two long selectors that differ after the cut stay two findings, and the
 * memory cannot grow with a page's selector length. Never the axis or the size, which change
 * while an agent works on a fix.
 */
export function layoutFingerprint(rule: LayoutAuditRule, selector: string): string {
  return createHash("sha256")
    .update(rule)
    .update("\0")
    .update(selector)
    .digest("base64url")
    .slice(0, 22);
}

export const LAYOUT_MEMORY_MAX_PATHS = 64;

interface RememberedPath {
  snapshot: FingerprintSnapshot;
  /** Start order of the audit that committed it. */
  startedAs: number;
}

// In-process only, on purpose: a backend restart forgets what the agent was shown, and the next
// publish then marks nothing persistent (the safe direction: the agent sees the issue again).
// Insertion order is the recency order: a commit moves its path to the end.
const remembered = new Map<string, RememberedPath>();
let auditsStarted = 0;

export interface LayoutAuditTurn {
  /**
   * One synchronous step, taken once the audit's outcomes are known: reads what the path has
   * remembered, lets `build` turn that into the report and the memory after it, and keeps that
   * memory when `remember` is true and no audit that started later has committed for this path.
   * An audit that loses that check still gets its own report back.
   */
  finish<T>(
    build: (previous: FingerprintSnapshot) => { report: T; next: FingerprintSnapshot },
    remember: boolean
  ): T;
}

function commit(key: string, startedAs: number, snapshot: FingerprintSnapshot): void {
  if ((remembered.get(key)?.startedAs ?? 0) > startedAs) return;
  remembered.delete(key);
  remembered.set(key, { snapshot, startedAs });
  for (const oldest of remembered.keys()) {
    if (remembered.size <= LAYOUT_MEMORY_MAX_PATHS) break;
    remembered.delete(oldest);
  }
}

/**
 * Takes this audit's place in the start order of its path. Audits of one path do not wait for
 * each other (a wait would have no deadline of its own): each runs with its own budget, and
 * the start order decides whose memory stands, so a slow early audit cannot overwrite what a
 * later one left. Call it before the audit's first await.
 */
export function startLayoutAudit(sessionDir: string, relPath: string): LayoutAuditTurn {
  const key = JSON.stringify([sessionDir, relPath]);
  auditsStarted += 1;
  const startedAs = auditsStarted;
  return {
    finish: (build, remember) => {
      const { report, next } = build(remembered.get(key)?.snapshot ?? {});
      if (remember) commit(key, startedAs, next);
      return report;
    },
  };
}
