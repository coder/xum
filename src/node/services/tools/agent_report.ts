import { jsonSchema, tool, type ToolExecutionOptions } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";

import {
  validateJsonSchemaSubset,
  validateJsonSchemaSubsetSchema,
  type JsonSchemaValidationError,
} from "@/common/utils/jsonSchemaSubset";
import { normalizeWorkflowAgentReportPayloadForHostSchema } from "@/common/utils/tools/workflowReportPayload";
import { sanitizeWorkflowAgentReportSchemaForOpenAI } from "@/common/utils/tools/schemaSanitizer";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  AgentReportInlineToolArgsSchema,
  TOOL_DEFINITIONS,
} from "@/common/utils/tools/toolDefinitions";

import { requireTaskService, requireWorkspaceId } from "./toolUtils";

interface AgentReportSuccessResult {
  success: true;
  message: string;
}

interface AgentProgressReport {
  reportMarkdown: string;
  title?: string;
  structuredOutput?: unknown;
}

interface AgentReportFailureResult {
  success: false;
  message: string;
  errors: JsonSchemaValidationError[];
}

type AgentReportResult = AgentReportSuccessResult | AgentReportFailureResult;

function validationFailure(
  message: string,
  errors: JsonSchemaValidationError[]
): AgentReportFailureResult {
  return { success: false, message, errors };
}

function zodValidationFailure(
  message: string,
  error: { issues: Array<{ path: unknown[]; message: string }> }
) {
  return validationFailure(
    message,
    error.issues.map((issue) => ({
      path: issue.path.length > 0 ? `$.${issue.path.join(".")}` : "$",
      message: issue.message,
    }))
  );
}

function getWorkflowAgentOutputSchema(
  config: ToolConfiguration
): Record<string, unknown> | undefined {
  const outputSchema = config.workflowAgentOutputSchema;
  if (outputSchema == null) {
    return undefined;
  }
  const schemaValidation = validateJsonSchemaSubsetSchema(outputSchema, {
    requireObjectSchema: true,
  });
  if (schemaValidation.success) {
    return outputSchema as Record<string, unknown>;
  }
  if (config.allowLegacyInvalidWorkflowAgentOutputSchema === true) {
    return undefined;
  }
  throw new Error("Invalid workflow agent output schema for agent_report.");
}

function validateStructuredOutput(config: ToolConfiguration, structuredOutput: unknown) {
  const outputSchema = getWorkflowAgentOutputSchema(config);
  if (outputSchema == null) {
    return null;
  }

  const normalizedOutput = normalizeWorkflowAgentReportPayloadForHostSchema(
    outputSchema,
    structuredOutput
  );
  const validation = validateJsonSchemaSubset(outputSchema, normalizedOutput);
  return validation.success
    ? null
    : validationFailure("Structured output failed schema validation.", validation.errors);
}

function buildInlineInputSchema(config: ToolConfiguration) {
  const outputSchema = getWorkflowAgentOutputSchema(config);
  if (outputSchema == null) {
    return AgentReportInlineToolArgsSchema;
  }

  // Expose an OpenAI-compatible schema to providers while keeping the richer
  // Ajv schema for host-side validation in executeInlineReport.
  const providerFacingSchema = sanitizeWorkflowAgentReportSchemaForOpenAI(
    outputSchema
  ) as JSONSchema7;
  return jsonSchema(providerFacingSchema, {
    validate: (value) => {
      const normalizedValue = normalizeWorkflowAgentReportPayloadForHostSchema(outputSchema, value);
      const validation = validateStructuredOutput(config, normalizedValue);
      if (validation) {
        return { success: false, error: new Error(validation.message) };
      }
      return { success: true, value: normalizedValue };
    },
  });
}

function parseProgressReport(
  config: ToolConfiguration,
  rawArgs: unknown
): { report: AgentProgressReport } | { failure: AgentReportFailureResult } {
  const workflowOutputSchema = getWorkflowAgentOutputSchema(config);
  if (workflowOutputSchema != null) {
    const normalizedArgs = normalizeWorkflowAgentReportPayloadForHostSchema(
      workflowOutputSchema,
      rawArgs
    );
    const structuredValidation = validateStructuredOutput(config, normalizedArgs);
    if (structuredValidation) {
      return { failure: structuredValidation };
    }
    return {
      report: {
        reportMarkdown: "Structured workflow update submitted.",
        structuredOutput: normalizedArgs,
      },
    };
  }

  const parsed = AgentReportInlineToolArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      failure: zodValidationFailure("Report arguments failed validation.", parsed.error),
    };
  }

  return {
    report: {
      reportMarkdown: parsed.data.reportMarkdown,
      title: parsed.data.title ?? undefined,
    },
  };
}

export const createAgentReportTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.agent_report.description,
    inputSchema: buildInlineInputSchema(config),
    execute: async (
      args: unknown,
      options: ToolExecutionOptions<unknown>
    ): Promise<AgentReportResult> => {
      const workspaceId = requireWorkspaceId(config, "agent_report");
      const taskService = requireTaskService(config, "agent_report");
      const parsed = parseProgressReport(config, args);
      if ("failure" in parsed) {
        return parsed.failure;
      }

      await taskService.reportAgentProgress(workspaceId, options.toolCallId, parsed.report);
      return {
        success: true,
        message: "Update sent to the parent workspace.",
      };
    },
  });
};
