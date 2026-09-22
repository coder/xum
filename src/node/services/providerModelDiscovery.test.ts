import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvHttpProxyAgent } from "undici/index.js";
import { Config } from "@/node/config";
import { CUSTOM_PROVIDER_TYPES } from "@/common/utils/providers/customProviders";
import type { BaseProviderConfig } from "@/common/config/schemas/providersConfig";
import { PolicyService } from "./policyService";
import { ProviderService } from "./providerService";

let root: string, config: Config, service: ProviderService, policy: PolicyService;
let cleanups: Array<() => void>;
function policySpy<K extends keyof PolicyService>(key: K) {
  const spy = spyOn(policy, key);
  cleanups.push(() => spy.mockRestore());
  return spy;
}
let server: ReturnType<typeof Bun.serve>;
let respond: (request: Request) => Response | Promise<Response>;
let requests: Request[];
const envKeys = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_ORG_ID",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_BASE_URL",
  "XAI_API_KEY",
  "XAI_BASE_URL",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "MOONSHOT_API_KEY",
  "ZAI_API_KEY",
  "GITHUB_COPILOT_TOKEN",
  "AI_GATEWAY_API_KEY",
];
let savedEnv: Array<string | undefined>;
function save(provider: string, extra: BaseProviderConfig = {}) {
  service.providersConfigStore.saveProvidersConfig({
    [provider]: {
      apiKey: "private-key",
      baseUrl: server.url.toString(),
      models: ["manual"],
      ...extra,
    },
  });
}
beforeEach(() => {
  cleanups = [];
  savedEnv = envKeys.map((key) => process.env[key]);
  envKeys.forEach((key) => delete process.env[key]);
  root = mkdtempSync(join(tmpdir(), "discovery-"));
  config = new Config(root);
  policy = new PolicyService(config);
  service = new ProviderService(config, policy);
  requests = [];
  respond = () => Response.json({ data: [], has_more: false });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request.clone());
      return respond(request);
    },
  });
});
afterEach(async () => {
  await server.stop(true);
  cleanups.forEach((cleanup) => cleanup());
  service.dispose();
  policy.dispose();
  rmSync(root, { recursive: true, force: true });
  envKeys.forEach((key, i) => {
    if (savedEnv[i] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[i];
  });
});

it.each(["anthropic", "openai"])(
  "lists %s without changing persisted config or routing inputs",
  async (provider) => {
    process.env.OPENAI_BASE_URL = `${server.url}ignored-env`;
    process.env.ANTHROPIC_BASE_URL = `${server.url}ignored-env`;
    save(provider, {
      baseUrl: `${server.url}proxy?tenant=one`,
      headers: { "x-custom": "private-header" },
      organization: "org-config",
    });
    await config.editConfig((current) => ({
      ...current,
      routePriority: ["coder", "direct"],
      routeOverrides: { [provider]: "direct" },
    }));
    const paths = [service.providersConfigStore.providersFile, join(root, "config.json")];
    const before = paths.map((path) => readFileSync(path, "utf8"));
    const routing = service.getConfig();
    respond = () =>
      Response.json({
        data: [{ id: "embedding-id" }, { id: "embedding-id" }, { id: "chat-id" }],
        has_more: false,
      });
    expect(await service.discoverModels(provider)).toEqual({
      status: "ok",
      modelIds: ["embedding-id", "chat-id"],
    });
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe(provider === "anthropic" ? "/proxy/v1/models" : "/proxy/models");
    expect(url.searchParams.get("tenant")).toBe("one");
    expect(requests[0].headers.get("x-custom")).toBe("private-header");
    if (provider === "anthropic") {
      expect(requests[0].headers.get("x-api-key")).toBe("private-key");
      expect(requests[0].headers.get("anthropic-version")).toBe("2023-06-01");
      expect(url.searchParams.get("limit")).toBe("1000");
    } else {
      expect(requests[0].headers.get("authorization")).toBe("Bearer private-key");
      expect(requests[0].headers.get("openai-organization")).toBe("org-config");
    }
    expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(before);
    expect(service.getConfig()).toEqual(routing);
  }
);

it("paginates Anthropic by cursor without following upstream URLs", async () => {
  save("anthropic");
  respond = () =>
    Response.json(
      requests.length === 1
        ? { data: [{ id: "a" }], has_more: true, last_id: "a", next: "https://untrusted.invalid" }
        : { data: [{ id: "a" }, { id: "b" }], has_more: false }
    );
  expect(await service.discoverModels("anthropic")).toEqual({ status: "ok", modelIds: ["a", "b"] });
  expect(new URL(requests[1].url).searchParams.get("after_id")).toBe("a");
  expect(requests).toHaveLength(2);
});

it("ignores Anthropic cursors carried in the configured base URL", async () => {
  save("anthropic", { baseUrl: `${server.url}?tenant=one&after_id=zzz&before_id=yyy` });
  respond = () => Response.json({ data: [{ id: "a" }], has_more: false });
  expect(await service.discoverModels("anthropic")).toEqual({ status: "ok", modelIds: ["a"] });
  const first = new URL(requests[0].url);
  expect(first.searchParams.has("after_id")).toBe(false);
  expect(first.searchParams.has("before_id")).toBe(false);
  expect(first.searchParams.get("tenant")).toBe("one");
});

it.each(["anthropic", "openai"])("accepts an empty %s catalog", async (provider) => {
  save(provider);
  respond = () => Response.json({ data: [], has_more: false, last_id: null });
  expect(await service.discoverModels(provider)).toEqual({ status: "ok", modelIds: [] });
});

it.each([
  "status",
  "json",
  "shape",
  "id",
  "cursor",
  "partial",
  "pages",
  "items",
  "body",
  "redirect",
])("fails closed on %s without returning upstream secrets or partial catalogs", async (kind) => {
  save("anthropic");
  respond = () => {
    if (kind === "status" || (kind === "partial" && requests.length > 1))
      return new Response("private-key private-header", { status: 401 });
    if (kind === "json") return new Response("private-key");
    if (kind === "shape") return Response.json({ models: [] });
    if (kind === "id") return Response.json({ data: [{ id: " " }], has_more: false });
    if (kind === "items")
      return Response.json({
        data: Array.from({ length: 10001 }, () => ({ id: "a" })),
        has_more: false,
      });
    if (kind === "body") return new Response("x".repeat(2 * 1024 * 1024 + 1));
    if (kind === "redirect")
      return new Response(null, { status: 302, headers: { location: `${server.url}redirected` } });
    return Response.json({
      data: [{ id: "a" }],
      has_more: true,
      last_id: kind === "pages" ? String(requests.length) : "a",
    });
  };
  const result = await service.discoverModels("anthropic");
  expect(result.status).toBe("error");
  expect(JSON.stringify(result)).not.toMatch(/private-key|private-header|modelIds/);
  expect(requests.length).toBeLessThanOrEqual(10);
  if (kind === "redirect") expect(requests).toHaveLength(1);
});

it.each(["config", "file", "env"])(
  "resolves %s credentials with the existing precedence",
  async (source) => {
    const keyFile = join(root, "key");
    writeFileSync(keyFile, "file-key\n");
    process.env.OPENAI_API_KEY = "env-key";
    process.env.OPENAI_BASE_URL = `${server.url}env-path`;
    process.env.OPENAI_ORG_ID = "env-org";
    save("openai", {
      apiKey: source === "config" ? "config-key" : undefined,
      apiKeyFile: source !== "env" ? keyFile : undefined,
      baseUrl: undefined,
    });
    expect((await service.discoverModels("openai")).status).toBe("ok");
    expect(requests[0].url).toBe(`${server.url}env-path/models`);
    expect(requests[0].headers.get("authorization")).toBe(`Bearer ${source}-key`);
    expect(requests[0].headers.get("openai-organization")).toBe("env-org");
  }
);

it.each(["unknown", "coder", "github-copilot", "disabled", "denied", "custom", "oauth", "azure"])(
  "does not request unavailable %s catalogs",
  async (kind) => {
    save("openai", {
      enabled: kind !== "disabled",
      ...(kind === "custom" && { providerType: "openai-compatible" }),
      ...(kind === "oauth" && { apiKey: undefined, codexOauth: { access: "private-oauth" } }),
      ...(kind === "azure" && { baseUrl: `${server.url}openai/deployments/name` }),
    });
    policySpy("isProviderAllowed").mockReturnValue(kind !== "denied");
    policySpy("isEnforced").mockReturnValue(kind === "denied");
    const provider = ["unknown", "coder", "github-copilot"].includes(kind) ? kind : "openai";
    expect(["unsupported", "not-configured"]).toContain(
      (await service.discoverModels(provider)).status
    );
    expect(requests).toHaveLength(0);
  }
);

it.each(["key", "keyfile", "base", "headers", "organization", "policy", "disabled"])(
  "rejects a delayed response after %s changes",
  async (change) => {
    const keyFile = join(root, "key");
    writeFileSync(keyFile, "first");
    save("openai", { apiKey: undefined, apiKeyFile: keyFile });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response>();
    respond = () => {
      started.resolve();
      return release.promise;
    };
    const enforced = policySpy("isEnforced").mockReturnValue(false);
    const pending = service.discoverModels("openai");
    await started.promise;
    if (change === "keyfile") writeFileSync(keyFile, "rotated");
    if (change === "key") save("openai", { apiKey: "rotated" });
    if (change === "base") save("openai", { baseUrl: `${server.url}other` });
    if (change === "headers")
      save("openai", { apiKey: undefined, apiKeyFile: keyFile, headers: { "x-tenant": "new" } });
    if (change === "organization")
      save("openai", { apiKey: undefined, apiKeyFile: keyFile, organization: "new" });
    if (change === "disabled") save("openai", { enabled: false });
    if (change === "policy") enforced.mockReturnValue(true);
    release.resolve(Response.json({ data: [{ id: "old-model" }] }));
    expect(await pending).toEqual({ status: "error", reason: "stale-config" });
  }
);

it("uses the forced endpoint and current model allowlist", async () => {
  save("openai", { baseUrl: "http://must-not-request.invalid" });
  policySpy("isEnforced").mockReturnValue(true);
  policySpy("isProviderAllowed").mockReturnValue(true);
  policySpy("getEffectivePolicy").mockReturnValue({
    policyFormatVersion: "0.1",
    providerAccess: [
      { id: "openai", forcedBaseUrl: `${server.url}forced`, allowedModels: ["allowed"] },
    ],
    mcp: { allowUserDefined: { remote: true, stdio: true } },
    runtimes: null,
  });
  respond = () => Response.json({ data: [{ id: "denied" }, { id: "allowed" }] });
  expect(await service.discoverModels("openai")).toEqual({ status: "ok", modelIds: ["allowed"] });
  expect(requests[0].url).toBe(`${server.url}forced/models`);
});

it.each(["abort", "pre-aborted", "timeout"])(
  "bounds a stalled response with %s",
  async (kind) => {
    save("openai");
    const started = Promise.withResolvers<void>();
    respond = () => {
      started.resolve();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":'));
          },
        })
      );
    };
    const abort = new AbortController();
    if (kind === "pre-aborted") abort.abort();
    const pending = service.discoverModels("openai", abort.signal);
    if (kind !== "pre-aborted") await started.promise;
    if (kind === "abort") abort.abort(new Error("private-abort-reason"));
    expect(await pending).toEqual({
      status: "error",
      reason: kind === "timeout" ? "timeout" : "aborted",
    });
    if (kind === "pre-aborted") expect(requests).toHaveLength(0);
  },
  15000
);

