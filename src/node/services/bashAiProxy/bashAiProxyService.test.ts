import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import type { AiSdkUsageLike } from "@/common/utils/tokens/usageHelpers";
import type { ProviderConfigRaw } from "@/node/utils/providerRequirements";

import { BashAiProxyService } from "./bashAiProxyService";
import { candidatePorts } from "./stableIdentity";

interface SeenRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const zero = { tokens: 0 };
const emptyDisplayUsage: ChatUsageDisplay = {
  input: zero,
  cached: zero,
  cacheCreate: zero,
  output: zero,
  reasoning: zero,
};

interface RecordCall {
  workspaceId: string;
  modelString: string;
  usage: AiSdkUsageLike;
}

const anthropicSse = [
  `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: { model: "claude-sonnet-5-5", usage: { input_tokens: 11, output_tokens: 1 } },
  })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 4 } })}\n\n`,
].join("");

/** A loopback stand-in for the provider: records each request and answers by path. */
async function startUpstream() {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.url === "/v1/messages") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(anthropicSse);
      } else if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ model: "gpt-6.1", usage: { prompt_tokens: 3, completion_tokens: 2 } })
        );
      } else if (req.url === "/v1/responses") {
        res.writeHead(307, { location: "https://elsewhere.example/v1/responses" });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { seen, server, baseUrl: `http://127.0.0.1:${port}/v1` };
}

