import { useEffect, useRef } from "react";

import { useOptionalAPI } from "@/browser/contexts/API";
import { updatePersistedState, usePersistedState } from "@/browser/hooks/usePersistedState";
import { CHAT_TRANSCRIPT_FULL_WIDTH_KEY } from "@/common/constants/storage";

/** Seeded from local cache to avoid a layout flash before the backend responds. */
export function useChatTranscriptFullWidth(): boolean {
  // Optional so isolated test renders and pre-API startup keep the cached layout preference.
  // Fall back to the injected ORPC client global because tests and Electron startup can have
  // a constructed client before this hook is under the API context provider.
  const api = useOptionalAPI()?.api ?? window.__ORPC_CLIENT__ ?? null;
  const fetchVersionRef = useRef(0);
  const [rawChatTranscriptFullWidth] = usePersistedState<unknown>(
    CHAT_TRANSCRIPT_FULL_WIDTH_KEY,
    false,
    { listener: true }
  );
  const chatTranscriptFullWidth = rawChatTranscriptFullWidth === true;
  const chatTranscriptFullWidthRef = useRef(chatTranscriptFullWidth);
  const persistedValueRef = useRef(chatTranscriptFullWidth);
  const backendPersistedValueRef = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    if (persistedValueRef.current !== chatTranscriptFullWidth) {
      persistedValueRef.current = chatTranscriptFullWidth;
      const backendPersistedValue = backendPersistedValueRef.current;
      backendPersistedValueRef.current = undefined;
      if (backendPersistedValue !== chatTranscriptFullWidth) {
        // Settings writes update persisted state first, so old backend reads must not overwrite them.
        fetchVersionRef.current++;
      }
    }

    chatTranscriptFullWidthRef.current = chatTranscriptFullWidth;
  }, [chatTranscriptFullWidth]);

  useEffect(() => {
    const getConfig = api?.config?.getConfig;
    if (!getConfig) {
      return;
    }

    const abortController = new AbortController();
    const { signal } = abortController;
    let iterator: AsyncIterator<unknown> | null = null;

    const setSyncedValue = (enabled: boolean) => {
      if (chatTranscriptFullWidthRef.current === enabled) {
        return;
      }

      chatTranscriptFullWidthRef.current = enabled;
      backendPersistedValueRef.current = enabled;
      updatePersistedState<boolean | undefined>(
        CHAT_TRANSCRIPT_FULL_WIDTH_KEY,
        enabled ? true : undefined
      );
    };

    const refresh = () => {
      const fetchVersion = ++fetchVersionRef.current;
      getConfig()
        .then((config) => {
          if (!signal.aborted && fetchVersion === fetchVersionRef.current) {
            setSyncedValue(config.chatTranscriptFullWidth === true);
          }
        })
        .catch(() => {
          // Keep the current preference on failure.
        });
    };

    refresh();

    const onConfigChanged = api?.config?.onConfigChanged;
    if (onConfigChanged) {
      const runSubscription = async () => {
        try {
          const subscribedIterator = await onConfigChanged(undefined, { signal });
          if (signal.aborted) {
            void subscribedIterator.return?.();
            return;
          }

          iterator = subscribedIterator;
          for await (const _ of subscribedIterator) {
            if (signal.aborted) {
              break;
            }
            refresh();
          }
        } catch {
          // Subscription errors are non-fatal.
        }
      };

      void runSubscription();
    }

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api]);

  return chatTranscriptFullWidth;
}
