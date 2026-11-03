import { randomBytes } from "node:crypto";
import { assignXumEnvironmentValue, type XumEnvironment } from "../../src/common/compat/xumEnv";

/**
 * A perf server listens on loopback, which every local account can reach, so it starts with a token
 * (the server reads `XUM_SERVER_AUTH_TOKEN`) instead of `--no-auth`. Pass it in the environment only:
 * command lines are readable by every local account.
 */
export function newServerToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * The environment entries that hand `token` to a server. The `--tree` benchmarks also start built
 * trees from before the MUX_ to XUM_ rename, which read only `MUX_SERVER_AUTH_TOKEN`, so this
 * writes both names through the shared compat helper.
 */
export function serverTokenEnv(token: string): XumEnvironment {
  const env: XumEnvironment = {};
  assignXumEnvironmentValue(env, "SERVER_AUTH_TOKEN", token);
  return env;
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
