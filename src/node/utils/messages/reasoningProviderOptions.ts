import type { ModelMessage } from "ai";

import type { MuxMessage, MuxReasoningPart } from "@/common/types/message";

export interface ReasoningProviderMetadata {
  anthropic?: {
    signature?: string;
    redactedData?: string;
  };
  // OpenAI/xAI Responses attach itemId + encrypted content so subsequent turns
  // can restore reasoning without server-side response storage. OpenAI is
  // replayed by encrypted content only (see attachReasoningReplayMetadata).
  openai?: {
    itemId?: string;
    reasoningEncryptedContent?: string | null;
  };
  xai?: {
    itemId?: string;
    reasoningEncryptedContent?: string | null;
  };
  // Google attaches thought signatures that must be replayed on later turns.
  google?: {
    thoughtSignature?: string;
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Runtime-validate reasoning replay data into the persisted providerOptions
 * shape, keeping only recognized string/null fields. History rows are read
 * with unchecked JSON casts, so a corrupt part must degrade to "no replay
 * metadata" rather than forwarding junk the provider would reject (which
 * would brick every subsequent request in the workspace).
 */
export function sanitizeReasoningReplayMetadata(
  value: unknown
): MuxReasoningPart["providerOptions"] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const options: NonNullable<MuxReasoningPart["providerOptions"]> = {};

  const anthropicSignature = nonEmptyString(asRecord(record.anthropic)?.signature);
  if (anthropicSignature) {
    options.anthropic = { signature: anthropicSignature };
  }

  const googleThoughtSignature = nonEmptyString(asRecord(record.google)?.thoughtSignature);
  if (googleThoughtSignature) {
    options.google = { thoughtSignature: googleThoughtSignature };
  }

  for (const provider of ["openai", "xai"] as const) {
    const meta = asRecord(record[provider]);
    if (!meta) continue;
    const itemId = nonEmptyString(meta.itemId);
    const encrypted =
      typeof meta.reasoningEncryptedContent === "string"
        ? meta.reasoningEncryptedContent
        : meta.reasoningEncryptedContent === null
          ? null
          : undefined;
    if (itemId == null && encrypted === undefined) continue;
    options[provider] = {
      ...(itemId != null ? { itemId } : {}),
      ...(encrypted !== undefined ? { reasoningEncryptedContent: encrypted } : {}),
    };
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

/**
 * Extract replay data from stream providerMetadata into the persisted
 * providerOptions shape. Anthropic needs signatures; xAI Responses needs
 * itemId + encrypted content (store=false); OpenAI Responses needs encrypted
 * content (the itemId is persisted for debugging only); Google needs thought
 * signatures. Replay happens via attachReasoningReplayMetadata.
 */
export function reasoningProviderOptionsFromMetadata(
  providerMetadata: ReasoningProviderMetadata | undefined
): MuxReasoningPart["providerOptions"] | undefined {
  return sanitizeReasoningReplayMetadata(providerMetadata);
}

export function mergeReasoningProviderOptions(
  existing: MuxReasoningPart["providerOptions"] | undefined,
  incoming: MuxReasoningPart["providerOptions"] | undefined
): MuxReasoningPart["providerOptions"] | undefined {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const merged: NonNullable<MuxReasoningPart["providerOptions"]> = { ...existing };

  if (incoming.anthropic) {
    merged.anthropic = { ...existing.anthropic, ...incoming.anthropic };
  }
  if (incoming.google) {
    merged.google = { ...existing.google, ...incoming.google };
  }
  for (const provider of ["openai", "xai"] as const) {
    if (!incoming[provider]) continue;
    merged[provider] = { ...existing[provider], ...incoming[provider] };
  }

  return merged;
}

/**
 * Request-only shape read by the AI SDK: convertToModelMessages copies UI-part
 * `providerMetadata` into ModelMessage `providerOptions` and ignores any
 * `providerOptions` field on the input part. Never persisted to history.
 */
type ReasoningPartWithReplayMetadata = MuxReasoningPart & {
  providerMetadata?: MuxReasoningPart["providerOptions"];
};

/**
 * Mirror persisted reasoning replay data (`providerOptions`, plus the legacy
 * top-level `signature` field from old histories) into `providerMetadata` so
 * convertToModelMessages passes it through to the provider request. Without
 * this bridge, prior-turn reasoning is silently dropped for every provider.
 * Non-mutating: history objects are reused elsewhere (e.g. debug logging).
 */
export function attachReasoningReplayMetadata(messages: MuxMessage[]): MuxMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;

    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "reasoning") return part;

