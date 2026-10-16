import type { IncomingHttpHeaders } from "node:http";
import type { RowTreeClient } from "@/node/orpc/staticWorkspaceView/rowTreeClient";
import { log } from "@/node/services/log";

/**
 * Whether a page request looks like a phone, the only device the static view draws on. A false
 * positive only starts the row-tree worker early. Browsers send Sec-CH-UA-Mobile only to secure
 * origins, so `xum server` over plain http on a LAN depends on the User-Agent: "Mobi" is MDN's
 * rule, in iPhone and Android phone agents but not in Android tablet ones.
 */
export function isPhoneRequest(headers: IncomingHttpHeaders): boolean {
  return headers["sec-ch-ua-mobile"] === "?1" || (headers["user-agent"] ?? "").includes("Mobi");
}

/**
 * Called by the SPA fallback after it sent a page. A phone's static view reads the row trees about
 * one round trip after its workspace page, sooner than the worker's cold load (about 300 ms), so
 * the page starts the worker. Signed-in requests only: the page needs no auth, and the worker
 * costs about 170 MB. It never throws and never delays the page: errors are only logged.
 */
export function warmRowTreesForPage(page: {
  isWorkspaceRoute: boolean;
  headers: IncomingHttpHeaders;
  client: Pick<RowTreeClient, "warm"> | undefined;
  isSignedIn: () => Promise<boolean>;
}): void {
  const client = page.client;
  if (!page.isWorkspaceRoute || !client || !isPhoneRequest(page.headers)) return;
  page
    .isSignedIn()
    .then((signedIn) => {
      if (signedIn) client.warm();
    })
    .catch((error: unknown) => log.warn("Static view row-tree warm-up failed:", error));
}
