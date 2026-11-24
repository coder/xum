import type { ProjectConfig } from "@/common/types/project";
import { normalizeRuntimeEnablement } from "@/common/types/runtime";
import { changeCreationDraftProject } from "./creationDraftProject";

/**
 * Project selector handler for the creation composer.
 *
 * This lives in its own module so the React Compiler can memoize it (#6843). The compiler skips
 * ChatInput entirely, so a handler defined inline there gets a new identity every render, and
 * CreationControls (onSelectedProjectPathChange) re-rendered on every keystroke.
 *
 * It takes the raw runtime enablement from the app config: ChatInput normalizes that into a new
 * object every render, which would also change this handler every render.
 */
export function useCreationProjectChangeHandler(
  draftId: string,
  userProjects: Map<string, ProjectConfig>,
  rawRuntimeEnablement: unknown,
  beginWorkspaceCreation: (projectPath: string, draftId?: string) => void
): (scope: string) => void {
  // The compiler's default "infer" mode ignores hooks that call no other hooks; opt in explicitly.
  "use memo";
  // A project change keeps the same draft (and editor); only its project fields change.
  return (scope) => {
    if (!draftId) return beginWorkspaceCreation(scope);
    beginWorkspaceCreation(
      changeCreationDraftProject(
        draftId,
        scope,
        userProjects,
        normalizeRuntimeEnablement(rawRuntimeEnablement)
      ),
      draftId
    );
  };
}
