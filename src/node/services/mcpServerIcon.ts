import { MCP_ICON_LIMITS } from "@/common/constants/mcpIcon";
import { MCP_IDENTITY_LIMITS } from "@/common/constants/mcpIdentity";
import type { MCPConnectionRef } from "@/common/types/mcp";
import assert from "@/common/utils/assert";
import { isHttpsUrlWithoutUserinfo } from "@/common/utils/mcp/httpsUrl";
import { isStrictBase64 } from "@/common/utils/mcp/pngDataUrl";
import { pinnedHttpsFetch, type PinnedHttpsFetch } from "@/node/utils/network/pinnedHttpsFetch";
import { decodeMcpIcon } from "./mcpIconDecodeClient";
import type { IconCandidate } from "./mcpServerIdentity";

/**
 * Server icon resolution: pick one candidate from a server's self-reported
 * `Implementation.icons`, then fetch and decode it under a single absolute
 * deadline with process-wide concurrency bounds. Everything here treats the
 * candidates as untrusted input; identity of what was fetched is established
 * by the origin-pinned fetch and the sniffing decoder, never by labels.
 *
 * Caching and same-generation deduplication belong to the icon registry; this
 * resolver is stateless apart from its job gate.
 */

/** Data URL forms the decoder can sniff; anything else is not artwork we render. */
const DATA_URL_PREFIX = /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,/;
const SIZE_ENTRY = /^(\d{1,5})x(\d{1,5})$/i;
const PREFERRED_MIN_PX = 32;
const PREFERRED_MAX_PX = 128;
/** The worker rejects longer hints; a hint this long is noise, not evidence. */
const MIME_HINT_MAX_CHARS = 128;

export type SelectedIcon =
  | { kind: "https"; url: URL; mimeTypes: string[] }
  | { kind: "data"; base64: string; mimeTypes: string[] };

/** 0 = a 32–128 px or `any` size is declared, 1 = no sizes, 2 = only other sizes. */
function sizeRank(sizes: readonly string[] | undefined): number {
  if (!sizes || sizes.length === 0) {
    return 1;
  }
  for (const entry of sizes) {
    if (entry.toLowerCase() === "any") {
      return 0;
    }
    const match = SIZE_ENTRY.exec(entry);
    if (match) {
      const largest = Math.max(Number(match[1]), Number(match[2]));
      if (largest >= PREFERRED_MIN_PX && largest <= PREFERRED_MAX_PX) {
        return 0;
      }
    }
  }
  return 2;
}

/**
 * Canonical MIME hints for the decoder: the essence (type/subtype, lowercase,
 * parameters stripped) of every advisory label, deduplicated. The decoder
 * rejects a specific `image/*` claim that contradicts the sniffed type, so
 * that claim must survive canonicalization intact: an image essence too long
 * to relay fails closed (null) instead of silently disappearing, while an
 * overlong generic type is noise and is dropped.
 */
function mimeHints(...hints: Array<string | undefined>): string[] | null {
  const kept: string[] = [];
  for (const hint of hints) {
    if (hint === undefined) {
      continue;
    }
    const essence = hint.split(";")[0].trim().toLowerCase();
    if (essence.length === 0) {
      continue;
    }
    if (essence.length > MIME_HINT_MAX_CHARS) {
      if (essence.startsWith("image/")) {
        return null;
      }
      continue;
    }
    if (!kept.includes(essence)) {
      kept.push(essence);
    }
  }
  return kept;
}

/**
 * Eligibility of one candidate. Copies every retained value so the result
 * never aliases the (server-controlled, possibly still mutating) candidate.
 */
