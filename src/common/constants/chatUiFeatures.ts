export const CHAT_UI_FEATURE_IDS = [
  "messageEditing",
  "imageAttachments",
  "slashCommandSuggestions",
  "commandPalette",
  "voiceInput",
  "reviewAnnotations",
  "bashForegroundControls",
  "jsonRawView",
  // Replacing the chat history with a message (Start Here, plan implement with replacement).
  "chatHistoryReplacement",
  // Composer dock decorations (#5092): the sub-agent tasks strip, the context switch warning, the
  // Chat Instructions decoration and the queued follow-up.
  "subAgentTasks",
  "contextSwitchWarning",
  "chatInstructions",
  "queuedMessage",
  // Viewing a background bash's output (the output dialog, which polls it while open).
  "backgroundBashOutput",
] as const;

export type ChatUiFeatureId = (typeof CHAT_UI_FEATURE_IDS)[number];

export type ChatUiSupport = "supported" | "unsupported" | "planned";