describe("BashAiProxyService", () => {
  let upstream: Awaited<ReturnType<typeof startUpstream>>;
  let proxy: BashAiProxyService;
  let enabled: boolean;
  let rootDir: string;
  let removed: Set<string>;
  let configs: Record<string, ProviderConfigRaw>;
  let recorded: RecordCall[];
  let liveDeltas: string[];
  let untrusted: Set<string>;

  beforeEach(async () => {
    upstream = await startUpstream();
    enabled = true;
    configs = {
      anthropic: { apiKey: "real-anthropic-key", baseUrl: upstream.baseUrl },
      openai: {
        apiKey: "real-openai-key",
        baseUrl: upstream.baseUrl,
        headers: { "x-gateway-team": "qa", Authorization: "Bearer not-this-one" },
      },
    };
    recorded = [];
    liveDeltas = [];
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-ai-proxy-"));
    removed = new Set();
    untrusted = new Set();
    proxy = makeProxy();
  });

  function makeProxy(): BashAiProxyService {
    return new BashAiProxyService({
      rootDir,
      isEnabled: () => enabled,
      workspaceExists: (workspaceId) => !removed.has(workspaceId),
      isWorkspaceTrusted: (workspaceId) => Promise.resolve(!untrusted.has(workspaceId)),
      loadProviderConfig: (provider) => configs[provider] ?? {},
      recordUsage: (workspaceId, modelString, usage) => {
        recorded.push({ workspaceId, modelString, usage });
        return Promise.resolve(
          workspaceId === "removed-ws"
            ? undefined
            : { model: modelString, usage: emptyDisplayUsage }
        );
      },
      onUsageRecorded: (workspaceId) => liveDeltas.push(workspaceId),
    });
  }

  afterEach(async () => {
    await proxy.stop();
    upstream.server.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test("both Anthropic SDK path styles reach /v1/messages with the Xum key and record once each", async () => {
    const env = await proxy.envFor("ws-1", "worktree", []);
    const base = env.ANTHROPIC_BASE_URL;
    expect(env.ANTHROPIC_API_KEY).toStartWith("xum-proxy-");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(env.ANTHROPIC_API_KEY);

    // AI SDK style (base + /messages) and official SDK style (base + /v1/messages).
    for (const path of ["/messages", "/v1/messages"]) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-5-5", stream: true }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(anthropicSse);
    }

    expect(upstream.seen.map((r) => r.url)).toEqual(["/v1/messages", "/v1/messages"]);
    for (const request of upstream.seen) {
      expect(request.headers["x-api-key"]).toBe("real-anthropic-key");
      expect(request.headers["anthropic-version"]).toBe("2023-06-01");
      expect(JSON.stringify(request.headers)).not.toContain("xum-proxy-");
    }
    expect(recorded).toEqual([
      {
        workspaceId: "ws-1",
        modelString: "anthropic:claude-sonnet-5-5",
        usage: { inputTokens: 11, cachedInputTokens: 0, outputTokens: 4 },
      },
      {
        workspaceId: "ws-1",
        modelString: "anthropic:claude-sonnet-5-5",
        usage: { inputTokens: 11, cachedInputTokens: 0, outputTokens: 4 },
      },
    ]);
    expect(liveDeltas).toEqual(["ws-1", "ws-1"]);
  });

  test("a Bearer key works for OpenAI, and streamed chat requests ask for usage", async () => {
    const env = await proxy.envFor("ws-2", "local", []);
    const res = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-6.1", stream: true, stream_options: { foo: 1 } }),
    });
    expect(res.status).toBe(200);
    await res.text();
    const [request] = upstream.seen;
    expect(request.headers.authorization).toBe("Bearer real-openai-key");
    // providers.jsonc headers go upstream, but never replace the auth header.
    expect(request.headers["x-gateway-team"]).toBe("qa");
    expect(JSON.parse(request.body)).toEqual({
      model: "gpt-6.1",
      stream: true,
      stream_options: { foo: 1, include_usage: true },
    });
    expect(recorded.map((r) => r.modelString)).toEqual(["openai:gpt-6.1"]);
  });

  test("an explicit include_usage choice is kept", async () => {
    const env = await proxy.envFor("ws-2b", "local", []);
    const body = JSON.stringify({ stream: true, stream_options: { include_usage: false } });
    const res = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body,
    });
    await res.text();
    expect(upstream.seen[0].body).toBe(body);
  });

  test("an origin-only OpenAI base URL gets /v1, like chat requests", async () => {
    configs.openai = { ...configs.openai, baseUrl: upstream.baseUrl.replace(/\/v1$/, "") };
    const env = await proxy.envFor("ws-origin", "local", []);
    const res = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(upstream.seen.map((r) => r.url)).toEqual(["/v1/chat/completions"]);
  });

  test("a base URL query stays a query, merged with the request's", async () => {
    configs.anthropic = { ...configs.anthropic, baseUrl: `${upstream.baseUrl}?token=abc` };
    const env = await proxy.envFor("ws-query", "local", []);
    await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY },
      body: "{}",
    });
    expect(upstream.seen.map((r) => r.url)).toEqual(["/v1/messages?token=abc&beta=true"]);
  });

  test("a configured OpenAI-Project header goes upstream, a command's own does not", async () => {
    configs.openai = { ...configs.openai, headers: { "OpenAI-Project": "proj_config" } };
    const env = await proxy.envFor("ws-project", "local", []);
    await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "openai-project": "proj_child" },
      body: "{}",
    });
    expect(upstream.seen[0].headers["openai-project"]).toBe("proj_config");
  });

  test("refusals never reach the provider", async () => {
    const env = await proxy.envFor("ws-3", "local", []);
    const post = (url: string, key: string) =>
      fetch(url, { method: "POST", headers: { "x-api-key": key }, body: "{}" });

    const unknownKey = await post(`${env.ANTHROPIC_BASE_URL}/v1/messages`, "xum-proxy-nope");
    expect(unknownKey.status).toBe(401);
    expect(((await unknownKey.json()) as { error: { message: string } }).error.message).toContain(
      "unknown key"
    );

    const notAllowed = await post(`${env.ANTHROPIC_BASE_URL}/v1/files`, env.ANTHROPIC_API_KEY);
    expect(notAllowed.status).toBe(404);

    removed.add("ws-3");
    const revoked = await post(`${env.ANTHROPIC_BASE_URL}/v1/messages`, env.ANTHROPIC_API_KEY);
    expect(revoked.status).toBe(401);

    expect(upstream.seen).toEqual([]);
    expect(recorded).toEqual([]);
  });

  test("after a restart the same port and key still work", async () => {
    const before = await proxy.envFor("ws-r", "local", []);
    await proxy.stop();

    proxy = makeProxy();
    const after = await proxy.envFor("ws-r", "local", []);
    expect(after.ANTHROPIC_BASE_URL).toBe(before.ANTHROPIC_BASE_URL);
    expect(after.ANTHROPIC_API_KEY).toBe(before.ANTHROPIC_API_KEY);

    // A process started before the restart uses its old env and is accepted and counted.
    const res = await fetch(`${before.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": before.ANTHROPIC_API_KEY },
      body: "{}",
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(recorded.map((r) => r.workspaceId)).toEqual(["ws-r"]);
  });

  test("a workspace ID with spaces still gets a key that works as a Bearer token", async () => {
    const env = await proxy.envFor("legacy project ws", "local", []);
    const res = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: "{}",
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(recorded.map((r) => r.workspaceId)).toEqual(["legacy project ws"]);
  });

  test("a candidate port that cannot be bound for another reason is skipped", async () => {
    // Windows can exclude a port (EACCES); a saved port can be privileged. Neither may disable
    // the proxy for good.
    const blocked = candidatePorts(rootDir, 1)[0];
    const listen = Reflect.get(http.Server.prototype, "listen") as (...a: unknown[]) => http.Server;
    const spy = spyOn(http.Server.prototype, "listen").mockImplementation(function (
      this: http.Server,
      ...args: unknown[]
    ) {
      if (args[0] !== blocked) return listen.apply(this, args);
      process.nextTick(() =>
        this.emit("error", Object.assign(new Error("denied"), { code: "EACCES" }))
      );
      return this;
    });
    try {
      const env = await proxy.envFor("ws-eacces", "local", []);
      expect(env.ANTHROPIC_BASE_URL).toBeDefined();
      expect(new URL(env.ANTHROPIC_BASE_URL).port).not.toBe(String(blocked));
    } finally {
      spy.mockRestore();
    }
  });

  test("a busy port moves to the next candidate, and the saved port comes back when free", async () => {
    const first = new URL((await proxy.envFor("ws-p", "local", [])).ANTHROPIC_BASE_URL).port;
    // A second backend on the same root (or any process on that port) takes the next candidate.
    const second = makeProxy();
    try {
      const other = new URL((await second.envFor("ws-p", "local", [])).ANTHROPIC_BASE_URL).port;
      expect(other).not.toBe(first);
    } finally {
      await second.stop();
    }
    await proxy.stop();
    proxy = makeProxy();
    expect(new URL((await proxy.envFor("ws-p", "local", [])).ANTHROPIC_BASE_URL).port).toBe(first);
  });

  test("a provider redirect is refused, not followed", async () => {
    const env = await proxy.envFor("ws-4", "local", []);
    const res = await fetch(`${env.OPENAI_BASE_URL}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: "{}",
    });
    expect(res.status).toBe(502);
    expect(upstream.seen.map((r) => r.url)).toEqual(["/v1/responses"]);
  });

  test("no live delta when the ledger write did not happen", async () => {
    const env = await proxy.envFor("removed-ws", "local", []);
    const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY },
      body: "{}",
    });
    await res.text();
    expect(recorded).toHaveLength(1);
    expect(liveDeltas).toEqual([]);
  });

  test("turning the switch off refuses keys that commands already hold", async () => {
    const env = await proxy.envFor("ws-off", "local", []);
    enabled = false;
    const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY },
      body: "{}",
    });
    expect(res.status).toBe(503);
    expect(upstream.seen).toEqual([]);
  });

  test("revoking project trust refuses keys that commands already hold", async () => {
    const env = await proxy.envFor("ws-trust", "local", []);
    untrusted.add("ws-trust");
    const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(upstream.seen).toEqual([]);
    expect(recorded).toEqual([]);
  });

  test("envFor gives a pair only when it is safe and useful", async () => {
    // A project secret that names any provider var turns off that provider's whole pair.
    const withSecret = await proxy.envFor("ws-5", "local", ["ANTHROPIC_BASE_URL"]);
    expect(Object.keys(withSecret).sort()).toEqual(["OPENAI_API_KEY", "OPENAI_BASE_URL"]);

    // Runtimes that cannot reach the backend's loopback get nothing.
    for (const runtime of ["ssh", "docker", "devcontainer"] as const) {
      expect(await proxy.envFor("ws-5", runtime, [])).toEqual({});
    }

    // A disabled provider has nothing to pay with.
    configs.openai = { ...configs.openai, enabled: false };
    expect(Object.keys(await proxy.envFor("ws-5", "local", []))).not.toContain("OPENAI_API_KEY");

    // The Settings switch turns the whole feature off.
    enabled = false;
    expect(await proxy.envFor("ws-5", "local", [])).toEqual({});
  });
});
