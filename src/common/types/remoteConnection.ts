import { getAppProxyBasePathFromPathname } from "@/common/appProxyBasePath";

/** Local desktop controls. Remote pages never receive this bridge. */
export interface RemoteConnectionApi {
  getState(): Promise<RemoteConnectionState>;
  connect(url: string): Promise<void>;
  disconnect(): Promise<void>;
  onStateChanged(callback: (state: RemoteConnectionState) => void): () => void;
  /** Open or focus a window for the xum server holding this root's server.lock. */
  openLocalServer(): Promise<OpenLocalServerResult>;
  /** The native menu asks the local window to run its Open Server Window flow. */
  onOpenServerWindowRequested(callback: () => void): () => void;
}

/** Never carries the server token. On "unavailable", RemoteConnectionState.error explains why. */
export type OpenLocalServerResult = { status: "shown" } | { status: "unavailable" };

export interface RemoteConnectionState {
  /** The server base URL retains its app-proxy path but excludes credentials and URL tokens. */
  serverUrl: string | null;
  status: "disconnected" | "connecting" | "connected";
  error?: string;
}

/** Validate a server address before opening remote content. */
export function parseRemoteConnectionUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter a valid HTTP or HTTPS server URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Use an HTTP or HTTPS server URL.");
  }
  if (url.username || url.password) {
    throw new Error("Remove the username and password from the server URL.");
  }
  return url;
}

/** Keep path-mounted servers distinct without retaining token links or page fragments. */
export function getRemoteConnectionServerUrl(input: string): string {
  const url = parseRemoteConnectionUrl(input);
  const pathname = getAppProxyBasePathFromPathname(url.pathname) ?? url.pathname;
  return url.origin + pathname.replace(/\/+$/, "");
}
