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
  // Composer dock decorations the webview does not share (#5092). The reviews banner is covered by
  // reviewAnnotations; the background processes strip, held inputs and sub-agent tasks (#5109) are
  // shared.
  subAgentTasks: "supported",
  // Needs whole-workspace usage metrics and the compaction procedure, which the bridge does not allow.
  contextSwitchWarning: "unsupported",
  // Targets the desktop Instructions sidebar; workspace.getAdditionalSystemContext is not bridged.
  chatInstructions: "unsupported",
  // Needs the queue procedures (edit, dispatch mode, send now), which the bridge does not allow.
  queuedMessage: "unsupported",
  backgroundBashOutput: "supported",
  // The webview mounts no right sidebar or Artifacts dialog, and its page CSP (nonce-only scripts,
  // no frame-src) would block sandboxed artifact frames; artifact cards render without opening.
  artifactsPanel: "unsupported",
} as const satisfies Record<ChatUiFeatureId, ChatUiSupport>;
