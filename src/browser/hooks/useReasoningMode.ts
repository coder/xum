import { useThinking } from "@/browser/contexts/ThinkingContext";

/**
 * Custom hook for the OpenAI pro reasoning-mode toggle.
 * Must be used within a ThinkingProvider (typically at workspace level).
 *
 * @returns [reasoningMode, setReasoningMode] tuple
 */
export function useReasoningMode() {
  const { reasoningMode, setReasoningMode } = useThinking();
  return [reasoningMode, setReasoningMode] as const;
}
