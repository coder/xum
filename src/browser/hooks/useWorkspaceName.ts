import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useAPI } from "@/browser/contexts/API";
import {
  draftStoreScopeKey,
  getDraftStore,
  useDraft,
  useDraftStoreHydrated,
  type DraftStoreScope,
} from "@/browser/stores/DraftStore";
import type { WorkspaceIdentity, WorkspaceNamePersistedState } from "@/common/orpc/schemas/drafts";
import type { NameGenerationError } from "@/common/types/errors";
import { DEFAULT_WORKSPACE_NAME_STATE, toStoredMessage } from "@/common/utils/workspaceNameState";
import {
  validateWorkspaceBranchName,
  validateWorkspaceName,
} from "@/common/utils/validation/workspaceValidation";

/** Discriminated error type for workspace name operations */
export type WorkspaceNameUIError =
  | { kind: "generation"; error: NameGenerationError }
  | { kind: "validation"; message: string }
  | { kind: "transport"; message: string };

/**
 * Caller fallbacks for name generation. The backend owns the precedence
 * (configured name_workspace model + thinking first, then its built-in small
 * models); the user's selected model is only a last resort after those.
 */
function buildNameGenCandidates(userModel: string | undefined): string[] {
  return userModel ? [userModel] : [];
}

function buildFallbackWorkspaceIdentity(message: string): WorkspaceIdentity {
  const normalized = message
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const name = normalized && !validateWorkspaceName(normalized).error ? normalized : "workspace";
  return { name, title: name };
}

export interface UseWorkspaceNameOptions {
  /** The user's message to generate a name for */
  message: string;
  /** Debounce delay in milliseconds (default: 500) */
  debounceMs?: number;
  /** User's selected model to try after the configured and built-in naming models */
  userModel?: string;
  /**
   * The creation draft whose body stores the name-generation state (DraftStore), so each draft
   * keeps its own auto-naming/manual name state and the state moves with the draft. Without one
   * the state is local to the component.
   */
  scope?: DraftStoreScope | null;
}

/** State and actions for workspace name generation, suitable for passing to components */
export interface WorkspaceNameState {
  /** The generated or manually entered name (shown in CreationControls UI) */
  name: string;
  /** The generated title (only available when auto-generation is enabled) */
  title: string | null;
  /** Whether name generation is in progress */
  isGenerating: boolean;
  /** Whether auto-generation is enabled */
  autoGenerate: boolean;
  /** Error state for generation/validation/transport failures */
  error: WorkspaceNameUIError | null;
  /** Set whether auto-generation is enabled */
  setAutoGenerate: (enabled: boolean) => void;
  /** Set manual name (for when auto-generate is off) */
  setName: (name: string) => void;
}

export interface UseWorkspaceNameReturn extends WorkspaceNameState {
  /** Wait for any pending generation to complete, returns both name and title */
  waitForGeneration: () => Promise<WorkspaceIdentity | null>;
}

/** Subscribed (never read) when the hook has no draft scope. */
const NO_DRAFT_SCOPE: DraftStoreScope = { kind: "pending", projectPath: "" };

/** The workspace name the creation form shows for persisted name state ("" when none). */
export function getNameFromPersistedState(state: WorkspaceNamePersistedState | null): string {
  if (state === null) return "";
  return state.autoGenerate ? (state.generatedIdentity?.name ?? "") : state.manualName;
}

/**
 * Extract the display title from persisted workspace name state.
 * Used by DraftAgentListItem to show the title in the sidebar without
 * duplicating knowledge of the persisted state structure.
 *
 * For auto-generated identities, prefers title (human-readable) over name (git-safe branch name).
 * This matches how real workspaces display: metadata.title ?? metadata.name.
 */
export function getDisplayTitleFromPersistedState(
  state: WorkspaceNamePersistedState | null
): string {
  if (state === null) return "";
  const { autoGenerate, generatedIdentity, manualName } = state;

  if (autoGenerate) {
    if (!generatedIdentity) {
      return "";
    }
    // Prefer title (e.g., "Fix plan mode over SSH") over name (e.g., "plan-a1b2")
    return generatedIdentity.title.trim() || generatedIdentity.name;
  }

  return manualName;
}

/**
 * Before the drafts load, a backend draft's stored name is unknown: a name generated against the
 * empty default would replace it once saved.
 */
function isBackendDraft(scope: DraftStoreScope | null): boolean {
  return scope !== null && scope.kind !== "pending";
}