it.each(["unchanged", "key", "abort"])(
  "rechecks publication after %s during dispatcher teardown",
  async (change) => {
    save("openai");
    respond = () => Response.json({ data: [{ id: "old-model" }] });
    const teardown = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Capture before spying; the callback overload is invoked below with its original receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const destroy = EnvHttpProxyAgent.prototype.destroy;
    const spy = spyOn(EnvHttpProxyAgent.prototype, "destroy").mockImplementation(async function (
      this: EnvHttpProxyAgent
    ) {
      // Close real sockets first, then hold the existing asynchronous cleanup boundary.
      await new Promise<void>((done) => destroy.call(this, null, done));
      teardown.resolve();
      await release.promise;
    });
    cleanups.push(() => spy.mockRestore());
    const abort = new AbortController();
    const pending = service.discoverModels("openai", abort.signal);
    try {
      await teardown.promise;
      if (change === "key") save("openai", { apiKey: "rotated" });
      if (change === "abort") abort.abort(new Error("private-abort-reason"));
      release.resolve();
      expect(await pending).toEqual(
        change === "unchanged"
          ? { status: "ok", modelIds: ["old-model"] }
          : { status: "error", reason: change === "key" ? "stale-config" : "aborted" }
      );
    } finally {
      release.resolve();
      await pending;
    }
  }
);

