import { isPlainObject } from "@/common/utils/isPlainObject";

/**
 * Gemini's OpenAI-compatible endpoint (behind google-typed Coder AI Gateway
 * instances) returns thought text inline in `content`, wrapped in
 * <thought>...</thought> and marked with `extra_content.google.thought`. The
 * gateway forwards that verbatim, and @ai-sdk/openai-compatible reads
 * reasoning only from `reasoning_content`, so rewrite it at the fetch layer.
 * Ported from coder/coder's coderd/x/googleopenai/thoughts.go.
 */
const THOUGHT_OPEN_MARKER = "<thought>";
const THOUGHT_CLOSE_MARKER = "</thought>";

function isThought(value: Record<string, unknown>): boolean {
  const extra = value.extra_content;
  return isPlainObject(extra) && isPlainObject(extra.google) && extra.google.thought === true;
}

/** The response with a rewritten body; the original length no longer applies. */
function withBody(response: Response, body: BodyInit): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Re-emit an SSE body line by line, preserving streaming latency across network reads. */
export function mapEventStreamLines(
  response: Response,
  body: ReadableStream<Uint8Array>,
  mapLine: (line: string) => string
): Response {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const mapped = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        pending += decoder.decode(bytes, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        if (lines.length > 0) {
          controller.enqueue(encoder.encode(`${lines.map(mapLine).join("\n")}\n`));
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending) {
          controller.enqueue(encoder.encode(mapLine(pending)));
        }
      },
    })
  );
  return withBody(response, mapped);
}

interface DataLine {
  prefix: string;
  chunk: Record<string, unknown> & { choices: unknown[] };
  carriageReturn: string;
}

/** The JSON chunk an SSE `data:` line carries, or null for any other line. */
function parseChoicesDataLine(line: string): DataLine | null {
  const prefix = /^data: ?/.exec(line)?.[0];
  if (prefix == null) {
    return null;
  }
  const carriageReturn = line.endsWith("\r") ? "\r" : "";
  const payload = line.slice(prefix.length, line.length - carriageReturn.length);
  if (!payload.startsWith("{")) {
    return null;
  }
  try {
    const chunk: unknown = JSON.parse(payload);
    return isPlainObject(chunk) && Array.isArray(chunk.choices)
      ? { prefix, chunk: chunk as DataLine["chunk"], carriageReturn }
      : null;
  } catch {
    return null;
  }
}

/**
 * Rewrite one streamed choice delta in place; `inThought` holds the choices
 * whose last delta was a thought. Returns whether the delta changed.
 */
function rewriteThoughtDelta(
  delta: Record<string, unknown>,
  index: number,
  inThought: Set<number>
): boolean {
  if (isThought(delta)) {
    const text = typeof delta.content === "string" ? delta.content : "";
    // Only the first thought delta carries the open marker.
    delta.reasoning_content =
      !inThought.has(index) && text.startsWith(THOUGHT_OPEN_MARKER)
        ? text.slice(THOUGHT_OPEN_MARKER.length)
        : text;
    delete delta.content;
    inThought.add(index);
    return true;
  }
  return inThought.has(index) && endThought(delta, index, inThought);
}

/**
 * The first visible text or tool call after a thought ends it; the close
 * marker leads the first non-thought content.
 */
function endThought(
  delta: Record<string, unknown>,
  index: number,
  inThought: Set<number>
): boolean {
  if (typeof delta.content !== "string" || delta.content === "") {
    if (delta.tool_calls != null) inThought.delete(index);
    return false;
  }
  inThought.delete(index);
  if (!delta.content.startsWith(THOUGHT_CLOSE_MARKER)) {
    return false;
  }
  delta.content = delta.content.slice(THOUGHT_CLOSE_MARKER.length);
  return true;
}

function rewriteThoughtStreamLine(line: string, inThought: Set<number>): string {
  const parsed = parseChoicesDataLine(line);
  if (parsed == null) {
    return line;
  }
  let changed = false;
  parsed.chunk.choices.forEach((choice: unknown, position) => {
    if (isPlainObject(choice) && isPlainObject(choice.delta)) {
      const index = typeof choice.index === "number" ? choice.index : position;
      changed = rewriteThoughtDelta(choice.delta, index, inThought) || changed;
    }
  });
  return changed ? `${parsed.prefix}${JSON.stringify(parsed.chunk)}${parsed.carriageReturn}` : line;
}

/** Split a <thought>-marked message into reasoning_content and the visible answer. */
function rewriteThoughtMessage(message: unknown): boolean {
  // The thought metadata gates the rewrite so an answer that legitimately
  // begins with the marker text is left alone.
  if (
    !isPlainObject(message) ||
    typeof message.content !== "string" ||
    !message.content.startsWith(THOUGHT_OPEN_MARKER) ||
    !isThought(message)
  ) {
    return false;
  }
  const thought = message.content.slice(THOUGHT_OPEN_MARKER.length);
  const closeIndex = thought.indexOf(THOUGHT_CLOSE_MARKER);
  message.reasoning_content = closeIndex >= 0 ? thought.slice(0, closeIndex) : thought;
  message.content = closeIndex >= 0 ? thought.slice(closeIndex + THOUGHT_CLOSE_MARKER.length) : "";
  return true;
}

function rewriteThoughtCompletion(completion: unknown): boolean {
  if (!isPlainObject(completion) || !Array.isArray(completion.choices)) {
    return false;
  }
  let changed = false;
  for (const choice of completion.choices) {
    changed = (isPlainObject(choice) && rewriteThoughtMessage(choice.message)) || changed;
  }
  return changed;
}

export function wrapFetchWithGeminiThoughts(baseFetch: typeof fetch): typeof fetch {
  const thoughtsFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const response = await baseFetch(input, init);
    // Error bodies keep their shape for the SDK's error handler.
    if (!response.ok || response.body == null) {
      return response;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const inThought = new Set<number>();
      return mapEventStreamLines(response, response.body, (line) =>
        rewriteThoughtStreamLine(line, inThought)
      );
    }
    if (!contentType.includes("application/json")) {
      return response;
    }
    const text = await response.text();
    let completion: unknown;
    try {
      completion = JSON.parse(text);
    } catch {
      completion = null;
    }
    return withBody(
      response,
      rewriteThoughtCompletion(completion) ? JSON.stringify(completion) : text
    );
  };

  return Object.assign(thoughtsFetch, baseFetch) as typeof fetch;
}
