import type { ChatUiFeatureId, ChatUiSupport } from "xum/common/constants/chatUiFeatures";

export const VSCODE_CHAT_UI_SUPPORT = {
  messageEditing: "planned",
  imageAttachments: "unsupported",
  slashCommandSuggestions: "planned",
  commandPalette: "unsupported",
  voiceInput: "unsupported",
  reviewAnnotations: "unsupported",
  bashForegroundControls: "unsupported",
  jsonRawView: "supported",
  // workspace.replaceChatHistory is a destructive write the bridge does not allow (#4942).
  chatHistoryReplacement: "unsupported",
} as const satisfies Record<ChatUiFeatureId, ChatUiSupport>;
