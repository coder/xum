import { describe, expect, test } from "bun:test";

import {
  consumeCapturedRequestHeaders,
  consumeRedactedRequestBody,
  DEVTOOLS_RUN_METADATA_ID_HEADER,
  DEVTOOLS_STEP_ID_HEADER,
} from "./devToolsHeaderCapture";
import { createOpenAIWebSocketTransportFetch } from "./openAIWebSocketTransportFetch";

function getFetchInputUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "string") {
    return input;
  }
  return input.url;
}

function createTestFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): typeof fetch {
  return Object.assign(handler, { preconnect: fetch.preconnect.bind(fetch) }) as typeof fetch;
}

function createTestWebSocketFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  close: () => void = () => undefined
): typeof fetch & { close: () => void } {
  return Object.assign(createTestFetch(handler), { close });
}

describe("createOpenAIWebSocketTransportFetch", () => {
  test("disabled transport keeps using the base fetch and exposes inactive cleanup", async () => {
    const baseCalls: string[] = [];
    const baseFetch = createTestFetch((input: RequestInfo | URL, _init?: RequestInit) => {
      baseCalls.push(getFetchInputUrl(input));
      return Promise.resolve(new Response("base"));
    });

    const transport = createOpenAIWebSocketTransportFetch({
      enabled: false,
      baseFetch,
      createWebSocketFetch: () => {
        throw new Error("WebSocket fetch should not be created when disabled");
      },
    });

    const response = await transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });

    expect(await response.text()).toBe("base");
    expect(baseCalls).toEqual(["https://api.openai.com/v1/responses"]);
    expect(transport.active).toBe(false);
    expect(() => transport.close()).not.toThrow();
  });

  test("enabled transport creates the WebSocket fetch lazily", async () => {
    let created = false;
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      createWebSocketFetch: () => {
        created = true;
        return createTestWebSocketFetch(() => Promise.resolve(new Response("ws")));
      },
    });

    expect(created).toBe(false);
    await transport.fetch("https://api.openai.com/v1/models", { method: "GET" });
    expect(created).toBe(false);
    await transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });
    expect(created).toBe(true);
  });

  test("enabled transport sends streaming Responses API posts through WebSocket fetch", async () => {
    const wsCalls: string[] = [];
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      createWebSocketFetch: () => {
        return createTestWebSocketFetch((input: RequestInfo | URL, _init?: RequestInit) => {
          wsCalls.push(getFetchInputUrl(input));
          return Promise.resolve(new Response("ws"));
        });
      },
    });

    const response = await transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });

    expect(await response.text()).toBe("ws");
    expect(wsCalls).toEqual(["https://api.openai.com/v1/responses"]);
    expect(transport.active).toBe(true);
  });

  test("passes custom WebSocket endpoint to the WebSocket fetch factory", async () => {
    let capturedOptions: { url?: string } | undefined;
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      webSocketUrl: "wss://proxy.openai.test/v1/responses",
      createWebSocketFetch: (options) => {
        capturedOptions = options;
        return createTestWebSocketFetch(() => Promise.resolve(new Response("ws")));
      },
    });

    await transport.fetch("https://proxy.openai.test/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });

    expect(capturedOptions).toEqual({ url: "wss://proxy.openai.test/v1/responses" });
  });

  test("enabled transport keeps non-eligible requests on the base fetch", async () => {
    const baseCalls: string[] = [];
    const wsCalls: string[] = [];
    const baseFetch = createTestFetch((input: RequestInfo | URL, _init?: RequestInit) => {
      baseCalls.push(getFetchInputUrl(input));
      return Promise.resolve(new Response("base"));
    });

    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch,
      createWebSocketFetch: () => {
        return createTestWebSocketFetch((input: RequestInfo | URL, _init?: RequestInit) => {
          wsCalls.push(getFetchInputUrl(input));
          return Promise.resolve(new Response("ws"));
        });
      },
    });

    const response = await transport.fetch("https://api.openai.com/v1/models", {
      method: "GET",
    });

    expect(await response.text()).toBe("base");
    expect(baseCalls).toEqual(["https://api.openai.com/v1/models"]);
    expect(wsCalls).toEqual([]);
  });

  test("enabled transport strips DevTools headers before WebSocket dispatch", async () => {
    let webSocketHeaders: Headers | undefined;
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      createWebSocketFetch: () =>
        createTestWebSocketFetch((_input: RequestInfo | URL, init?: RequestInit) => {
          webSocketHeaders = new Headers(init?.headers);
          return Promise.resolve(new Response("ws"));
        }),
    });

    await transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        [DEVTOOLS_STEP_ID_HEADER]: "step-ws-1",
        [DEVTOOLS_RUN_METADATA_ID_HEADER]: "run-metadata-1",
      },
      body: JSON.stringify({ stream: true }),
    });

    expect(webSocketHeaders).toBeDefined();
    if (!webSocketHeaders) {
      throw new Error("Expected WebSocket fetch to receive request headers");
    }
    expect(webSocketHeaders.get(DEVTOOLS_STEP_ID_HEADER)).toBeNull();
    expect(webSocketHeaders.get(DEVTOOLS_RUN_METADATA_ID_HEADER)).toBeNull();
    const captured = consumeCapturedRequestHeaders("step-ws-1");
    expect(captured).toEqual({ authorization: "[REDACTED]" });
  });

  test("captures the body of a Request input for failed-step debug evidence", async () => {
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      createWebSocketFetch: () =>
        createTestWebSocketFetch(() => Promise.resolve(new Response("ws"))),
    });

    await transport.fetch(
      new Request("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { [DEVTOOLS_STEP_ID_HEADER]: "step-ws-request" },
        body: JSON.stringify({ stream: true, api_key: "sk-request-secret" }),
      })
    );

    expect(consumeRedactedRequestBody("step-ws-request")).toEqual({
      stream: true,
      api_key: "[REDACTED]",
    });
  });

  test("enabled transport keeps non-streaming Responses posts on the base fetch", async () => {
    const baseBodies: string[] = [];
    const wsCalls: string[] = [];
    const baseFetch = createTestFetch((_input: RequestInfo | URL, init?: RequestInit) => {
      baseBodies.push(typeof init?.body === "string" ? init.body : "");
      return Promise.resolve(new Response("base"));
    });
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch,
      createWebSocketFetch: () =>
        createTestWebSocketFetch((input: RequestInfo | URL) => {
          wsCalls.push(getFetchInputUrl(input));
          return Promise.resolve(new Response("ws"));
        }),
    });

    const streamFalse = await transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: false }),
    });
    const streamAbsent = await transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(await streamFalse.text()).toBe("base");
    expect(await streamAbsent.text()).toBe("base");
    expect(baseBodies).toEqual([JSON.stringify({ stream: false }), JSON.stringify({})]);
    expect(wsCalls).toEqual([]);
  });

  test("enabled transport recognizes streaming Responses Request objects", async () => {
    const wsCalls: string[] = [];
    let webSocketHeaders: Headers | undefined;
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      createWebSocketFetch: () =>
        createTestWebSocketFetch((input: RequestInfo | URL, init?: RequestInit) => {
          wsCalls.push(getFetchInputUrl(input));
          webSocketHeaders = new Headers(init?.headers);
          return Promise.resolve(new Response("ws"));
        }),
    });
    const request = new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer request-key" },
      body: JSON.stringify({ stream: true }),
    });

    const response = await transport.fetch(request);

    expect(await response.text()).toBe("ws");
    expect(wsCalls).toEqual(["https://api.openai.com/v1/responses"]);
    expect(webSocketHeaders?.get("authorization")).toBe("Bearer request-key");
  });

  test("enabled transport recognizes Responses URLs with query parameters", async () => {
    const wsCalls: string[] = [];
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      createWebSocketFetch: () =>
        createTestWebSocketFetch((input: RequestInfo | URL) => {
          wsCalls.push(getFetchInputUrl(input));
          return Promise.resolve(new Response("ws"));
        }),
    });

    const response = await transport.fetch("https://api.openai.com/v1/responses?beta=2", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });

    expect(await response.text()).toBe("ws");
    expect(wsCalls).toEqual(["https://api.openai.com/v1/responses?beta=2"]);
  });

  test("close retries after a connection-establishment race", async () => {
    let closeCalls = 0;
    let resolveWebSocketFetch: ((response: Response) => void) | undefined;
    const webSocketFetchPromise = new Promise<Response>((resolve) => {
      resolveWebSocketFetch = resolve;
    });
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      createWebSocketFetch: () =>
        createTestWebSocketFetch(
          () => webSocketFetchPromise,
          () => {
            closeCalls += 1;
          }
        ),
    });

    const responsePromise = transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });
    await Promise.resolve();
    transport.close();
    if (!resolveWebSocketFetch) {
      throw new Error("Expected test WebSocket fetch resolver to be initialized");
    }
    resolveWebSocketFetch(new Response("ws"));

    expect(await (await responsePromise).text()).toBe("ws");
    expect(closeCalls).toBe(2);
  });

  test("close retry failure does not mask a resolved WebSocket response", async () => {
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      createWebSocketFetch: () =>
        createTestWebSocketFetch(
          () => Promise.resolve(new Response("ws")),
          () => {
            throw new Error("close failed");
          }
        ),
    });

    const responsePromise = transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });
    await Promise.resolve();
    expect(() => transport.close()).toThrow("close failed");

    expect(await (await responsePromise).text()).toBe("ws");
  });

  test("close is idempotent after WebSocket fetch creation", async () => {
    let closeCalls = 0;
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      createWebSocketFetch: () =>
        createTestWebSocketFetch(
          () => Promise.resolve(new Response("ws")),
          () => {
            closeCalls += 1;
          }
        ),
    });

    await transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });
    transport.close();
    transport.close();

    expect(closeCalls).toBe(1);
  });
});
