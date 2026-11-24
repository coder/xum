import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import path from "node:path";
import { MCP_ICON_LIMITS } from "@/common/constants/mcpIcon";
import { isPngDataUrl } from "@/common/utils/mcp/pngDataUrl";

function workerEntry(): string {
  // Docker bundles services into one entry, with the worker beside it. Normal
  // Node/Electron builds preserve src/node's directory layout instead.
  if (path.basename(__filename) === "server-bundle.js")
    return path.join(__dirname, "mcpIconDecode.js");
  if (path.extname(__filename) === ".ts") {
    return "isBun" in process
      ? path.join(__dirname, "../workers/mcpIconDecode.ts")
      : path.resolve(__dirname, "../../../dist/node/workers/mcpIconDecode.js");
  }
  return path.join(__dirname, "../workers/mcpIconDecode.js");
}

/** The caller holds its concurrency slot until this promise settles on child exit. */
export function decodeMcpIcon(
  bytes: Buffer,
  mimeTypes: string[],
  signal: AbortSignal,
  spawn: (entry: string, options: ForkOptions) => ChildProcess = fork
): Promise<string | null> {
  if (signal.aborted || bytes.length === 0 || bytes.length > MCP_ICON_LIMITS.bodyMaxBytes)
    return Promise.resolve(null);
  return new Promise((resolve) => {
    let result: string | null = null;
    let child: ChildProcess;
    try {
      child = spawn(workerEntry(), {
        execPath: process.execPath,
        execArgv: [],
        // Never forward credentials, NODE_OPTIONS, preload hooks, or proxy settings
        // into the native decoder. Windows needs its system directory for DLLs.
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          UV_THREADPOOL_SIZE: "1",
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "json",
      });
    } catch {
      resolve(null);
      return;
    }
    let stopping = false;
    const abort = () => {
      if (stopping) return;
      stopping = true;
      result = null;
      child.kill("SIGKILL");
    };
    child.on("message", (message: unknown) => {
      result = isPngDataUrl(message) ? message : null;
    });
    child.once("exit", (code) => {
      signal.removeEventListener("abort", abort);
      resolve(code === 0 && !stopping && !signal.aborted ? result : null);
    });
    child.on("error", () => {
      abort();
      // A failed spawn has no process and no exit event to await.
      if (child.pid === undefined) {
        signal.removeEventListener("abort", abort);
        resolve(null);
      }
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else {
      try {
        child.send({ base64: bytes.toString("base64"), mimeTypes }, (error) => {
          if (error) abort();
        });
      } catch {
        abort();
      }
    }
  });
}
