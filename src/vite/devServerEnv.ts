import { isIP } from "node:net";

import { resolveXumEnvironmentValue, type XumEnvironment } from "../common/compat/xumEnv";

export const DEFAULT_VITE_DEV_HOST = "127.0.0.1";
export const DEFAULT_VITE_DEV_PORT = 5173;
export const DEFAULT_VITE_PREVIEW_PORT = 4173;
export const DEFAULT_BACKEND_PROXY_HOST = "127.0.0.1";
export const DEFAULT_BACKEND_PROXY_PORT = 3000;

export interface ViteDevServerEnv {
  host: string;
  port: number;
  allowedHosts: true | string[];
  previewPort: number;
  backendHost: string;
  backendPort: number;
  /**
   * Unix socket of the backend, when `make dev-server` started it with `--unix-socket`. The proxy
   * then never uses the backend's TCP port: any local account can bind that port while the backend
   * restarts, and the browser's reconnect URL carries the token.
   */
  backendSocket: string | undefined;
  enableTutorialsInSandbox: string | undefined;
}

function parsePort(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseAllowedHosts(raw: string | undefined, host: string): true | string[] {
  const trimmed = raw?.trim();
  if (trimmed) {
    if (trimmed === "true" || trimmed === "all") {
      // Explicit opt-in only: this turns off Vite's DNS-rebinding Host check.
      return true;
    }

    const parsed = trimmed
      .split(",")
      .map((candidate) => candidate.trim())
      .filter(Boolean);

    return parsed.length ? parsed : ["localhost", "127.0.0.1"];
  }

  const defaults = ["localhost", "127.0.0.1"];
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "0.0.0.0" && host !== "::") {
    defaults.push(host);
  }

  return defaults;
}

/**
 * Same rules as Vite 7's `server.allowedHosts` check: loopback names and IP addresses always pass
 * (an IP cannot be DNS-rebound), anything else must be listed, and a "." prefix matches that name
 * and its subdomains. Vite applies its check to HTTP requests and its own HMR socket, but not to
 * WebSocket upgrades that its proxy forwards, so vite.config.ts calls this from the proxy `bypass`.
 * Stricter than Vite in one case: a missing Host is refused, because every browser sends one.
 */
export function isDevServerHostAllowed(
  hostHeader: string | undefined,
  allowedHosts: true | string[]
): boolean {
  if (allowedHosts === true) {
    return true;
  }
  if (hostHeader === undefined) {
    return false;
  }

  const host = hostHeader.trim();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end > 0 && isIP(host.slice(1, end)) === 6;
  }

  const hostname = host.split(":")[0];
  if (isIP(hostname) === 4 || hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }
  return allowedHosts.some(
    (allowed) =>
      allowed === hostname ||
      (allowed.startsWith(".") && (allowed.slice(1) === hostname || hostname.endsWith(allowed)))
  );
}

/** Resolve Vite/dev-server env with XUM_* winning over leftover MUX_* aliases. */
export function resolveViteDevServerEnv(env: XumEnvironment): ViteDevServerEnv {
  const host = resolveXumEnvironmentValue("VITE_HOST", env) ?? DEFAULT_VITE_DEV_HOST;
  const port = parsePort(resolveXumEnvironmentValue("VITE_PORT", env), DEFAULT_VITE_DEV_PORT);
  const previewPort = parsePort(
    resolveXumEnvironmentValue("VITE_PREVIEW_PORT", env),
    DEFAULT_VITE_PREVIEW_PORT
  );
  const backendSocket = resolveXumEnvironmentValue("BACKEND_SOCKET", env);
  const backendHost = resolveXumEnvironmentValue("BACKEND_HOST", env) ?? DEFAULT_BACKEND_PROXY_HOST;
  const backendPort = parsePort(
    resolveXumEnvironmentValue("BACKEND_PORT", env),
    DEFAULT_BACKEND_PROXY_PORT
  );

  return {
    host,
    port,
    allowedHosts: parseAllowedHosts(resolveXumEnvironmentValue("VITE_ALLOWED_HOSTS", env), host),
    previewPort,
    backendHost,
    backendPort,
    // A blank value (a recipe that exports it empty) is no socket. A path is never trimmed: the
    // backend listens on the value as make exported it, so Vite must connect to the same bytes.
    backendSocket: backendSocket?.trim() === "" ? undefined : backendSocket,
    enableTutorialsInSandbox: resolveXumEnvironmentValue("ENABLE_TUTORIALS_IN_SANDBOX", env),
  };
}
