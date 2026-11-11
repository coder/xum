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
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(mapped, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Rewrite one SSE line; `inThought` tracks, per choice, whether the last delta was a thought. */
function rewriteThoughtStreamLine(line: string, inThought: Set<number>): string {
  const prefix = /^data: ?/.exec(line)?.[0];
  if (prefix == null) {
    return line;
  }
  const carriageReturn = line.endsWith("\r") ? "\r" : "";
  const payload = line.slice(prefix.length, line.length - carriageReturn.length);
  if (!payload.startsWith("{")) {
    return line;
  }
  let chunk: unknown;
  try {
    chunk = JSON.parse(payload);
  } catch {
    return line;
  }
  if (!isPlainObject(chunk) || !Array.isArray(chunk.choices)) {
    return line;
  }
  let changed = false;
  chunk.choices.forEach((choice: unknown, position) => {
    if (!isPlainObject(choice) || !isPlainObject(choice.delta)) {
      return;
    }
    const index = typeof choice.index === "number" ? choice.index : position;
    const delta = choice.delta;
    if (isThought(delta)) {
      let text = typeof delta.content === "string" ? delta.content : "";
      if (!inThought.has(index)) {
        text = text.startsWith(THOUGHT_OPEN_MARKER) ? text.slice(THOUGHT_OPEN_MARKER.length) : text;
        inThought.add(index);
      }
      delta.reasoning_content = text;
      delete delta.content;
      changed = true;
      return;
    }
    if (!inThought.has(index)) {
      return;
    }
    // The first visible text or tool call ends the thought; the close marker
    // leads the first non-thought content.
    if (typeof delta.content === "string" && delta.content !== "") {
      inThought.delete(index);
      if (delta.content.startsWith(THOUGHT_CLOSE_MARKER)) {
        delta.content = delta.content.slice(THOUGHT_CLOSE_MARKER.length);
        changed = true;
      }
    } else if (delta.tool_calls != null) {
      inThought.delete(index);
    }
  });
  return changed ? `${prefix}${JSON.stringify(chunk)}${carriageReturn}` : line;
}

/** Split <thought>-marked message content into reasoning_content and the visible answer. */
function rewriteThoughtCompletion(completion: unknown): boolean {
  if (!isPlainObject(completion) || !Array.isArray(completion.choices)) {
    return false;
  }
  let changed = false;
  for (const choice of completion.choices) {
    const message = isPlainObject(choice) ? choice.message : null;
    // The thought metadata gates the rewrite so an answer that legitimately
    // begins with the marker text is left alone.
    if (
      !isPlainObject(message) ||
      typeof message.content !== "string" ||
      !message.content.startsWith(THOUGHT_OPEN_MARKER) ||
      !isThought(message)
    ) {
      continue;
    }
    let reasoning = message.content.slice(THOUGHT_OPEN_MARKER.length);
    let answer = "";
    const closeIndex = reasoning.indexOf(THOUGHT_CLOSE_MARKER);
    if (closeIndex >= 0) {
      answer = reasoning.slice(closeIndex + THOUGHT_CLOSE_MARKER.length);
      reasoning = reasoning.slice(0, closeIndex);
    }
    message.reasoning_content = reasoning;
    message.content = answer;
    changed = true;
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
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(rewriteThoughtCompletion(completion) ? JSON.stringify(completion) : text, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  return Object.assign(thoughtsFetch, baseFetch) as typeof fetch;
}
