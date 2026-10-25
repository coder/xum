import type { CoderWorkspaceConfig, ParsedRuntime } from "@/common/types/runtime";

/**
 * Coder config change handler for the creation composer.
 *
 * This lives in its own module so the React Compiler can memoize it. The compiler skips
 * ChatInput entirely, so a handler defined inline there gets a new identity every render.
 * That identity flows into useCoderWorkspace's setters and the CreationControls coder props,
 * which then re-render on every keystroke when the Coder CLI is installed.
 */
export function useCoderConfigChangeHandler(
  coderRuntimeHost: string | null,
  setSelectedRuntime: (runtime: ParsedRuntime) => void
): (config: CoderWorkspaceConfig | null) => void {
  // The compiler's default "infer" mode ignores hooks that call no other hooks; opt in explicitly.
  "use memo";
  return (config) => {
    if (coderRuntimeHost == null) return;
    // Existing Coder workspaces name the SSH host; new ones derive it later.
    const computedHost = config?.workspaceName ? `${config.workspaceName}.coder` : coderRuntimeHost;
    setSelectedRuntime({
      mode: "ssh",
      host: computedHost,
      coder: config ?? undefined,
    });
  };
}
