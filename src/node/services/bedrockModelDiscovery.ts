import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from "@aws-sdk/client-bedrock";
import type { HttpRequest } from "@smithy/types";
// Bun's undici shim does not implement request-local dispatcher cleanup.
import { EnvHttpProxyAgent, request as httpRequest } from "undici/index.js";
import assert from "node:assert";
import { z } from "zod";
import type { BaseProviderConfig } from "@/common/config/schemas/providersConfig";
import type { ProviderModelDiscoveryResult } from "@/common/orpc/types";
import { MODEL_DISCOVERY_LIMITS } from "@/constants/modelDiscovery";
import { resolveProviderCredentials } from "@/node/utils/providerRequirements";
import type { ModelDiscoveryRequest } from "./providerModelDiscovery";

type Unavailable = Exclude<ProviderModelDiscoveryResult, { status: "ok" }>;
interface Source {
  config: BaseProviderConfig;
  enabled: boolean;
  policy: ModelDiscoveryRequest["policy"];
}
type Credentials = Awaited<ReturnType<BedrockClient["config"]["credentials"]>>;
type Snapshot = Source & { region: string; bearer?: string; credentials?: Credentials };
const nonblank = (value: unknown): value is string => typeof value === "string" && !!value.trim();

function snapshot(source: Source): Snapshot | Unavailable {
  const { config, policy } = source;
  if (!source.enabled) return { status: "not-configured" };
  // Runtime URLs and injected providers cannot establish a control-plane identity.
  if (
    policy.forcedBaseUrl ||
    [
      "baseUrl",
      "baseURL",
      "endpoint",
      "fetch",
      "credentialProvider",
      "credentials",
      "providerType",
    ].some((key) => config[key] != null)
  )
    return { status: "unsupported" };
  const { region } = resolveProviderCredentials("bedrock", config);
  if (!region) return { status: "not-configured" };
  if (region.trim() !== region || region.includes("fips")) return { status: "unsupported" };
  const base = { ...source, region };
  const explicit = config.accessKeyId != null || config.secretAccessKey != null;
  if (explicit && (!nonblank(config.accessKeyId) || !nonblank(config.secretAccessKey)))
    return { status: "unsupported" };
  // Inference spreads apiKey only with an explicit pair. A supplied blank value
  // masks the environment bearer before the SDK trims it and selects SigV4.
  const rawBearer = explicit
    ? (config.apiKey ?? process.env.AWS_BEARER_TOKEN_BEDROCK)
    : // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- Inference lets an empty configured bearer fall through to ENV.
      config.bearerToken || process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (rawBearer != null && typeof rawBearer !== "string") return { status: "unsupported" };
  if (nonblank(rawBearer)) return { ...base, bearer: rawBearer.trim() };
  // A whitespace bearer without a pair falls through to a different implicit
  // inference identity. Leave it manual rather than guessing that credential chain.
  if (!explicit && rawBearer) return { status: "unsupported" };
  let credentials: Credentials;
  if (explicit) {
    assert(nonblank(config.accessKeyId) && nonblank(config.secretAccessKey));
    if (config.sessionToken != null && typeof config.sessionToken !== "string")
      return { status: "unsupported" };
    credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(typeof config.sessionToken === "string" && { sessionToken: config.sessionToken }),
    };
  } else {
    // No files, SSO, process, role, web-identity, ECS or IMDS resolution here.
    // A selected profile outranks ENV in the inference chain and is not inspectable.
    if (config.profile || process.env.AWS_PROFILE) return { status: "unsupported" };
    const {
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
      AWS_SESSION_TOKEN: sessionToken,
      AWS_CREDENTIAL_EXPIRATION: expiry,
      AWS_CREDENTIAL_SCOPE: credentialScope,
      AWS_ACCOUNT_ID: accountId,
    } = process.env;
    if (!nonblank(accessKeyId) || !nonblank(secretAccessKey)) return { status: "unsupported" };
    const expiration = expiry ? new Date(expiry) : undefined;
    if (
      expiration &&
      (!Number.isFinite(expiration.getTime()) || expiration.getTime() <= Date.now())
    )
      return { status: "unsupported" };
    credentials = {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken && { sessionToken }),
      ...(expiration && { expiration }),
      ...(credentialScope && { credentialScope }),
      ...(accountId && { accountId }),
    };
  }
  return { ...base, credentials };
}
const Id = z
  .string()
  .min(1)
  .refine((id) => id.trim() === id);
