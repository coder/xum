import { randomUUID } from "node:crypto";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type {
  DevToolsStep,
  DevToolsStepInput,
  DevToolsStepOutput,
  DevToolsUsage,
} from "@/common/types/devtools";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import {
  DEVTOOLS_RUN_METADATA_ID_HEADER,
  DEVTOOLS_STEP_ID_HEADER,
  consumeCapturedRequestHeaders,
  redactHeaders,
} from "./devToolsHeaderCapture";
import type { DevToolsService } from "./devToolsService";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractFinishReason(reason: unknown): string | undefined {
  if (typeof reason === "string") {
    return reason;
  }

  if (!isRecord(reason)) {
    return undefined;
  }

  const raw = reason.raw;
  if (typeof raw === "string" && raw.length > 0) {
    return raw;
  }

  const unified = reason.unified;
  if (typeof unified === "string" && unified.length > 0) {
    return unified;
  }

  return undefined;
}

function extractTokenTotal(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const total = value.total;
  return typeof total === "number" ? total : undefined;
}

function extractOptionalTokenCount(
  record: Record<string, unknown>,
  key: string
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function extractInputTokens(value: unknown): DevToolsUsage["inputTokens"] | undefined {
  if (typeof value === "number") {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const total = extractTokenTotal(value);
  if (total === undefined) {
    return undefined;
  }

  return {
    total,
    noCache: extractOptionalTokenCount(value, "noCache"),
    cacheRead: extractOptionalTokenCount(value, "cacheRead"),
    cacheWrite: extractOptionalTokenCount(value, "cacheWrite"),
  };
}

function extractOutputTokens(value: unknown): DevToolsUsage["outputTokens"] | undefined {
  if (typeof value === "number") {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const total = extractTokenTotal(value);
  if (total === undefined) {
    return undefined;
  }

  return {
    total,
    text: extractOptionalTokenCount(value, "text"),
    reasoning: extractOptionalTokenCount(value, "reasoning"),
  };
}

function createEmptyStep(
  stepId: string,
  runId: string,
  stepNumber: number,
  type: DevToolsStep["type"],
  model: LanguageModelV4,
  input: DevToolsStepInput | null
): DevToolsStep {
  return {
    id: stepId,
    runId,
    stepNumber,
    type,
    modelId: model.modelId,
    provider:
      typeof model.provider === "string" && model.provider.length > 0 ? model.provider : null,
    startedAt: new Date().toISOString(),
    durationMs: null,
    input,
    output: null,
    usage: null,
    error: null,
    rawRequest: null,
    requestHeaders: null,
    responseHeaders: null,
    rawResponse: null,
    rawChunks: null,
  };
}

function extractGenerateToolCalls(result: LanguageModelV4GenerateResult): unknown[] | undefined {
  const toolCallsFromContent = result.content
    .filter((part) => part.type === "tool-call")
    .map((part) => ({
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      args: part.input,
    }));

  if (toolCallsFromContent.length > 0) {
    return toolCallsFromContent;
  }

  if (!isRecord(result)) {
    return undefined;
  }

  const resultRecord = result as Record<string, unknown>;
  const dynamicToolCalls = resultRecord.toolCalls;
  return Array.isArray(dynamicToolCalls) ? dynamicToolCalls : undefined;
}

function extractInput(
  params: LanguageModelV4CallOptions | null | undefined
): DevToolsStepInput | null {
  if (!params) {
    return null;
  }

  return {
    prompt: params.prompt ?? null,
    tools: params.tools ?? undefined,
    toolChoice: params.toolChoice ?? undefined,
    maxOutputTokens: params.maxOutputTokens ?? undefined,
    temperature: params.temperature ?? undefined,
    providerOptions: params.providerOptions ?? undefined,
  };
}

function extractGenerateOutput(result: LanguageModelV4GenerateResult): DevToolsStepOutput {
  return {
    content: result.content ?? undefined,
    finishReason: extractFinishReason(result.finishReason),
    toolCalls: extractGenerateToolCalls(result),
  };
}

export function extractUsage(
  usage: LanguageModelV4Usage | Record<string, unknown> | null | undefined
): DevToolsUsage | null {
  if (!usage || !isRecord(usage)) {
    return null;
  }

  const inputTokens =
    extractInputTokens(usage.inputTokens) ?? extractOptionalTokenCount(usage, "promptTokens");
  const outputTokens =
    extractOutputTokens(usage.outputTokens) ?? extractOptionalTokenCount(usage, "completionTokens");
  const explicitTotalTokens = extractOptionalTokenCount(usage, "totalTokens");
  const inputTokenTotal = extractTokenTotal(inputTokens);
  const outputTokenTotal = extractTokenTotal(outputTokens);

  const totalTokens =
    typeof explicitTotalTokens === "number"
      ? explicitTotalTokens
      : inputTokenTotal !== undefined || outputTokenTotal !== undefined
        ? (inputTokenTotal ?? 0) + (outputTokenTotal ?? 0)
        : undefined;

  const raw = Object.prototype.hasOwnProperty.call(usage, "raw") ? usage.raw : undefined;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    typeof totalTokens !== "number" &&
    raw === undefined
  ) {
    return null;
  }

  const normalizedUsage: DevToolsUsage = {
    inputTokens,
    outputTokens,
    totalTokens,
  };

  if (raw !== undefined) {
    normalizedUsage.raw = raw;
  }

  return normalizedUsage;
}

export function createDevToolsMiddleware(
  workspaceId: string,
  service: DevToolsService
): LanguageModelV4Middleware {
  assert(workspaceId.trim().length > 0, "createDevToolsMiddleware requires a workspaceId");
  assert(service, "createDevToolsMiddleware requires a DevToolsService");

  const runId = randomUUID();
  let runCreated = false;
  let runCreationPromise: Promise<void> | null = null;
  let stepCounter = 0;

  async function ensureRun(runMetadataId?: string): Promise<void> {
    if (runCreated) {
      return;
    }

    if (runCreationPromise) {
      await runCreationPromise;
      return;
    }

    runCreationPromise = (async () => {
      try {
        await service.createRun(
          workspaceId,
          {
            id: runId,
            workspaceId,
            startedAt: new Date().toISOString(),
          },
          runMetadataId
        );
        runCreated = true;
      } catch (error) {
        log.warn("DevTools: failed to create run", {
          workspaceId,
          runId,
          error: getErrorMessage(error),
        });
      }
    })();

    try {
      await runCreationPromise;
    } finally {
      runCreationPromise = null;
    }
  }

  function extractRunMetadataId(params: LanguageModelV4CallOptions): string | undefined {
    const rawMetadataId = params.headers?.[DEVTOOLS_RUN_METADATA_ID_HEADER];
    if (typeof rawMetadataId !== "string") {
      return undefined;
    }

    const runMetadataId = rawMetadataId.trim();
    return runMetadataId.length > 0 ? runMetadataId : undefined;
  }

  async function createStep(
    stepType: DevToolsStep["type"],
    params: LanguageModelV4CallOptions,
    model: LanguageModelV4
  ): Promise<{ stepId: string; startedAtMs: number } | null> {
    try {
      const runMetadataId = extractRunMetadataId(params);
      await ensureRun(runMetadataId);

      const stepId = randomUUID();
      const stepNumber = (stepCounter += 1);
      const input = extractInput(params);

      await service.createStep(
        workspaceId,
        createEmptyStep(stepId, runId, stepNumber, stepType, model, input)
      );

      return {
        stepId,
        startedAtMs: Date.now(),
      };
    } catch (error) {
      log.warn("DevTools: failed to create step", {
        workspaceId,
        runId,
        stepType,
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  function injectStepIdHeader(params: LanguageModelV4CallOptions, stepId: string): void {
    assert(stepId.trim().length > 0, "injectStepIdHeader requires a non-empty stepId");

    const headers = new Headers();
    if (params.headers != null) {
      for (const [key, value] of Object.entries(params.headers)) {
        if (typeof value === "string") {
          headers.set(key, value);
        }
      }
    }

    headers.set(DEVTOOLS_STEP_ID_HEADER, stepId);
    params.headers = Object.fromEntries(headers.entries());
  }

  return {
    specificationVersion: "v4",

    wrapGenerate: async ({ doGenerate, params, model }) => {
      if (!service.enabled) {
        return doGenerate();
      }

      const step = await createStep("generate", params, model);
      if (step == null) {
        return doGenerate();
      }

      const { stepId, startedAtMs } = step;
      injectStepIdHeader(params, stepId);

      let finalized = false;
      const finalizeStep = async (update: Partial<DevToolsStep>): Promise<void> => {
        if (finalized) {
          return;
        }

        finalized = true;
        if (params.abortSignal != null) {
          params.abortSignal.removeEventListener("abort", abortHandler);
        }

        try {
          await service.updateStep(workspaceId, stepId, {
            durationMs: Date.now() - startedAtMs,
            ...update,
          });
        } catch (error) {
          // DevTools persistence is best-effort; never let observability failures
          // reject the model call that already succeeded.
          log.warn("DevTools: failed to persist step finalization", {
            workspaceId,
            stepId,
            error: getErrorMessage(error),
          });
        }
      };

      const abortHandler = (): void => {
        const capturedRequestHeaders = consumeCapturedRequestHeaders(stepId);
        void finalizeStep({
          output: null,
          usage: null,
          error: "Request aborted",
          rawRequest: null,
          requestHeaders: capturedRequestHeaders,
          responseHeaders: null,
          rawResponse: null,
          rawChunks: null,
        });
      };

      if (params.abortSignal != null) {
        if (params.abortSignal.aborted) {
          abortHandler();
        } else {
          params.abortSignal.addEventListener("abort", abortHandler, { once: true });
        }
      }

      try {
        const result = await doGenerate();
        const capturedRequestHeaders = consumeCapturedRequestHeaders(stepId);

        await finalizeStep({
          output: extractGenerateOutput(result),
          usage: extractUsage(result.usage),
          rawRequest: result.request?.body ?? null,
          requestHeaders: capturedRequestHeaders,
          responseHeaders:
            result.response?.headers != null
              ? redactHeaders(
                  Object.fromEntries(Object.entries(result.response.headers)),
                  "response"
                )
              : null,
          rawResponse: result.response?.body ?? null,
          rawChunks: null,
          error: null,
        });

        return result;
      } catch (error) {
        const capturedRequestHeaders = consumeCapturedRequestHeaders(stepId);
        await finalizeStep({
          output: null,
          usage: null,
          error: getErrorMessage(error),
          rawRequest: null,
          requestHeaders: capturedRequestHeaders,
          responseHeaders: null,
          rawResponse: null,
          rawChunks: null,
        });
        throw error;
      }
    },

    wrapStream: async ({ doStream, params, model }) => {
      if (!service.enabled) {
        return doStream();
      }

      const userRequestedRawChunks = params.includeRawChunks === true;
      const step = await createStep("stream", params, model);
      if (step == null) {
        return doStream();
      }

      const { stepId, startedAtMs } = step;
      params.includeRawChunks = true;
      injectStepIdHeader(params, stepId);

      let finalized = false;
      let capturedRequestHeaders: Record<string, string> | null = null;
      let rawRequest: unknown = null;
      let responseHeaders: Record<string, string> | null = null;

      const currentText = new Map<string, string>();
      const currentReasoning = new Map<string, string>();
      const textParts: Array<{ id: string; text: string }> = [];
      const reasoningParts: Array<{ id: string; text: string }> = [];
      const toolCalls: unknown[] = [];
      const rawChunks: unknown[] = [];
      const fullStreamChunks: unknown[] = [];

      let finishReason: string | undefined;
      let usage: DevToolsUsage | null = null;
      let streamError: string | null = null;

      const buildOutput = (): DevToolsStepOutput => {
        // Streams can end abruptly (abort/cancel/error) before receiving `*-end`
        // chunks, so flush in-progress deltas to preserve partial debug output.
        for (const [id, text] of currentText) {
          textParts.push({ id, text });
        }
        currentText.clear();

        for (const [id, text] of currentReasoning) {
          reasoningParts.push({ id, text });
        }
        currentReasoning.clear();

        return {
          textParts,
          reasoningParts,
          toolCalls,
          finishReason,
        };
      };

      const finalizeStep = async (
        update: Pick<
          DevToolsStep,
          | "output"
          | "usage"
          | "error"
          | "rawRequest"
          | "requestHeaders"
          | "responseHeaders"
          | "rawResponse"
          | "rawChunks"
        >
      ): Promise<void> => {
        if (finalized) {
          return;
        }

        finalized = true;
        if (params.abortSignal != null) {
          params.abortSignal.removeEventListener("abort", abortHandler);
        }

        try {
          await service.updateStep(workspaceId, stepId, {
            durationMs: Date.now() - startedAtMs,
            ...update,
          });
        } catch (error) {
          // DevTools persistence is best-effort; never let observability failures
          // reject the model call that already succeeded.
          log.warn("DevTools: failed to persist step finalization", {
            workspaceId,
            stepId,
            error: getErrorMessage(error),
          });
        }
      };

      const abortHandler = (): void => {
        void finalizeStep({
          output: buildOutput(),
          usage,
          error: "Request aborted",
          rawRequest,
          requestHeaders: capturedRequestHeaders,
          responseHeaders,
          rawResponse: fullStreamChunks,
          rawChunks,
        });
      };

      if (params.abortSignal != null) {
        if (params.abortSignal.aborted) {
          abortHandler();
        } else {
          params.abortSignal.addEventListener("abort", abortHandler, { once: true });
        }
      }

      let streamResult: LanguageModelV4StreamResult;
      try {
        streamResult = await doStream();
        capturedRequestHeaders = consumeCapturedRequestHeaders(stepId);
      } catch (error) {
        capturedRequestHeaders = consumeCapturedRequestHeaders(stepId);
        await finalizeStep({
          output: null,
          usage: null,
          error: getErrorMessage(error),
          rawRequest: null,
          requestHeaders: capturedRequestHeaders,
          responseHeaders: null,
          rawResponse: null,
          rawChunks: null,
        });
        throw error;
      }

      const { stream, ...rest } = streamResult;
      rawRequest = rest.request?.body ?? null;
      responseHeaders =
        rest.response?.headers != null
          ? redactHeaders(Object.fromEntries(Object.entries(rest.response.headers)), "response")
          : null;
      const reader = stream.getReader();

      const collectChunk = (chunk: LanguageModelV4StreamPart): boolean => {
        if (chunk.type === "raw") {
          rawChunks.push(chunk.rawValue);
          return userRequestedRawChunks;
        }

        fullStreamChunks.push(chunk);

        switch (chunk.type) {
          case "text-start": {
            currentText.set(chunk.id, "");
            break;
          }
          case "text-delta": {
            currentText.set(chunk.id, `${currentText.get(chunk.id) ?? ""}${chunk.delta}`);
            break;
          }
          case "text-end": {
            textParts.push({
              id: chunk.id,
              text: currentText.get(chunk.id) ?? "",
            });
            currentText.delete(chunk.id);
            break;
          }
          case "reasoning-start": {
            currentReasoning.set(chunk.id, "");
            break;
          }
          case "reasoning-delta": {
            currentReasoning.set(chunk.id, `${currentReasoning.get(chunk.id) ?? ""}${chunk.delta}`);
            break;
          }
          case "reasoning-end": {
            reasoningParts.push({
              id: chunk.id,
              text: currentReasoning.get(chunk.id) ?? "",
            });
            currentReasoning.delete(chunk.id);
            break;
          }
          case "tool-call": {
            toolCalls.push({
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              args: chunk.input,
            });
            break;
          }
          case "finish": {
            finishReason = extractFinishReason(chunk.finishReason);
            usage = extractUsage(chunk.usage);
            break;
          }
          case "error": {
            finishReason ??= "error";
            // Capture the error payload so the step is marked as failed in DevTools.
            streamError = getErrorMessage(chunk.error);
            break;
          }
          default:
            break;
        }

        return true;
      };

      const trackedStream = new ReadableStream<LanguageModelV4StreamPart>({
        async pull(controller): Promise<void> {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) {
                await finalizeStep({
                  output: buildOutput(),
                  usage,
                  error: streamError,
                  rawRequest,
                  requestHeaders: capturedRequestHeaders,
                  responseHeaders,
                  rawResponse: fullStreamChunks,
                  rawChunks,
                });
                controller.close();
                return;
              }

              assert(value, "DevTools middleware expected stream value when done=false");

              if (!collectChunk(value)) {
                continue;
              }

              controller.enqueue(value);
              return;
            }
          } catch (error) {
            await finalizeStep({
              output: buildOutput(),
              usage,
              error: getErrorMessage(error),
              rawRequest,
              requestHeaders: capturedRequestHeaders,
              responseHeaders,
              rawResponse: fullStreamChunks,
              rawChunks,
            });
            controller.error(error);
          }
        },

        async cancel(reason): Promise<void> {
          try {
            await reader.cancel(reason);
          } finally {
            await finalizeStep({
              output: buildOutput(),
              usage,
              error: "Request aborted",
              rawRequest,
              requestHeaders: capturedRequestHeaders,
              responseHeaders,
              rawResponse: fullStreamChunks,
              rawChunks,
            });
          }
        },
      });

      return {
        ...rest,
        stream: trackedStream,
      };
    },
  };
}