const httpAdapters = [
  "google",
  "xai",
  "deepseek",
  "moonshotai",
  "openrouter",
  "ollama",
  "zai",
  ...CUSTOM_PROVIDER_TYPES,
];
function catalog(provider: string) {
  if (provider === "google")
    return {
      models: [
        { name: "models/chat", supportedGenerationMethods: ["generateContent"] },
        { name: "models/not-chat", supportedGenerationMethods: ["embedContent"] },
        { name: "publishers/models/another", supportedGenerationMethods: ["generateContent"] },
      ],
    };
  if (provider === "ollama")
    return { models: [{ name: "chat" }, { model: "chat" }, { model: "another:tag" }] };
  return { data: [{ id: "chat" }, { id: "chat" }], has_more: false };
}
function saveAdapter(provider: string, overrides: BaseProviderConfig = {}) {
  const custom = CUSTOM_PROVIDER_TYPES.find((type) => type === provider);
  const id = custom ? "fixture" : provider;
  save(id, {
    baseUrl: `${server.url}proxy/api/`,
    ...(custom && { providerType: custom }),
    ...overrides,
  });
  return id;
}

it.each(httpAdapters)(
  "HTTP adapter %s preserves explicit URLs, credentials, IDs and config bytes",
  async (provider) => {
    const id = saveAdapter(provider, { headers: { "x-custom": "private-header" } });
    await config.editConfig((current) => ({
      ...current,
      routePriority: ["direct"],
      routeOverrides: { [id]: "direct" },
    }));
    const files = [service.providersConfigStore.providersFile, join(root, "config.json")];
    const before = files.map((file) => readFileSync(file, "utf8"));
    respond = () => Response.json(catalog(provider));
    expect(await service.discoverModels(id)).toEqual({
      status: "ok",
      modelIds:
        provider === "google"
          ? ["chat", "publishers/models/another"]
          : provider === "ollama"
            ? ["chat", "another:tag"]
            : ["chat"],
    });
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe(
      provider === "ollama"
        ? "/proxy/api/tags"
        : provider === "anthropic-messages"
          ? "/proxy/api/v1/models"
          : "/proxy/api/models"
    );
    expect(requests[0].headers.get("x-custom")).toBe("private-header");
    const keyHeader =
      provider === "google"
        ? "x-goog-api-key"
        : provider === "anthropic-messages"
          ? "x-api-key"
          : "authorization";
    expect(requests[0].headers.get(keyHeader)).toBe(
      provider === "ollama"
        ? null
        : keyHeader === "authorization"
          ? "Bearer private-key"
          : "private-key"
    );
    if (provider === "google") expect(url.searchParams.get("pageSize")).toBe("1000");
    respond = () =>
      Response.json(
        provider === "google" || provider === "ollama"
          ? { models: [] }
          : { data: [], has_more: false }
      );
    expect(await service.discoverModels(id)).toEqual({ status: "ok", modelIds: [] });
    expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
  }
);