const Foundations = z.object({
  modelSummaries: z
    .array(z.object({ modelId: Id, inferenceTypesSupported: z.array(z.string()).optional() }))
    .default([]),
});
const Profiles = z.object({
  inferenceProfileSummaries: z
    .array(
      z.object({
        inferenceProfileId: Id,
        status: Id,
        models: z.array(z.object({ modelArn: z.string() })).optional(),
      })
    )
    .default([]),
  nextToken: Id.optional(),
});
// Foundation ARNs end in `foundation-model/<modelId>`; anything else is not a text foundation.
const foundationModelId = (arn: string) => /(?:^|:)foundation-model\/(.+)$/.exec(arn)?.[1];
const escapeQuery = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );

// Fixed snapshots only: discovery must not prompt, refresh credentials, or persist catalogs.
export async function discoverBedrockModels(
  resolve: () => Source,
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
    const source = snapshot(resolve());
    if ("status" in source) return source;
    const identity = JSON.stringify(source);
    const current = () => {
      if (JSON.stringify(snapshot(resolve())) !== identity) {
        reason = "stale-config";
        throw new Error();
      }
      combined.throwIfAborted();
    };
    agent = new EnvHttpProxyAgent({ connect: { timeout: MODEL_DISCOVERY_LIMITS.timeoutMs } });
    // Text foundations (including profile-only ones) decide which profiles are chat-capable.
    const textFoundations = new Set<string>(),
      profiles: Array<{ id: string; models: string[] }> = [];
    const ids = new Set<string>(),
      cursors = new Set<string>();
    let pages = 0,
      bytes = 0,
      items = 0;
    const client = new BedrockClient({
      region: source.region,
      defaultsMode: "standard",
      retryMode: "standard",
      maxAttempts: 1,
      useFipsEndpoint: false,
      useDualstackEndpoint: false,
      userAgentAppId: "xum",
      authSchemePreference: [source.bearer ? "httpBearerAuth" : "sigv4"],
      token: source.bearer ? { token: source.bearer } : undefined,
      // The SDK eagerly constructs its default chain even for bearer auth when
      // credentials is absent. This private reject-only guard forbids that fallback.
      credentials:
        source.credentials ?? (() => Promise.reject(new Error("Unexpected SigV4 selection"))),
      requestHandler: {
        async handle(request: HttpRequest) {
          current();
          reason = "request-failed";
          if (++pages > MODEL_DISCOVERY_LIMITS.pages) {
            reason = "limit-exceeded";
            throw new Error();
          }
          assert(
            request.method === "GET" && request.body == null,
            "Bedrock listing must be read-only"
          );
          assert(agent, "Discovery owns its transport until publication");
          const query = Object.entries(request.query ?? {})
            .flatMap(([key, value]) =>
              (Array.isArray(value) ? value : [value]).map(
                (v) => `${escapeQuery(key)}=${escapeQuery(v ?? "")}`
              )
            )
            .join("&");
          const url = `${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ""}${request.path}${query ? `?${query}` : ""}`;
          const response = await httpRequest(url, {
            method: "GET",
            headers: request.headers,
            dispatcher: agent,
            signal: combined,
          });
          // Never follow redirects or return a foundation-only catalog on profile failure.
          if (response.statusCode < 200 || response.statusCode >= 300) throw new Error();
          const chunks: Uint8Array[] = [];
          for await (const value of response.body) {
            const chunk: unknown = value;
            assert(chunk instanceof Uint8Array, "HTTP body chunks must be bytes");
            bytes += chunk.length;
            if (bytes > MODEL_DISCOVERY_LIMITS.bytes) {
              reason = "limit-exceeded";
              throw new Error();
            }
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks);
          // Validate raw entries before SDK deserialization can coerce/drop malformed IDs.
          reason = "invalid-response";
          const parsed: unknown = JSON.parse(body.toString("utf8"));
          if (request.path === "/foundation-models") {
            const page = Foundations.parse(parsed);
            items += page.modelSummaries.length;
            for (const model of page.modelSummaries) {
              textFoundations.add(model.modelId);
              // Profile-only foundations reject direct invocation; their profiles are listed below.
              if (
                !model.inferenceTypesSupported ||
                model.inferenceTypesSupported.includes("ON_DEMAND")
              )
                ids.add(model.modelId);
            }
          } else {
            assert(request.path === "/inference-profiles", "Unexpected Bedrock listing operation");
            const page = Profiles.parse(parsed);
            items += page.inferenceProfileSummaries.length;
            for (const profile of page.inferenceProfileSummaries)
              if (profile.status === "ACTIVE")
                profiles.push({
                  id: profile.inferenceProfileId,
                  models: (profile.models ?? []).map((model) => model.modelArn),
                });
          }
          if (items > MODEL_DISCOVERY_LIMITS.items) {
            reason = "limit-exceeded";
            throw new Error();
          }
          return {
            response: {
              statusCode: response.statusCode,
              headers: Object.fromEntries(
                Object.entries(response.headers).flatMap(([key, value]) =>
                  value == null ? [] : [[key, Array.isArray(value) ? value.join(",") : value]]
                )
              ),
              body,
            },
          };
        },
      },
    });
    // Native partition resolution, not a rewritten bedrock-runtime host. Mark the
    // resolved endpoint explicit so middleware never loads ambient endpoint config.
    const endpoint = client.config.endpointProvider({
      Region: source.region,
      UseFIPS: false,
      UseDualStack: false,
    });
    client.config.endpoint = () => Promise.resolve(client.config.urlParser(endpoint.url));
    client.config.isCustomEndpoint = true;
    await client.send(new ListFoundationModelsCommand({ byOutputModality: "TEXT" }), {
      abortSignal: combined,
    });
    let nextToken: string | undefined;
    do {
      current();
      const page = await client.send(
        new ListInferenceProfilesCommand({
          maxResults: MODEL_DISCOVERY_LIMITS.pageSize,
          nextToken,
        }),
        { abortSignal: combined }
      );
      nextToken = page.nextToken;
      if (nextToken && cursors.has(nextToken)) {
        reason = "invalid-response";
        throw new Error();
      }
      if (nextToken) cursors.add(nextToken);
    } while (nextToken);
    // Profile listing has no modality filter: keep only profiles whose every backing
    // model is a listed text foundation, so embedding/image profiles are not suggested.
    for (const profile of profiles)
      if (
        profile.models.length > 0 &&
        profile.models.every((arn) => {
          const id = foundationModelId(arn);
          return id != null && textFoundations.has(id);
        })
      )
        ids.add(profile.id);
    await agent.destroy().catch(() => undefined);
    agent = undefined;
    current();
    const allowed = source.policy.allowedModels;
    return { status: "ok", modelIds: [...ids].filter((id) => !allowed || allowed.includes(id)) };
  } catch {
    return {
      status: "error",
      reason: signal?.aborted ? "aborted" : deadline.signal.aborted ? "timeout" : reason,
    };
  } finally {
    clearTimeout(timeout);
    // No await after the successful publication fence, including an empty cleanup.
    if (agent) await agent.destroy().catch(() => undefined);
  }
}
