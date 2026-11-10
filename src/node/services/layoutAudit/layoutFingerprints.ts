import { createHash } from "crypto";
import type {
  LayoutAuditRule,
  LayoutAuditViewportClass,
} from "@/common/constants/artifactLayoutAudit";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";

/**
 * Per viewport class, the fingerprints of the last COMPLETE pass there. A missing class was
 * never completed. A finding is "persistent" when its fingerprint is in the set of its class:
 * the agent was shown it on an earlier publish and it still stands.
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
// Insertion order is the recency order: a commit moves its path to the end.
const remembered = new Map<string, FingerprintSnapshot>();
const audits = new MutexMap<string>();

export interface LayoutMemory {
  /** What the last committed audit of this path left behind. */
  readonly previous: FingerprintSnapshot;
  commit(next: FingerprintSnapshot): void;
}

/**
 * Runs `audit` alone for this path, so audits of one path commit in publish order and each one
 * reads what the one before it committed. Audits of other paths run at the same time. A call
 * that never commits (it was cancelled, or threw) leaves the memory as it was.
 */
export function withLayoutMemory<T>(
  sessionDir: string,
  relPath: string,
  audit: (memory: LayoutMemory) => Promise<T>
): Promise<T> {
  const key = JSON.stringify([sessionDir, relPath]);
  return audits.withLock(key, () =>
    audit({
      previous: remembered.get(key) ?? {},
      commit: (next) => {
        remembered.delete(key);
        remembered.set(key, next);
        for (const oldest of remembered.keys()) {
          if (remembered.size <= LAYOUT_MEMORY_MAX_PATHS) break;
          remembered.delete(oldest);
        }
      },
    })
  );
}
