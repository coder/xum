import type { SendMessageOptions } from "@/common/orpc/types";
import type { PostCompactionAttachment } from "@/common/types/attachment";
import type { MuxMessage, MuxMessageMetadata } from "@/common/types/message";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import type { ErrorEvent } from "@/common/types/stream";
import type { OpenAIReasoningMode, ThinkingLevel } from "@/common/types/thinking";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { FileState } from "@/node/services/agentSession";
import type { MemorySessionContext } from "@/node/services/memoryService";
import type { ActiveTurnThinkingOverride } from "@/node/services/thinkingOverride";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";

/** Options used to prepare and execute a turn. */
export interface StreamMessageOptions {
  messages: MuxMessage[];
  workspaceId: string;
  modelString: string;
  thinkingLevel?: ThinkingLevel;
  /** OpenAI pro reasoning mode; delivered via provider options (inert for unsupported models). */
  reasoningMode?: OpenAIReasoningMode;
  toolPolicy?: ToolPolicy;
  abortSignal?: AbortSignal;
  /** Live workspace scratchpad snapshot from the renderer; when present it wins over disk. */
  additionalSystemContext?: string;
  additionalSystemInstructions?: string;
  maxOutputTokens?: number;
  muxProviderOptions?: MuxProviderOptions;
  /** Internal-only flag for Copilot billing attribution; never sourced from IPC schemas. */
  agentInitiated?: boolean;
  agentId?: string;
  /** See SendMessageOptionsSchema.strictAgentResolution: explicit-agent sends fail loudly instead of falling back to exec. */
  strictAgentResolution?: SendMessageOptions["strictAgentResolution"];
  /** ACP prompt correlation id used to match stream events to a specific request. */
  acpPromptId?: string;
  /** Invoked with each fatal pre-start error event this call emits before returning Err. */
  onPreStartError?: (event: ErrorEvent) => void;
  /** Tool names that should be delegated back to ACP clients for this request. */
  delegatedToolNames?: string[];
  recordFileState?: (filePath: string, state: FileState) => Promise<void>;
  postCompactionAttachments?: PostCompactionAttachment[] | null;
  /**
   * Resolver for the session-segment memory context (memory experiment):
   * index snapshot for the memory tool description + hot-memories block.
   * AgentSession caches the result per model/session segment because hot-memory
   * selection is token-budgeted with the active model tokenizer. A callback
   * (not a pre-resolved value) because it must be computed after
   * runtime.ensureReady(): project-scope listing on a
   * stopped Docker/remote workspace would otherwise cache an empty/partial
   * context for the whole segment.
   */
  resolveMemoryContext?: (
    modelString: string,
    options?: { includeHotMemories?: boolean }
  ) => Promise<MemorySessionContext | undefined>;
  experiments?: SendMessageOptions["experiments"];
  allowAgentSetGoal?: boolean;
  workspaceGoalService?: WorkspaceGoalService;
  disableWorkspaceAgents?: boolean;
  hasQueuedMessages?: (dispatchMode?: "tool-end" | "turn-end") => boolean;
  muxMetadata?: MuxMessageMetadata;
  openaiTruncationModeOverride?: "auto" | "disabled";
  /**
   * Model floor already resolved by AgentSession (config.json
   * minThinkingLevelByModel → resolveMinimumThinkingLevel). Passed down so
   * mid-turn overrides clamp against the same floor as the send-time level;
   * internal callers may omit it (re-resolved from defaults).
   */
  minThinkingLevel?: ThinkingLevel;
  /**
   * Session-owned per-turn holder for mid-turn thinking-level overrides.
   * When absent (compaction, sub-agent paths), the feature is inert for the
   * stream. See src/node/services/thinkingOverride.ts.
   */
  activeTurnThinkingOverride?: ActiveTurnThinkingOverride;
}
