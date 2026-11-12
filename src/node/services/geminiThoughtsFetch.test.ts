import { describe, expect, it } from "bun:test";

import { wrapFetchWithGeminiThoughts } from "./geminiThoughtsFetch";

const thought = { google: { thought: true } };

function respondWith(response: Response): typeof fetch {
  return wrapFetchWithGeminiThoughts((() => Promise.resolve(response)) as unknown as typeof fetch);
}

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe("wrapFetchWithGeminiThoughts", () => {
  it("moves streamed thoughts to reasoning_content per choice across reads and CRLF lines", async () => {
    const line = (choices: unknown[]) => `data: ${JSON.stringify({ choices })}\r\n\r\n`;
    const body = [
      line([
        { index: 0, delta: { content: "<thought>A1", extra_content: thought } },
        { index: 1, delta: { content: "<thought>B1", extra_content: thought } },
      ]),
      line([
        { index: 0, delta: { content: " A2", extra_content: thought } },
        // A tool call ends choice 1's thought without content.
        { index: 1, delta: { tool_calls: [{ id: "call_b", function: { name: "t" } }] } },
      ]),
      line([
        { index: 0, delta: { content: "</thought>answer" } },
        { index: 1, delta: { content: "</thought> is text now" } },
      ]),
      line([{ index: 0, delta: { content: "plain" } }]),
      "data: [DONE]\r\n\r\n",
    ].join("");
    // Split inside a JSON payload and inside the open marker.
    const cut = body.indexOf("<thou") + 3;
    const response = await respondWith(
      new Response(streamOf([body.slice(0, cut), body.slice(cut)]), {
        headers: { "content-type": "text/event-stream", "content-length": "1" },
      })
    )("https://gateway.example/chat/completions");

    expect(response.headers.get("content-length")).toBeNull();
    const events = (await response.text()).split("\r\n\r\n").filter(Boolean);
    expect(events.at(-1)).toBe("data: [DONE]");
    expect(
      events.slice(0, -1).map((event) => {
        const chunk = JSON.parse(event.slice("data: ".length)) as {
          choices: Array<{ delta: Record<string, unknown> }>;
        };
        return chunk.choices.map(({ delta }) => ({
          content: delta.content,
          reasoning: delta.reasoning_content,
        }));
      })
    ).toEqual([
      [
        { content: undefined, reasoning: "A1" },
        { content: undefined, reasoning: "B1" },
      ],
      [
        { content: undefined, reasoning: " A2" },
        { content: undefined, reasoning: undefined },
      ],
      [
        { content: "answer", reasoning: undefined },
        { content: "</thought> is text now", reasoning: undefined },
      ],
      [{ content: "plain", reasoning: undefined }],
    ]);
  });

  it("splits a JSON completion's marked message and leaves unmarked ones alone", async () => {
    const completion = {
      choices: [
        {
          message: { content: "<thought>why</thought>answer", extra_content: thought },
        },
        // Same text without thought metadata is a literal answer.
        { message: { content: "<thought>literal</thought>" } },
        // A response cut off mid-thought has no close marker and no answer.
        { message: { content: "<thought>cut off", extra_content: thought } },
      ],
    };
    const response = await respondWith(
      new Response(JSON.stringify(completion), { headers: { "content-type": "application/json" } })
    )("https://gateway.example/chat/completions");

    const rewritten = (await response.json()) as { choices: Array<{ message: unknown }> };
    expect(rewritten.choices.map((choice) => choice.message)).toEqual([
      { content: "answer", reasoning_content: "why", extra_content: thought },
      { content: "<thought>literal</thought>" },
      { content: "", reasoning_content: "cut off", extra_content: thought },
    ]);
  });
});
