// Schemas re-exported for consumers that import from "@/common/orpc/schemas".

// Runtime schemas
export {
  RuntimeConfigSchema,
  RuntimeModeSchema,
  RuntimeEnablementIdSchema,
} from "./schemas/runtime";

// Project schemas
export { ProjectConfigSchema, WorkspaceConfigSchema } from "./schemas/project";

// Workspace schemas
export { WorkspaceAISettingsSchema } from "./schemas/workspaceAiSettings";
export {
  BestOfGroupSchema,
  FrontendWorkspaceMetadataSchema,
  GitStatusSchema,
  ProjectRefSchema,
  WorkspaceActivitySnapshotSchema,
  WorkspaceGoalDefaultsOverrideSchema,
  WorkspaceHeartbeatSettingsSchema,
  WorkspaceMetadataSchema,
} from "./schemas/workspace";

// Workspace stats schemas
export { WorkspaceStatsSnapshotSchema } from "./schemas/workspaceStats";

// Workspace review-state schemas
export {
  ReviewStateDeltaSchema,
  ReviewStateEventSchema,
  ReviewStateImportLegacyOutputSchema,
  ReviewStateSectionsSchema,
  ReviewStateSnapshotSchema,
} from "./schemas/reviewState";

// Chat stats schemas
export { ChatStatsSchema, TokenConsumerSchema } from "./schemas/chatStats";

// Agent Skill schemas
export {
  AgentSkillDescriptorSchema,
  AgentSkillFrontmatterSchema,
  AgentSkillIssueSchema,
  AgentSkillPackageSchema,
  AgentSkillScopeSchema,
  SkillNameSchema,
  resolveSkillAdvertise,
  resolveSkillUserInvocable,
  resolveSkillWhenToUse,
} from "./schemas/agentSkill";

// Workflow schemas
export {
  AvailableWorkflowSchema,
  StructuredTaskOutputSchema,
  WorkflowArgSummarySchema,
  WorkflowDeclaredPhaseSchema,
  WorkflowPhaseManifestSchema,
  WORKFLOW_DECLARED_PHASES_MAX,
  WORKFLOW_PHASE_DESCRIPTION_MAX_LENGTH,
  WORKFLOW_PHASE_NAME_MAX_LENGTH,
  WorkflowScriptDescriptorSchema,
  WorkflowMetadataSchema,
  WorkflowScriptScopeSchema,
  WorkflowEventSequenceSchema,
  WorkflowResultSchema,
  WorkflowRunEventSchema,
  WorkflowRunIdSchema,
  WorkflowRunParentSchema,
  WorkflowRunRecordSchema,
  WorkflowRunStatusSchema,
  WorkflowRunStreamEventSchema,
  WorkflowStepRecordSchema,
  WorkflowStepStatusSchema,
} from "./schemas/workflow";

// Error schemas
// Agent Definition schemas
export {
  AgentDefinitionDescriptorSchema,
  AgentDefinitionFrontmatterSchema,
  AgentDefinitionPackageSchema,
  AgentDefinitionScopeSchema,
  AgentIdSchema,
} from "./schemas/agentDefinition";

export {
  SendMessageAcceptedSchema,
  SendMessageErrorSchema,
  StreamErrorTypeSchema,
  NameGenerationErrorSchema,
  PlanReviewErrorSchema,
} from "./schemas/errors";

// Secrets schemas
export { SecretSchema } from "./schemas/secrets";

// Provider options schemas
export { MuxProviderOptionsSchema } from "./schemas/providerOptions";

export { backup } from "./schemas/backup";
// Terminal schemas
export {
  TerminalCreateParamsSchema,
  TerminalResizeParamsSchema,
  TerminalSessionSchema,
} from "./schemas/terminal";

// Message schemas
export {
  BranchListResultSchema,
  DynamicToolPartPendingSchema,
  DynamicToolPartSchema,
  FilePartSchema,
  MuxToolPartSchema,
} from "./schemas/message";
export type { FilePart } from "./schemas/message";

// Stream event schemas
export {
  AutoRetryAbandonedEventSchema,
  AutoRetryScheduledEventSchema,
  AutoRetryStartingEventSchema,
  CaughtUpMessageSchema,
  ChatMuxMessageSchema,
  DeleteMessageSchema,
  ErrorEventSchema,
  GoalBudgetLimitedEventSchema,
  OnChatDowngradeReasonSchema,
  ReasoningDeltaEventSchema,
  ReasoningEndEventSchema,
  RuntimeStatusEventSchema,
  SendMessageOptionsSchema,
  AcpPromptCorrelationSchema,
  HistoryEditPreconditionSchema,
  StreamAbortReasonSchema,
  StreamAbortEventSchema,
  StreamLifecycleEventSchema,
  StreamLifecycleSnapshotSchema,
  StreamDeltaEventSchema,
  StreamEndEventSchema,
  StreamErrorMessageSchema,
  StreamStartEventSchema,
  ToolCallDeltaEventSchema,
  ToolCallEndEventSchema,
  ToolCallExecutionStartEventSchema,
  ToolCallStartEventSchema,
  BashOutputEventSchema,
  TaskCreatedEventSchema,
  WorkflowRunAttachedEventSchema,
  AdvisorOutputEventSchema,
  AdvisorReasoningOutputEventSchema,
  AdvisorPhaseEventSchema,
  RestartBlockerSchema,
  UpdateStatusSchema,
  UsageDeltaEventSchema,
  WorkspaceChatMessageSchema,
  WorkspaceInitEventSchema,
} from "./schemas/stream";

// API router schemas
export {
  ApiServerStatusSchema,
  AWSCredentialStatusSchema,
  analytics,
  coder,
  config,
  browser,
  devtools,
  drafts,
  uiLayouts,
  desktop,
  general,
  menu,
  agentPlugins,
  agentSkills,
  agents,
  workflows,
  nameGeneration,
  projects,
  mcpOauth,
  mcp,
  memory,
  refinements,
  secrets,
  CustomProviderMutationErrorSchema,
  ProviderConfigInfoSchema,
  ProviderModelDiscoveryResultSchema,
  ProviderModelEntrySchema,
  ModelCatalogEntrySchema,
  ModelCatalogSearchInputSchema,
  ModelCatalogSearchResultSchema,
  muxGateway,
  muxGatewayOauth,
  copilotOauth,
  codexOauth,
  coderOauth,
  providers,
  ProvidersConfigMapSchema,
  server,
  ServerAuthSessionSchema,
  serverAuth,
  splashScreens,
  tasks,
  experiments,
  telemetry,
  ssh,
  terminal,
  tokenizer,
  update,
  voice,
  window,
  workspace,
} from "./schemas/api";
export type { WorkspaceSendMessageOutput } from "./schemas/api";