it.each(["google", "openrouter", "anthropic-messages"])(
  "paginates %s without guessing model names",
  async (provider) => {
    const id = saveAdapter(
      provider,
      provider === "openrouter"
        ? { baseUrl: `${server.url}proxy/api?tenant=one&scope=a&scope=b` }
        : {}
    );
    respond = () => {
      const more = requests.length === 1;
      if (provider === "google")
        return Response.json({
          models: [
            {
              name: "models/chat",
              supportedGenerationMethods: more ? ["embedContent"] : ["generateContent"],
            },
          ],
          ...(more && { nextPageToken: "next/token" }),
        });
      return Response.json({
        data: [{ id: more ? "first" : "second" }],
        has_more: more,
        last_id: more ? "first" : "second",
        ...(provider === "openrouter" && { links: { next: more ? "?offset=1" : null } }),
      });
    };
    expect(await service.discoverModels(id)).toEqual({
      status: "ok",
      modelIds: provider === "google" ? ["chat"] : ["first", "second"],
    });
    const next = new URL(requests[1].url);
    expect(next.pathname).toBe(new URL(requests[0].url).pathname);
    if (provider === "openrouter") {
      expect(next.searchParams.get("tenant")).toBe("one");
      expect(next.searchParams.getAll("scope")).toEqual(["a", "b"]);
    }
    expect(
      next.searchParams.get(
        provider === "google" ? "pageToken" : provider === "openrouter" ? "offset" : "after_id"
      )
    ).toBe(provider === "google" ? "next/token" : provider === "openrouter" ? "1" : "first");
  }
);

it.each([
  ["google", "pageToken"],
  ["openrouter", "offset"],
] as const)("%s ignores a %s cursor carried in the configured base URL", async (provider, key) => {
  const id = saveAdapter(provider, { baseUrl: `${server.url}proxy/api?tenant=one&${key}=zzz` });
  respond = () => Response.json(catalog(provider));
  expect((await service.discoverModels(id)).status).toBe("ok");
  const first = new URL(requests[0].url);
  expect(first.searchParams.has(key)).toBe(false);
  expect(first.searchParams.get("tenant")).toBe("one");
});

