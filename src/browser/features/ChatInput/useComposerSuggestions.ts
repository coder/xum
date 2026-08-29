import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";
import { useAPI } from "@/browser/contexts/API";
import { subscribeAgentPluginsMutated } from "@/browser/utils/agentPluginMutations";
import { findAtMentionAtCursor } from "@/common/utils/atMentions";
import { findInlineSkillReferenceAtCursor } from "@/browser/utils/agentSkills/inlineSkillReferences";
import {
  getInlineSkillInsertionTrailingText,
  getInlineSkillSuggestions,
} from "@/browser/utils/agentSkills/inlineSkillSuggestions";
import {
  findSymbolCommandAtCursor,
  getSymbolSuggestions,
} from "@/browser/features/ChatInput/symbolShortcuts";
import { getCommandGhostHint } from "@/browser/utils/slashCommands/registry";
import { getSlashCommandSuggestions } from "@/browser/utils/slashCommands/suggestions";
import { resolveSlashCommandExperimentValue } from "@/browser/utils/slashCommands/experimentVisibility";
import type { SlashSuggestion } from "@/browser/utils/slashCommands/types";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { MCPPromptDescriptor } from "@/common/orpc/schemas/mcp";
import type { PluginSlashCommandDescriptor } from "@/common/orpc/schemas/agentPlugins";

export type ComposerSuggestionToken =
  | { kind: "file"; startIndex: number; endIndex: number; query: string }
  | { kind: "inline"; startIndex: number; endIndex: number; query: string }
  | { kind: "symbol"; startIndex: number; endIndex: number; query: string }
  | { kind: "slash"; startIndex: 0; endIndex: number; query: string };

interface SuggestionExperiments {
  workspaceHeartbeats: boolean;
  dynamicWorkflows: boolean;
  memory: boolean;
  memoryConsolidation: boolean;
  rlm: boolean;
  programmaticToolCalling: boolean;
}

interface SynchronousSuggestionContext {
  agentSkills: AgentSkillDescriptor[];
  mcpPrompts: MCPPromptDescriptor[];
  pluginCommands: PluginSlashCommandDescriptor[];
  variant: "creation" | "workspace";
  experiments: SuggestionExperiments;
}

export function detectActiveComposerToken(
  input: string,
  cursor: number
): ComposerSuggestionToken | null {
  const boundedCursor = Math.min(Math.max(cursor, 0), input.length);
  const file = findAtMentionAtCursor(input, boundedCursor);
  if (file) {
    return {
      kind: "file",
      startIndex: file.startIndex,
      endIndex: file.endIndex,
      query: file.query,
    };
  }

  const inline = findInlineSkillReferenceAtCursor(input, boundedCursor);
  if (inline) {
    return {
      kind: "inline",
      startIndex: inline.startIndex,
      endIndex: inline.endIndex,
      query: inline.partial,
    };
  }

  const symbol = findSymbolCommandAtCursor(input, boundedCursor);
  if (symbol) {
    return {
      kind: "symbol",
      startIndex: symbol.startIndex,
      endIndex: symbol.endIndex,
      query: symbol.partial,
    };
  }

  if (input.trimStart().startsWith("/")) {
    return { kind: "slash", startIndex: 0, endIndex: input.length, query: input };
  }
  return null;
}

export function getSynchronousComposerSuggestions(
  token: ComposerSuggestionToken | null,
  context: SynchronousSuggestionContext
): SlashSuggestion[] {
  if (!token || token.kind === "file") return [];
  if (token.kind === "inline") {
    return getInlineSkillSuggestions({
      partial: token.query,
      descriptors: context.agentSkills,
      mcpPrompts: context.mcpPrompts,
    });
  }
  if (token.kind === "symbol") return getSymbolSuggestions(token.query);
  return getSlashCommandSuggestions(token.query, {
    agentSkills: context.agentSkills,
    mcpPrompts: context.mcpPrompts,
    pluginCommands: context.pluginCommands,
    variant: context.variant,
    isExperimentEnabled: (experimentId) =>
      resolveSlashCommandExperimentValue(experimentId, context.experiments),
  });
}

