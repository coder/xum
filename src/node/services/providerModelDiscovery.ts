// Use the installed transport: Bun's built-in undici shim lacks dispatcher cleanup.
import { EnvHttpProxyAgent, request as httpRequest } from "undici/index.js";
import { z } from "zod";
import type { ProviderModelDiscoveryResult } from "@/common/orpc/types";
import {
  normalizeAnthropicBaseURL,
  normalizeOpenAICompatibleBaseURL,
} from "@/common/utils/providers/baseUrl";
import type { CustomProviderType } from "@/common/utils/providers/customProviders";
import { MODEL_DISCOVERY_LIMITS } from "@/constants/modelDiscovery";

type Unavailable = Exclude<ProviderModelDiscoveryResult, { status: "ok" }>;
type ModelListFormat = "openai" | "anthropic" | "google" | "ollama" | "openrouter";
export interface ModelDiscoveryRequest {
  readonly provider: string;
  readonly providerType?: CustomProviderType;
  readonly format: ModelListFormat;
  readonly conditional: boolean;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly organization?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly policy: Readonly<{
    enforced: boolean;
    forcedBaseUrl?: string;
    allowedModels?: readonly string[] | null;
  }>;
}
const ModelId = z
  .string()
  .min(1)
  .refine((id) => id.trim() === id);
const PageSchema = z.object({
  data: z.array(z.object({ id: ModelId })),
  has_more: z.boolean().optional(),
  last_id: ModelId.nullish(),
  links: z.object({ next: z.string().min(1).nullish() }).optional(),
});
const GooglePage = z.object({
  models: z.array(
    z.object({
      name: ModelId.transform((name) => name.replace(/^models\//, "")).pipe(ModelId),
      supportedGenerationMethods: z.array(z.string()).optional(),
    })
  ),
  nextPageToken: z.string().optional(),
});
const OllamaPage = z.object({
  models: z.array(z.union([z.object({ name: ModelId }), z.object({ model: ModelId })])),
});

function parsePage(body: unknown, format: ModelListFormat) {
  if (format === "google") {
    const page = GooglePage.parse(body);
    return {
      count: page.models.length,
      cursor: page.nextPageToken,
      ids: page.models
        .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
        .map((model) => model.name),
    };
  }
  if (format === "ollama") {
    const page = OllamaPage.parse(body);
    return {
      count: page.models.length,
      cursor: undefined,
      ids: page.models.map((model) => ("name" in model ? model.name : model.model)),
    };
  }
  const page = PageSchema.parse(body);
  const cursor =
    format === "anthropic"
      ? page.has_more
        ? page.last_id
        : undefined
      : format === "openrouter"
        ? page.links?.next
        : undefined;
  // A compatible inference API does not imply a complete or differently paginated catalog.
  if ((format === "anthropic" && page.has_more === undefined) || (page.has_more && !cursor))
    throw new Error();
  return { count: page.data.length, ids: page.data.map((model) => model.id), cursor };
}

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
    const anthropic = request.format === "anthropic";
    const base = anthropic
      ? normalizeAnthropicBaseURL(request.baseUrl)
      : request.provider === "openai" || request.providerType
        ? normalizeOpenAICompatibleBaseURL(request.baseUrl)
        : request.baseUrl;
    let url = new URL(base);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      return { status: "unsupported" };
    // Azure catalogs contain model IDs, not the user's deployment names. The path
    // heuristic only applies to OpenAI's deployment-based configuration; other
    // adapters and custom proxies may legitimately mount under /deployments.
    if (
      request.format === "openai" &&
      (url.hostname.endsWith(".openai.azure.com") ||
        (request.provider === "openai" && /\/deployments(?:\/|$)/i.test(url.pathname)))
    )
      return { status: "unsupported" };
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${request.format === "ollama" ? "tags" : "models"}`;
    // A cursor carried in the configured base would skip catalog pages and still
    // look complete; start from the first page and set cursors only from replies.
    const inheritedCursors = anthropic
      ? ["after_id", "before_id"]
      : request.format === "google"
        ? ["pageToken"]
        : request.format === "openrouter"
          ? ["offset"]
          : [];
    for (const key of inheritedCursors) url.searchParams.delete(key);
    const endpoint = new URL(url);
    const headers = new Headers();
    if (anthropic) headers.set("anthropic-version", "2023-06-01");
    if (request.apiKey)
      headers.set(
        anthropic ? "x-api-key" : request.format === "google" ? "x-goog-api-key" : "authorization",
        anthropic || request.format === "google" ? request.apiKey : `Bearer ${request.apiKey}`
      );
    if (request.provider === "openai" && request.organization)
      headers.set("OpenAI-Organization", request.organization);
    for (const [key, value] of Object.entries(request.headers ?? {})) headers.set(key, value);
    agent = new EnvHttpProxyAgent({ connect: { timeout: MODEL_DISCOVERY_LIMITS.timeoutMs } });
    const ids = new Set<string>(),
      cursors = new Set<string>();
    if (request.format === "openrouter") cursors.add(url.href);
    let items = 0,
      bytes = 0;
    for (let page = 0; page < MODEL_DISCOVERY_LIMITS.pages; page++) {
      current();
      if (anthropic || request.format === "google")
        url.searchParams.set(
          anthropic ? "limit" : "pageSize",
          String(MODEL_DISCOVERY_LIMITS.pageSize)
        );
      reason = "request-failed";
      const response = await httpRequest(url, {
        method: "GET",
        headers: Object.fromEntries(headers),
        signal: combined,
        dispatcher: agent,
      });
      if (request.conditional && page === 0 && [404, 405].includes(response.statusCode)) {
        // Fence like the success path: teardown can yield to edits or cancellation.
        await agent.destroy().catch(() => undefined);
        agent = undefined;
        current();
        return { status: "unsupported" };
      }
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
      const data = parsePage(JSON.parse(Buffer.concat(chunks).toString("utf8")), request.format);
      items += data.count;
      if (items > MODEL_DISCOVERY_LIMITS.items) {
        reason = "limit-exceeded";
        throw new Error();
      }
      for (const id of data.ids) ids.add(id);
      if (!data.cursor) {
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
      if (!data.count) throw new Error();
      let cursor = data.cursor;
      if (request.format === "openrouter") {
        const next = new URL(cursor, url);
        if (
          next.origin !== endpoint.origin ||
          next.pathname !== endpoint.pathname ||
          next.username ||
          next.password ||
          next.hash
        )
          throw new Error();
        // A page link cannot discard or collapse configured proxy query parameters
        // (for example a tenant, or a repeated scope).
        for (const key of new Set(endpoint.searchParams.keys())) next.searchParams.delete(key);
        for (const [key, value] of endpoint.searchParams) next.searchParams.append(key, value);
        url = next;
        cursor = url.href;
      } else url.searchParams.set(anthropic ? "after_id" : "pageToken", cursor);
      if (cursors.has(cursor)) throw new Error();
      cursors.add(cursor);
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
