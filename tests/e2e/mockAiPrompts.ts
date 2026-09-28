export const MOCK_LIST_PROGRAMMING_LANGUAGES = "[mock:list-languages] List 3 programming languages";

export const MOCK_PERMISSION_MODE_PROMPTS = {
  PLAN_REFACTOR: "[mock:permission:plan-refactor] How should I refactor this function?",
  EXECUTE_PLAN: "[mock:permission:exec-refactor] Do it",
} as const;

export const MOCK_TOOL_FLOW_PROMPTS = {
  FILE_READ: "[mock:tool:file-read] What's in README.md?",
  LIST_DIRECTORY: "[mock:tool:list-directory] What files are in the current directory?",
  CREATE_TEST_FILE: "[mock:tool:create-test-file] Create a file called test.txt with 'hello' in it",
  READ_TEST_FILE: "[mock:tool:read-test-file] Now read that file",
  RECALL_TEST_FILE: "[mock:tool:recall-test-file] What did it contain?",
  REASONING_QUICKSORT: "[mock:reasoning:quicksort] Explain quicksort algorithm step by step",
  USER_NOTIFY: "[mock:tool:notify] Notify me that the task is complete",
} as const;

export const MOCK_ERROR_PROMPTS = {
  TRIGGER_RATE_LIMIT: "[mock:error:rate-limit] Trigger rate limit error",
  TRIGGER_API_ERROR: "[mock:error:api] Trigger API error",
  TRIGGER_NETWORK_ERROR: "[mock:error:network] Trigger network error",
} as const;

export const MOCK_ERROR_MESSAGES = {
  RATE_LIMIT: "Rate limit exceeded. Please retry after 60 seconds.",
  API_ERROR: "Internal server error occurred while processing the request.",
  NETWORK_ERROR: "Network connection lost. Please check your internet connection.",
} as const;

export const MOCK_REVIEW_PROMPTS = {
  SUMMARIZE_BRANCHES: "[mock:review:branches] Let's summarize the current branches.",
  OPEN_ONBOARDING_DOC: "[mock:review:open-doc] Open the onboarding doc.",
  SHOW_ONBOARDING_DOC: "[mock:review:show-doc] Show the onboarding doc contents instead.",
} as const;

export const MOCK_SLASH_COMMAND_PROMPTS = {
  MODEL_STATUS:
    "[mock:model-status] Please confirm which model is currently active for this conversation.",
} as const;

export const MOCK_COMPACTION_SUMMARY_PREFIX = "Mock compaction summary:";

/** Streams for ~18 s so perf scenarios can switch between chats that stay mid-stream. */
export const MOCK_LONG_STREAM_PROMPT = "[mock:long-stream] Keep streaming for a while";
