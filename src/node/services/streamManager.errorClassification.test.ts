import { describe, expect, test } from "bun:test";
import { APICallError, LoadAPIKeyError, RetryError } from "ai";
import {
  categorizeAPICallError,
  categorizeError,
  categorizeErrorMessage,
  categorizeStructuredError,
  describeProviderStreamError,
  getContextBudgetStreamError,
  getSelfClassifiedStreamError,
} from "./streamManager";
import { ContextBudgetBlockedError, ContextBudgetExceededError } from "./contextBudgetError";
import { EmptyStreamOutputError, StreamTruncatedError } from "./turnEngine/streamErrors";
import { OPENAI_RESPONSES_BASE_URL_HINT } from "./utils/openAIResponsesBaseUrlHint";
import type { StreamErrorType } from "@/common/types/errors";

function apiError(statusCode: number, message: string, data?: unknown): APICallError {
  return new APICallError({
    message,
    url: "https://api.example.com/v1/responses",
    requestBodyValues: {},
    statusCode,
    responseBody: "{}",
    ...(data !== undefined ? { data } : {}),
  });
}

function retryError(errors: unknown[]): RetryError {
  return new RetryError({ message: "Retry failed", reason: "maxRetriesExceeded", errors });
}

describe("categorizeError", () => {
  const cases: Array<[string, unknown, StreamErrorType]> = [
    ["context budget block", new ContextBudgetBlockedError("blocked"), "context_budget_blocked"],
    ["truncated stream class", new StreamTruncatedError("Anthropic"), "stream_truncated"],
    ["missing API key", new LoadAPIKeyError({ message: "no key" }), "authentication"],
    ["API call error", apiError(401, "Unauthorized"), "authentication"],
    ["structured cause", { error: { code: "rate_limit_exceeded" } }, "rate_limit"],
    // A structured shape without a known code falls through to the message rules.
    ["unknown structured code", Object.assign(new Error("network down"), { error: {} }), "network"],
    ["plain error", new Error("boom"), "api"],
    ["non-error value", "boom", "unknown"],
  ];
  for (const [name, error, expected] of cases) {
    test(name, () => {
      expect(categorizeError(error)).toBe(expected);
    });
  }

  test("a RetryError surfaces a non-retryable cause and hides a transient one", () => {
    expect(categorizeError(retryError([apiError(402, "Payment required")]))).toBe("quota");
    expect(categorizeError(retryError([apiError(400, "Bad request")]))).toBe("retry_failed");
    expect(categorizeError(retryError([retryError([])]))).toBe("retry_failed");
    expect(categorizeError(retryError(["opaque"]))).toBe("retry_failed");
    expect(categorizeError(retryError([]))).toBe("retry_failed");
  });
});

describe("categorizeAPICallError", () => {
  const cases: Array<[string, APICallError, StreamErrorType]> = [
    ["402 is quota", apiError(402, "Payment required"), "quota"],
    ["429 throttling is rate_limit", apiError(429, "Too many requests"), "rate_limit"],
    ["500 is server_error", apiError(500, "Internal error"), "server_error"],
    [
      "OpenAI model_not_found at any status",
      apiError(400, "x", { error: { code: "model_not_found" } }),
      "model_not_found",
    ],
    [
      "Anthropic not_found_error at 404",
      apiError(404, "x", { error: { type: "not_found_error" } }),
      "model_not_found",
    ],
    [
      "not_found_error off 404 stays api",
      apiError(400, "x", { error: { type: "not_found_error" } }),
      "api",
    ],
    ["prompt is too long", apiError(400, "Prompt is too long"), "context_exceeded"],
    ["input is too long", apiError(400, "input is too long"), "context_exceeded"],
    [
      "token count exceeds the limit",
      apiError(400, "prompt token count of 9 exceeds the limit of 8"),
      "context_exceeded",
    ],
    ["token without a limit stays api", apiError(400, "token exceeds"), "api"],
    ["generic 400 is api", apiError(400, "Bad request"), "api"],
  ];
  for (const [name, error, expected] of cases) {
    test(name, () => {
      expect(categorizeAPICallError(error)).toBe(expected);
    });
  }
});

describe("categorizeStructuredError", () => {
  const cases: Array<[string, unknown, StreamErrorType | null]> = [
    ["model_not_found code", { error: { code: "model_not_found" } }, "model_not_found"],
    ["not_found_error type", { error: { type: "not_found_error" } }, "model_not_found"],
    ["context length", { error: { code: "context_length_exceeded" } }, "context_exceeded"],
    ["rate limit", { error: { code: "rate_limit_exceeded" } }, "rate_limit"],
    ["unknown code", { error: { code: "other" } }, null],
    ["null error", { error: null }, null],
    ["string error", { error: "nope" }, null],
    ["no error key", {}, null],
    ["null", null, null],
  ];
  for (const [name, error, expected] of cases) {
    test(name, () => {
      expect(categorizeStructuredError(error)).toBe(expected);
    });
  }
});

