/**
 * Fake Anthropic and OpenAI provider for the `bash-ai-proxy` bug-bash scenario
 * (BUGBASH_SCENARIO=bash-ai-proxy, see startApp.ts).
 *
 * It plays two roles, both on loopback, so no model call leaves the machine and nothing is billed:
 * 1. The app's chat model. Every agent turn makes the fake itself call Xum's bash AI proxy, with
 *    the key Xum gives that workspace's bash commands, picked from the fixed PLANS table by a
 *    keyword in the message (default: "probe"). The reply lists the HTTP answers.
 *    Agent tools stay off (AGENTS.md: no agent tools or terminals in bug bashes until the app
 *    runs in a sandbox), so the agent runs no command. The proxy cannot tell these harness-owned
 *    calls from a bash command's; the bash env injection itself is covered by unit tests.
 * 2. The upstream behind the proxy. The proxy forwards here with the key from the Xum provider
 *    settings. Probe answers carry fixed token counts, so explorers can cross-check the Costs tab.
 *
 * Every request is logged as one `[fake-provider]` line (no key values) to the app log.
 */
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";

import { deriveProxyKey } from "../../src/node/services/bashAiProxy/stableIdentity";
import { BASH_AI_PROXY_STATE_FILE } from "../../src/node/services/bashAiProxy/proxyState";

/** Token counts in every probe answer, so a skeptic can add them up. */
export const PROBE_USAGE = { input: 1234, output: 56, cacheRead: 100 } as const;
const PROBE_MARKER = "bugbash-proxy-probe";

type Call = "anthropic" | "anthropic-stream" | "openai-chat" | "openai-responses" | "bad-key";

interface Plan {
  keyword: string;
  displayName: string;
  calls: Call[];
  /** Calls run one every 5 s after the reply, like a background command. */
  background: boolean;
}

/** Fixed plans. The first keyword found in the user's message wins; "probe" is the default. */
const PLANS: Plan[] = [
  {
    keyword: "[proxy:stream]",
    displayName: "one streamed Anthropic call",
    calls: ["anthropic-stream"],
    background: false,
  },
  {
    keyword: "[proxy:openai]",
    displayName: "one OpenAI chat and one OpenAI responses call",
    calls: ["openai-chat", "openai-responses"],
    background: false,
  },
  {
    keyword: "[proxy:many]",
    displayName: "five Anthropic calls",
    calls: Array<Call>(5).fill("anthropic"),
    background: false,
  },
  {
    keyword: "[proxy:background]",
    displayName: "twelve background Anthropic calls, one every 5 s",
    calls: Array<Call>(12).fill("anthropic"),
    background: true,
  },
  {
    keyword: "[proxy:bad-key]",
    displayName: "one Anthropic call with a wrong key",
    calls: ["bad-key"],
    background: false,
  },
  {
    keyword: "[proxy:status]",
    displayName: "no new call, only the background results so far",
    calls: [],
    background: false,
  },
  { keyword: "probe", displayName: "one Anthropic call", calls: ["anthropic"], background: false },
];

type Json = Record<string, unknown>;

function pickPlan(userText: string): Plan {
  const text = userText.toLowerCase();
  return PLANS.find((p) => p.keyword !== "probe" && text.includes(p.keyword)) ?? PLANS.at(-1)!;
}

/**
 * The workspace whose agent sent this turn: its system prompt names the worktree path. Match the
 * configured paths (they can hold spaces) instead of parsing the path out of the prompt.
 */
function workspaceIdFor(xumRoot: string, system: string): string | undefined {
  if (!system.includes("You are in a git worktree at ")) return undefined;
  const config = JSON.parse(fs.readFileSync(path.join(xumRoot, "config.json"), "utf8")) as {
    projects?: [string, { workspaces?: { path?: string; id?: string }[] }][];
  };
  for (const [, project] of config.projects ?? []) {
    // The path ends the line: a boundary, so `.../playground` never matches `.../playground-2`.
    const hit = project.workspaces?.find((w) => {
      if (w.path === undefined) return false;
      const needle = `You are in a git worktree at ${w.path}`;
      const at = system.indexOf(needle);
      return at !== -1 && [undefined, "\n"].includes(system[at + needle.length]);
    });
    if (hit?.id) return hit.id;
  }
  return undefined;
}

