import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Session } from "electron";
import { type AppPage, installAppDocumentPolicy } from "./appDocumentPolicy";
import { JS_CALL_STACKS_DOCUMENT_POLICY } from "./hangStacks";

type ResponseHeaders = Record<string, string | string[]>;
type HeadersListener = (
  details: { url: string; responseHeaders?: ResponseHeaders },
  callback: (response: { responseHeaders?: ResponseHeaders }) => void
) => void;

// Stand-in for `session.webRequest`. Like Electron, it keeps one onHeadersReceived
// listener per session (registering again replaces it). Electron applies the filter
// natively, so the tests check the filter and call the listener directly.
function createFakeWebRequestSession() {
  let registration:
    | { filter: { urls: string[]; types?: string[] }; listener: HeadersListener }
    | undefined;
  const session = {
    webRequest: {
      onHeadersReceived: (
        filter: { urls: string[]; types?: string[] },
        listener: HeadersListener
      ) => {
        registration = { filter, listener };
      },
    },
  };
  return { session: session as unknown as Session, getRegistration: () => registration };
}

function install(appPage: AppPage): HeadersListener {
  const fake = createFakeWebRequestSession();
  installAppDocumentPolicy(fake.session, appPage);
  // createWindow can run again on the same session (macOS activate); the active listener
  // must still be the app-page one.
  installAppDocumentPolicy(fake.session, appPage);
  const registration = fake.getRegistration();
  if (registration === undefined) {
    throw new Error("installAppDocumentPolicy registered no onHeadersReceived listener");
  }
  // The native type filter keeps subresource loads out of the JS callback.
  expect(registration.filter.types).toEqual(["mainFrame"]);
  return registration.listener;
}

function callListener(listener: HeadersListener, url: string, responseHeaders: ResponseHeaders) {
  let response: { responseHeaders?: ResponseHeaders } | undefined;
  listener({ url, responseHeaders }, (value) => {
    response = value;
  });
  return response;
}

const csp = ["default-src 'self'"];
const withPolicy = {
  responseHeaders: {
    "Content-Security-Policy": csp,
    "Document-Policy": JS_CALL_STACKS_DOCUMENT_POLICY,
  },
};

describe("installAppDocumentPolicy", () => {
  test("adds Document-Policy to the app index.html only and keeps CSP", () => {
    const htmlPath = path.resolve("/opt/xum/dist/index.html");
    const listener = install({ kind: "file", path: htmlPath });

    expect(
      callListener(listener, pathToFileURL(htmlPath).href, { "Content-Security-Policy": csp })
    ).toEqual(withPolicy);
    for (const url of [
      // Another local file (e.g. a different window's page).
      pathToFileURL(path.resolve("/opt/xum/dist/other.html")).href,
      // Same path on a remote host is not the local app page.
      "file://remote-host/opt/xum/dist/index.html",
      "http://127.0.0.1:5173/index.html",
    ]) {
      expect(callListener(listener, url, { "Content-Security-Policy": csp })).toEqual({});
    }
  });

  test("adds Document-Policy to dev-server documents only and keeps CSP", () => {
    const devServerUrl = "http://127.0.0.1:5173";
    const listener = install({ kind: "devServer", url: devServerUrl });

    expect(
      callListener(listener, `${devServerUrl}/index.html`, { "Content-Security-Policy": csp })
    ).toEqual(withPolicy);
    // Other origins (e.g. a remote-server window on the same session) pass through.
    expect(
      callListener(listener, "http://127.0.0.1:3000/", { "Content-Security-Policy": csp })
    ).toEqual({});
  });
});
