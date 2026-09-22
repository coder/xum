import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@/node/config";
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
