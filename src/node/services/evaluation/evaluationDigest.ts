import * as crypto from "node:crypto";
import { canonicalEvaluationJson } from "@/common/types/evaluation";

/**
 * Hashing for the evaluation primitive (node-only: `src/common/types/evaluation.ts`
 * stays crypto-free for browser bundles).
 */

export function sha256Hex(canonical: string): string {
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/** Non-secret endpoint identity of a resolved evaluation model. */
export interface EvaluationConfigFingerprintInput {
  readonly providerName: string;
  readonly customProviderId?: string;
  readonly baseURL?: string;
  readonly wireProviderName: string;
  readonly effectiveModelString: string;
}

/**
 * sha256 of the canonical (key-sorted) JSON of the non-secret endpoint identity.
 * Deliberately excludes API keys and headers: the fingerprint is persisted in
 * step admissions so a re-resolution against a changed endpoint can be
 * detected, and it must never leak credentials into workflow records.
 */
export function computeConfigFingerprint(input: EvaluationConfigFingerprintInput): string {
  const identity: Record<string, string> = {
    providerName: input.providerName,
    wireProviderName: input.wireProviderName,
    effectiveModelString: input.effectiveModelString,
  };
  if (input.customProviderId !== undefined) {
    identity.customProviderId = input.customProviderId;
  }
  if (input.baseURL !== undefined) {
    identity.baseURL = input.baseURL;
  }
  return sha256Hex(canonicalEvaluationJson(identity));
}
