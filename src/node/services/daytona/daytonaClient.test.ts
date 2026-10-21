import { describe, expect, it } from "bun:test";
import { rememberDaytonaToken } from "@/node/runtime/daytonaTokenRedaction";
import { DaytonaApiError, DaytonaClient } from "./daytonaClient";

const API_URL = "https://daytona.test/api";
const API_KEY = "test-api-key-not-real";

interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeFetch(handler: (request: RecordedRequest) => Response | Promise<Response>): {
  fetch: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      url: new URL(input instanceof Request ? input.url : input.toString()),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    return handler(request);
  };
  return { fetch: impl as typeof fetch, requests };
}

async function captureError(promise: Promise<unknown>): Promise<DaytonaApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DaytonaApiError) return error;
    throw error;
  }
  throw new Error("expected a DaytonaApiError");
}

describe("DaytonaClient", () => {
  it("maps HTTP failures to typed errors with the server message, never echoing secrets", async () => {
    const cases = [
      { status: 401, message: "Invalid credentials", kind: "unauthorized" },
      { status: 403, message: "Forbidden", kind: "unauthorized" },
      { status: 404, message: "Sandbox not found", kind: "not_found" },
      { status: 400, message: "Snapshot has fixed resources", kind: "bad_request" },
      { status: 503, message: "Maintenance", kind: "server" },
    ] as const;
    for (const testCase of cases) {
      const { fetch } = fakeFetch(() =>
        jsonResponse(testCase.status, { statusCode: testCase.status, message: testCase.message })
      );
      const client = new DaytonaClient({ apiUrl: API_URL, apiKey: API_KEY, fetch });
      const error = await captureError(client.revokeSshAccess("sb-1", "secret-ssh-token"));
      expect(error.kind).toBe(testCase.kind);
      expect(error.status).toBe(testCase.status);
      expect(error.serverMessage).toBe(testCase.message);
      expect(error.message).toContain(testCase.message);
      expect(error.message).not.toContain(API_KEY);
      expect(error.message).not.toContain("secret-ssh-token");
    }
  });

  it("redacts the request's secrets that a failed response or fetch error echoes", async () => {
    // Characters a query string encodes, so an echoed request URI carries the token encoded.
    const token = "secret/ssh+token value";
    const echo = (request: RecordedRequest) =>
      `${request.method} ${request.url.toString()} ${request.headers.Authorization} ${token}`;
    const responses = [
      (request: RecordedRequest) => jsonResponse(400, { message: `Invalid: ${echo(request)}` }),
      (request: RecordedRequest) => new Response(`<p>${echo(request)}</p>`, { status: 502 }),
      (request: RecordedRequest) => jsonResponse(500, { message: [echo(request), "again"] }),
    ];
    const secrets = [token, encodeURIComponent(token), "secret%2Fssh%2Btoken+value", API_KEY];
    for (const respond of responses) {
      const { fetch } = fakeFetch(respond);
      const client = new DaytonaClient({ apiUrl: API_URL, apiKey: API_KEY, fetch });
      const error = await captureError(client.revokeSshAccess("sb-1", token));
      for (const secret of secrets) {
        expect(error.message).not.toContain(secret);
        expect(error.serverMessage ?? "").not.toContain(secret);
      }
      expect(error.message).toContain("DELETE /sandbox/sb-1/ssh-access");
    }

    // A fetch failure that names the request URL.
    const failingFetch = ((input: URL) =>
      Promise.reject(new TypeError(`fetch failed for ${input.href}`))) as typeof fetch;
    const failing = new DaytonaClient({ apiUrl: API_URL, apiKey: API_KEY, fetch: failingFetch });
    const transport = await captureError(failing.revokeSshAccess("sb-1", token));
    expect(transport.kind).toBe("unreachable");
    for (const secret of secrets) expect(transport.message).not.toContain(secret);

    // Any endpoint: a token minted earlier that another call's error echoes.
    rememberDaytonaToken("minted-earlier-token-q7z");
    const other = new DaytonaClient({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: fakeFetch(() => jsonResponse(500, { message: "user minted-earlier-token-q7z" })).fetch,
    });
    const otherError = await captureError(other.getSandbox("sb-1"));
    expect(otherError.message).not.toContain("minted-earlier-token-q7z");
  });

  it("reduces an HTML error page or a long message to a short plain-text excerpt", async () => {
    const page = `<!DOCTYPE html><html><head><style>body { color: red }</style></head><body>
      <h1>502 Bad Gateway</h1>
      <p>nginx</p></body></html>`;
    const htmlClient = new DaytonaClient({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: fakeFetch(() => new Response(page, { status: 502 })).fetch,
    });
    const htmlError = await captureError(htmlClient.listSandboxes());
    expect(htmlError.serverMessage).toBe("502 Bad Gateway nginx");

    const longClient = new DaytonaClient({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: fakeFetch(() => jsonResponse(500, { message: `<b>${"x".repeat(500)}</b>` })).fetch,
    });
    const longError = await captureError(longClient.listSandboxes());
    expect(longError.serverMessage).toBe(`${"x".repeat(200)}...`);
  });

  it("fails with a timeout error instead of hanging on a stuck control plane", async () => {
    const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
      })) as typeof fetch;
    const client = new DaytonaClient({
      apiUrl: API_URL,
      apiKey: API_KEY,
      fetch: hangingFetch,
      timeoutMs: 20,
    });
    const error = await captureError(client.getSandbox("sb-1"));
    expect(error.kind).toBe("timeout");
  });

  it("reports an unreachable control plane", async () => {
    const failingFetch = (() =>
      Promise.reject(new TypeError("fetch failed: ECONNREFUSED"))) as unknown as typeof fetch;
    const client = new DaytonaClient({ apiUrl: API_URL, apiKey: API_KEY, fetch: failingFetch });
    const error = await captureError(client.getSandbox("sb-1"));
    expect(error.kind).toBe("unreachable");
    expect(error.message).toContain("https://daytona.test");
  });

  it("refuses authenticated calls without a key, while /config stays public", async () => {
    const { fetch, requests } = fakeFetch(() =>
      jsonResponse(200, {
        sshGatewayHost: "ssh.daytona.test",
        sshGatewayPort: 2222,
        sshGatewayHostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample"],
        defaultSnapshot: "daytona-small",
      })
    );
    const client = new DaytonaClient({ apiUrl: `${API_URL}/`, fetch });
    expect(await client.getConfig()).toEqual({
      sshGatewayHost: "ssh.daytona.test",
      sshGatewayPort: 2222,
      sshGatewayHostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample"],
      defaultSnapshot: "daytona-small",
    });
    expect(requests[0].url.toString()).toBe("https://daytona.test/api/config");
    expect(requests[0].headers.Authorization).toBeUndefined();

    const error = await captureError(client.listSandboxes());
    expect(error.kind).toBe("not_configured");
    expect(requests).toHaveLength(1);
  });

  it("rejects a /config without an SSH gateway", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(200, { defaultSnapshot: "x" }));
    const client = new DaytonaClient({ apiUrl: API_URL, fetch });
    const error = await captureError(client.getConfig());
    expect(error.message).toContain("SSH gateway");
  });

  it("follows nextCursor across sandbox pages with the label filter on every page", async () => {
    const { fetch, requests } = fakeFetch((request) => {
      const cursor = request.url.searchParams.get("cursor");
      if (!cursor)
        return jsonResponse(200, { items: [{ id: "a" }, { id: "b" }], nextCursor: "c2" });
      if (cursor === "c2") return jsonResponse(200, { items: [{ id: "c" }], nextCursor: "c3" });
      return jsonResponse(200, { items: [], nextCursor: null });
    });
    const client = new DaytonaClient({ apiUrl: API_URL, apiKey: API_KEY, fetch });
    const sandboxes = await client.listSandboxes({ "xum.instance": "inst-1" });
    expect(sandboxes.map((sandbox) => sandbox.id)).toEqual(["a", "b", "c"]);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.headers.Authorization).toBe(`Bearer ${API_KEY}`);
      expect(JSON.parse(request.url.searchParams.get("labels") ?? "null")).toEqual({
        "xum.instance": "inst-1",
      });
    }
  });

  it("walks snapshot pages until totalPages", async () => {
    const { fetch, requests } = fakeFetch((request) => {
      const page = Number(request.url.searchParams.get("page"));
      return jsonResponse(200, {
        items: [{ name: `snap-${page}`, id: `id-${page}` }],
        total: 2,
        page,
        totalPages: 2,
      });
    });
    const client = new DaytonaClient({ apiUrl: API_URL, apiKey: API_KEY, fetch });
    expect(await client.listSnapshots()).toEqual([{ name: "snap-1" }, { name: "snap-2" }]);
    expect(requests).toHaveLength(2);
  });

  it("walks full snapshot pages when the totals are omitted, stopping on a short page", async () => {
    // 100 per page (the limit Xum asks for), then 3; totalPages is optional in the response.
    const { fetch, requests } = fakeFetch((request) => {
      const page = Number(request.url.searchParams.get("page"));
      const count = page === 1 ? 100 : page === 2 ? 3 : 0;
      const items = Array.from({ length: count }, (_, i) => ({ name: `snap-${page}-${i}` }));
      return jsonResponse(200, { items });
    });
    const client = new DaytonaClient({ apiUrl: API_URL, apiKey: API_KEY, fetch });
    const snapshots = await client.listSnapshots();
    expect(snapshots).toHaveLength(103);
    expect(snapshots.at(-1)).toEqual({ name: "snap-2-2" });
    expect(requests).toHaveLength(2);
  });

  it("stops at a full page that repeats the last one (a server that ignores page)", async () => {
    const { fetch, requests } = fakeFetch(() =>
      jsonResponse(200, {
        items: Array.from({ length: 100 }, (_, i) => ({ name: `snap-${i}` })),
      })
    );
    const client = new DaytonaClient({ apiUrl: API_URL, apiKey: API_KEY, fetch });
    expect(await client.listSnapshots()).toHaveLength(100);
    expect(requests).toHaveLength(2);
  });
});