it.each(["zai", ...CUSTOM_PROVIDER_TYPES])(
  "conditional %s probes distinguish missing endpoints from upstream errors",
  async (provider) => {
    const id = saveAdapter(provider);
    for (const status of [404, 405, 401, 403, 429]) {
      respond = () => new Response("private-upstream-error", { status });
      expect(await service.discoverModels(id)).toEqual(
        status === 404 || status === 405
          ? { status: "unsupported" }
          : { status: "error", reason: "request-failed" }
      );
    }
    respond = () => Response.json({ unexpected: [] });
    expect(await service.discoverModels(id)).toEqual({
      status: "error",
      reason: "invalid-response",
    });
    respond = () => Response.json({ data: [{ id: "partial" }], has_more: true });
    expect(await service.discoverModels(id)).toEqual({
      status: "error",
      reason: "invalid-response",
    });
    if (provider === "anthropic-messages") {
      respond = () => Response.json({ data: [] });
      expect(await service.discoverModels(id)).toEqual({
        status: "error",
        reason: "invalid-response",
      });
    }
  }
);

it.each(["zai", ...CUSTOM_PROVIDER_TYPES])(
  "conditional %s unsupported replies are fenced by config changes",
  async (provider) => {
    const id = saveAdapter(provider);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response>();
    respond = () => {
      started.resolve();
      return release.promise;
    };
    const pending = service.discoverModels(id);
    await started.promise;
    saveAdapter(provider, { headers: { "x-tenant": "new" } });
    release.resolve(new Response("missing", { status: 404 }));
    expect(await pending).toEqual({ status: "error", reason: "stale-config" });
  }
);

it.each(["openrouter", "openai-compatible"])(
  "%s endpoints mounted under /deployments are still listed",
  async (provider) => {
    const id = saveAdapter(provider, { baseUrl: `${server.url}deployments/v1` });
    respond = () => Response.json({ data: [{ id: "proxied" }] });
    expect(await service.discoverModels(id)).toEqual({ status: "ok", modelIds: ["proxied"] });
  }
);

it.each([...CUSTOM_PROVIDER_TYPES])(
  "isolates %s credentials and supports only explicit keyless endpoints",
  async (provider) => {
    process.env.OPENAI_API_KEY = "must-not-leak";
    process.env.ANTHROPIC_API_KEY = "must-not-leak";
    const id = saveAdapter(provider, { apiKey: undefined });
    respond = () => Response.json(catalog(provider));
    expect((await service.discoverModels(id)).status).toBe("ok");
    expect(requests[0].headers.get("authorization")).toBeNull();
    expect(requests[0].headers.get("x-api-key")).toBeNull();
    const keyFile = join(root, "custom-key");
    writeFileSync(keyFile, "file-key");
    saveAdapter(provider, { apiKey: undefined, apiKeyFile: keyFile });
    expect((await service.discoverModels(id)).status).toBe("ok");
    expect(
      requests[1].headers.get(provider === "anthropic-messages" ? "x-api-key" : "authorization")
    ).toBe(provider === "anthropic-messages" ? "file-key" : "Bearer file-key");
    rmSync(keyFile);
    expect((await service.discoverModels(id)).status).not.toBe("ok");
    saveAdapter(provider, { apiKey: undefined, baseUrl: undefined });
    expect(await service.discoverModels(id)).toEqual({ status: "not-configured" });
    expect(requests).toHaveLength(2);
  }
);

it.each(httpAdapters)(
  "does not request disabled or policy-denied %s catalogs",
  async (provider) => {
    const id = saveAdapter(provider, { enabled: false });
    expect(await service.discoverModels(id)).toEqual({ status: "not-configured" });
    saveAdapter(provider);
    policySpy("isEnforced").mockReturnValue(true);
    policySpy("isProviderAllowed").mockReturnValue(false);
    expect(await service.discoverModels(id)).toEqual({ status: "not-configured" });
    expect(requests).toHaveLength(0);
  }
);

it("does not implicitly contact an unconfigured Ollama service", async () => {
  expect(await service.discoverModels("ollama")).toEqual({ status: "not-configured" });
  expect(requests).toHaveLength(0);
});

it.each(["google", "openrouter", "anthropic-messages"])(
  "rejects malformed, repeating and excessive %s pages",
  async (provider) => {
    const id = saveAdapter(provider);
    for (const failure of ["malformed", "repeat", "pages", "partial"]) {
      requests = [];
      respond = () => {
        if (failure === "malformed") return Response.json({ data: "wrong", models: "wrong" });
        if (failure === "partial" && requests.length > 1)
          return new Response("private-error", { status: 404 });
        const cursor = failure === "pages" ? String(requests.length) : "repeat";
        if (provider === "google")
          return Response.json({
            models: [{ name: "models/chat", supportedGenerationMethods: ["generateContent"] }],
            nextPageToken: cursor,
          });
        return Response.json({
          data: [{ id: "chat" }],
          has_more: true,
          last_id: cursor,
          ...(provider === "openrouter" && { links: { next: `?page=${cursor}` } }),
        });
      };
      expect((await service.discoverModels(id)).status).toBe("error");
      expect(requests.length).toBeLessThanOrEqual(10);
    }
  }
);

