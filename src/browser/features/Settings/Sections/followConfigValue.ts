import type { APIClient } from "@/browser/contexts/API";

/** Load a config-backed value, and again after every config change, until `signal` aborts. */
export async function followConfigValue<T>(
  api: APIClient,
  signal: AbortSignal,
  read: (client: APIClient) => Promise<T>,
  onLoaded: (value: T) => void
): Promise<void> {
  const load = async () => {
    const value = await read(api);
    if (!signal.aborted) onLoaded(value);
  };
  // Load only once the subscription is live, so a change made during the load loads again.
  const changes = await api.config.onConfigChanged(undefined, { signal });
  await load();
  for await (const _ of changes) {
    await load();
  }
}
