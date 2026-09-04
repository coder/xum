import { EnvHttpProxyAgent, type Dispatcher } from "undici";
import { SERVER_UPDATE_CHECK_TIMEOUT_MS } from "@/constants/serverUpdate";
import { isExactVersion } from "./installLayout";

const dispatcher = new EnvHttpProxyAgent();

export async function fetchDistTags(
  registry: string,
  request: (url: string, options: RequestInit) => Promise<Response> = fetch
): Promise<{ latest?: string; next?: string }> {
  const options: RequestInit & { dispatcher: Dispatcher } = {
    dispatcher,
    signal: AbortSignal.timeout(SERVER_UPDATE_CHECK_TIMEOUT_MS),
  };
  const response = await request(`${registry}/-/package/@coder%2Fxum/dist-tags`, options);
  if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`);
  const tags: unknown = await response.json();
  if (!tags || typeof tags !== "object") throw new Error("Invalid registry dist-tags response");
  return {
    latest: "latest" in tags && isExactVersion(tags.latest) ? tags.latest : undefined,
    next: "next" in tags && isExactVersion(tags.next) ? tags.next : undefined,
  };
}
