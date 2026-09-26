import { describe, expect, it } from "bun:test";
import {
  DEVTOOLS_RUN_METADATA_ID_HEADER,
  DEVTOOLS_STEP_ID_HEADER,
  captureAndStripDevToolsHeader,
  consumeCapturedRequestHeaders,
  closeCapturedRequestBody,
  consumeRedactedRequestBody,
  discardCapturedRequestBody,
  redactHeaders,
  resolveDevToolsCaptureBody,
} from "../devToolsHeaderCapture";

describe("devToolsHeaderCapture", () => {
  it("captures headers and strips synthetic header from Headers object", () => {
    const headers = new Headers({
      "content-type": "application/json",
      "x-api-key": "sk-123",
      "user-agent": "mux/1.0 ai-sdk/anthropic/3.0",
      [DEVTOOLS_STEP_ID_HEADER]: "step-abc",
      [DEVTOOLS_RUN_METADATA_ID_HEADER]: "metadata-abc",
    });

    captureAndStripDevToolsHeader(headers);

    // Synthetic headers were stripped from the Headers object
    expect(headers.get(DEVTOOLS_STEP_ID_HEADER)).toBeNull();
    expect(headers.get(DEVTOOLS_RUN_METADATA_ID_HEADER)).toBeNull();
    // Other headers remain intact
    expect(headers.get("content-type")).toBe("application/json");

    // Captured headers include real headers (redacted as needed) but not the synthetic one
    const captured = consumeCapturedRequestHeaders("step-abc");
    expect(captured).not.toBeNull();
    expect(captured!["content-type"]).toBe("application/json");
    expect(captured!["x-api-key"]).toBe("[REDACTED]");
    expect(captured!["user-agent"]).toBe("mux/1.0 ai-sdk/anthropic/3.0");
    expect(captured![DEVTOOLS_STEP_ID_HEADER]).toBeUndefined();
    expect(captured![DEVTOOLS_RUN_METADATA_ID_HEADER]).toBeUndefined();
  });

  it("redacts sensitive headers before persisting captured metadata", () => {
    const headers = new Headers({
      authorization: "Bearer sk-abc",
      "x-api-key": "x-api-key-value",
      "api-key": "api-key-value",
      "x-goog-api-key": "x-goog-api-key-value",
      "x-session-token": "token-value",
      "client-secret": "secret-value",
      "content-type": "application/json",
      "user-agent": "mux/1.0 ai-sdk/openai/5.0",
      [DEVTOOLS_STEP_ID_HEADER]: "step-sensitive",
    });

    captureAndStripDevToolsHeader(headers);

    const captured = consumeCapturedRequestHeaders("step-sensitive");
    expect(captured).not.toBeNull();
    expect(captured!.authorization).toBe("[REDACTED]");
    expect(captured!["x-api-key"]).toBe("[REDACTED]");
    expect(captured!["api-key"]).toBe("[REDACTED]");
    expect(captured!["x-goog-api-key"]).toBe("[REDACTED]");
    expect(captured!["x-session-token"]).toBe("[REDACTED]");
    expect(captured!["client-secret"]).toBe("[REDACTED]");
    expect(captured!["content-type"]).toBe("application/json");
    expect(captured!["user-agent"]).toBe("mux/1.0 ai-sdk/openai/5.0");
  });

  it("keeps response token metadata visible for debugging", () => {
    const headers = redactHeaders(
      {
        "anthropic-ratelimit-input-tokens-remaining": "123",
        "x-ratelimit-tokens-reset": "10",
      },
      "response"
    );

    expect(headers["anthropic-ratelimit-input-tokens-remaining"]).toBe("123");
    expect(headers["x-ratelimit-tokens-reset"]).toBe("10");
  });

  it("redacts unknown response token headers by default", () => {
    const headers = redactHeaders(
      {
        "x-auth-token": "response-token",
      },
      "response"
    );

    expect(headers["x-auth-token"]).toBe("[REDACTED]");
  });

  it("still redacts response set-cookie headers", () => {
    const headers = redactHeaders(
      {
        "set-cookie": "session=abc123",
      },
      "response"
    );

    expect(headers["set-cookie"]).toBe("[REDACTED]");
  });

  it("continues redacting request token headers", () => {
    const headers = redactHeaders({
      "x-session-token": "token-value",
    });

    expect(headers["x-session-token"]).toBe("[REDACTED]");
  });

  it("consumeCapturedRequestHeaders returns null for unknown stepId", () => {
    expect(consumeCapturedRequestHeaders("unknown")).toBeNull();
  });

  it("consumeCapturedRequestHeaders cleans up after read", () => {
    const headers = new Headers({
      [DEVTOOLS_STEP_ID_HEADER]: "step-1",
    });
    captureAndStripDevToolsHeader(headers);

    consumeCapturedRequestHeaders("step-1"); // first read
    expect(consumeCapturedRequestHeaders("step-1")).toBeNull(); // second read → null
  });

  it("never persists a request body it cannot parse and redact", () => {
    captureAndStripDevToolsHeader(
      new Headers({ [DEVTOOLS_STEP_ID_HEADER]: "step-text" }),
      "api_key=sk-plain-text-secret"
    );
    expect(consumeRedactedRequestBody("step-text")).toBeNull();
  });

  it("redacts the shared credential vocabulary in request bodies", () => {
    captureAndStripDevToolsHeader(
      new Headers({ [DEVTOOLS_STEP_ID_HEADER]: "step-creds" }),
      JSON.stringify({
        auth_token: "a",
        privateKey: "b",
        credentials: { user: "c", pass: "d" },
        jwt: "e",
        max_tokens: 64,
        prompt_cache_key: "visible",
      })
    );
    expect(consumeRedactedRequestBody("step-creds")).toEqual({
      auth_token: "[REDACTED]",
      privateKey: "[REDACTED]",
      credentials: "[REDACTED]",
      jwt: "[REDACTED]",
      max_tokens: 64,
      prompt_cache_key: "visible",
    });
  });

  it("redacts Anthropic redacted_thinking payloads but keeps unrelated data fields", () => {
    captureAndStripDevToolsHeader(
      new Headers({ [DEVTOOLS_STEP_ID_HEADER]: "step-anthropic" }),
      JSON.stringify({
        messages: [
          { type: "redacted_thinking", data: "opaque-blob" },
          { type: "document", data: "visible" },
        ],
      })
    );
    expect(consumeRedactedRequestBody("step-anthropic")).toEqual({
      messages: [
        { type: "redacted_thinking", data: "[REDACTED 11 chars]" },
        { type: "document", data: "visible" },
      ],
    });
  });

  it("drops a discarded body so a later read finds nothing", () => {
    captureAndStripDevToolsHeader(new Headers({ [DEVTOOLS_STEP_ID_HEADER]: "step-ok" }), "{}");
    discardCapturedRequestBody("step-ok");
    expect(consumeRedactedRequestBody("step-ok")).toBeNull();
  });

  it("reads the body of a Request input only for a DevTools-tracked request", async () => {
    const body = JSON.stringify({ model: "m" });
    const tracked = new Request("https://api.example/v1", {
      method: "POST",
      headers: { [DEVTOOLS_STEP_ID_HEADER]: "step-request" },
      body,
    });
    expect(await resolveDevToolsCaptureBody(tracked.headers, tracked, undefined)).toBe(body);
    // The caller's Request stays readable: the helper reads a clone.
    expect(await tracked.text()).toBe(body);
    // `init.body` wins, as fetch itself would send it.
    expect(await resolveDevToolsCaptureBody(tracked.headers, "https://api.example", { body: "{}" })).toBe(
      "{}"
    );
    const untracked = new Request("https://api.example/v1", { method: "POST", body });
    expect(await resolveDevToolsCaptureBody(untracked.headers, untracked, undefined)).toBeUndefined();
  });

  it("ignores a capture that arrives after its step was closed by an abort", () => {
    closeCapturedRequestBody("step-late");
    captureAndStripDevToolsHeader(new Headers({ [DEVTOOLS_STEP_ID_HEADER]: "step-late" }), "{}");
    expect(consumeRedactedRequestBody("step-late")).toBeNull();
    // Settling the step clears the closed mark, so the id holds no state afterwards.
    captureAndStripDevToolsHeader(new Headers({ [DEVTOOLS_STEP_ID_HEADER]: "step-late" }), "{}");
    expect(consumeRedactedRequestBody("step-late")).toEqual({});
  });

  it("strips run metadata header even without step header", () => {
    const headers = new Headers({
      "content-type": "application/json",
      [DEVTOOLS_RUN_METADATA_ID_HEADER]: "metadata-only",
    });

    captureAndStripDevToolsHeader(headers);

    expect(headers.get(DEVTOOLS_RUN_METADATA_ID_HEADER)).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("is a no-op when synthetic header is absent", () => {
    const headers = new Headers({
      "content-type": "application/json",
      "x-api-key": "sk-123",
    });

    captureAndStripDevToolsHeader(headers);

    // Headers unchanged
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-api-key")).toBe("sk-123");
  });
});
