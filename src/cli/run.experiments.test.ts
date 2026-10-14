import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";

const BUN_EXECUTABLE = process.execPath;
const INDEX_ENTRY = path.join(import.meta.dir, "index.ts");
const MOCK_PROVIDER = "local-mock";
const MOCK_MODEL = "mock-model";

interface ChatRequest {
  tools?: Array<{ function?: { name?: string } }>;
}

describe("xum run experiments", () => {
  test("-e programmatic-tool-calling gives the model code_execution", async () => {
    using tmp = new DisposableTempDir("run-experiments");
    const repo = path.join(tmp.path, "repo");
    const xumRoot = path.join(tmp.path, "xum-root");
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(xumRoot, { recursive: true });

    const toolSets: string[][] = [];
    const fixture = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (data: Buffer) => chunks.push(data));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
        toolSets.push((body.tools ?? []).flatMap((tool) => tool.function?.name ?? []));
        const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
          `data: ${JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
            created: 1,
            model: MOCK_MODEL,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`;
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(chunk({ role: "assistant", content: "done" }, null));
        response.write(chunk({}, "stop"));
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
      await fs.writeFile(
        path.join(xumRoot, "providers.jsonc"),
        JSON.stringify({
          [MOCK_PROVIDER]: {
            providerType: "openai-compatible",
            baseUrl: `${origin}/v1`,
            models: [{ id: MOCK_MODEL, mappedToModel: "anthropic:claude-haiku-4-5" }],
          },
        }),
        "utf-8"
      );
      const run =
        await Bun.$`${BUN_EXECUTABLE} ${INDEX_ENTRY} run --dir ${repo} --model ${`${MOCK_PROVIDER}:${MOCK_MODEL}`} -e programmatic-tool-calling --json ${"Say done"}`
          .env({ ...process.env, XUM_ROOT: xumRoot, MUX_ROOT: xumRoot, NO_COLOR: "1" })
          .nothrow()
          .quiet();
      expect(run.exitCode).toBe(0);
      const agentTools = toolSets.find((tools) => tools.length > 0);
      expect(agentTools).toContain("code_execution");
    } finally {
      fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  }, 90_000);
});