it.each(["https://untrusted.invalid/models", "/escaped/models", "?page=same"])(
  "refuses OpenRouter page escapes or cycles: %s",
  async (next) => {
    saveAdapter("openrouter");
    respond = () => Response.json({ data: [{ id: "chat" }], links: { next } });
    expect(await service.discoverModels("openrouter")).toEqual({
      status: "error",
      reason: "invalid-response",
    });
    expect(requests.length).toBeLessThanOrEqual(2);
    expect(requests.every((request) => new URL(request.url).origin === server.url.origin)).toBe(
      true
    );
  }
);

it.each(["google", "ollama"])(
  "bounds %s model counts before filtering or deduplication",
  async (provider) => {
    saveAdapter(provider);
    const item =
      provider === "google"
        ? { name: "models/embedding", supportedGenerationMethods: ["embedContent"] }
        : { name: "duplicate" };
    respond = () => Response.json({ models: Array.from({ length: 10001 }, () => item) });
    expect(await service.discoverModels(provider)).toEqual({
      status: "error",
      reason: "limit-exceeded",
    });
  }
);

it("fences custom wire-type changes while a catalog is in flight", async () => {
  const id = saveAdapter("openai-compatible");
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<Response>();
  respond = () => {
    started.resolve();
    return release.promise;
  };
  const pending = service.discoverModels(id);
  try {
    await Promise.race([
      started.promise,
      pending.then(() => {
        throw new Error("Expected a loopback request");
      }),
    ]);
    saveAdapter("openai-responses");
    release.resolve(Response.json({ data: [{ id: "old" }] }));
    expect(await pending).toEqual({ status: "error", reason: "stale-config" });
  } finally {
    release.resolve(Response.json({ data: [] }));
    await pending;
  }
});

const specializedProviders = ["github-copilot", "mux-gateway"];
function specializedCatalog(
  provider: string,
  models: unknown[] = [
    { id: "vendor/model.v1" },
    { id: "vendor/model.v1" },
    { id: "embedding", modelType: "embedding" },
  ]
) {
  return provider === "mux-gateway" ? { models } : { data: models };
}
function saveSpecialized(provider: string, overrides: BaseProviderConfig = {}) {
  save(provider, { ...(provider === "mux-gateway" && { couponCode: "coupon-key" }), ...overrides });
}

it.each(specializedProviders)(
  "specialized %s lists verbatim IDs with exact paths/headers and no writes",
  async (provider) => {
    saveSpecialized(provider, {
      baseUrl: undefined,
      baseURL: `${server.url}proxy?tenant=one`,
      headers: { "x-custom": "private-header" },
    });
    await config.editConfig((current) => ({
      ...current,
      routePriority: [provider, "direct"],
      routeOverrides: { openai: provider },
    }));
    const files = [service.providersConfigStore.providersFile, join(root, "config.json")];
    const before = files.map((file) => readFileSync(file, "utf8"));
    respond = () => Response.json(specializedCatalog(provider));
    expect(await service.discoverModels(provider)).toEqual({
      status: "ok",
      modelIds: ["vendor/model.v1", "embedding"],
    });
    expect(requests[0].method).toBe("GET");
    expect(requests[0].url).toBe(
      `${server.url}proxy/${provider === "mux-gateway" ? "config" : "models"}?tenant=one`
    );
    expect(requests[0].headers.get("authorization")).toBe(
      `Bearer ${provider === "mux-gateway" ? "coupon-key" : "private-key"}`
    );
    expect(requests[0].headers.get("x-custom")).toBe("private-header");
    if (provider === "mux-gateway") {
      expect(requests[0].headers.get("ai-gateway-protocol-version")).toBe("0.0.1");
      expect(requests[0].headers.get("ai-gateway-auth-method")).toBe("api-key");
    } else {
      expect(requests[0].headers.get("openai-intent")).toBe("conversation-edits");
      expect(requests[0].headers.get("accept")).toBe("application/json");
    }
    respond = () => Response.json(specializedCatalog(provider, []));
    expect(await service.discoverModels(provider)).toEqual({ status: "ok", modelIds: [] });
    expect(requests).toHaveLength(2);
    expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
  }
);

