import { useAppConfig } from "@/browser/stores/AppConfigStore";

export function useChatTranscriptFullWidth(): boolean {
  return useAppConfig((config) => config.chatTranscriptFullWidth === true);
}