/** The name state of the creation draft `scope` (DraftStore), or component-local state without one. */
function useWorkspaceNameStorage(scope: DraftStoreScope | null) {
  // Always subscribe, but only *use* the draft when a scope is provided.
  const draft = useDraft(scope ?? NO_DRAFT_SCOPE);
  const hydrated = useDraftStoreHydrated();
  const [localState, setLocalState] = useState<WorkspaceNamePersistedState>(
    DEFAULT_WORKSPACE_NAME_STATE
  );
  // Callers build the scope inline: the setters read the latest one, so they stay stable.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const setStoredIn = useCallback(
    (
      target: DraftStoreScope | null,
      update: (prev: WorkspaceNamePersistedState) => WorkspaceNamePersistedState
    ) => {
      if (target === null) {
        setLocalState(update);
        return;
      }
      getDraftStore().setNameState(target, (prev) => update(prev ?? DEFAULT_WORKSPACE_NAME_STATE));
    },
    []
  );
  const setStored = useCallback(
    (update: (prev: WorkspaceNamePersistedState) => WorkspaceNamePersistedState) =>
      setStoredIn(scopeRef.current, update),
    [setStoredIn]
  );
  // A generation writes to the draft it was started for: a draft switch renders the new scope
  // before its effect cancels the request, so the latest scope may already be another draft.
  const currentScope = useCallback(() => scopeRef.current, []);
  return {
    stored: scope ? (draft.nameState ?? DEFAULT_WORKSPACE_NAME_STATE) : localState,
    setStored,
    setStoredIn,
    currentScope,
    scopeKey: scope === null ? null : draftStoreScopeKey(scope),
    canAutoGenerate: hydrated || !isBackendDraft(scope),
  };
}

/**
 * Hook for managing workspace name generation with debouncing.
 *
 * Automatically generates names as the user types their message,
 * but allows manual override. If the user clears the manual name,
 * auto-generation resumes.
 */