describe("categorizeErrorMessage", () => {
  // Rule order matters: each case's text also matches a later rule.
  const cases: Array<[string, Error, StreamErrorType]> = [
    [
      "truncation before network",
      new Error("stream closed before message_stop: network"),
      "stream_truncated",
    ],
    [
      "Google ADC file before token",
      new Error(
        "Unable to read the credential file specified by the GOOGLE_APPLICATION_CREDENTIALS environment variable: refresh_token"
      ),
      "authentication",
    ],
    [
      "AbortError name",
      Object.assign(new Error("network gone"), { name: "AbortError" }),
      "aborted",
    ],
    ["abort before network", new Error("fetch aborted"), "aborted"],
    ["fetch before token", new Error("fetch failed for token"), "network"],
    [
      "node-fetch connection failure before token",
      new Error("request to https://oauth2.googleapis.com/token failed, reason: ECONNRESET"),
      "network",
    ],
    [
      "request without failure stays on later rules",
      new Error("request to the token"),
      "context_exceeded",
    ],
    [
      "model does not exist before token",
      new Error("model x does not exist (token)"),
      "model_not_found",
    ],
    ["model doesn't exist", new Error("model doesn't exist"), "model_not_found"],
    ["model not found", new Error("model not found"), "model_not_found"],
    ["model access", new Error("you do not have access to this model"), "model_not_found"],
    ["model access short", new Error("you don't have access to the model"), "model_not_found"],
    ["model no access", new Error("model: no access"), "model_not_found"],
    ["model alone is not a match", new Error("model overloaded"), "api"],
    ["context before quota", new Error("context limit"), "context_exceeded"],
    ["too long", new Error("too long"), "context_exceeded"],
    ["maximum before limit", new Error("maximum limit"), "context_exceeded"],
    ["quota", new Error("quota reached"), "quota"],
    ["limit before key", new Error("key limit"), "quota"],
    ["insufficient balance", new Error("insufficient balance"), "quota"],
    ["add credits", new Error("please add credits"), "quota"],
    ["payment required", new Error("payment required"), "quota"],
    ["auth", new Error("unauthorized"), "authentication"],
    ["key", new Error("bad key"), "authentication"],
    ["other", new Error("boom"), "api"],
  ];
  for (const [name, error, expected] of cases) {
    test(name, () => {
      expect(categorizeErrorMessage(error)).toBe(expected);
    });
  }
});

describe("self-describing stream errors", () => {
  test("the attempt loop's own failures keep their message", () => {
    const empty = new EmptyStreamOutputError();
    expect(getSelfClassifiedStreamError(empty)).toEqual({
      error: empty.message,
      errorType: "empty_output",
    });
    expect(getSelfClassifiedStreamError(new Error("x"))).toBeNull();
  });

  test("only an exceeded context budget reports its details", () => {
    const details: ContextBudgetExceededError["details"] = {
      type: "context_budget_exceeded",
      model: "m",
      estimate: 2,
      hardCeiling: 1,
    };
    const exceeded = new ContextBudgetExceededError(details);
    expect(getContextBudgetStreamError(exceeded)).toEqual({
      error: exceeded.message,
      errorType: "context_budget_blocked",
      contextBudgetExceeded: details,
    });
    expect(getContextBudgetStreamError(new ContextBudgetBlockedError("b"))).toEqual({
      error: "b",
      errorType: "context_budget_blocked",
    });
    expect(getContextBudgetStreamError(new Error("x"))).toBeNull();
  });
});

describe("describeProviderStreamError", () => {
  const overload = apiError(529, "Overloaded");
  const base = { errorMessage: "raw", routeProvider: "" };

  test("names the missing model, without its provider prefix when it has one", () => {
    for (const [model, name] of [
      ["anthropic:sonnet-1m", "sonnet-1m"],
      ["bare-model", "bare-model"],
    ]) {
      const described = describeProviderStreamError({
        ...base,
        errorType: "model_not_found",
        actualError: new Error("x"),
        model,
      });
      expect(described.errorMessage).toStartWith(`Model '${name}' does not exist`);
    }
  });

  test("adds the base URL hint unless the rejection names an access program", () => {
    const describe400 = (data?: unknown) =>
      describeProviderStreamError({
        errorMessage: "raw",
        errorType: "api",
        actualError: apiError(400, "Bad request", data),
        model: "openai:gpt-x",
        routeProvider: "openai",
      }).errorMessage;
    expect(describe400()).toBe(`raw\n\n${OPENAI_RESPONSES_BASE_URL_HINT}`);
    const accessProgram = describe400({
      error: { code: "invalid_access_program", message: "Nope." },
    });
    expect(accessProgram).toEndWith(" OpenAI: Nope.");
    expect(accessProgram).not.toContain(OPENAI_RESPONSES_BASE_URL_HINT);
  });

  test("maps an overload to server_error only on Anthropic models", () => {
    const anthropic = describeProviderStreamError({
      ...base,
      errorType: "api",
      actualError: overload,
      model: "anthropic:claude-x",
    });
    expect(anthropic).toEqual({
      errorMessage: "Anthropic is temporarily overloaded (HTTP 529). Please try again later.",
      errorType: "server_error",
    });
    const openai = describeProviderStreamError({
      ...base,
      errorType: "api",
      actualError: overload,
      model: "openai:gpt-x",
    });
    expect(openai).toEqual({ errorMessage: "raw", errorType: "api" });
  });
});
