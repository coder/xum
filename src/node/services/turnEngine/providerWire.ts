/**
 * providerWire: pure reads of provider error payloads (OpenAI previousResponseId,
 * structured error codes, HTTP status codes) shared by StreamManager's error paths
 * and ProviderRequest's lost-response-ID decision (turn-engine layer 4a).
 */
import { APICallError } from "ai";

/**
 * Extract previousResponseId from error response body
 * OpenAI's error message includes the ID: "Previous response with id 'resp_...' not found."
 */
export function extractPreviousResponseIdFromError(error: unknown): string | undefined {
  // Check APICallError.responseBody first
  if (APICallError.isInstance(error) && typeof error.responseBody === "string") {
    const match = /'(resp_[a-f0-9]+)'/.exec(error.responseBody);
    if (match) {
      return match[1];
    }
  }

  // Check error message
  if (error instanceof Error) {
    const match = /'(resp_[a-f0-9]+)'/.exec(error.message);
    if (match) {
      return match[1];
    }
  }

  return undefined;
}

export function extractErrorCode(error: unknown): string | undefined {
  const candidates: unknown[] = [];
  if (error instanceof Error && error.cause) {
    candidates.push(error.cause);
  }
  if (APICallError.isInstance(error)) {
    candidates.push(error.data);
  }
  candidates.push(error);
  for (const candidate of candidates) {
    const directCode = getStructuredErrorCode(candidate);
    if (directCode) {
      return directCode;
    }
    if (candidate && typeof candidate === "object" && "data" in candidate) {
      const dataCandidate = (candidate as { data?: unknown }).data;
      const nestedCode = getStructuredErrorCode(dataCandidate);
      if (nestedCode) {
        return nestedCode;
      }
    }
  }
  return undefined;
}

export function extractStatusCode(error: unknown): number | undefined {
  if (error instanceof Error && error.cause) {
    const statusCode = extractStatusCode(error.cause);
    if (typeof statusCode === "number") {
      return statusCode;
    }
  }

  if (APICallError.isInstance(error) && typeof error.statusCode === "number") {
    return error.statusCode;
  }

  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const candidate = (error as { statusCode?: unknown }).statusCode;
    if (typeof candidate === "number") {
      return candidate;
    }
  }

  return undefined;
}

function getStructuredErrorCode(candidate: unknown): string | undefined {
  if (typeof candidate === "object" && candidate !== null && "error" in candidate) {
    const withError = candidate as { error?: unknown };
    if (withError.error && typeof withError.error === "object") {
      const nested = withError.error as Record<string, unknown>;
      const code = nested.code;
      if (typeof code === "string") {
        return code;
      }
    }
  }
  return undefined;
}
