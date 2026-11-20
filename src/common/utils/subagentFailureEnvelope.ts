// Keep the producer and parser compatible with both persisted protocol versions.
export const SUBAGENT_FAILURE_FOOTER =
  "This sub-agent task failed terminally and will not produce a report. Do not re-await it.";
export const WORKSPACE_TURN_FAILURE_FOOTER =
  "This delegated workspace turn ended without a final report. Do not re-await this execution. Other workspace activity can continue.";

export interface SubagentFailureEnvelope {
  taskId: string;
  agentType: string;
  errorType: string;
  errorMessage: string;
  executionVersion?: string;
  executionId?: string;
}

// The header lists the execution version straight after the task ID. A version tag further down
// is body text: rows written before the body became fixed Xum text can hold anything there.
const FAILURE_HEADER_EXECUTION_VERSION =
  /^<mux_subagent_failure>\n<task_id>[^\n<>]+<\/task_id>\n<execution_version>([^\n<>]+)<\/execution_version>\n/;

/**
 * The execution version a failure row names in its header, else null. Delivery dedupe reads this
 * rather than parseSubagentFailureEnvelope: it must also see rows that do not parse as complete
 * envelopes, but it must never read a version out of the body.
 */
export function parseSubagentFailureExecutionVersion(content: string): string | null {
  return FAILURE_HEADER_EXECUTION_VERSION.exec(content)?.[1] ?? null;
}

/** Parse the persisted failure protocol without changing the model-facing message. */
export function parseSubagentFailureEnvelope(content: string): SubagentFailureEnvelope | null {
  // Match the entire producer envelope so malformed or mixed-content messages remain visible as-is.
  // The error body is greedy: embedded protocol examples must not truncate the actual diagnostic.
  const match =
    /^<mux_subagent_failure>\n<task_id>([^\n<>]+)<\/task_id>\n(?:<execution_version>([^\n<>]+)<\/execution_version>\n)?(?:<execution_id>([^\n<>]+)<\/execution_id>\n)?<agent_type>([^\n<>]+)<\/agent_type>\n<error_type>([^\n<>]+)<\/error_type>\n<error_message>\n([\s\S]+)\n<\/error_message>\n([^\n]+)\n<\/mux_subagent_failure>$/.exec(
      content
    );
  if (!match) return null;

  const [, taskId, executionVersion, executionId, agentType, errorType, errorMessage, footer] =
    match;
  if (footer !== SUBAGENT_FAILURE_FOOTER && footer !== WORKSPACE_TURN_FAILURE_FOOTER) return null;
  if (![taskId, agentType, errorType, errorMessage].every((field) => field.trim().length > 0)) {
    return null;
  }
  return {
    taskId,
    agentType,
    errorType,
    errorMessage,
    ...(executionVersion ? { executionVersion } : {}),
    ...(executionId ? { executionId } : {}),
  };
}
