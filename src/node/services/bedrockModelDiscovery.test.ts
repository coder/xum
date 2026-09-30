import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import type * as childProcess from "node:child_process";
import type * as credentials from "@aws-sdk/credential-provider-node";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool, EnvHttpProxyAgent } from "undici/index.js";
import type { BaseProviderConfig } from "@/common/config/schemas/providersConfig";
import { MODEL_DISCOVERY_LIMITS } from "@/constants/modelDiscovery";
import { Config } from "@/node/config";
import { PolicyService } from "./policyService";
import { ProviderService } from "./providerService";
import { discoverBedrockModels } from "./bedrockModelDiscovery";

let root: string, config: Config, service: ProviderService, policy: PolicyService;
let server: ReturnType<typeof Bun.serve>, agent: Pool;
let respond: (request: Request) => Response | Promise<Response>;
let requests: Request[], origins: string[], cleanups: Array<() => void>;
let savedEnv: NodeJS.ProcessEnv;
const pair = { accessKeyId: "CONFIGKEY", secretAccessKey: "config-secret" };
function save(extra: BaseProviderConfig = {}) {
  service.providersConfigStore.saveProvidersConfig({ bedrock: { region: "us-east-1", ...extra } });
}
// The AWS SDK reaches files, processes and its default chain through CommonJS `require`. In
// bun those module objects are distinct from the ESM namespaces, so spies on the namespaces
// never see SDK calls. Spy on the objects the SDK actually calls.
const requireCjs = createRequire(import.meta.url);
const sdkFsPromises = requireCjs("node:fs/promises") as typeof fs;
const sdkChildProcess = requireCjs("node:child_process") as typeof childProcess;
const sdkCredentials = requireCjs("@aws-sdk/credential-provider-node") as typeof credentials;
function watch<T extends object, K extends keyof T>(object: T, key: K) {
  const spy = spyOn(object, key);
  cleanups.push(() => spy.mockRestore());
  return spy;
}
beforeEach(() => {
  cleanups = [];
  savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("AWS_")) delete process.env[key];
  root = mkdtempSync(join(tmpdir(), "bedrock-discovery-"));
  config = new Config(root);
  policy = new PolicyService(config);
  service = new ProviderService(config, policy);
  requests = [];
  origins = [];
  respond = () => Response.json({});
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request.clone());
      return respond(request);
    },
  });
  agent = new Pool(server.url.origin);
  // Intercept only our transport destination. Native SDK endpoint selection, signing,
  // serialization, bounded reads and decoding still run against a real HTTP fixture.
  watch(EnvHttpProxyAgent.prototype, "dispatch").mockImplementation((options, handler) => {
    origins.push(String(options.origin));
    return agent.dispatch({ ...options, origin: server.url.origin }, handler);
  });
});
afterEach(async () => {
  cleanups.reverse().forEach((cleanup) => cleanup());
  await agent.destroy();
  await server.stop(true);
  service.dispose();
  policy.dispose();
  rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

it("lists on-demand text foundations and text-backed active profiles without writes", async () => {
  save({ ...pair, models: ["manual"], sessionToken: "session" });
  await config.editConfig((current) => ({ ...current, routePriority: ["coder", "direct"] }));
  const paths = [service.providersConfigStore.providersFile, join(root, "config.json")];
  const before = paths.map((path) => readFileSync(path, "utf8"));
  respond = () =>
    Response.json(
      requests.length === 1
        ? {
            modelSummaries: [
              { modelId: "foundation", inferenceTypesSupported: ["ON_DEMAND"] },
              { modelId: "foundation" },
              // Direct invocation is rejected; only its profiles are usable.
              { modelId: "profile-only", inferenceTypesSupported: ["INFERENCE_PROFILE"] },
            ],
          }
        : {
            inferenceProfileSummaries: [
              {
                inferenceProfileId: "us.system:0",
                type: "SYSTEM_DEFINED",
                status: "ACTIVE",
                models: [
                  { modelArn: "arn:aws:bedrock:us-east-1::foundation-model/profile-only" },
                  { modelArn: "arn:aws:bedrock:us-west-2::foundation-model/profile-only" },
                ],
              },
              {
                inferenceProfileId: "application-id",
                type: "APPLICATION",
                status: "ACTIVE",
                models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/foundation" }],
              },
              // Not backed by a listed text foundation (embedding, unknown, or malformed).
              {
                inferenceProfileId: "embedding-profile",
                status: "ACTIVE",
                models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/titan-embed" }],
              },
              { inferenceProfileId: "no-models", status: "ACTIVE" },
              {
                inferenceProfileId: "malformed",
                status: "ACTIVE",
                models: [{ modelArn: "wrong" }],
              },
              {
                inferenceProfileId: "inactive",
                status: "INACTIVE",
                models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/foundation" }],
              },
            ],
            ...(requests.length === 2 && { nextToken: "a +/=!*" }),
          }
    );
  expect(await service.discoverModels("bedrock")).toEqual({
    status: "ok",
    modelIds: ["foundation", "us.system:0", "application-id"],
  });
  expect(new URL(requests[0].url).pathname).toBe("/foundation-models");
  expect(new URL(requests[0].url).searchParams.get("byOutputModality")).toBe("TEXT");
  expect(new URL(requests[1].url).pathname).toBe("/inference-profiles");
  expect(new URL(requests[1].url).searchParams.get("maxResults")).toBe("1000");
  expect(new URL(requests[2].url).searchParams.get("nextToken")).toBe("a +/=!*");
  expect(requests[0].headers.get("x-amz-security-token")).toBe("session");
  expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(before);
});

it.each([
  [pair, {}, "CONFIGKEY", null],
  [
    { ...pair, sessionToken: "config-session" },
    { AWS_SESSION_TOKEN: "ignored" },
    "CONFIGKEY",
    "config-session",
  ],
  [pair, { AWS_SESSION_TOKEN: "ignored" }, "CONFIGKEY", null],
  [{ ...pair, bearerToken: "ignored" }, {}, "CONFIGKEY", null],
  [
    { ...pair, apiKey: " config-bearer " },
    { AWS_BEARER_TOKEN_BEDROCK: "env-bearer" },
    "Bearer config-bearer",
    null,
  ],
  [pair, { AWS_BEARER_TOKEN_BEDROCK: "env-bearer" }, "Bearer env-bearer", null],
  [{ ...pair, apiKey: "" }, { AWS_BEARER_TOKEN_BEDROCK: "env-bearer" }, "CONFIGKEY", null],
  [{ ...pair, apiKey: "  " }, { AWS_BEARER_TOKEN_BEDROCK: "env-bearer" }, "CONFIGKEY", null],
  [
    { bearerToken: " config-bearer ", profile: "ignored" },
    { AWS_BEARER_TOKEN_BEDROCK: "env-bearer" },
    "Bearer config-bearer",
    null,
  ],
  [{ profile: "ignored" }, { AWS_BEARER_TOKEN_BEDROCK: "env-bearer" }, "Bearer env-bearer", null],
  [
    {},
    {
      AWS_ACCESS_KEY_ID: "ENVKEY",
      AWS_SECRET_ACCESS_KEY: "env-secret",
      AWS_SESSION_TOKEN: "env-session",
    },
    "ENVKEY",
    "env-session",
  ],
] satisfies Array<[BaseProviderConfig, NodeJS.ProcessEnv, string, string | null]>)(
  "matches inference authentication %#",
  async (extra, env, auth, session) => {
    save(extra);
    Object.assign(process.env, env);
    expect(await service.discoverModels("bedrock")).toEqual({ status: "ok", modelIds: [] });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const authorization = request.headers.get("authorization");
      if (auth.startsWith("Bearer")) expect(authorization).toBe(auth);
      else
        expect(authorization).toMatch(
          new RegExp(
            `^AWS4-HMAC-SHA256 Credential=${auth}/[^/]+/us-east-1/bedrock/aws4_request,.*Signature=[0-9a-f]{64}$`
          )
        );
      expect(request.headers.get("x-amz-security-token")).toBe(session);
    }
  }
);

it.each([
  [{}, {}, "unsupported"],
  [
    { profile: "sso" },
    { AWS_ACCESS_KEY_ID: "ENVKEY", AWS_SECRET_ACCESS_KEY: "secret" },
    "unsupported",
  ],
  [
    {},
    { AWS_PROFILE: "sso", AWS_ACCESS_KEY_ID: "ENVKEY", AWS_SECRET_ACCESS_KEY: "secret" },
    "unsupported",
  ],
  [
    { bearerToken: " " },
    { AWS_ACCESS_KEY_ID: "ENVKEY", AWS_SECRET_ACCESS_KEY: "secret" },
    "unsupported",
  ],
  [{}, { AWS_BEARER_TOKEN_BEDROCK: " " }, "unsupported"],
  [{ accessKeyId: "partial" }, { AWS_BEARER_TOKEN_BEDROCK: "other" }, "unsupported"],
  [{ ...pair, sessionToken: 4 }, {}, "unsupported"],
  [{ accessKeyId: " ", secretAccessKey: "secret" }, {}, "unsupported"],
  [{ ...pair, baseUrl: "https://runtime.invalid" }, {}, "unsupported"],
  [{ ...pair, baseURL: "https://runtime.invalid" }, {}, "unsupported"],
  [{ ...pair, endpoint: "https://runtime.invalid" }, {}, "unsupported"],
  [{ ...pair, enabled: false }, {}, "not-configured"],
  [{ ...pair, region: "" }, {}, "not-configured"],
  [
    {},
    {
      AWS_ACCESS_KEY_ID: "ENVKEY",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_CREDENTIAL_EXPIRATION: "invalid",
    },
    "unsupported",
  ],
  [
    {},
    {
      AWS_ACCESS_KEY_ID: "ENVKEY",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_CREDENTIAL_EXPIRATION: "2000-01-01",
    },
    "unsupported",
  ],
] satisfies Array<[BaseProviderConfig, NodeJS.ProcessEnv, "unsupported" | "not-configured"]>)(
  "does no network work for unavailable source %#",
  async (extra, env, status) => {
    save(extra);
    Object.assign(process.env, env);
    expect(await service.discoverModels("bedrock")).toEqual({ status });
    expect(origins).toEqual([]);
  }
);

it.each(["us-east-1", "cn-north-1", "us-gov-west-1", "sigv4"])(
  "pins native %s endpoints without SDK file/process/chain/metadata work",
  async (region) => {
    const sigv4 = region === "sigv4";
    if (sigv4) region = "us-east-1";
    save({ region, ...(sigv4 ? pair : { bearerToken: "fixed" }) });
    const awsFile = join(root, "aws-config");
    writeFileSync(
      awsFile,
      `[default]\ncredential_process = touch ${join(root, "forbidden")}\nendpoint_url = http://127.0.0.1:1\n`
    );
    Object.assign(process.env, {
      AWS_CONFIG_FILE: awsFile,
      AWS_SHARED_CREDENTIALS_FILE: awsFile,
      AWS_DEFAULTS_MODE: "auto",
      AWS_ENDPOINT_URL: "http://127.0.0.1:1",
      AWS_ENDPOINT_URL_BEDROCK: "http://127.0.0.1:1",
      AWS_CONTAINER_CREDENTIALS_FULL_URI: `${server.url}metadata`,
      AWS_EC2_METADATA_SERVICE_ENDPOINT: `${server.url}metadata`,
      AWS_USE_FIPS_ENDPOINT: "true",
      AWS_USE_DUALSTACK_ENDPOINT: "true",
      AWS_MAX_ATTEMPTS: "9",
      AWS_SDK_UA_APP_ID: "ambient",
    });
    const files = watch(sdkFsPromises, "readFile"),
      processes = watch(sdkChildProcess, "exec"),
      chain = watch(sdkCredentials, "defaultProvider");
    expect(await service.discoverModels("bedrock")).toEqual({ status: "ok", modelIds: [] });
    // These spies are process-wide, and other suites sharing the bun process (a CI shard) can
    // read files or spawn commands meanwhile. Count only calls that reach this test's own AWS
    // config file or its credential_process, which only the SDK under test can touch.
    expect(files.mock.calls.filter(([path]) => path === awsFile)).toEqual([]);
    expect(processes.mock.calls.filter(([command]) => String(command).includes(root))).toEqual([]);
    expect(existsSync(join(root, "forbidden"))).toBe(false);
    expect(chain).not.toHaveBeenCalled();
    expect(origins).toEqual(
      Array.from(
        { length: 2 },
        () => `https://bedrock.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`
      )
    );
    expect(requests.every((request) => !request.url.includes("metadata"))).toBe(true);
  }
);

it.each([
  "json",
  "null",
  "id",
  "status",
  "cursor",
  "partial",
  "redirect",
  "retry",
  "pages",
  "items",
  "bytes",
])("rejects %s rather than publishing a partial catalog", async (kind) => {
  save(pair);
  respond = () => {
    const profiles = requests.length > 1;
    if (kind === "retry") return new Response("secret", { status: 503 });
    if (kind === "json") return new Response("secret");
    if (kind === "redirect")
      return new Response(null, { status: 302, headers: { location: `${server.url}leaked` } });
    if (kind === "partial" && profiles) return new Response("secret", { status: 403 });
    const count = kind === "items" ? 6000 : 1;
    if (!profiles)
      return Response.json({
        modelSummaries: Array.from({ length: count }, () =>
          kind === "null" ? null : { modelId: kind === "id" ? " " : "model" }
        ),
        ...(kind === "bytes" && { padding: "x".repeat(1100000) }),
      });
    return Response.json({
      inferenceProfileSummaries: Array.from({ length: count }, () => ({
        inferenceProfileId: "profile",
        status: kind === "status" ? null : "ACTIVE",
      })),
      ...(["cursor", "pages"].includes(kind) && {
        nextToken: kind === "cursor" ? "same" : String(requests.length),
      }),
      ...(kind === "bytes" && { padding: "x".repeat(1100000) }),
    });
  };
  const result = await service.discoverModels("bedrock");
  expect(result).toEqual({
    status: "error",
    reason: ["pages", "items", "bytes"].includes(kind)
      ? "limit-exceeded"
      : ["partial", "redirect", "retry"].includes(kind)
        ? "request-failed"
        : "invalid-response",
  });
  if (kind === "pages") expect(requests).toHaveLength(MODEL_DISCOVERY_LIMITS.pages);
  if (kind === "partial") expect(requests).toHaveLength(2);
  if (["redirect", "retry"].includes(kind)) expect(requests).toHaveLength(1);
});

it.each(["request", "teardown"])(
  "fences edits, policy, expiration and cancellation during %s",
  async (phase) => {
    for (const change of ["key", "policy", "expiry", "abort"]) {
      const previousRequests = requests.length;
      save(pair);
      const abort = new AbortController();
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      if (change === "expiry") {
        save();
        Object.assign(process.env, {
          AWS_ACCESS_KEY_ID: "ENVKEY",
          AWS_SECRET_ACCESS_KEY: "secret",
          AWS_CREDENTIAL_EXPIRATION: "2999-01-01",
        });
      }
      if (phase === "teardown") {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const destroy = EnvHttpProxyAgent.prototype.destroy;
        watch(EnvHttpProxyAgent.prototype, "destroy").mockImplementation(function (
          this: EnvHttpProxyAgent
        ) {
          entered.resolve();
          return release.promise.then(
            () =>
              new Promise<void>((resolve, reject) => {
                destroy.call(this, null, (error?: Error | null) =>
                  error ? reject(error) : resolve()
                );
              })
          );
        });
      }
      respond = async () => {
        if (phase === "request") {
          entered.resolve();
          await release.promise;
        }
        return Response.json({});
      };
      const result = service.discoverModels("bedrock", abort.signal);
      try {
        await entered.promise;
        if (change === "key") save({ ...pair, secretAccessKey: "changed" });
        if (change === "policy") watch(policy, "isEnforced").mockReturnValue(true);
        if (change === "expiry")
          watch(Date, "now").mockReturnValue(new Date("3000-01-01").getTime());
        if (change === "abort") abort.abort("private");
      } finally {
        release.resolve();
      }
      expect(await result).toEqual({
        status: "error",
        reason: change === "abort" ? "aborted" : "stale-config",
      });
      expect(requests.length - previousRequests).toBe(phase === "request" ? 1 : 2);
      cleanups
        .splice(1)
        .reverse()
        .forEach((cleanup) => cleanup());
      delete process.env.AWS_CREDENTIAL_EXPIRATION;
    }
  }
);

it.each(["abort", "pre-aborted", "timeout"])(
  "bounds a stalled Bedrock body with %s",
  async (kind) => {
    save(pair);
    const started = Promise.withResolvers<void>();
    respond = () => {
      started.resolve();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"modelSummaries":'));
          },
        })
      );
    };
    const abort = new AbortController();
    if (kind === "pre-aborted") abort.abort();
    const result = service.discoverModels("bedrock", abort.signal);
    if (kind !== "pre-aborted") await started.promise;
    if (kind === "abort") abort.abort("private-reason");
    expect(await result).toEqual({
      status: "error",
      reason: kind === "timeout" ? "timeout" : "aborted",
    });
    expect(requests).toHaveLength(kind === "pre-aborted" ? 0 : 1);
  },
  15000
);

