import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Session } from "electron";
import { installDevServerDocumentPolicy, installFileDocumentPolicy } from "./appDocumentPolicy";
import { JS_CALL_STACKS_DOCUMENT_POLICY } from "./hangStacks";

type FileHandler = (request: Request) => Promise<Response>;

// Minimal stand-in for the two Session members the file handler uses. `fetch` plays
// Chromium's built-in file handler: it returns a canned response for any URL.
function createFakeSession(builtIn: (url: string) => Response) {
  const handlers: FileHandler[] = [];
  const fetchInits: unknown[] = [];
  const session = {
    protocol: {
      handle: (scheme: string, handler: FileHandler) => {
        expect(scheme).toBe("file");
        handlers.push(handler);
      },
    },
    fetch: (request: Request, init: unknown) => {
      fetchInits.push(init);
      return Promise.resolve(builtIn(request.url));
    },
  };
  return { session: session as unknown as Session, handlers, fetchInits };
}

describe("installFileDocumentPolicy", () => {
  const htmlPath = path.resolve("/opt/xum/dist/index.html");

  test("adds Document-Policy to the app page only and keeps the rest of the response", async () => {
    const fake = createFakeSession(
      (url) =>
        new Response(`body of ${url}`, {
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "text/html", "X-Existing": "kept" },
        })
    );
    installFileDocumentPolicy(fake.session, htmlPath);
    expect(fake.handlers).toHaveLength(1);
    const handler = fake.handlers[0];

    const pageUrl = pathToFileURL(htmlPath).href;
    const page = await handler(new Request(pageUrl));
    expect(page.status).toBe(200);
    expect(page.headers.get("Document-Policy")).toBe(JS_CALL_STACKS_DOCUMENT_POLICY);
    expect(page.headers.get("Content-Type")).toBe("text/html");
    expect(page.headers.get("X-Existing")).toBe("kept");
    expect(await page.text()).toBe(`body of ${pageUrl}`);

    const asset = await handler(new Request(pathToFileURL(path.resolve("/opt/xum/dist/app.js"))));
    expect(asset.headers.get("Document-Policy")).toBeNull();

    // Every request is forwarded to the built-in handler, never back into this one.
    expect(fake.fetchInits).toEqual([
      { bypassCustomProtocolHandlers: true },
      { bypassCustomProtocolHandlers: true },
    ]);
  });

  test("registers the file handler once per session", () => {
    const fake = createFakeSession(() => new Response(""));
    installFileDocumentPolicy(fake.session, htmlPath);
    installFileDocumentPolicy(fake.session, htmlPath);
    expect(fake.handlers).toHaveLength(1);
  });
});

type HeadersListener = (
  details: { url: string; responseHeaders?: Record<string, string | string[]> },
  callback: (response: { responseHeaders?: Record<string, string | string[]> }) => void
) => void;

// Stand-in for `session.webRequest`: records each registration. Electron itself applies
// the filter, so the test checks the filter and calls the listener directly.
function createFakeWebRequestSession() {
  const registrations: Array<{ filter: { types?: string[] }; listener: HeadersListener }> = [];
  const session = {
    webRequest: {
      onHeadersReceived: (filter: { types?: string[] }, listener: HeadersListener) => {
        registrations.push({ filter, listener });
      },
    },
  };
  return { session: session as unknown as Session, registrations };
}

function callListener(
  listener: HeadersListener,
  url: string,
  responseHeaders: Record<string, string | string[]>
) {
  let response: { responseHeaders?: Record<string, string | string[]> } | undefined;
  listener({ url, responseHeaders }, (value) => {
    response = value;
  });
  return response;
}

describe("installDevServerDocumentPolicy", () => {
  const devServerUrl = "http://127.0.0.1:5173";

  test("adds Document-Policy to dev-server main frames only and keeps CSP", () => {
    const fake = createFakeWebRequestSession();
    installDevServerDocumentPolicy(fake.session, devServerUrl);
    installDevServerDocumentPolicy(fake.session, devServerUrl);
    // Electron keeps one listener per session; a second registration would replace it.
    expect(fake.registrations).toHaveLength(1);
    const { filter, listener } = fake.registrations[0];
    expect(filter.types).toEqual(["mainFrame"]);

    const csp = ["default-src 'self'"];
    expect(
      callListener(listener, `${devServerUrl}/index.html`, { "Content-Security-Policy": csp })
    ).toEqual({
      responseHeaders: {
        "Content-Security-Policy": csp,
        "Document-Policy": JS_CALL_STACKS_DOCUMENT_POLICY,
      },
    });
    // Other origins (e.g. a remote-server window on the same session) pass through.
    expect(
      callListener(listener, "http://127.0.0.1:3000/", { "Content-Security-Policy": csp })
    ).toEqual({});
  });
});
