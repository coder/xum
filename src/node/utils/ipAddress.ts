import * as net from "node:net";
import assert from "@/common/utils/assert";

/**
 * The IP version of a literal address: 4, 6, or 0 when `input` is not one.
 *
 * net.isIP is pure (no file, socket or DNS access), but agent-loop files may not import
 * `net` (local/no-host-imports, which cannot tell its pure helpers from sockets). Loop
 * code and its helpers take isIP from here instead.
 */
export function isIP(input: string): 0 | 4 | 6 {
  const version = net.isIP(input);
  assert(
    version === 0 || version === 4 || version === 6,
    `net.isIP returned an unknown IP version: ${version}`
  );
  return version;
}
