import type { RemoteConnectionApi } from "@/common/types/remoteConnection";

export const REMOTE_CONNECTION_SETTINGS_SECTION = "remote-connection";

/**
 * Open (or focus) the window for the xum server running on this Xum root (#4846). Shared by the
 * shortcut, the command palette, and the native menu. When no window could be shown, open
 * Settings → Remote Connection: the bridge state there explains why (no server, another server's
 * window, a failed load) and offers the URL form.
 */
export async function openServerWindow(
  bridge: RemoteConnectionApi,
  openSettings: (section: string) => void
): Promise<void> {
  const result = await bridge.openLocalServer().catch(() => ({ status: "unavailable" as const }));
  if (result.status !== "shown") openSettings(REMOTE_CONNECTION_SETTINGS_SECTION);
}