const PROBE_BODIES: Record<Exclude<Call, "bad-key">, { route: string; body: Json }> = {
  anthropic: {
    route: "/anthropic/v1/messages",
    body: {
      model: "claude-opus-5-5",
      max_tokens: 5,
      messages: [{ role: "user", content: PROBE_MARKER }],
    },
  },
  "anthropic-stream": {
    route: "/anthropic/v1/messages",
    body: {
      model: "claude-opus-5-5",
      max_tokens: 5,
      stream: true,
      messages: [{ role: "user", content: PROBE_MARKER }],
    },
  },
  "openai-chat": {
    route: "/openai/v1/chat/completions",
    body: {
      model: "gpt-6.1-sol",
      stream: true,
      messages: [{ role: "user", content: PROBE_MARKER }],
    },
  },
  "openai-responses": {
    route: "/openai/v1/responses",
    body: { model: "gpt-6.1-sol", input: PROBE_MARKER },
  },
};

/** One call through Xum's proxy, as a bash command with the injected variables would make it. */
async function proxyCall(xumRoot: string, workspaceId: string, call: Call): Promise<string> {
  let state: { secret?: string; port?: number };
  try {
    state = JSON.parse(
      fs.readFileSync(path.join(xumRoot, BASH_AI_PROXY_STATE_FILE), "utf8")
    ) as typeof state;
  } catch {
    return "no proxy: the switch was never turned on";
  }
  if (typeof state.port !== "number" || typeof state.secret !== "string") {
    return "no proxy: the switch was never turned on";
  }
  const key = call === "bad-key" ? "xum-proxy-wrong" : deriveProxyKey(state.secret, workspaceId);
  const probe = PROBE_BODIES[call === "bad-key" ? "anthropic" : call];
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (probe.route.startsWith("/openai")) headers.authorization = `Bearer ${key}`;
  else headers["x-api-key"] = key;
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}${probe.route}`, {
      method: "POST",
      headers,
      body: JSON.stringify(probe.body),
    });
    const text = await res.text();
    const error = /"message":"([^"]*)"/.exec(text)?.[1];
    return `HTTP ${res.status}${res.ok ? "" : ` ${error ?? text.slice(0, 120)}`}`;
  } catch (error) {
    return `connection failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as Json).type === "text"
        ? String((part as Json).text)
        : ""
    )
    .join(" ");
}

/**
 * A probe is the exact one-message request a fixed script sends. Chat turns also contain the
 * marker (the bash tool input quotes the script), so a substring match is not enough.
 */
function isProbe(body: Json): boolean {
  if (body.input === PROBE_MARKER) return true;
  const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : [];
  return messages.length === 1 && messages[0]?.content === PROBE_MARKER;
}

function sse(res: http.ServerResponse, events: [string | null, Json | string][]): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const [type, data] of events) {
    const payload =
      typeof data === "string" ? data : JSON.stringify(type ? { type, ...data } : data);
    res.write(`${type ? `event: ${type}\n` : ""}data: ${payload}\n\n`);
  }
  res.end();
}

function json(res: http.ServerResponse, status: number, body: Json): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

let seq = 0;
function messageStart(model: string, usage: Json): [string, Json] {
  return [
    "message_start",
    {
      message: {
        id: `msg_fake_${++seq}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    },
  ];
}

function chatText(res: http.ServerResponse, body: Json, text: string): void {
  const model = typeof body.model === "string" ? body.model : "claude-sonnet-5-5";
  if (body.stream !== true) {
    json(res, 200, {
      id: `msg_fake_${++seq}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 2 },
    });
    return;
  }
  sse(res, [
    messageStart(model, { input_tokens: 500, output_tokens: 1 }),
    ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { index: 0 }],
    [
      "message_delta",
      { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } },
    ],
    ["message_stop", {}],
  ]);
}