function eligibleIcon(candidate: IconCandidate, binding: MCPConnectionRef): SelectedIcon | null {
  const src = candidate.src;
  if (typeof src !== "string") {
    return null;
  }
  if (src.startsWith("https://")) {
    // Remote artwork only from the exact configured origin of a url transport:
    // stdio servers have no origin to bind to, and other origins would let the
    // server point the app at arbitrary hosts.
    if (
      (binding.transport !== "http" && binding.transport !== "sse") ||
      binding.origin === undefined ||
      src.length > MCP_IDENTITY_LIMITS.iconHttpsSrcMaxChars ||
      !isHttpsUrlWithoutUserinfo(src)
    ) {
      return null;
    }
    const url = new URL(src);
    if (url.origin !== binding.origin) {
      return null;
    }
    const mimeTypes = mimeHints(candidate.mimeType);
    return mimeTypes ? { kind: "https", url, mimeTypes } : null;
  }
  // Length is checked before any regex or base64 work touches the payload.
  if (src.length > MCP_IDENTITY_LIMITS.iconDataSrcMaxChars) {
    return null;
  }
  const match = DATA_URL_PREFIX.exec(src);
  if (!match) {
    return null;
  }
  const base64 = src.slice(match[0].length);
  if (!isStrictBase64(base64)) {
    return null;
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const decodedBytes = (base64.length / 4) * 3 - padding;
  if (decodedBytes <= 0 || decodedBytes > MCP_ICON_LIMITS.bodyMaxBytes) {
    return null;
  }
  const mimeTypes = mimeHints(candidate.mimeType, match[1]);
  return mimeTypes ? { kind: "data", base64, mimeTypes } : null;
}

/**
 * Choose the icon to resolve: among the first `iconCandidatesMax` eligible
 * candidates, prefer a declared 32–128 px (or `any`) size, then a dark theme,
 * then declaration order. Pure; returns null when nothing is eligible.
 */
export function selectIconCandidate(
  candidates: readonly IconCandidate[],
  binding: MCPConnectionRef
): SelectedIcon | null {
  let best: { icon: SelectedIcon; sizeRank: number; dark: boolean } | undefined;
  for (const candidate of candidates.slice(0, MCP_IDENTITY_LIMITS.iconCandidatesMax)) {
    const icon = eligibleIcon(candidate, binding);
    if (!icon) {
      continue;
    }
    const rank = sizeRank(candidate.sizes);
    const dark = candidate.theme === "dark";
    if (!best || rank < best.sizeRank || (rank === best.sizeRank && dark && !best.dark)) {
      best = { icon, sizeRank: rank, dark };
    }
  }
  return best?.icon ?? null;
}

export type IconDecode = (
  bytes: Buffer,
  mimeTypes: string[],
  signal: AbortSignal
) => Promise<string | null>;

/** Test seams; production uses the pinned fetch, the killable decoder, and the shared deadline. */
export interface IconResolverDependencies {
  fetch?: PinnedHttpsFetch;
  decode?: IconDecode;
  /** One absolute deadline per job, created at admission (queue time counts). */
  createDeadline?: () => AbortSignal;
}

export interface IconResolver {
  resolve(candidates: readonly IconCandidate[], binding: MCPConnectionRef): Promise<string | null>;
}

interface Waiter {
  signal: AbortSignal;
  admit: (admitted: boolean) => void;
}

/**
 * Bounded job gate: `concurrentJobs` slots covering download + decode, at most
 * `queuedJobs` waiting; anything beyond that is refused immediately. A waiter
 * whose deadline expires leaves the queue without ever being launched.
 */
class JobGate {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly slots: number,
    private readonly queueLimit: number
  ) {
    assert(
      slots > 0 && queueLimit >= 0,
      "JobGate requires positive slots and a non-negative queue"
    );
  }

  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) {
      return Promise.resolve(false);
    }
    if (this.active < this.slots) {
      this.active += 1;
      return Promise.resolve(true);
    }
    if (this.waiters.length >= this.queueLimit) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = { signal, admit: resolve };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) {
          this.waiters.splice(index, 1);
          resolve(false);
        }
      };
      waiter.admit = (admitted) => {
        signal.removeEventListener("abort", onAbort);
        resolve(admitted);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** Called exactly once per successful acquire, after the job's decoder has settled. */
  release(): void {
    assert(this.active > 0, "JobGate.release without an active job");
    this.active -= 1;
    while (this.waiters.length > 0 && this.active < this.slots) {
      const next = this.waiters.shift();
      if (!next) {
        break;
      }
      if (next.signal.aborted) {
        next.admit(false);
        continue;
      }
      this.active += 1;
      next.admit(true);
    }
  }
}

export function createIconResolver(dependencies: IconResolverDependencies = {}): IconResolver {
  const fetch = dependencies.fetch ?? pinnedHttpsFetch;
  const decode = dependencies.decode ?? decodeMcpIcon;
  const createDeadline =
    dependencies.createDeadline ?? (() => AbortSignal.timeout(MCP_ICON_LIMITS.deadlineMs));
  const gate = new JobGate(MCP_ICON_LIMITS.concurrentJobs, MCP_ICON_LIMITS.queuedJobs);

  return {
    async resolve(candidates, binding) {
      // One budget for the whole attempt: selection, queueing, fetch, decode.
      const signal = createDeadline();
      const selected = selectIconCandidate(candidates, binding);
      if (!selected) {
        return null;
      }
      if (!(await gate.acquire(signal))) {
        return null;
      }
      try {
        if (signal.aborted) {
          return null;
        }
        let bytes: Buffer;
        let mimeTypes: string[] | null;
        if (selected.kind === "https") {
          const fetched = await fetch(selected.url, signal);
          if (!fetched) {
            return null;
          }
          bytes = fetched.bytes;
          mimeTypes = mimeHints(...selected.mimeTypes, fetched.contentType);
          if (!mimeTypes) {
            return null;
          }
        } else {
          bytes = Buffer.from(selected.base64, "base64");
          mimeTypes = selected.mimeTypes;
        }
        if (signal.aborted || bytes.length === 0 || bytes.length > MCP_ICON_LIMITS.bodyMaxBytes) {
          return null;
        }
        // The slot stays held until the decoder settles — on child exit — even
        // when the deadline has already fired, so a killed worker cannot
        // overlap with a freshly admitted one.
        return await decode(bytes, mimeTypes, signal);
      } catch {
        return null;
      } finally {
        gate.release();
      }
    },
  };
}

const processResolver = createIconResolver();

/** Process-owned resolver: one gate for every server and every caller. */
export const resolveServerIcon: IconResolver["resolve"] = (candidates, binding) =>
  processResolver.resolve(candidates, binding);
