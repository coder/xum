/**
 * Fake Anthropic and OpenAI provider for the `bash-ai-proxy` bug-bash scenario
 * (BUGBASH_SCENARIO=bash-ai-proxy, see startApp.ts).
 *
 * It plays two roles, both on loopback, so no model call leaves the machine and nothing is billed:
 * 1. The app's chat model. Every user message makes the agent run ONE bash command, picked from
 *    the fixed SCRIPTS table by a keyword in the message (default: "probe"). The explorer cannot
 *    choose the command text, only which fixed script runs.
 * 2. The upstream behind Xum's bash AI proxy. The scripts call the proxy with curl, and the proxy
 *    forwards here with the key from the Xum provider settings. Probe answers carry fixed token
 *    counts, so explorers can cross-check the Costs tab against the bash output.
 *
 * Every request is logged as one `[fake-provider]` line (no key values) to the app log.
 */
import * as http from "http";
import type { AddressInfo } from "net";

/** Token counts in every probe answer, so a skeptic can add them up. */
export const PROBE_USAGE = { input: 1234, output: 56, cacheRead: 100 } as const;
const PROBE_MARKER = "bugbash-proxy-probe";

const ANTHROPIC_JSON = `'{"model":"claude-opus-5-5","max_tokens":5,"messages":[{"role":"user","content":"${PROBE_MARKER}"}]}'`;
const ANTHROPIC_STREAM = `'{"model":"claude-opus-5-5","max_tokens":5,"stream":true,"messages":[{"role":"user","content":"${PROBE_MARKER}"}]}'`;
const OPENAI_CHAT = `'{"model":"gpt-6.1-sol","stream":true,"messages":[{"role":"user","content":"${PROBE_MARKER}"}]}'`;
const OPENAI_RESPONSES = `'{"model":"gpt-6.1-sol","input":"${PROBE_MARKER}"}'`;

const SHOW_ENV = [
  'echo "ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-<unset>}"',
  'echo "OPENAI_BASE_URL=${OPENAI_BASE_URL:-<unset>}"',
  'echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:+${ANTHROPIC_API_KEY:0:14}...}"',
].join("\n");
const NEED_PROXY =
  'if [ -z "$ANTHROPIC_BASE_URL" ]; then echo "no proxy variables: nothing to call"; exit 0; fi';
const anthropicCall = (data: string, key = "$ANTHROPIC_API_KEY") =>
  `curl -sS -w '\\nHTTP %{http_code}\\n' "$ANTHROPIC_BASE_URL/v1/messages" -H "x-api-key: ${key}" -H 'content-type: application/json' -d ${data}`;

interface Script {
  keyword: string;
  displayName: string;
  background: boolean;
  script: string;
}

/** Fixed scripts. The first keyword found in the user's message wins; "probe" is the default. */
const SCRIPTS: Script[] = [
  {
    keyword: "[bash:stream]",
    displayName: "Streamed Anthropic call",
    background: false,
    script: [SHOW_ENV, NEED_PROXY, anthropicCall(ANTHROPIC_STREAM)].join("\n"),
  },
  {
    keyword: "[bash:openai]",
    displayName: "OpenAI calls",
    background: false,
    script: [
      SHOW_ENV,
      'if [ -z "$OPENAI_BASE_URL" ]; then echo "no OpenAI proxy variables"; exit 0; fi',
      `curl -sS -w '\\nHTTP %{http_code}\\n' "$OPENAI_BASE_URL/chat/completions" -H "authorization: Bearer $OPENAI_API_KEY" -H 'content-type: application/json' -d ${OPENAI_CHAT}`,
      `curl -sS -w '\\nHTTP %{http_code}\\n' "$OPENAI_BASE_URL/responses" -H "authorization: Bearer $OPENAI_API_KEY" -H 'content-type: application/json' -d ${OPENAI_RESPONSES}`,
    ].join("\n"),
  },
  {
    keyword: "[bash:many]",
    displayName: "Five Anthropic calls",
    background: false,
    script: [
      SHOW_ENV,
      NEED_PROXY,
      `for i in 1 2 3 4 5; do ${anthropicCall(ANTHROPIC_JSON)}; done`,
    ].join("\n"),
  },
  {
    keyword: "[bash:background]",
    displayName: "Background calls, one every 5 s",
    background: true,
    script: [
      SHOW_ENV,
      NEED_PROXY,
      `for i in 1 2 3 4 5 6; do ${anthropicCall(ANTHROPIC_JSON)}; sleep 5; done`,
    ].join("\n"),
  },
  {
    keyword: "[bash:bad-key]",
    displayName: "Call with a wrong key",
    background: false,
    script: [SHOW_ENV, NEED_PROXY, anthropicCall(ANTHROPIC_JSON, "xum-proxy-wrong")].join("\n"),
  },
  {
    keyword: "probe",
    displayName: "Anthropic call through the proxy",
    background: false,
    script: [SHOW_ENV, NEED_PROXY, anthropicCall(ANTHROPIC_JSON)].join("\n"),
  },
];

type Json = Record<string, unknown>;

function pickScript(userText: string): Script {
  const text = userText.toLowerCase();
  return SCRIPTS.find((s) => s.keyword !== "probe" && text.includes(s.keyword)) ?? SCRIPTS.at(-1)!;
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

function anthropicChat(res: http.ServerResponse, body: Json): string {
  const model = typeof body.model === "string" ? body.model : "claude-sonnet-5-5";
  const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : [];
  const tools = Array.isArray(body.tools) ? (body.tools as Json[]).map((t) => t.name) : [];
  const last = messages.at(-1);
  const answeredTool =
    Array.isArray(last?.content) && (last.content as Json[]).some((c) => c?.type === "tool_result");
  const usage = { input_tokens: 500, output_tokens: 1 };

  if (!tools.includes("bash") || answeredTool) {
    const text = answeredTool ? "Done. The bash command finished; see its output above." : "ok";
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
      return answeredTool ? "chat-final" : "background-json";
    }
    sse(res, [
      messageStart(model, usage),
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text } }],
      ["content_block_stop", { index: 0 }],
      [
        "message_delta",
        { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } },
      ],
      ["message_stop", {}],
    ]);
    return answeredTool ? "chat-final" : "background-sse";
  }

  const userText = textOf([...messages].reverse().find((m) => m.role === "user")?.content);
  const script = pickScript(userText);
  const input = JSON.stringify({
    script: script.script,
    timeout_secs: script.background ? 120 : 30,
    display_name: script.displayName,
    run_in_background: script.background,
  });
  sse(res, [
    messageStart(model, usage),
    ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
    [
      "content_block_delta",
      { index: 0, delta: { type: "text_delta", text: `Running: ${script.displayName}.` } },
    ],
    ["content_block_stop", { index: 0 }],
    [
      "content_block_start",
      {
        index: 1,
        content_block: { type: "tool_use", id: `toolu_fake_${seq}`, name: "bash", input: {} },
      },
    ],
    ["content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: input } }],
    ["content_block_stop", { index: 1 }],
    [
      "message_delta",
      { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 40 } },
    ],
    ["message_stop", {}],
  ]);
  return `chat-tool:${script.keyword}`;
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
export async function startFakeProvider(): Promise<{ origin: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
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
        kind = isProbe(body) ? anthropicProbe(res, body) : anthropicChat(res, body);
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
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}
