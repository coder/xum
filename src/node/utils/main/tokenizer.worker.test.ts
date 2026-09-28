import { describe, expect, test } from "@jest/globals";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Tokenizer, models, type Encoding } from "ai-tokenizer";

import type { TokenizerWorkerData } from "./tokenizer.worker";

interface WorkerReply {
  messageId: number;
  result?: unknown;
  error?: { message: string };
}

describe("tokenizer worker", () => {
  test("answers requests posted before its encoding finished loading, and survives a misroute", async () => {
    const workerData: TokenizerWorkerData = { encoding: "claude" };
    const worker = new Worker(join(__dirname, "tokenizer.worker.ts"), { workerData });
    try {
      const replies = new Map<number, WorkerReply>();
      const waiters = new Map<number, (reply: WorkerReply) => void>();
      worker.on("message", (reply: WorkerReply) => {
        replies.set(reply.messageId, reply);
        waiters.get(reply.messageId)?.(reply);
      });
      const workerFailure = new Promise<never>((_, reject) => {
        worker.once("error", reject);
      });
      const post = (messageId: number, taskName: string, data: unknown): Promise<WorkerReply> => {
        const reply = new Promise<WorkerReply>((resolve) => waiters.set(messageId, resolve));
        worker.postMessage({ messageId, taskName, data });
        return Promise.race([reply, workerFailure]);
      };

      const claudeModels = [
        "anthropic/claude-3-haiku",
        "anthropic/claude-3.7-sonnet",
        "anthropic/claude-opus-4",
        "anthropic/claude-sonnet-4.5",
        "anthropic/claude-3.5-haiku",
      ];
      // The misroute below only exercises the routing guard if its model exists and uses
      // another encoding (otherwise the unknown-model guard would reject it instead).
      expect(models["openai/gpt-5"].encoding).not.toBe(workerData.encoding);
      const texts = ["", "hello world", "function f() {\n  return 1;\n}", "漢字 🙂 <|endoftext|>"];

      // Everything below is posted synchronously after spawning, i.e. while the worker is still
      // evaluating its encoding: none of it may be dropped or answered with the wrong encoding.
      const counts = claudeModels.map((modelName, i) =>
        post(i, "countTokensBatch", { modelName, inputs: texts })
      );
      const ready = post(100, "ready", "anthropic/claude-sonnet-4.5");
      const misrouted = post(101, "countTokensBatch", { modelName: "openai/gpt-5", inputs: ["x"] });

      // The worker loads the same module; the barrel re-exports this object unchanged.
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- oracle for the worker's own encoding
      const oracle = new Tokenizer(require("ai-tokenizer/encoding/claude") as Encoding);
      const expected = texts.map((text) => oracle.encode(text, [], []).length);

      for (const reply of await Promise.all(counts)) {
        expect(reply).toEqual({ messageId: reply.messageId, result: expected });
      }
      expect(await ready).toEqual({ messageId: 100, result: "claude" });
      const misrouteReply = await misrouted;
      expect(misrouteReply.result).toBeUndefined();
      expect(misrouteReply.error?.message).toContain("openai/gpt-5");

      // Still serving after the misroute error.
      expect(
        await post(102, "countTokensBatch", {
          modelName: "anthropic/claude-3-haiku",
          inputs: texts,
        })
      ).toEqual({ messageId: 102, result: expected });
      expect(replies.size).toBe(claudeModels.length + 3);
    } finally {
      await worker.terminate();
    }
  }, 120_000);
});
