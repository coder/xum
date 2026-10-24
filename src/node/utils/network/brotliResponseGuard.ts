/**
 * Stopgap for CVE-2026-111497 (#7358). Electron 44.5.1 bundles Node 24.21.0, and fetch decodes a
 * `Content-Encoding: br` response with that Node's Brotli decoder, which crafted data can exploit.
 * Until Electron bundles a fixed Node, outbound requests ask for gzip or deflate only, and a Brotli
 * response is refused before fetch decodes it. Refusing inside the decoder instead leaves the fetch
 * hanging. Off on Bun (its fetch has its own decoder and ignores dispatchers) and on fixed Node.
 */
// Real undici under Bun too (the bare specifier is Bun's shim), so the tests run this code.
import { DecoratorHandler, getGlobalDispatcher, setGlobalDispatcher } from "undici/index.js";
import type { Dispatcher } from "undici/index.js";
import { log } from "@/node/services/log";
import { nodeHasBrotliFix } from "@/node/utils/nodeBrotliFix";

type HeaderValue = string | string[] | undefined;

function codings(value: HeaderValue): string[] {
  const joined = Array.isArray(value) ? value.join(",") : (value ?? "");
  return joined
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** Drops `br` and the `*` wildcard (which allows `br`); "identity" when nothing else is left. */
function acceptEncodingWithoutBrotli(value: HeaderValue): HeaderValue {
  if (value === undefined) return value;
  const kept = codings(value).filter((part) => {
    const coding = part.split(";")[0].trim().toLowerCase();
    return coding !== "br" && coding !== "*";
  });
  return kept.length > 0 ? kept.join(", ") : "identity";
}

// fetch passes its headers as a plain object. Other forms pass through unchanged: a Brotli reply
// to them is still refused, it just fails the request.
function headersWithoutBrotli(
  headers: Dispatcher.DispatchOptions["headers"]
): Dispatcher.DispatchOptions["headers"] {
  if (headers == null || Array.isArray(headers) || Symbol.iterator in headers) return headers;
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) =>
      name.toLowerCase() === "accept-encoding"
        ? [name, acceptEncodingWithoutBrotli(value)]
        : [name, value]
    )
  );
}

// undici's types declare DecoratorHandler without the handler methods it implements.
const Decorator: new (handler: Dispatcher.DispatchHandler) => Dispatcher.DispatchHandler =
  DecoratorHandler;

class RefuseBrotliHandler extends Decorator {
  onResponseStart(
    controller: Dispatcher.DispatchController,
    statusCode: number,
    headers: Record<string, HeaderValue>,
    statusMessage?: string
  ): void {
    if (codings(headers["content-encoding"]).some((coding) => coding.toLowerCase() === "br")) {
      controller.abort(new Error("Refused a Brotli-encoded response (CVE-2026-111497)"));
      return;
    }
    super.onResponseStart?.(controller, statusCode, headers, statusMessage);
  }
}

export const refuseBrotliResponses: Dispatcher.DispatcherComposeInterceptor =
  (dispatch) => (opts, handler) =>
    dispatch(
      { ...opts, headers: headersWithoutBrotli(opts.headers) },
      new RefuseBrotliHandler(handler)
    );

export function isBrotliResponseGuardNeeded(
  versions: Record<string, string | undefined> = process.versions
): boolean {
  if ("bun" in versions || versions.node === undefined) return false;
  return nodeHasBrotliFix(versions.node) !== true;
}

/** For a dispatcher that fetch gets through its `dispatcher` option, which bypasses the global one. */
export function guardAgainstBrotliResponses(dispatcher: Dispatcher): Dispatcher {
  return isBrotliResponseGuardNeeded() ? dispatcher.compose(refuseBrotliResponses) : dispatcher;
}

let installed = false;

/** Guards every fetch that uses the global dispatcher. Idempotent. */
export function installBrotliResponseGuard(): void {
  if (installed || !isBrotliResponseGuardNeeded()) return;
  installed = true;
  try {
    setGlobalDispatcher(getGlobalDispatcher().compose(refuseBrotliResponses));
  } catch (error) {
    // Startup must not fail over this: any code can replace the global dispatcher.
    log.error("Could not guard the global fetch dispatcher against Brotli responses:", error);
  }
}
