import { useEffect, useState } from "react";
import {
  clearCreationRuntimeHandOff,
  peekCreationRuntimeHandOff,
} from "@/browser/utils/creationDraftCarry";

/**
 * The runtime picked in a creation composer, starting from the pick a moved draft handed off.
 * `explicit` marks a user pick (not a Settings default change), the only kind a move carries.
 */
export function useCreationRuntimePick(draftScopeId: string | null | undefined) {
  const [runtime, setRuntime] = useState(() => peekCreationRuntimeHandOff(draftScopeId));
  const [explicit, setExplicit] = useState(() => runtime != null);
  // Cleared after mount, not in the initializer: StrictMode runs initializers twice.
  useEffect(() => clearCreationRuntimeHandOff(draftScopeId), [draftScopeId]);
  // Raw state setters: stable without React Compiler (useDraftWorkspaceSettings.compiler.test.tsx
  // compiles only its caller).
  return { runtime, explicitRuntime: explicit ? runtime : null, setRuntime, setExplicit };
}
