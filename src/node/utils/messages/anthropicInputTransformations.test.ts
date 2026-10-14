import { describe, expect, it, test } from "bun:test";
import {
  countAnthropicInputTransformations,
  readInputTransformations,
} from "./anthropicInputTransformations";

const withEntries = (inputTransformations: unknown) => ({
  anthropic: { cacheCreationInputTokens: 0, inputTransformations },
});

describe("countAnthropicInputTransformations", () => {
  test("counts dropped blocks by reason and mismatch-allowed flags separately", () => {
    expect(
      countAnthropicInputTransformations(
        withEntries([
          {
            type: "thinking_dropped",
            path: "messages.1.content.0",
            reason: "prefix_binding_mismatch",
          },
          {
            type: "thinking_dropped",
            path: "messages.3.content.0",
            reason: "prefix_binding_mismatch",
          },
          {
            type: "thinking_dropped",
            path: "messages.5.content.0",
            reason: "model_binding_mismatch",
          },
          {
            type: "thinking_dropped",
            path: "messages.7.content.0",
            reason: "organization_binding_mismatch",
          },
          {
            type: "thinking_mismatch_allowed",
            path: "messages.9.content.0",
            reason: "prefix_binding_mismatch",
          },
        ])
      )
    ).toEqual({
      dropped: {
        prefix_binding_mismatch: 2,
        model_binding_mismatch: 1,
        organization_binding_mismatch: 1,
      },
      mismatchAllowed: 1,
    });
  });

  test("ignores malformed entries and unknown types or reasons", () => {
    const counts = countAnthropicInputTransformations(
      withEntries([
        null,
        "thinking_dropped",
        { type: "thinking_dropped" },
        { type: "thinking_dropped", reason: "some_future_reason" },
        // No path: malformed, so not counted.
        { type: "thinking_dropped", reason: "prefix_binding_mismatch" },
        { type: "some_future_type", reason: "prefix_binding_mismatch" },
        { type: "thinking_mismatch_allowed", reason: "model_binding_mismatch" },
        {
          type: "thinking_dropped",
          path: "messages.1.content.0",
          reason: "model_binding_mismatch",
        },
      ])
    );
    expect(counts).toEqual({
      dropped: {
        prefix_binding_mismatch: 0,
        model_binding_mismatch: 1,
        organization_binding_mismatch: 0,
      },
      mismatchAllowed: 0,
    });
  });

  test("returns null when nothing recognizable was reported", () => {
    expect(countAnthropicInputTransformations(undefined)).toBeNull();
    expect(countAnthropicInputTransformations({ openai: { inputTransformations: [] } })).toBeNull();
    expect(countAnthropicInputTransformations({ anthropic: "not an object" })).toBeNull();
    expect(countAnthropicInputTransformations(withEntries("not an array"))).toBeNull();
    expect(countAnthropicInputTransformations(withEntries([]))).toBeNull();
    expect(
      countAnthropicInputTransformations(withEntries([{ type: "unknown", reason: "unknown" }]))
    ).toBeNull();
  });
});

const dropped = (path: string, reason = "prefix_binding_mismatch") => ({
  type: "thinking_dropped",
  path,
  reason,
});

describe("readInputTransformations", () => {
  it("lets the final message_delta replace message_start's report", () => {
    const events = [
      {
        type: "message_start",
        message: { input_transformations: [dropped("messages.1.content.0")] },
      },
      { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      // An ordinary delta without the field keeps the earlier report.
      { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 1 } },
      {
        type: "message_delta",
        input_transformations: [dropped("messages.3.content.0", "model_binding_mismatch")],
      },
    ];
    expect(readInputTransformations(events)).toEqual([
      dropped("messages.3.content.0", "model_binding_mismatch"),
    ]);
  });

  it("keeps message_start's report when no later event re-reports", () => {
    const events = [
      {
        type: "message_start",
        message: { input_transformations: [dropped("messages.1.content.0")] },
      },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ];
    expect(readInputTransformations(events)).toEqual([dropped("messages.1.content.0")]);
  });

  it("reads a non-streaming response body and distinguishes empty from unreported", () => {
    expect(readInputTransformations([{ type: "message", input_transformations: [] }])).toEqual([]);
    expect(readInputTransformations([{ type: "message", content: [] }])).toBeNull();
    expect(readInputTransformations(null)).toBeNull();
  });

  it("ignores other providers' events and malformed entries", () => {
    // OpenAI Responses events have their own `type` values and never match.
    expect(
      readInputTransformations([
        { type: "response.output_text.delta", input_transformations: [dropped("x")] },
        "data: [DONE]",
        null,
      ])
    ).toBeNull();
    const events = [
      {
        type: "message_start",
        message: {
          input_transformations: [
            { type: "thinking_mismatch_allowed", path: "messages.5.content.1", extra: "dropped" },
            { type: "thinking_dropped", path: 3 },
            { path: "messages.1.content.0" },
            "junk",
            { type: "future_type", path: "messages.7.content.0", reason: 42 },
          ],
        },
      },
      // A malformed (non-array) re-report does not erase the valid one.
      { type: "message_delta", input_transformations: "oops" },
    ];
    expect(readInputTransformations(events)).toEqual([
      { type: "thinking_mismatch_allowed", path: "messages.5.content.1" },
      { type: "future_type", path: "messages.7.content.0" },
    ]);
  });
});
