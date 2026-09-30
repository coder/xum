/**
 * Strip UI-only tool output before sending to providers.
 * Produces a cloned array safe for sending to providers without touching persisted history/UI.
 */
import type { MuxMessage, MuxToolPart } from "@/common/types/message";
import { sanitizeUnknownForProviderOutput } from "@/common/utils/providerOutputSanitization";
import { stripToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";
import { stripWorkflowRunRecordForModel } from "@/common/utils/workflowRunMessages";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripThumbnailFromLegacyImage(image: unknown): unknown {
  if (!isRecord(image)) {
    return image;
  }

  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(image)) {
    if (key !== "thumbnail") {
      stripped[key] = value;
    }
  }
  return stripped;
}

function stripResolvedSourcePath(source: unknown): unknown {
  if (!isRecord(source)) {
    return source;
  }

  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key !== "resolvedPath") {
      stripped[key] = value;
    }
  }
  return stripped;
}

function stripWorkflowRunAttachment(part: MuxToolPart): MuxToolPart {
  if (part.workflowRun == null) {
    return part;
  }

  if (part.state === "input-available") {
    const { workflowRun: _workflowRun, ...stripped } = part;
    return stripped;
  }
  if (part.state === "output-available") {
    const { workflowRun: _workflowRun, ...stripped } = part;
    return stripped;
  }

  const { workflowRun: _workflowRun, ...stripped } = part;
  return stripped;
}

function stripLegacyImageToolOutputForModel(output: unknown): unknown {
  if (Array.isArray(output)) {
    return output.map(stripLegacyImageToolOutputForModel);
  }
  if (!isRecord(output)) {
    return output;
  }

  const images = output.images;
  const isLegacyImageToolSuccess = output.success === true && Array.isArray(images);
  const record: Record<string, unknown> = isLegacyImageToolSuccess
    ? {
        ...output,
        images: images.map(stripThumbnailFromLegacyImage),
        ...(isRecord(output.source) ? { source: stripResolvedSourcePath(output.source) } : {}),
      }
    : output;

  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    stripped[key] =
      isLegacyImageToolSuccess && key === "images"
        ? value
        : stripLegacyImageToolOutputForModel(value);
  }
  return stripped;
}

export function applyToolOutputRedaction(messages: MuxMessage[]): MuxMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;

    const newParts = msg.parts.map((part) => {
      if (part.type !== "dynamic-tool") return part;
      const providerPart = stripWorkflowRunAttachment(part);
      if (providerPart.state !== "output-available") return providerPart;

      const outputWithoutUiOnly = stripWorkflowRunRecordForModel(
        providerPart.toolName,
        stripToolOutputUiOnly(providerPart.output)
      );
      const sanitizedOutput = sanitizeUnknownForProviderOutput(
        stripLegacyImageToolOutputForModel(outputWithoutUiOnly)
      );
      const nestedCalls = providerPart.nestedCalls?.map((nestedCall) => {
        if (nestedCall.state !== "output-available") {
          return nestedCall;
        }
        const nestedOutputWithoutUiOnly = stripWorkflowRunRecordForModel(
          nestedCall.toolName,
          stripToolOutputUiOnly(nestedCall.output)
        );
        return {
          ...nestedCall,
          output: sanitizeUnknownForProviderOutput(
            stripLegacyImageToolOutputForModel(nestedOutputWithoutUiOnly)
          ),
        };
      });
      return {
        ...providerPart,
        ...(nestedCalls ? { nestedCalls } : {}),
        output: sanitizedOutput,
      };
    });

    return {
      ...msg,
      parts: newParts,
    } satisfies MuxMessage;
  });
}
