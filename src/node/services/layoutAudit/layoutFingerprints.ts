import { createHash } from "crypto";
import { LRUCache } from "lru-cache";
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

// In-process only, on purpose: a backend restart forgets what the agent was shown, and the next
// publish then marks nothing persistent (the safe direction: the agent sees the issue again).
// Only a commit counts as use: a commit makes its path the newest, and reading what a path has
// remembered (`peek`) leaves the order alone.
const remembered = new LRUCache<string, FingerprintSnapshot>({ max: LAYOUT_MEMORY_MAX_PATHS });

/**
 * The ordering state of one path. It lives in its own map, not with the memory, and exists
 * exactly while an audit of the path is in flight: the first start creates it and the last
 * finish deletes it. The memory is bounded and evicts paths, but an audit that is still running
 * keeps its ordering, so a slow early audit cannot overwrite what a later one committed even
 * after that commit's memory entry was evicted.
 */
interface PathAudits {
  /** Audits of the path that started and have not finished. */
  inFlight: number;
  /** The highest start number whose audit has committed memory; 0 when none has. */
  committedStart: number;
}
const auditsByPath = new Map<string, PathAudits>();
let auditsStarted = 0;

/** How many paths have an audit in flight. */
export function layoutAuditPathsInFlight(): number {
  return auditsByPath.size;
}

export interface LayoutAuditTurn {
  /**
   * One synchronous step that ends the audit, taken once its outcomes are known: reads what the
   * path has remembered, lets `build` turn that into the report and the memory after it, and
   * keeps that memory when `remember` is true and no audit that started later has committed for
   * this path. An audit that loses that check still gets its own report back. The audit ends
   * whether or not `build` throws. Call it exactly once.
   */
  finish<T>(
    build: (previous: FingerprintSnapshot) => { report: T; next: FingerprintSnapshot },
    remember: boolean
  ): T;
}

/**
 * Takes this audit's place in the start order of its path. Audits of one path do not wait for
 * each other (a wait would have no deadline of its own): each runs with its own budget, and
 * the start order decides whose memory stands, so a slow early audit cannot overwrite what a
 * later one left. Call it before the audit's first await, and finish what it returns.
 */
export function startLayoutAudit(sessionDir: string, relPath: string): LayoutAuditTurn {
  const key = JSON.stringify([sessionDir, relPath]);
  const path = auditsByPath.get(key) ?? { inFlight: 0, committedStart: 0 };
  auditsByPath.set(key, path);
  path.inFlight += 1;
  auditsStarted += 1;
  const startedAs = auditsStarted;
  return {
    finish: (build, remember) => {
      try {
        const { report, next } = build(remembered.peek(key) ?? {});
        if (remember && startedAs > path.committedStart) {
          path.committedStart = startedAs;
          remembered.set(key, next);
        }
        return report;
      } finally {
        path.inFlight -= 1;
        if (path.inFlight === 0) auditsByPath.delete(key);
      }
    },
  };
}