it.each(specializedProviders)(
  "specialized %s preserves its configured-header precedence",
  async (provider) => {
    saveSpecialized(provider, {
      headers: {
        Authorization: "Bearer custom-auth",
        "OPENAI-INTENT": "custom-intent",
        "X-API-KEY": "extra-key",
        "AI-GATEWAY-PROTOCOL-VERSION": "custom-protocol",
        "AI-GATEWAY-AUTH-METHOD": "custom-method",
      },
    });
    respond = () => Response.json(specializedCatalog(provider));
    expect((await service.discoverModels(provider)).status).toBe("ok");
    const headers = requests[0].headers;
    expect(headers.get("authorization")).toBe(
      provider === "github-copilot" ? "Bearer private-key" : "Bearer custom-auth"
    );
    expect(headers.get("openai-intent")).toBe(
      provider === "github-copilot" ? "conversation-edits" : "custom-intent"
    );
    expect(headers.get("x-api-key")).toBe(provider === "github-copilot" ? null : "extra-key");
    expect(headers.get("ai-gateway-protocol-version")).toBe("custom-protocol");
    expect(headers.get("ai-gateway-auth-method")).toBe("custom-method");
  }
);

it.each(["copilot-config", "copilot-file", "copilot-env", "gateway-coupon", "gateway-voucher"])(
  "specialized %s uses only the existing credential resolver",
  async (source) => {
    process.env.GITHUB_COPILOT_TOKEN = "env-key";
    process.env.AI_GATEWAY_API_KEY = "must-not-use-sdk-environment";
    const file = join(root, "key");
    writeFileSync(file, "file-key");
    const copilot = source.startsWith("copilot");
    const provider = copilot ? "github-copilot" : "mux-gateway";
    save(
      provider,
      copilot
        ? {
            apiKey: source === "copilot-config" ? "config-key" : undefined,
            apiKeyFile: source === "copilot-env" ? undefined : file,
          }
        : {
            couponCode: source === "gateway-coupon" ? "coupon-key" : undefined,
            voucher: "voucher-key",
          }
    );
    respond = () => Response.json(specializedCatalog(provider));
    expect((await service.discoverModels(provider)).status).toBe("ok");
    expect(requests[0].headers.get("authorization")).toBe(`Bearer ${source.split("-")[1]}-key`);
  }
);

it.each(specializedProviders)(
  "specialized %s applies forced endpoints, model policy, disabled and shadow rules",
  async (provider) => {
    saveSpecialized(provider, { baseUrl: "http://must-not-contact.invalid" });
    policySpy("isEnforced").mockReturnValue(true);
    const allowed = policySpy("isProviderAllowed").mockReturnValue(true);
    policySpy("getEffectivePolicy").mockReturnValue({
      policyFormatVersion: "0.1",
      providerAccess: [
        { id: provider, forcedBaseUrl: `${server.url}forced`, allowedModels: ["embedding"] },
      ],
      mcp: { allowUserDefined: { remote: true, stdio: true } },
      runtimes: null,
    });
    respond = () => Response.json(specializedCatalog(provider));
    expect(await service.discoverModels(provider)).toEqual({
      status: "ok",
      modelIds: ["embedding"],
    });
    expect(new URL(requests[0].url).pathname).toBe(
      `/forced/${provider === "mux-gateway" ? "config" : "models"}`
    );
    allowed.mockReturnValue(false);
    expect(await service.discoverModels(provider)).toEqual({ status: "not-configured" });
    allowed.mockReturnValue(true);
    saveSpecialized(provider, { enabled: false });
    expect(await service.discoverModels(provider)).toEqual({ status: "not-configured" });
    saveSpecialized(provider, { providerType: "openai-compatible" });
    expect(await service.discoverModels(provider)).toEqual({ status: "unsupported" });
    expect(requests).toHaveLength(1);
  }
);

it("specialized unconfigured providers never borrow generic Gateway credentials", async () => {
  process.env.AI_GATEWAY_API_KEY = "must-not-use-sdk-environment";
  expect(await service.discoverModels("github-copilot")).toEqual({ status: "not-configured" });
  save("mux-gateway");
  expect(await service.discoverModels("mux-gateway")).toEqual({ status: "not-configured" });
  save("mux-gateway", { couponCode: "", voucher: "not-a-fallback-for-blank-coupon" });
  expect(await service.discoverModels("mux-gateway")).toEqual({ status: "not-configured" });
  expect(requests).toHaveLength(0);
});