/**
 * A chat request. Agent turns (their system prompt names the worktree) make the plan's proxy
 * calls; everything else the app asks (titles, status) gets a short "ok".
 */
/** The latest background plan per workspace and its HTTP results. */
const backgroundRuns = new Map<string, { results: string[]; done: boolean }>();

async function anthropicChat(
  res: http.ServerResponse,
  body: Json,
  xumRoot: string
): Promise<string> {
  const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : [];
  const workspaceId = workspaceIdFor(xumRoot, textOf(body.system));
  if (workspaceId === undefined) {
    chatText(res, body, "ok");
    return "app-chat";
  }
  const userText = textOf([...messages].reverse().find((m) => m.role === "user")?.content);
  const plan = pickPlan(userText);
  // Background results so far, so the explorer can read them in the next reply.
  const background = backgroundRuns.get(workspaceId);
  const backgroundLines = background
    ? [
        `Background calls (${background.done ? "finished" : "still running"}):`,
        ...background.results.map((r, i) => `  call ${i + 1}: ${r}`),
      ]
    : [];
  if (plan.background) {
    const run = { results: [] as string[], done: false };
    backgroundRuns.set(workspaceId, run);
    chatText(
      res,
      body,
      `Started ${plan.displayName}. Send '[proxy:status]' to see their HTTP results; it says "finished" when all calls ran.`
    );
    // Like a background command: the calls outlive the turn.
    (async () => {
      for (const [i, call] of plan.calls.entries()) {
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, 5000));
        const result = await proxyCall(xumRoot, workspaceId, call);
        run.results.push(result);
        console.log(`[fake-provider] background call ${i + 1}: ${result}`);
      }
    })()
      .catch((error: unknown) => run.results.push(`harness error: ${String(error)}`))
      .finally(() => {
        run.done = true;
      });
    return `chat-background:${plan.keyword}`;
  }
  const results: string[] = [];
  for (const call of plan.calls)
    results.push(`${call}: ${await proxyCall(xumRoot, workspaceId, call)}`);
  // Neutral wording: an expected refusal (401, 403, 503) is a result, not a success.
  const lines =
    plan.calls.length > 0
      ? [`Results of ${plan.displayName} through the Xum proxy:`, ...results]
      : [];
  chatText(res, body, [...lines, ...backgroundLines].join("\n") || "No background calls yet.");
  return `chat-plan:${plan.keyword}`;
}

function anthropicProbe(res: http.ServerResponse, body: Json): string {
  const model = typeof body.model === "string" ? body.model : "claude-opus-5-5";
  if (body.stream === true) {
    sse(res, [
      messageStart(model, {
        input_tokens: PROBE_USAGE.input,
        cache_read_input_tokens: PROBE_USAGE.cacheRead,
        output_tokens: 1,
      }),
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "pong" } }],
      ["content_block_stop", { index: 0 }],
      [
        "message_delta",
        {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: PROBE_USAGE.output },
        },
      ],
      ["message_stop", {}],
    ]);
    return "probe-anthropic-sse";
  }
  json(res, 200, {
    id: `msg_probe_${++seq}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "pong" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: PROBE_USAGE.input,
      output_tokens: PROBE_USAGE.output,
      cache_read_input_tokens: PROBE_USAGE.cacheRead,
    },
  });
  return "probe-anthropic-json";
}

function openAiUsage(): Json {
  return {
    prompt_tokens: PROBE_USAGE.input,
    completion_tokens: PROBE_USAGE.output,
    prompt_tokens_details: { cached_tokens: PROBE_USAGE.cacheRead },
  };
}

function openAiChat(res: http.ServerResponse, body: Json): string {
  const model = typeof body.model === "string" ? body.model : "gpt-6.1-sol";
  const includeUsage = (body.stream_options as Json | undefined)?.include_usage === true;
  if (body.stream !== true) {
    json(res, 200, {
      id: "chatcmpl_fake",
      object: "chat.completion",
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" },
      ],
      usage: openAiUsage(),
    });
    return "probe-openai-chat-json";
  }
  const chunk = (extra: Json) =>
    [null, { id: "chatcmpl_fake", object: "chat.completion.chunk", model, ...extra }] as [
      null,
      Json,
    ];
  sse(res, [
    chunk({
      choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }],
    }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    ...(includeUsage ? [chunk({ choices: [], usage: openAiUsage() })] : []),
    [null, "[DONE]"],
  ]);
  return `probe-openai-chat-sse(usage=${includeUsage})`;
}

/** The app's own OpenAI calls (not probes): a short streamed or JSON "ok" with tiny usage. */
function openAiAppResponses(res: http.ServerResponse, body: Json): string {
  const model = typeof body.model === "string" ? body.model : "gpt-6.1-sol";
  const usage = {
    input_tokens: 20,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 2,
    output_tokens_details: { reasoning_tokens: 0 },
  };
  const item = { type: "message", id: "msg_app", role: "assistant" };
  const done = {
    ...item,
    status: "completed",
    content: [{ type: "output_text", text: "ok", annotations: [] }],
  };
  const response = (status: string, extra: Json) => ({
    id: `resp_app_${++seq}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status,
    ...extra,
  });
  if (body.stream !== true) {
    json(res, 200, response("completed", { output: [done], usage }));
    return "app-openai-responses-json";
  }
  sse(res, [
    ["response.created", { response: response("in_progress", { output: [] }) }],
    [
      "response.output_item.added",
      { output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    ],
    [
      "response.output_text.delta",
      { item_id: "msg_app", output_index: 0, content_index: 0, delta: "ok" },
    ],
    ["response.output_item.done", { output_index: 0, item: done }],
    ["response.completed", { response: response("completed", { output: [done], usage }) }],
  ]);
  return "app-openai-responses-sse";
}