export function useWorkspaceName(options: UseWorkspaceNameOptions): UseWorkspaceNameReturn {
  const { message, debounceMs = 500, userModel } = options;
  const scope = options.scope ?? null;
  const { api } = useAPI();
  const candidates = useMemo(() => buildNameGenCandidates(userModel), [userModel]);

  const { stored, setStored, setStoredIn, currentScope, scopeKey, canAutoGenerate } =
    useWorkspaceNameStorage(scope);

  const { generatedIdentity, manualName, autoGenerate, lastGeneratedFor } = stored;

  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<WorkspaceNameUIError | null>(null);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Message pending in debounce timer (captured at schedule time), and the draft it is for
  const pendingMessageRef = useRef<string>("");
  const pendingScopeRef = useRef<DraftStoreScope | null>(null);
  // Generation request counter for cancellation
  const requestIdRef = useRef(0);
  // Current in-flight generation promise and its resolver
  const generationPromiseRef = useRef<{
    promise: Promise<WorkspaceIdentity | null>;
    resolve: (identity: WorkspaceIdentity | null) => void;
    requestId: number;
  } | null>(null);

  // Name shown in CreationControls UI: generated name when auto, manual when not
  const name = autoGenerate ? (generatedIdentity?.name ?? "") : manualName;
  // Derived rather than set on keystrokes so a restored invalid name (e.g. a bounded prefix after a
  // restart) is flagged right away instead of failing only on submit.
  const manualNameValidationError =
    !autoGenerate && name.trim() ? validateWorkspaceBranchName(name).error : undefined;
  // Title is only shown when auto-generation is enabled (manual mode doesn't have generated title)
  const title = autoGenerate ? (generatedIdentity?.title ?? null) : null;

  // Cancel any pending generation and resolve waiters with null
  const cancelPendingGeneration = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
      pendingMessageRef.current = "";
    }
    // Increment request ID to invalidate any in-flight request
    const oldRequestId = requestIdRef.current;
    requestIdRef.current++;
    // Resolve any waiters so they don't hang forever
    if (generationPromiseRef.current?.requestId === oldRequestId) {
      generationPromiseRef.current.resolve(null);
      generationPromiseRef.current = null;
      setIsGenerating(false);
    }
  }, []);

  // When switching between draft scopes, ensure the "in flight" generation UI doesn't leak.
  useEffect(() => {
    cancelPendingGeneration();
    setIsGenerating(false);
    setError(null);
  }, [scopeKey, cancelPendingGeneration]);

  const generateIdentity = useCallback(
    async (
      forMessage: string,
      target: DraftStoreScope | null
    ): Promise<WorkspaceIdentity | null> => {
      if (!api || !forMessage.trim()) {
        return null;
      }
      const setGenerated = (identity: WorkspaceIdentity) =>
        setStoredIn(target, (prev) => ({
          ...prev,
          generatedIdentity: identity,
          lastGeneratedFor: toStoredMessage(forMessage),
        }));

      const requestId = ++requestIdRef.current;
      setIsGenerating(true);
      setError(null);

      // Create a promise that external callers can wait on
      let resolvePromise: ((identity: WorkspaceIdentity | null) => void) | undefined;
      const promise = new Promise<WorkspaceIdentity | null>((resolve) => {
        resolvePromise = resolve;
      });
      // TypeScript doesn't understand the Promise executor runs synchronously
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
      const safeResolve = resolvePromise!;
      generationPromiseRef.current = { promise, resolve: safeResolve, requestId };

      try {
        // Backend prepends the configured naming model and built-in fallbacks, then
        // tries candidates in order with retry on API errors (createModel resolves routing).
        const result = await api.nameGeneration.generate({
          message: forMessage,
          candidates,
        });

        // Check if this request is still current (wasn't cancelled)
        if (requestId !== requestIdRef.current) {
          // Don't resolve here - cancellation already resolved the promise
          return null;
        }

        if (result.success) {
          const identity: WorkspaceIdentity = {
            name: result.data.name,
            title: result.data.title,
          };

          setGenerated(identity);

          safeResolve(identity);
          return identity;
        }

        const fallbackIdentity = buildFallbackWorkspaceIdentity(forMessage);
        setGenerated(fallbackIdentity);
        setError(null);
        safeResolve(fallbackIdentity);
        return fallbackIdentity;
      } catch {
        if (requestId !== requestIdRef.current) {
          return null;
        }
        const fallbackIdentity = buildFallbackWorkspaceIdentity(forMessage);
        setGenerated(fallbackIdentity);
        setError(null);
        safeResolve(fallbackIdentity);
        return fallbackIdentity;
      } finally {
        if (requestId === requestIdRef.current) {
          setIsGenerating(false);
          generationPromiseRef.current = null;
        }
      }
    },
    [api, setStoredIn, candidates]
  );

  // Debounced generation effect
  useEffect(() => {
    // Don't generate if:
    // - Auto-generation is disabled
    // - Message is empty
    // - Already generated for this message
    if (
      !canAutoGenerate ||
      !autoGenerate ||
      !message.trim() ||
      lastGeneratedFor === toStoredMessage(message)
    ) {
      // Clear any pending timer since conditions changed
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        pendingMessageRef.current = "";
      }
      return;
    }

    // Cancel any in-flight request since message changed
    cancelPendingGeneration();

    // Capture message for the debounced callback (avoid stale closure)
    pendingMessageRef.current = message;
    pendingScopeRef.current = currentScope();

    // Debounce the generation
    debounceTimerRef.current = setTimeout(() => {
      const msg = pendingMessageRef.current;
      debounceTimerRef.current = null;
      pendingMessageRef.current = "";
      void generateIdentity(msg, pendingScopeRef.current);
    }, debounceMs);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        pendingMessageRef.current = "";
      }
    };
  }, [
    canAutoGenerate,
    message,
    autoGenerate,
    lastGeneratedFor,
    debounceMs,
    generateIdentity,
    cancelPendingGeneration,
    currentScope,
  ]);

  // When auto-generate is toggled, handle name preservation
  const handleSetAutoGenerate = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        // Switching to auto: reset so debounced generation will trigger
        setStored((prev) => ({ ...prev, autoGenerate: true, lastGeneratedFor: "" }));
        setError(null);
        return;
      }

      // Switching to manual: copy generated name as starting point for editing
      setStored((prev) => ({
        ...prev,
        autoGenerate: false,
        manualName: prev.generatedIdentity?.name ?? prev.manualName,
      }));
    },
    [setStored]
  );

  const setNameManual = useCallback(
    (newName: string) => {
      setStored((prev) => ({ ...prev, manualName: newName }));
      setError(null);
    },
    [setStored]
  );

  const waitForGeneration = useCallback(async (): Promise<WorkspaceIdentity | null> => {
    // If auto-generate is off, user has provided a manual name
    // Use that name directly with a generated title from the message
    if (!autoGenerate) {
      if (!name.trim()) {
        setError({ kind: "validation", message: "Please enter a workspace name" });
        return null;
      }
      // Manual name provided — skip LLM call entirely.
      // The manual name doubles as the display title; users who type a custom
      // name expect to see exactly that in the sidebar.
      return { name: name.trim(), title: name.trim() };
    }

    // Always wait for generation to complete on the full message.
    // With voice input, the message can go from empty to complete very quickly,
    // so we must ensure the generated identity reflects the total content.

    // If there's a debounced generation pending, trigger it immediately
    // Use the captured message from pendingMessageRef to avoid stale closures
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
      const msg = pendingMessageRef.current;
      pendingMessageRef.current = "";
      if (msg.trim()) {
        return generateIdentity(msg, pendingScopeRef.current);
      }
    }

    // If generation is in progress, wait for it to complete
    if (generationPromiseRef.current) {
      return generationPromiseRef.current.promise;
    }

    // If we have an identity that was generated for the current message, use it
    if (generatedIdentity && lastGeneratedFor === toStoredMessage(message)) {
      return generatedIdentity;
    }

    // Otherwise generate a fresh identity for the current message
    if (message.trim()) {
      return generateIdentity(message, currentScope());
    }

    return null;
  }, [
    autoGenerate,
    name,
    generatedIdentity,
    lastGeneratedFor,
    message,
    generateIdentity,
    currentScope,
  ]);

  return useMemo(
    () => ({
      name,
      title,
      isGenerating,
      autoGenerate,
      error: manualNameValidationError
        ? { kind: "validation", message: manualNameValidationError }
        : error,
      setAutoGenerate: handleSetAutoGenerate,
      setName: setNameManual,
      waitForGeneration,
    }),
    [
      name,
      title,
      isGenerating,
      autoGenerate,
      error,
      manualNameValidationError,
      handleSetAutoGenerate,
      setNameManual,
      waitForGeneration,
    ]
  );
}
