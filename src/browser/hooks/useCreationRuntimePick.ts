import { useEffect, useState } from "react";
import {
  clearCreationRuntimeHandOff,
  peekCreationRuntimeHandOff,
} from "@/browser/utils/creationDraftCarry";
import type { ParsedRuntime } from "@/common/types/runtime";

/**
 * The runtime picked in a creation composer, starting from the pick a moved draft handed off.
 * `explicitRuntime` is the user's last pick, the only runtime a move carries. It is kept apart
 * from `runtime`: a fallback replaces the runtime shown, and another project may offer the pick.
 */
export function useCreationRuntimePick(draftScopeId: string | null | undefined) {
  const [runtime, setRuntime] = useState(() => peekCreationRuntimeHandOff(draftScopeId));
  const [explicitRuntime, setExplicitRuntime] = useState(() => runtime);
  // Cleared after mount, not in the initializer: StrictMode runs initializers twice.
  useEffect(() => clearCreationRuntimeHandOff(draftScopeId), [draftScopeId]);
  // Raw state setters: stable without React Compiler (useDraftWorkspaceSettings.compiler.test.tsx
  // compiles only its caller).
  return { runtime, explicitRuntime, setRuntime, setExplicitRuntime };
}

/**
 * The user's pick once the runtime shown changed to `runtime`. A fallback is not a pick: it keeps
 * the last one, since another project may offer the runtime that the fallback replaced.
 */
export function runtimePickAfter(
  pick: ParsedRuntime | null,
  runtime: ParsedRuntime,
  fallback: boolean
): ParsedRuntime | null {
  return fallback ? pick : runtime;
}
