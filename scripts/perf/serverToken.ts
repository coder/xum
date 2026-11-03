import { randomBytes } from "node:crypto";

/**
 * A perf server listens on loopback, which every local account can reach, so it starts with a token
 * (the server reads `XUM_SERVER_AUTH_TOKEN`) instead of `--no-auth`. Pass it in the environment only:
 * command lines are readable by every local account.
 */
export function newServerToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * `url` with the `?token=` that the app and the static views read. Use it to navigate only: it must
 * not reach a log or a result file, so record the URL without it.
 */
export function withServerToken(url: string, token: string): string {
  const withToken = new URL(url);
  withToken.searchParams.set("token", token);
  return withToken.href;
}