export function applyComposerSuggestion(
  input: string,
  token: ComposerSuggestionToken,
  suggestion: SlashSuggestion
): { input: string; cursor: number } {
  if (token.kind === "slash") {
    return { input: suggestion.replacement, cursor: suggestion.replacement.length };
  }

  const after = input.slice(token.endIndex);
  const trailing =
    token.kind === "file"
      ? " "
      : token.kind === "inline"
        ? getInlineSkillInsertionTrailingText(after)
        : "";
  const next = input.slice(0, token.startIndex) + suggestion.replacement + trailing + after;
  return {
    input: next,
    cursor: token.startIndex + suggestion.replacement.length + trailing.length,
  };
}

function tokenKey(token: ComposerSuggestionToken | null): string | null {
  return token ? [token.kind, token.startIndex, token.endIndex, token.query].join(":") : null;
}

function fileType(path: string): string {
  if (path.endsWith("/")) return "Directory";
  const lastDot = path.lastIndexOf(".");
  const lastSlash = path.lastIndexOf("/");
  return lastDot > lastSlash && lastDot < path.length - 1
    ? path.slice(lastDot + 1).toUpperCase()
    : "File";
}

interface UseComposerSuggestionsOptions {
  input: string;
  setInput: (input: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  variant: "creation" | "workspace";
  workspaceId: string | null;
  projectPath: string | null;
  disableWorkspaceAgents: boolean;
  transferredDraftProjectDiscovery: boolean;
  agentPluginsEnabled: boolean;
  experiments: SuggestionExperiments;
}

export function useComposerSuggestions(options: UseComposerSuggestionsOptions) {
  const { api } = useAPI();
  const [cursor, setCursor] = useState(options.input.length);
  const [selection, setSelection] = useState({ tokenKey: "", index: 0, dismissed: false });
  const [fileCompletion, setFileCompletion] = useState<{
    tokenKey: string;
    suggestions: SlashSuggestion[];
  }>({ tokenKey: "", suggestions: [] });
  const [agentSkills, setAgentSkills] = useState<AgentSkillDescriptor[]>([]);
  const [mcpPrompts, setMcpPrompts] = useState<MCPPromptDescriptor[]>([]);
  const [pluginCommands, setPluginCommands] = useState<PluginSlashCommandDescriptor[]>([]);
  const [pluginMutationTick, setPluginMutationTick] = useState(0);
  const fileRequestId = useRef(0);
  const skillRequestId = useRef(0);
  const mcpRequestId = useRef(0);
  const mcpRequest = useRef<Promise<void> | null>(null);
  const mcpLoadedAt = useRef(0);
  const mcpWorkspace = useRef<string | null>(null);
  const mcpAbort = useRef<AbortController | null>(null);
  const listId = useId();

  const activeToken = detectActiveComposerToken(options.input, cursor);
  const activeTokenKey = tokenKey(activeToken) ?? "";
  const synchronousSuggestions = getSynchronousComposerSuggestions(activeToken, {
    agentSkills,
    mcpPrompts,
    pluginCommands,
    variant: options.variant,
    experiments: options.experiments,
  });
  const suggestions =
    activeToken?.kind === "file" && fileCompletion.tokenKey === activeTokenKey
      ? fileCompletion.suggestions
      : synchronousSuggestions;
  const dismissed = selection.tokenKey === activeTokenKey && selection.dismissed;
  const isVisible = !dismissed && suggestions.length > 0;
  const selectedIndex =
    selection.tokenKey === activeTokenKey
      ? Math.min(selection.index, Math.max(0, suggestions.length - 1))
      : 0;

  useEffect(
    () => subscribeAgentPluginsMutated(() => setPluginMutationTick((tick) => tick + 1)),
    []
  );

  useEffect(() => {
    let mounted = true;
    const requestId = ++skillRequestId.current;
    const discovery =
      options.variant === "workspace" && options.workspaceId
        ? {
            workspaceId: options.workspaceId,
            disableWorkspaceAgents:
              options.disableWorkspaceAgents || options.transferredDraftProjectDiscovery,
          }
        : options.variant === "creation" && options.projectPath
          ? { projectPath: options.projectPath }
          : null;
    if (!api || !discovery) {
      setAgentSkills([]);
      return;
    }
    api.agentSkills
      .list(discovery)
      .then((skills) => {
        if (mounted && skillRequestId.current === requestId) setAgentSkills(skills);
      })
      .catch((error: unknown) => {
        console.error("Failed to load agent skills:", error);
        if (mounted && skillRequestId.current === requestId) setAgentSkills([]);
      });
    return () => {
      mounted = false;
    };
  }, [
    api,
    options.variant,
    options.workspaceId,
    options.projectPath,
    options.disableWorkspaceAgents,
    options.transferredDraftProjectDiscovery,
    options.agentPluginsEnabled,
    pluginMutationTick,
  ]);

  useEffect(() => {
    let mounted = true;
    if (
      !api ||
      options.variant !== "workspace" ||
      !options.workspaceId ||
      !options.agentPluginsEnabled
    ) {
      setPluginCommands([]);
      return;
    }
    api.workspace.plugins.slashCommands
      .list({ workspaceId: options.workspaceId })
      .then((commands) => {
        if (mounted) setPluginCommands(commands);
      })
      .catch(() => {
        if (mounted) setPluginCommands([]);
      });
    return () => {
      mounted = false;
    };
  }, [api, options.variant, options.workspaceId, options.agentPluginsEnabled, pluginMutationTick]);

  useEffect(() => {
    const workspaceId = options.workspaceId;
    if (!api || options.variant !== "workspace" || !workspaceId) {
      mcpWorkspace.current = null;
      mcpLoadedAt.current = 0;
      mcpRequestId.current++;
      mcpRequest.current = null;
      mcpAbort.current?.abort();
      mcpAbort.current = null;
      setMcpPrompts([]);
      return;
    }
    if (mcpWorkspace.current !== workspaceId) {
      mcpWorkspace.current = workspaceId;
      mcpLoadedAt.current = 0;
      mcpRequestId.current++;
      mcpRequest.current = null;
      mcpAbort.current?.abort();
      mcpAbort.current = null;
      setMcpPrompts([]);
    }
    if (activeToken?.kind !== "slash" && activeToken?.kind !== "inline") return;
    if (Date.now() - mcpLoadedAt.current < 30_000 || mcpRequest.current) return;

    const requestId = ++mcpRequestId.current;
    const controller = new AbortController();
    mcpAbort.current = controller;
    const request = api.workspace.mcp.prompts
      .list({ workspaceId }, { signal: controller.signal })
      .then((prompts) => {
        if (mcpWorkspace.current === workspaceId && mcpRequestId.current === requestId) {
          setMcpPrompts(prompts);
          mcpLoadedAt.current = Date.now();
        }
      })
      .catch(() => {
        if (mcpWorkspace.current === workspaceId && mcpRequestId.current === requestId) {
          mcpLoadedAt.current = Date.now();
        }
      })
      .finally(() => {
        if (mcpRequest.current === request) mcpRequest.current = null;
        if (mcpAbort.current === controller) mcpAbort.current = null;
      });
    mcpRequest.current = request;
  }, [api, activeToken?.kind, options.variant, options.workspaceId]);

  useEffect(() => {
    if (!api || activeToken?.kind !== "file") return;
    const scope = options.variant === "workspace" ? options.workspaceId : options.projectPath;
    if (!scope) return;
    const requestId = ++fileRequestId.current;
    const requestedTokenKey = activeTokenKey;
    const request =
      options.variant === "workspace"
        ? api.workspace.getFileCompletions({
            workspaceId: scope,
            query: activeToken.query,
            limit: 20,
          })
        : api.projects.getFileCompletions({
            projectPath: scope,
            query: activeToken.query,
            limit: 20,
          });
    request
      .then((result) => {
        if (fileRequestId.current !== requestId) return;
        setFileCompletion({
          tokenKey: requestedTokenKey,
          suggestions: result.paths
            .filter((path) => !/\s/.test(path))
            .map((path) => ({
              id: `file:${path}`,
              display: path,
              description: fileType(path),
              replacement: `@${path}`,
            })),
        });
      })
      .catch(() => {
        if (fileRequestId.current === requestId) {
          setFileCompletion({ tokenKey: requestedTokenKey, suggestions: [] });
        }
      });
  }, [api, activeTokenKey, options.variant, options.workspaceId, options.projectPath]);

  const dismiss = useCallback(() => {
    setSelection({ tokenKey: activeTokenKey, index: selectedIndex, dismissed: true });
  }, [activeTokenKey, selectedIndex]);

  const setSelectedIndex = useCallback(
    (index: number) => setSelection({ tokenKey: activeTokenKey, index, dismissed: false }),
    [activeTokenKey]
  );

  const select = useCallback(
    (suggestion: SlashSuggestion) => {
      if (!activeToken) return;
      const applied = applyComposerSuggestion(options.input, activeToken, suggestion);
      options.setInput(applied.input);
      setCursor(applied.cursor);
      setSelection({ tokenKey: activeTokenKey, index: 0, dismissed: true });
      requestAnimationFrame(() => {
        const element = options.inputRef.current;
        if (!element || element.disabled) return;
        element.focus();
        element.selectionStart = applied.cursor;
        element.selectionEnd = applied.cursor;
      });
    },
    [activeToken, activeTokenKey, options.input, options.inputRef, options.setInput]
  );

  useEffect(() => {
    if (!isVisible) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setSelectedIndex((selectedIndex + delta + suggestions.length) % suggestions.length);
      } else if ((event.key === "Tab" || event.key === "Enter") && !event.shiftKey) {
        event.preventDefault();
        const suggestion = suggestions[selectedIndex];
        if (suggestion) select(suggestion);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [dismiss, isVisible, select, selectedIndex, setSelectedIndex, suggestions]);

  useEffect(() => () => mcpAbort.current?.abort(), []);

  const handleCursorActivity = useCallback(() => {
    const element = options.inputRef.current;
    if (element) setCursor(element.selectionStart ?? options.input.length);
  }, [options.input.length, options.inputRef]);

  const handleInputCaretChange = useCallback((caret: number | undefined, inputLength: number) => {
    setCursor(caret ?? inputLength);
  }, []);

  const ghostHint = getCommandGhostHint(options.input, isVisible && activeToken?.kind === "slash", {
    variant: options.variant,
    isExperimentEnabled: (experimentId) =>
      resolveSlashCommandExperimentValue(experimentId, options.experiments),
  });

  return {
    activeToken,
    suggestions,
    selectedIndex,
    setSelectedIndex,
    select,
    dismiss,
    isVisible,
    listId,
    ariaLabel:
      activeToken?.kind === "file"
        ? "File path suggestions"
        : activeToken?.kind === "inline"
          ? "Skill suggestions"
          : activeToken?.kind === "symbol"
            ? "Symbol shortcuts"
            : "Slash command suggestions",
    highlightQuery:
      activeToken?.kind === "file" ||
      activeToken?.kind === "inline" ||
      activeToken?.kind === "symbol"
        ? activeToken.query
        : undefined,
    isFileSuggestion: activeToken?.kind === "file",
    suppressionKeys: activeToken?.kind === "slash" ? "command" : "file",
    ghostHint,
    handleCursorActivity,
    handleInputCaretChange,
    agentSkillDescriptors: agentSkills,
    mcpPromptDescriptors: mcpPrompts,
  };
}
