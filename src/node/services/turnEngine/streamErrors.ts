/**
 * The stream failures the attempt loop raises itself: an empty stream, a
 * terminal refusal and a truncated stream. StreamManager's error payload
 * (buildStreamErrorPayload) maps each one to its stream error type.
 */

const EMPTY_STREAM_OUTPUT_ERROR_MESSAGE =
  "The model ended the stream before producing any assistant-visible output. This usually means the upstream stream was dropped rather than completed normally. Xum will retry automatically when possible, and if retries keep failing you should try again or switch models.";

const STREAM_TRUNCATED_MESSAGE_SUFFIX =
  "stream closed unexpectedly before the response completed. Xum will retry automatically when possible, and if retries keep failing you should try again or switch models.";

export class EmptyStreamOutputError extends Error {
  constructor() {
    super(EMPTY_STREAM_OUTPUT_ERROR_MESSAGE);
    this.name = "EmptyStreamOutputError";
  }
}

/**
 * Terminal provider refusal: the model declined to continue the turn. Unlike
 * EmptyStreamOutputError (a transport drop), retrying the same request will
 * likely refuse again, so this maps to the non-retryable "model_refusal" stream
 * error type.
 */
export class ModelRefusalError extends Error {
  constructor(model: string, finishReason: string, fallbackNote?: string) {
    super(
      `The model refused to continue (finishReason: ${finishReason}): ${model}. ` +
        "Retrying the same request is unlikely to help; try rephrasing or a different model." +
        (fallbackNote ? ` ${fallbackNote}` : "")
    );
    this.name = "ModelRefusalError";
  }
}

export class StreamTruncatedError extends Error {
  readonly providerDisplayName: string;

  constructor(providerDisplayName: string) {
    super(`${providerDisplayName} ${STREAM_TRUNCATED_MESSAGE_SUFFIX}`);
    this.name = "StreamTruncatedError";
    this.providerDisplayName = providerDisplayName;
  }
}
