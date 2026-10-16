/**
 * Node worker thread (not a browser worker) for `xum server`: renders static workspace view row
 * trees with the live markdown components (renderRowTree). It runs off the main thread because
 * loading React, Streamdown and the components takes about 450 ms, and esbuild bundles it into
 * dist/workers because tsconfig.main cannot compile these browser modules (CSS, import.meta).
 * rowTreeClient.ts is the only caller. Protocol: posts "ready" once loaded, then answers each
 * `{ id, rows }` with `{ id, trees }`.
 */
import assert from "node:assert";
import { parentPort } from "node:worker_threads";
import { renderRowTree } from "@/browser/features/Messages/staticRowTree";

const port = parentPort;
assert(port, "staticRowTree.worker must run in a worker thread");
port.on("message", (message: { id: number; rows: Array<{ text: string; isUser: boolean }> }) => {
  const trees = message.rows.map((row) => {
    try {
      return renderRowTree(row.text, row.isUser);
    } catch {
      return null; // one bad row gives no view for that row, not for the batch
    }
  });
  port.postMessage({ id: message.id, trees });
});
port.postMessage("ready");
