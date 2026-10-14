import { useCallback } from "react";
import { useLiveAPI } from "@/browser/contexts/API";
import { useSettings } from "@/browser/contexts/SettingsContext";
import type { RuntimeConfig } from "@/common/types/runtime";
import { openInEditor } from "@/browser/utils/openInEditor";

export type { OpenInEditorResult } from "@/browser/utils/openInEditor";

/**
 * Hook to open a path in the user's configured code editor.
 *
 * This is a thin wrapper around the shared renderer entry point in
 * `src/browser/utils/openInEditor.ts`.
 */
export function useOpenInEditor() {
  // The live client only: offline, openInEditor() returns its "API not available" result.
  const api = useLiveAPI();
  const { open: openSettings } = useSettings();

  return useCallback(
    async (
      workspaceId: string,
      targetPath: string,
      runtimeConfig?: RuntimeConfig,
      options?: { isFile?: boolean }
    ) => {
      return openInEditor({
        api,
        openSettings,
        workspaceId,
        targetPath,
        runtimeConfig,
        isFile: options?.isFile,
      });
    },
    [api, openSettings]
  );
}
