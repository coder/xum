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
] as const;

export type ChatUiFeatureId = (typeof CHAT_UI_FEATURE_IDS)[number];

export type ChatUiSupport = "supported" | "unsupported" | "planned";