      // Sanitize both sources: history rows are unchecked JSON casts, so
      // malformed values must be dropped instead of forwarded to the provider.
      const legacySignatureValue = nonEmptyString(part.signature);
      const legacySignature = legacySignatureValue
        ? { anthropic: { signature: legacySignatureValue } }
        : undefined;
      // providerOptions wins over the legacy field when both carry a signature.
      const replayMetadata = mergeReasoningProviderOptions(
        legacySignature,
        sanitizeReasoningReplayMetadata(part.providerOptions)
      );
      if (!replayMetadata) return part;

      // A bare itemId is the interrupted-stream shape: reasoning-end never
      // delivered the encrypted content. There is nothing self-contained to
      // replay, and a bare server-side reference (xAI store=false) is
      // unresolvable and would fail every subsequent request; complete parts
      // always carry encrypted content because requests include
      // reasoning.encrypted_content. Drop bare references at replay time only;
      // stream-time accumulation keeps partial metadata so reasoning-end can
      // still complete it.
      for (const provider of ["openai", "xai"] as const) {
        const meta = replayMetadata[provider];
        if (meta && nonEmptyString(meta.reasoningEncryptedContent) == null) {
          delete replayMetadata[provider];
        }
      }
      // OpenAI Responses: never replay by server-side reference. With the SDK's
      // default store=true an itemId becomes `item_reference` and the encrypted
      // blob is ignored; that reference is unresolvable after a route/credential
      // change (gateway<->direct, Codex store=false turns) or eviction, and
      // OpenAI answers 400 "Item with id 'rs_…' not found" on every retry.
      // Encrypted content is self-contained, so send only that. Request-only:
      // the persisted part keeps its itemId. xAI is left as-is (already
      // store=false; its converter behaviour without ids is not established).
      if (replayMetadata.openai?.itemId != null) {
        const { itemId: _omit, ...rest } = replayMetadata.openai;
        replayMetadata.openai = rest;
      }
      if (Object.keys(replayMetadata).length === 0) return part;

      changed = true;
      const bridged: ReasoningPartWithReplayMetadata = {
        ...part,
        providerMetadata: replayMetadata,
      };
      return bridged;
    });

    return changed ? { ...message, parts } : message;
  });
}

/**
 * Drop OpenAI reasoning replay from a prepared request after the Responses
 * wire rejected it (unresolvable `rs_` item, unverifiable encrypted_content).
 * OpenAI mints both, so nothing local can repair them and re-sending the same
 * input fails deterministically. Only reasoning parts carrying the `openai`
 * namespace go: persisted history bridged by attachReasoningReplayMetadata and
 * same-turn SDK step messages (itemId + encrypted content copied from
 * providerMetadata) alike. Text, tool parts, string assistants and other
 * providers' reasoning stay. An assistant emptied by the removal is dropped
 * (an empty content array is not valid input). Non-mutating and identity
 * preserving on no-op so the caller can tell "nothing to repair" apart.
 */
export function stripOpenAIReasoningReplay(messages: ModelMessage[]): ModelMessage[] {
  let changed = false;
  const stripped: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") {
      stripped.push(message);
      continue;
    }
    const content = message.content.filter(
      (part) => !(part.type === "reasoning" && part.providerOptions?.openai != null)
    );
    if (content.length === message.content.length) {
      stripped.push(message);
      continue;
    }
    changed = true;
    if (content.length > 0) {
      stripped.push({ ...message, content });
    }
  }
  return changed ? stripped : messages;
}

/**
 * Find the start index of the trailing contiguous reasoning-part run.
 * Used so encrypted content on reasoning-end can attach to the first delta part.
 */
export function findFirstReasoningPartIndexInTrailingRun(
  parts: ReadonlyArray<{ type?: string } | undefined>
): number {
  let firstReasoningIndex = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]?.type !== "reasoning") break;
    firstReasoningIndex = i;
  }
  return firstReasoningIndex;
}
