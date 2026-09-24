// Use the installed transport: Bun's built-in undici shim lacks dispatcher cleanup.
import { EnvHttpProxyAgent, request as httpRequest } from "undici/index.js";
import { z } from "zod";
import type { ProviderModelDiscoveryResult } from "@/common/orpc/types";
import {
  normalizeAnthropicBaseURL,
  normalizeOpenAICompatibleBaseURL,
} from "@/common/utils/providers/baseUrl";
import { MODEL_DISCOVERY_LIMITS } from "@/constants/modelDiscovery";

interface Unavailable {
  status: "unsupported" | "not-configured";
}
export interface ModelDiscoveryRequest {
  readonly provider: "anthropic" | "openai";
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly organization?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly policy: Readonly<{
    enforced: boolean;
    forcedBaseUrl?: string;
    allowedModels?: readonly string[] | null;
  }>;
}
const PageSchema = z.object({
  data: z.array(
    z.object({
      id: z
        .string()
        .min(1)
        .refine((id) => id.trim() === id),
    })
  ),
  has_more: z.boolean().optional(),
  last_id: z.string().min(1).nullish(),
});

// Request snapshots (including secrets) stay private and are never logged or returned.
export async function discoverProviderModels(
  resolve: () => ModelDiscoveryRequest | Unavailable,
  signal?: AbortSignal
): Promise<ProviderModelDiscoveryResult> {
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), MODEL_DISCOVERY_LIMITS.timeoutMs);
  const combined = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])]);
  let agent: EnvHttpProxyAgent | undefined;
  let reason: Extract<ProviderModelDiscoveryResult, { status: "error" }>["reason"] =
    "request-failed";
  try {
    combined.throwIfAborted();
    const request = resolve();
    if ("status" in request) return request;
    const identity = JSON.stringify(request);
    const current = () => {
      if (JSON.stringify(resolve()) !== identity) {
        reason = "stale-config";
        throw new Error();
      }
      combined.throwIfAborted();
    };
    const anthropic = request.provider === "anthropic";
    const normalize = anthropic ? normalizeAnthropicBaseURL : normalizeOpenAICompatibleBaseURL;
    const url = new URL(
      normalize(
        request.baseUrl ??
          (anthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1")
      )
    );
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      return { status: "unsupported" };
    // Azure catalogs contain model IDs, not the user's deployment names.
    if (
      !anthropic &&
      (url.hostname.endsWith(".openai.azure.com") || /\/deployments(?:\/|$)/i.test(url.pathname))
    )
      return { status: "unsupported" };
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
    // A cursor carried in the configured base would skip catalog pages and still
    // look complete; start from the first page and set cursors only from replies.
    if (anthropic) for (const key of ["after_id", "before_id"]) url.searchParams.delete(key);
    const headers = new Headers(
      anthropic
        ? { "x-api-key": request.apiKey, "anthropic-version": "2023-06-01" }
        : {
            authorization: `Bearer ${request.apiKey}`,
            ...(request.organization && { "OpenAI-Organization": request.organization }),
          }
    );
    for (const [key, value] of Object.entries(request.headers ?? {})) headers.set(key, value);
    agent = new EnvHttpProxyAgent({ connect: { timeout: MODEL_DISCOVERY_LIMITS.timeoutMs } });
    const ids = new Set<string>(),
      cursors = new Set<string>();
    let items = 0,
      bytes = 0;
    for (let page = 0; page < MODEL_DISCOVERY_LIMITS.pages; page++) {
      current();
      if (anthropic) url.searchParams.set("limit", "1000");
      reason = "request-failed";
      const response = await httpRequest(url, {
        method: "GET",
        headers: Object.fromEntries(headers),
        signal: combined,
        dispatcher: agent,
      });
      // Native request never follows redirects; reject 3xx without forwarding credentials.
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error();
      const chunks: Uint8Array[] = [];
      for await (const value of response.body) {
        const chunk: unknown = value;
        if (!(chunk instanceof Uint8Array)) throw new Error();
        bytes += chunk.length;
        if (bytes > MODEL_DISCOVERY_LIMITS.bytes) {
          reason = "limit-exceeded";
          throw new Error();
        }
        chunks.push(chunk);
      }
      reason = "invalid-response";
      const data = PageSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      items += data.data.length;
      if (items > MODEL_DISCOVERY_LIMITS.items) {
        reason = "limit-exceeded";
        throw new Error();
      }
      for (const item of data.data) ids.add(item.id);
      if (anthropic && data.has_more === undefined) throw new Error();
      if (!anthropic || !data.has_more) {
        // Teardown can yield to credential edits or cancellation; fence publication after it.
        await agent.destroy().catch(() => undefined);
        agent = undefined;
        current();
        const allowed = request.policy.allowedModels;
        return {
          status: "ok",
          modelIds: [...ids].filter((id) => !allowed || allowed.includes(id)),
        };
      }
      if (!data.last_id || !data.data.length || cursors.has(data.last_id)) throw new Error();
      cursors.add(data.last_id);
      url.searchParams.set("after_id", data.last_id);
    }
    return { status: "error", reason: "limit-exceeded" };
  } catch {
    // Never expose upstream bodies, URLs, headers, thrown errors, or abort reasons.
    return {
      status: "error",
      reason: signal?.aborted ? "aborted" : deadline.signal.aborted ? "timeout" : reason,
    };
  } finally {
    clearTimeout(timeout);
    // Do not yield again after successful publication's fence, even by awaiting undefined.
    if (agent) await agent.destroy().catch(() => undefined);
  }
}