it.each(specializedProviders)(
  "specialized %s errors never log out, fall back, or return empty success",
  async (provider) => {
    saveSpecialized(provider);
    const before = readFileSync(service.providersConfigStore.providersFile, "utf8");
    for (const status of [404, 405, 401, 403, 429, 500]) {
      respond = () => new Response("private-upstream-error", { status });
      expect(await service.discoverModels(provider)).toEqual(
        provider === "mux-gateway" && [404, 405].includes(status)
          ? { status: "unsupported" }
          : { status: "error", reason: "request-failed" }
      );
      expect(readFileSync(service.providersConfigStore.providersFile, "utf8")).toBe(before);
    }
    expect(requests).toHaveLength(6);
  }
);

it.each(specializedProviders)(
  "specialized %s rejects invalid, partial, oversized, and redirected catalogs",
  async (provider) => {
    saveSpecialized(provider);
    for (const kind of ["json", "shape", "id", "partial", "items", "bytes", "redirect"]) {
      requests = [];
      respond = () => {
        if (kind === "json") return new Response("private-body");
        if (kind === "shape")
          return Response.json(provider === "mux-gateway" ? { data: [] } : { models: [] });
        if (kind === "id")
          return Response.json(specializedCatalog(provider, [{ id: "valid" }, { id: " " }]));
        if (kind === "partial")
          return Response.json({ ...specializedCatalog(provider), has_more: true });
        if (kind === "items")
          return Response.json(
            specializedCatalog(
              provider,
              Array.from({ length: 10001 }, () => ({ id: "duplicate" }))
            )
          );
        if (kind === "bytes") return new Response("x".repeat(2 * 1024 * 1024 + 1));
        return new Response(null, {
          status: 302,
          headers: { location: `${server.url}redirected` },
        });
      };
      expect(await service.discoverModels(provider)).toEqual({
        status: "error",
        reason:
          kind === "redirect"
            ? "request-failed"
            : ["items", "bytes"].includes(kind)
              ? "limit-exceeded"
              : "invalid-response",
      });
      expect(requests).toHaveLength(1);
    }
  }
);

const specializedRaceCases = [
  "copilot-key",
  "copilot-file",
  "gateway-coupon",
  "gateway-voucher",
].flatMap((source) =>
  ["request", "teardown"].flatMap((cut) =>
    ["credential", "abort", "headers", "policy", "base"].map((change) => [source, cut, change])
  )
);
it.each(specializedRaceCases)(
  "specialized %s rejects %s-time %s changes",
  async (source, cut, change) => {
    const provider = source.startsWith("copilot") ? "github-copilot" : "mux-gateway";
    const file = join(root, "key");
    writeFileSync(file, "initial");
    const field =
      provider === "github-copilot"
        ? "apiKey"
        : source === "gateway-voucher"
          ? "voucher"
          : "couponCode";
    const auth =
      source === "copilot-file" ? { apiKey: undefined, apiKeyFile: file } : { [field]: "initial" };
    save(provider, auth);
    const barrier = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    respond = async () => {
      if (cut === "request") {
        barrier.resolve();
        await release.promise;
      }
      return Response.json(specializedCatalog(provider));
    };
    if (cut === "teardown") {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const destroy = EnvHttpProxyAgent.prototype.destroy;
      const spy = spyOn(EnvHttpProxyAgent.prototype, "destroy").mockImplementation(async function (
        this: EnvHttpProxyAgent
      ) {
        await new Promise<void>((done) => destroy.call(this, null, done));
        barrier.resolve();
        await release.promise;
      });
      cleanups.push(() => spy.mockRestore());
    }
    const abort = new AbortController();
    const pending = service.discoverModels(provider, abort.signal);
    try {
      await Promise.race([
        barrier.promise,
        pending.then(() => {
          throw new Error("Expected active loopback request or teardown");
        }),
      ]);
      if (change === "credential") {
        if (source === "copilot-file") writeFileSync(file, "rotated");
        else save(provider, { ...auth, [field]: "rotated" });
      }
      if (change === "abort") abort.abort(new Error("private-abort-reason"));
      if (change === "headers") save(provider, { ...auth, headers: { "x-identity": "changed" } });
      if (change === "base") save(provider, { ...auth, baseUrl: `${server.url}changed` });
      if (change === "policy") {
        policySpy("isEnforced").mockReturnValue(true);
        policySpy("isProviderAllowed").mockReturnValue(false);
      }
      release.resolve();
      expect(await pending).toEqual({
        status: "error",
        reason: change === "abort" ? "aborted" : "stale-config",
      });
    } finally {
      release.resolve();
      await pending;
    }
  }
);

it.each(specializedProviders)(
  "specialized %s bounds stalled metadata bodies",
  async (provider) => {
    saveSpecialized(provider);
    respond = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
        })
      );
    expect(await service.discoverModels(provider)).toEqual({ status: "error", reason: "timeout" });
  },
  15000
);
