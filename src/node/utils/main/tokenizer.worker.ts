import assert from "node:assert";
import { parentPort, workerData } from "node:worker_threads";
import { Tokenizer, models } from "ai-tokenizer";
import type { Encoding, Model, ModelName } from "ai-tokenizer";
import { getErrorMessage } from "@/common/utils/errors";

export type EncodingName = Model["encoding"];

export interface TokenizerWorkerData {
  encoding: EncodingName;
}

export interface CountTokensBatchInput {
  modelName: ModelName;
  inputs: string[];
}

// The barrel evaluates all four encodings (~14.5 s CPU on a loaded host; o200k_base alone ~10 s, #4816).
// Static specifiers keep evaluation lazy, and the Docker build (Makefile TOKENIZER_ENCODINGS) swaps
// each for its own bundle next to the worker bundle.
/* eslint-disable @typescript-eslint/no-require-imports -- lazy require: only this worker's encoding is evaluated */
const ENCODING_LOADERS: Record<EncodingName, () => Encoding> = {
  claude: () => require("ai-tokenizer/encoding/claude") as Encoding,
  o200k_base: () => require("ai-tokenizer/encoding/o200k_base") as Encoding,
  cl100k_base: () => require("ai-tokenizer/encoding/cl100k_base") as Encoding,
  p50k_base: () => require("ai-tokenizer/encoding/p50k_base") as Encoding,
};
/* eslint-enable @typescript-eslint/no-require-imports */

// Each worker serves exactly one encoding (one worker per encoding, so a slow load never blocks
// another encoding's counts). A request for a model of another encoding is a routing bug.
function assertRoutedHere(modelName: ModelName, encoding: EncodingName): void {
  const model = models[modelName];
  assert(model, `Unknown tokenizer model '${modelName}'`);
  assert(
    model.encoding === encoding,
    `Tokenizer model '${modelName}' uses encoding '${model.encoding}', but this worker serves '${encoding}'`
  );
}

function countTokens(tokenizer: Tokenizer, input: string): number {
  // Token counting is measurement, not a safety boundary: ordinary user/repo
  // text can legitimately contain special-token strings like "<|endoftext|>"
  // (e.g. GPT-2/BPE tasks), and count() -> encode() throws on them by
  // default, which fatally breaks counting for the whole message. Empty
  // allowed + disallowed sets disable the rejection without interpreting the
  // spelling as one reserved token: the literal characters tokenize as
  // ordinary text, keeping counts faithful to what providers see.
  return tokenizer.encode(input, [], []).length;
}

// Handle messages from main thread
if (parentPort) {
  const port = parentPort;
  const encoding = (workerData as Partial<TokenizerWorkerData> | null)?.encoding;
  assert(
    typeof encoding === "string" && Object.hasOwn(ENCODING_LOADERS, encoding),
    `Tokenizer worker needs a known workerData.encoding, got '${String(encoding)}'`
  );
  // Load before attaching the listener: requests that arrive meanwhile queue in the port, so the
  // encoding is evaluated exactly once. Counts depend only on the encoding, so one Tokenizer
  // serves every model routed here.
  const tokenizer = new Tokenizer(ENCODING_LOADERS[encoding]());

  port.on("message", (message: { messageId: number; taskName: string; data: unknown }) => {
    try {
      let result: unknown;

      switch (message.taskName) {
        case "countTokensBatch": {
          // The main thread sends many texts per message: one message per text cost a
          // postMessage round trip each, which dominated counting on huge chats (#4653).
          const { modelName, inputs } = message.data as CountTokensBatchInput;
          assertRoutedHere(modelName, encoding);
          assert(Array.isArray(inputs), "countTokensBatch expects an array of inputs");
          result = inputs.map((input) => countTokens(tokenizer, input));
          break;
        }
        case "ready": {
          // Answered only after the load above, so it doubles as the "encoding is warm" signal.
          const modelName = message.data as ModelName;
          assertRoutedHere(modelName, encoding);
          result = encoding;
          break;
        }
        default:
          throw new Error(`Unknown task: ${message.taskName}`);
      }

      port.postMessage({
        messageId: message.messageId,
        result,
      });
    } catch (error) {
      port.postMessage({
        messageId: message.messageId,
        error: {
          message: getErrorMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      });
    }
  });
}