it.each(["fetch", "credentialProvider", "credentials"])(
  "refuses injected %s without invoking it",
  async (field) => {
    const callback = () => {
      throw new Error("Must not execute custom IO");
    };
    expect(
      await discoverBedrockModels(() => ({
        config: { ...pair, region: "us-east-1", [field]: callback },
        enabled: true,
        policy: { enforced: false },
      }))
    ).toEqual({ status: "unsupported" });
    expect(origins).toHaveLength(0);
  }
);

it("filters policy only at publication and rejects forced endpoints", async () => {
  save(pair);
  watch(policy, "isEnforced").mockReturnValue(true);
  watch(policy, "isProviderAllowed").mockReturnValue(true);
  const effective = watch(policy, "getEffectivePolicy").mockReturnValue({
    policyFormatVersion: "0.1",
    mcp: { allowUserDefined: { remote: true, stdio: true } },
    runtimes: null,
    providerAccess: [{ id: "bedrock", allowedModels: ["keep"] }],
  });
  respond = () => Response.json({ modelSummaries: [{ modelId: "drop" }, { modelId: "keep" }] });
  expect(await service.discoverModels("bedrock")).toEqual({ status: "ok", modelIds: ["keep"] });
  effective.mockReturnValue({
    policyFormatVersion: "0.1",
    mcp: { allowUserDefined: { remote: true, stdio: true } },
    runtimes: null,
    providerAccess: [{ id: "bedrock", forcedBaseUrl: "https://runtime.invalid" }],
  });
  expect(await service.discoverModels("bedrock")).toEqual({ status: "unsupported" });
  expect(requests).toHaveLength(2);
});
