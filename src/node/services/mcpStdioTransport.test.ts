import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { MCPStdioTransport } from "./mcpStdioTransport";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("MCPStdioTransport.close", () => {
  // #4760: workspace removal stops MCP servers before deleting the checkout. A server that
  // ignores stdin EOF must still be gone once close() returns.
  test("kills a server that ignores stdin EOF and joins its exit", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-close-"));
    try {
      const pidFile = path.join(tempDir, "server.pid");
      const processAbort = new AbortController();
      const execStream = await createRuntime({ type: "local", srcBaseDir: tempDir }).exec(
        `echo $$ > "${pidFile}"; exec sleep 30`,
        { cwd: tempDir, timeout: 60, abortSignal: processAbort.signal }
      );
      const transport = new MCPStdioTransport(execStream, { kill: () => processAbort.abort() });
      await transport.start();

      const deadline = Date.now() + 5000;
      let pidText = "";
      while (pidText === "" && Date.now() < deadline) {
        pidText = await fsPromises.readFile(pidFile, "utf8").catch(() => "");
        if (pidText === "") await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const pid = Number.parseInt(pidText.trim(), 10);
      expect(pid).toBeGreaterThan(1);

      await transport.close();

      const alive = isAlive(pid);
      if (alive) process.kill(pid, "SIGKILL");
      expect(alive).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15000);
});