function openAiResponses(res: http.ServerResponse, body: Json): string {
  const model = typeof body.model === "string" ? body.model : "gpt-6.1-sol";
  if (!isProbe(body)) return openAiAppResponses(res, body);
  json(res, 200, {
    id: "resp_fake",
    object: "response",
    model,
    status: "completed",
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "pong" }] },
    ],
    usage: {
      input_tokens: PROBE_USAGE.input,
      input_tokens_details: { cached_tokens: PROBE_USAGE.cacheRead },
      output_tokens: PROBE_USAGE.output,
      output_tokens_details: { reasoning_tokens: 0 },
    },
  });
  return "probe-openai-responses";
}

/** Starts the fake on a free loopback port and returns its origin (no trailing slash). */
export async function startFakeProvider(
  xumRoot: string
): Promise<{ origin: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    const handle = async (): Promise<void> => {
      let body: Json = {};
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        body = raw ? (JSON.parse(raw) as Json) : {};
      } catch {
        // Not JSON: the 404 below answers it.
      }
      const route = (req.url ?? "").split("?")[0];
      let kind: string;
      if (req.method === "POST" && route.endsWith("/messages")) {
        kind = isProbe(body) ? anthropicProbe(res, body) : await anthropicChat(res, body, xumRoot);
      } else if (req.method === "POST" && route.endsWith("/chat/completions")) {
        kind = openAiChat(res, body);
      } else if (req.method === "POST" && route.endsWith("/responses")) {
        kind = openAiResponses(res, body);
      } else if (req.method === "GET" && route.endsWith("/models")) {
        kind = "models";
        json(res, 200, { data: [{ id: "claude-opus-5-5", type: "model" }] });
      } else {
        kind = "404";
        json(res, 404, { type: "error", error: { type: "not_found_error", message: "fake" } });
      }
      const key = String(req.headers["x-api-key"] ?? req.headers.authorization ?? "");
      console.log(
        `[fake-provider] ${req.method} ${route} kind=${kind} model=${String(body.model)} stream=${String(body.stream === true)} key=${key.includes("xum-proxy-") ? "PROXY-KEY-LEAKED" : key ? "xum-settings-key" : "none"}`
      );
    };
    req.on("end", () => {
      handle().catch((error: unknown) => {
        console.log(`[fake-provider] request failed: ${String(error)}`);
        if (!res.headersSent) json(res, 500, { type: "error", error: { message: "fake failed" } });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}
