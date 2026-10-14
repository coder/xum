import type {
  AskUserQuestionUiOnlyPayload,
  FileEditUiOnlyPayload,
  NotifyUiOnlyPayload,
  ToolOutputUiOnly,
} from "@/common/types/tools";

export const TOOL_OUTPUT_UI_ONLY_FIELD = "ui_only" as const;

interface JsonContainer {
  type: "json";
  value: unknown;
}

function unwrapJsonContainer(output: unknown): { wrapped: boolean; value: unknown } {
  if (output && typeof output === "object" && "type" in output && "value" in output) {
    const record = output as { type?: unknown; value?: unknown };
    if (record.type === "json") {
      return { wrapped: true, value: record.value };
    }
  }
  return { wrapped: false, value: output };
}

function rewrapJsonContainer(wrapped: boolean, value: unknown): unknown {
  if (!wrapped) {
    return value;
  }

  const container: JsonContainer = {
    type: "json",
    value,
  };
  return container;
}

function stripUiOnlyDeep(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(stripUiOnlyDeep);
  }

  const record = value as Record<string, unknown>;
  const stripped: Record<string, unknown> = {};

  for (const [key, nested] of Object.entries(record)) {
    if (key === TOOL_OUTPUT_UI_ONLY_FIELD) {
      continue;
    }
    stripped[key] = stripUiOnlyDeep(nested);
  }

  return stripped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}

function isAskUserQuestionUiOnly(value: unknown): value is AskUserQuestionUiOnlyPayload {
  if (!isRecord(value)) {
    return false;
  }

  if (!Array.isArray(value.questions)) {
    return false;
  }

  return isStringRecord(value.answers);
}

function isFileEditUiOnly(value: unknown): value is FileEditUiOnlyPayload {
  return isRecord(value) && typeof value.diff === "string";
}

function isNotifyUiOnly(value: unknown): value is NotifyUiOnlyPayload {
  if (!isRecord(value)) {
    return false;
  }

  const notifiedVia = value.notifiedVia;
  if (notifiedVia !== "electron" && notifiedVia !== "browser") {
    return false;
  }

  if (
    "workspaceId" in value &&
    value.workspaceId !== undefined &&
    typeof value.workspaceId !== "string"
  ) {
    return false;
  }

  return true;
}

function isUiOnlyRecord(value: unknown): value is ToolOutputUiOnly {
  if (!isRecord(value)) {
    return false;
  }

  const record = value;

  if ("ask_user_question" in record && !isAskUserQuestionUiOnly(record.ask_user_question)) {
    return false;
  }

  if ("file_edit" in record && !isFileEditUiOnly(record.file_edit)) {
    return false;
  }

  if ("notify" in record && !isNotifyUiOnly(record.notify)) {
    return false;
  }

  return true;
}

export function getToolOutputUiOnly(output: unknown): ToolOutputUiOnly | undefined {
  const unwrapped = unwrapJsonContainer(output);
  const value = unwrapped.value;

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  if (!(TOOL_OUTPUT_UI_ONLY_FIELD in value)) {
    return undefined;
  }

  const uiOnly = (value as Record<string, unknown>)[TOOL_OUTPUT_UI_ONLY_FIELD];
  return isUiOnlyRecord(uiOnly) ? uiOnly : undefined;
}

export function stripToolOutputUiOnly(output: unknown): unknown {
  const unwrapped = unwrapJsonContainer(output);
  const stripped = stripUiOnlyDeep(unwrapped.value);
  return rewrapJsonContainer(unwrapped.wrapped, stripped);
}
