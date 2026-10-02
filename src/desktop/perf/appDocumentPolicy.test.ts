import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Session } from "electron";
import { installFileDocumentPolicy } from "./appDocumentPolicy";
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
