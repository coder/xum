import { describe, expect, test } from "bun:test";
import { APICallError, StreamProviderError } from "ai";
import { isRepeatCappedProviderError } from "./providerErrorRepeatCap";

const GATEWAY_MESSAGE =
  "processing error: accumulate event: error converting content block to JSON: json: error calling MarshalJSON for type json.RawMessage: invalid character '}' looking for beginning of value";

describe("isRepeatCappedProviderError (#4228)", () => {
  // The shape the AI SDK built for the #4228 gateway error part: no status, not retryable.
  test("a stream error part with no HTTP status and no retryable flag is capped", () => {
    expect(
      isRepeatCappedProviderError(
        new StreamProviderError({ message: GATEWAY_MESSAGE, type: "error", isRetryable: false })
      )
    ).toBe(true);
  });

  // The same text through any other path never stops retrying: an outage repeats its text too.
  test.each([
    [
      "an HTTP status on the stream part",
      new StreamProviderError({ message: GATEWAY_MESSAGE, statusCode: 503, isRetryable: true }),
    ],
    [
      "a retryable stream part",
      new StreamProviderError({ message: GATEWAY_MESSAGE, isRetryable: true }),
    ],
    [
      "a server-side error type",
      new StreamProviderError({
        message: GATEWAY_MESSAGE,
        type: "overloaded_error",
        isRetryable: false,
      }),
    ],
    [
      "a server-side error code",
      new StreamProviderError({
        message: GATEWAY_MESSAGE,
        code: "server_error",
        isRetryable: false,
      }),
    ],
    [
      "an HTTP response",
      new APICallError({
        message: GATEWAY_MESSAGE,
        url: "https://gateway.example/v1/messages",
        requestBodyValues: {},
        statusCode: 400,
      }),
    ],
    ["a transport error", new TypeError(GATEWAY_MESSAGE)],
    ["a plain thrown error", new Error(GATEWAY_MESSAGE)],
  ])("%s is not capped", (_name, error) => {
    expect(isRepeatCappedProviderError(error)).toBe(false);
  });
});
