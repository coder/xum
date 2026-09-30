import { useState, type ReactNode } from "react";
import {
  AlertCircle,
  BarChart3,
  Brain,
  ChevronRight,
  Settings,
  Shield,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { CopyButton } from "@/browser/components/CopyButton/CopyButton";
import { cn } from "@/common/lib/utils";
import type {
  DevToolsInputTokenBreakdown,
  DevToolsOutputTokenBreakdown,
  DevToolsStep,
  DevToolsUsage,
} from "@/common/types/devtools";
import { getTokenTotal } from "@/common/types/devtools";
import { assertNever } from "@/common/utils/assertNever";
import { formatDuration } from "@/common/utils/formatDuration";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import { truncateToFirstLine } from "./devToolsStepCardHelpers";

const PRE_CLASS_NAME =
  "whitespace-pre-wrap break-words text-[10px] text-muted bg-background-primary rounded border border-border-light p-2 mt-1 max-h-[220px] overflow-auto min-w-0";
const ROLE_COLORS: Record<string, string> = {
  system: "bg-neutral-500/20 text-neutral-400",
  user: "bg-blue-500/20 text-blue-400",
  assistant: "bg-green-500/20 text-green-400",
  tool: "bg-violet-500/20 text-violet-400",
};
const DEFAULT_ROLE_COLOR = "bg-neutral-500/20 text-neutral-400";
const POLICY_ACTION_STYLES: Record<ToolPolicy[number]["action"], string> = {
  require: "bg-blue-500/20 text-blue-400",
  disable: "bg-red-500/20 text-red-400",
  enable: "bg-green-500/20 text-green-400",
};

type MetadataSection = "tools" | "options" | "usage" | "policy";
type RawViewMode = "ai-sdk" | "provider";

interface ParsedTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

interface DevToolsStepCardProps {
  step: DevToolsStep;
  toolPolicy?: ToolPolicy;
}

export function DevToolsStepCard(props: DevToolsStepCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [activeMetadataSection, setActiveMetadataSection] = useState<MetadataSection | null>(null);

  const tools = extractTools(props.step.input?.tools);
  const tokenSummary = formatStepTokenSummary(props.step.usage);
  const safeToolPolicy = sanitizeToolPolicy(props.toolPolicy);

  const toggleMetadataSection = (section: MetadataSection): void => {
    setActiveMetadataSection((previous) => (previous === section ? null : section));
  };

  return (
    <div className="border-border-light bg-background min-w-0 rounded border">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="hover:bg-hover flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left"
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 transition-transform", expanded && "rotate-90")}
        />
        <span className="text-foreground text-xs font-medium">Step {props.step.stepNumber}</span>
        <span className="text-muted min-w-0 truncate text-[10px]">{props.step.modelId}</span>
        {props.step.durationMs != null && (
          <span className="text-muted text-[10px]">
            {formatDuration(props.step.durationMs, "precise")}
          </span>
        )}
        {tokenSummary != null && <span className="text-muted text-[10px]">{tokenSummary}</span>}
        {props.step.error && <AlertCircle className="text-destructive ml-auto h-3 w-3 shrink-0" />}
      </button>

      {expanded && (
        <div className="border-border-light min-w-0 border-t px-2 py-1.5">
          <MetadataBar
            step={props.step}
            tools={tools}
            toolPolicy={safeToolPolicy ?? undefined}
            activeSection={activeMetadataSection}
            onToggleSection={toggleMetadataSection}
          />

          {activeMetadataSection != null && (
            <MetadataSectionContent
              section={activeMetadataSection}
              step={props.step}
              tools={tools}
              toolPolicy={safeToolPolicy ?? undefined}
            />
          )}

          <div className="border-border-light mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 border-t pt-2">
            <div className="border-border-light min-w-0 border-r pr-2">
              <p className="text-muted text-[9px] font-semibold tracking-wide uppercase">Input</p>
              <StepInputPanel step={props.step} />
            </div>

            <div className="min-w-0 pl-0.5">
              <p className="text-muted text-[9px] font-semibold tracking-wide uppercase">Output</p>
              <StepOutputPanel step={props.step} />
            </div>
          </div>

          <RequestResponseSection step={props.step} />
        </div>
      )}
    </div>
  );
}

function MetadataBar(props: {
  step: DevToolsStep;
  tools: ParsedTool[];
  toolPolicy?: ToolPolicy;
  activeSection: MetadataSection | null;
  onToggleSection: (section: MetadataSection) => void;
}) {
  const details: string[] = [];
  if (props.step.input?.maxOutputTokens != null) {
    details.push(`max tokens: ${props.step.input.maxOutputTokens.toLocaleString()}`);
  }

  if (props.step.input?.toolChoice != null) {
    details.push(
      `tool choice: ${truncateString(formatToolChoice(props.step.input.toolChoice), 64)}`
    );
  }

  const hasProviderOptions = props.step.input?.providerOptions != null;
  const hasUsage = props.step.usage != null;
  const hasToolPolicy = props.toolPolicy != null && props.toolPolicy.length > 0;
  const hasPills = props.tools.length > 0 || hasProviderOptions || hasUsage || hasToolPolicy;

  return (
    <div className="border-border-light bg-background-primary flex min-w-0 flex-wrap items-center gap-1 rounded border px-2 py-1">
      {props.step.provider != null && props.step.provider.length > 0 && (
        <span className="min-w-0 rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-medium break-all text-blue-400">
          {props.step.provider}
        </span>
      )}

      <span className="font-monospace text-muted min-w-0 text-[10px] break-all">
        {props.step.modelId}
      </span>

      {details.map((detail, index) => (
        <span key={`${detail}-${index}`} className="flex items-center gap-1">
          <span className="text-muted text-[10px]">·</span>
          <span className="text-muted text-[10px]">{detail}</span>
        </span>
      ))}

      {hasPills && (
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
          {props.tools.length > 0 && (
            <MetadataPill
              icon={Wrench}
              label={`${props.tools.length} available tools`}
              active={props.activeSection === "tools"}
              onClick={() => props.onToggleSection("tools")}
            />
          )}

          {hasProviderOptions && (
            <MetadataPill
              icon={Settings}
              label="Provider options"
              active={props.activeSection === "options"}
              onClick={() => props.onToggleSection("options")}
            />
          )}

          {hasUsage && (
            <MetadataPill
              icon={BarChart3}
              label="Usage"
              active={props.activeSection === "usage"}
              onClick={() => props.onToggleSection("usage")}
            />
          )}

          {hasToolPolicy && (
            <MetadataPill
              icon={Shield}
              label={`${props.toolPolicy?.length ?? 0} policy rules`}
              active={props.activeSection === "policy"}
              onClick={() => props.onToggleSection("policy")}
            />
          )}
        </div>
      )}
    </div>
  );
}

function MetadataPill(props: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = props.icon;

  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "inline-flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px]",
        props.active
          ? "bg-hover text-foreground"
          : "text-muted hover:bg-hover/70 hover:text-foreground"
      )}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="min-w-0 break-words">{props.label}</span>
    </button>
  );
}

function MetadataSectionContent(props: {
  section: MetadataSection;
  step: DevToolsStep;
  tools: ParsedTool[];
  toolPolicy?: ToolPolicy;
}) {
  switch (props.section) {
    case "tools":
      return <AvailableToolsSection tools={props.tools} />;
    case "options":
      return <ProviderOptionsSection providerOptions={props.step.input?.providerOptions} />;
    case "usage":
      return props.step.usage != null ? (
        <TokenUsageSection usage={props.step.usage} />
      ) : (
        <p className="text-muted mt-1 text-[10px]">No usage recorded</p>
      );
    case "policy":
      return props.toolPolicy != null && props.toolPolicy.length > 0 ? (
        <ToolPolicySection policy={props.toolPolicy} />
      ) : (
        <p className="text-muted mt-1 text-[10px]">No policy configured</p>
      );
    default:
      return assertNever(props.section);
  }
}

function AvailableToolsSection(props: { tools: ParsedTool[] }) {
  if (props.tools.length === 0) {
    return <p className="text-muted mt-1 text-[10px]">No tools available</p>;
  }

  return (
    <div className="mt-1 flex min-w-0 flex-col gap-1">
      {props.tools.map((tool, index) => (
        <div
          key={`${tool.name}-${index}`}
          className="border-border-light bg-background-primary min-w-0 rounded border p-2"
        >
          <div className="flex min-w-0 items-center gap-1">
            <Wrench className="h-3 w-3 shrink-0 text-violet-500" />
            <span className="text-foreground min-w-0 text-[10px] font-semibold break-all">
              {tool.name}
            </span>
          </div>

          {tool.description != null && tool.description.length > 0 && (
            <p className="text-muted mt-1 text-[10px] break-words">{tool.description}</p>
          )}

          {tool.parameters != null && (
            <div className="mt-1">
              <p className="text-muted text-[9px] font-semibold tracking-wide uppercase">
                Parameters
              </p>
              <JsonBlock data={tool.parameters} maxHeight="160px" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ToolPolicySection(props: { policy: ToolPolicy }) {
  return (
    <div className="mt-1 flex min-w-0 flex-col gap-1">
      {props.policy.map((filter, index) => (
        <div
          key={`${filter.regex_match}-${index}`}
          className="border-border-light bg-background-primary flex min-w-0 items-center gap-2 rounded border px-2 py-1"
        >
          <code className="text-foreground font-monospace min-w-0 flex-1 text-[10px] break-all">
            {filter.regex_match}
          </code>
          <span
            className={cn(
              "ml-auto shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase",
              POLICY_ACTION_STYLES[filter.action]
            )}
          >
            {filter.action}
          </span>
        </div>
      ))}
    </div>
  );
}

function sanitizeToolPolicy(value: unknown): ToolPolicy | null {
  // DevTools runs are replayed from JSONL without strict runtime schema checks.
  // Filter malformed policy values so opening the Policy section never crashes.
  if (!Array.isArray(value)) {
    return null;
  }

  const sanitized: ToolPolicy = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const regexMatch = entry.regex_match;
    const action = entry.action;
    if (typeof regexMatch !== "string") {
      continue;
    }
    if (action !== "enable" && action !== "disable" && action !== "require") {
      continue;
    }

    sanitized.push({ regex_match: regexMatch, action });
  }

  return sanitized.length > 0 ? sanitized : null;
}
function ProviderOptionsSection(props: { providerOptions: unknown }) {
  return (
    <div className="mt-1">
      <JsonBlock data={props.providerOptions} emptyMessage="No provider options captured" />
    </div>
  );
}

function TokenUsageSection(props: { usage: DevToolsUsage }) {
  const inputTotal = getTokenTotal(props.usage.inputTokens);
  const outputTotal = getTokenTotal(props.usage.outputTokens);
  const inputBreakdown = isInputTokenBreakdown(props.usage.inputTokens)
    ? props.usage.inputTokens
    : null;
  const outputBreakdown = isOutputTokenBreakdown(props.usage.outputTokens)
    ? props.usage.outputTokens
    : null;

  return (
    <div className="border-border-light bg-background-primary mt-1 rounded border p-2">
      <div className="grid grid-cols-2 gap-2">
        <TokenUsageCard
          title="Input Tokens"
          total={inputTotal}
          lines={[
            { label: "No cache", value: inputBreakdown?.noCache },
            { label: "Cache read", value: inputBreakdown?.cacheRead },
            { label: "Cache write", value: inputBreakdown?.cacheWrite },
          ]}
        />

        <TokenUsageCard
          title="Output Tokens"
          total={outputTotal}
          lines={[
            { label: "Text", value: outputBreakdown?.text },
            { label: "Reasoning", value: outputBreakdown?.reasoning },
          ]}
        />
      </div>

      <p className="text-muted mt-2 text-[10px]">
        Total:{" "}
        {formatTokenCount(props.usage.totalTokens ?? getCombinedTotal(inputTotal, outputTotal))}
      </p>

      {props.usage.raw != null && (
        <div className="mt-2">
          <p className="text-muted text-[9px] font-semibold tracking-wide uppercase">
            Raw Provider Usage
          </p>
          <JsonBlock data={props.usage.raw} maxHeight="160px" />
        </div>
      )}
    </div>
  );
}

function TokenUsageCard(props: {
  title: string;
  total: number | undefined;
  lines: Array<{ label: string; value: number | undefined }>;
}) {
  const linesToRender = props.lines.filter((line) => line.value != null);

  return (
    <div className="border-border-light bg-background rounded border p-2">
      <p className="text-muted text-[9px] font-semibold tracking-wide uppercase">{props.title}</p>
      <p className="text-foreground text-sm font-semibold">{formatTokenCount(props.total)}</p>
      {linesToRender.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {linesToRender.map((line) => (
            <p key={line.label} className="text-muted text-[10px]">
              {line.label}: {formatTokenCount(line.value)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function StepInputPanel(props: { step: DevToolsStep }) {
  const [showAllMessages, setShowAllMessages] = useState(false);
  const prompt = props.step.input?.prompt;

  if (!isUnknownArray(prompt)) {
    if (props.step.input == null) {
      return <p className="text-muted mt-1 text-[10px]">No input recorded</p>;
    }

    return (
      <div className="mt-1">
        <JsonBlock data={props.step.input} emptyMessage="No input captured" />
      </div>
    );
  }

  if (prompt.length === 0) {
    return <p className="text-muted mt-1 text-[10px]">No prompt messages</p>;
  }

  const visibleMessages = showAllMessages ? prompt : prompt.slice(Math.max(0, prompt.length - 2));

  return (
    <div className="mt-1 flex min-w-0 flex-col gap-1">
      {prompt.length > 2 && (
        <button
          type="button"
          onClick={() => setShowAllMessages(!showAllMessages)}
          className="text-link self-start text-[10px] hover:underline"
        >
          {showAllMessages ? "Show latest 2 messages" : `Show all ${prompt.length} messages`}
        </button>
      )}

      {visibleMessages.map((message, index) => (
        <MessagePreview key={`${props.step.id}-message-${index}`} message={message} />
      ))}
    </div>
  );
}

function StepOutputPanel(props: { step: DevToolsStep }) {
  const textParts = props.step.output?.textParts ?? [];
  const reasoningParts = props.step.output?.reasoningParts ?? [];
  const toolCalls = props.step.output?.toolCalls ?? [];
  const finishReason = props.step.output?.finishReason;

  const hasOutput =
    textParts.length > 0 ||
    reasoningParts.length > 0 ||
    toolCalls.length > 0 ||
    props.step.output?.content != null ||
    finishReason != null ||
    props.step.error != null;

  if (!hasOutput) {
    return <p className="text-muted mt-1 text-[10px]">No output recorded</p>;
  }

  return (
    <div className="mt-1 flex min-w-0 flex-col gap-1.5">
      {reasoningParts.map((reasoningPart) => (
        <ReasoningBlock key={reasoningPart.id} text={reasoningPart.text} />
      ))}

      {toolCalls.map((toolCall, index) => {
        const toolCallRecord = isRecord(toolCall) ? toolCall : null;
        const toolCallId =
          toolCallRecord != null && typeof toolCallRecord.toolCallId === "string"
            ? toolCallRecord.toolCallId
            : `${props.step.id}-tool-${index}`;

        return <ToolCallCard key={toolCallId} toolCall={toolCall} />;
      })}

      {textParts.map((textPart) => (
        <div key={textPart.id}>
          <p className="text-foreground text-[10px] font-semibold">Text</p>
          <pre className={PRE_CLASS_NAME}>{textPart.text}</pre>
        </div>
      ))}

      {textParts.length === 0 && props.step.output?.content != null && (
        <div>
          <p className="text-foreground text-[10px] font-semibold">Content</p>
          <pre className={PRE_CLASS_NAME}>{extractDisplayContent(props.step.output.content)}</pre>
        </div>
      )}

      {finishReason != null && (
        <p className="text-muted text-[10px]">Finish reason: {finishReason}</p>
      )}

      {props.step.error != null && (
        <p className="text-destructive text-[10px] break-all">Error: {props.step.error}</p>
      )}
    </div>
  );
}

function RequestResponseSection(props: { step: DevToolsStep }) {
  const [expanded, setExpanded] = useState(false);
  const [viewMode, setViewMode] = useState<RawViewMode>("ai-sdk");

  const requestData =
    viewMode === "ai-sdk"
      ? (props.step.input ?? props.step.rawRequest)
      : extractProviderRequest(props.step);
  const responseData =
    viewMode === "ai-sdk"
      ? (props.step.output ?? props.step.rawResponse)
      : Array.isArray(props.step.rawChunks) && props.step.rawChunks.length > 0
        ? props.step.rawChunks
        : props.step.rawResponse;

  return (
    <div className="border-border-light mt-2 min-w-0 border-t pt-1.5">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="hover:bg-hover flex w-full min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left"
      >
        <ChevronRight
          className={cn(
            "text-muted h-3 w-3 shrink-0 transition-transform",
            expanded && "rotate-90"
          )}
        />
        <span className="text-foreground text-[10px] font-semibold">Request / Response</span>
      </button>

      {expanded && (
        <div className="mt-1 min-w-0">
          <div className="flex items-center gap-1 px-1 pb-1">
            <ToggleButton
              active={viewMode === "ai-sdk"}
              onClick={() => setViewMode("ai-sdk")}
              label="AI SDK"
            />
            <ToggleButton
              active={viewMode === "provider"}
              onClick={() => setViewMode("provider")}
              label="Provider"
            />
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
            <div className="min-w-0">
              <p className="text-muted text-[9px] font-semibold tracking-wide uppercase">Request</p>
              <JsonBlock data={requestData} emptyMessage="No request captured" />
            </div>
            <div className="min-w-0">
              <p className="text-muted text-[9px] font-semibold tracking-wide uppercase">
                {formatRawResponseLabel(viewMode, props.step)}
              </p>
              <JsonBlock data={responseData} emptyMessage="No response captured" />
            </div>
          </div>

          {viewMode === "provider" &&
            props.step.requestHeaders != null &&
            Object.keys(props.step.requestHeaders).length > 0 && (
              <div className="mt-2 min-w-0">
                <p className="text-muted text-[9px] font-semibold tracking-wide uppercase">
                  Request Headers
                </p>
                <JsonBlock data={props.step.requestHeaders} maxHeight="120px" />
              </div>
            )}

          {viewMode === "provider" &&
            props.step.responseHeaders != null &&
            Object.keys(props.step.responseHeaders).length > 0 && (
              <div className="mt-2 min-w-0">
                <p className="text-muted text-[9px] font-semibold tracking-wide uppercase">
                  Response Headers
                </p>
                <JsonBlock data={props.step.responseHeaders} maxHeight="120px" />
              </div>
            )}
        </div>
      )}
    </div>
  );
}

function ToggleButton(props: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px]",
        props.active
          ? "bg-hover text-foreground"
          : "text-muted hover:bg-hover/70 hover:text-foreground"
      )}
    >
      {props.label}
    </button>
  );
}

function JsonBlock(props: { data: unknown; emptyMessage?: string; maxHeight?: string }) {
  const text =
    props.data != null
      ? stringifyForDisplay(props.data)
      : (props.emptyMessage ?? "No data captured");

  return (
    <div className="group relative mt-1 min-w-0">
      <pre
        className={PRE_CLASS_NAME}
        style={props.maxHeight != null ? { maxHeight: props.maxHeight } : {}}
      >
        {text}
      </pre>
      <div className="absolute top-1 right-1 opacity-0 transition-opacity group-hover:opacity-100">
        <CopyButton text={text} className="!p-1" />
      </div>
    </div>
  );
}

/**
 * Keep DevTools expansion affordances consistent: tool calls, prompt messages, and
 * reasoning blocks all use the same chevron + preview interaction pattern.
 */
function CollapsibleCard(props: {
  icon: ReactNode;
  label?: ReactNode;
  preview: string;
  borderColorClass: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={cn(
        "bg-background-primary min-w-0 rounded border border-l-2 px-2 py-1",
        props.borderColorClass
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="hover:bg-hover/50 flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left"
      >
        {props.icon}
        {props.label}
        {!expanded && props.preview.length > 0 && (
          <span className="text-muted min-w-0 flex-1 truncate text-[10px]">{props.preview}</span>
        )}
        <ChevronRight
          className={cn(
            "text-muted ml-auto h-2.5 w-2.5 shrink-0 transition-transform",
            expanded && "rotate-90"
          )}
        />
      </button>

      {expanded && <div className="mt-1 min-w-0">{props.children}</div>}
    </div>
  );
}

function ToolCallCard(props: { toolCall: unknown }) {
  const toolCallRecord = isRecord(props.toolCall) ? props.toolCall : null;
  const toolName =
    toolCallRecord != null && typeof toolCallRecord.toolName === "string"
      ? toolCallRecord.toolName
      : "unknown";
  const args = toolCallRecord?.args;

  return (
    <CollapsibleCard
      icon={<Wrench className="h-3 w-3 shrink-0 text-violet-500" />}
      label={
        <span className="text-foreground min-w-0 flex-1 truncate text-[10px] font-semibold">
          {toolName}
        </span>
      }
      preview={formatArgsPreview(args)}
      borderColorClass="border-violet-500/30"
    >
      <JsonBlock data={args} emptyMessage="No arguments" maxHeight="150px" />
    </CollapsibleCard>
  );
}

function MessagePreview(props: { message: unknown }) {
  const role = getPromptRole(props.message);
  const content = extractDisplayContent(getPromptContent(props.message));

  return (
    <CollapsibleCard
      icon={<RoleBadge role={role} />}
      preview={truncateToFirstLine(content, 80)}
      borderColorClass="border-border-light"
    >
      <pre className="text-muted max-h-[220px] min-w-0 overflow-auto text-[10px] break-words whitespace-pre-wrap">
        {content}
      </pre>
    </CollapsibleCard>
  );
}

function RoleBadge(props: { role: string }) {
  const normalizedRole = props.role.toLowerCase();
  const colorClass = ROLE_COLORS[normalizedRole] ?? DEFAULT_ROLE_COLOR;

  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase", colorClass)}>
      {normalizedRole}
    </span>
  );
}

function ReasoningBlock(props: { text: string }) {
  return (
    <CollapsibleCard
      icon={<Brain className="h-3 w-3 shrink-0 text-amber-500" />}
      label={<span className="text-foreground min-w-0 text-[10px] font-medium">Thinking</span>}
      preview={truncateToFirstLine(props.text, 80)}
      borderColorClass="border-amber-500/30"
    >
      <pre className="text-muted max-h-[220px] min-w-0 overflow-auto text-[10px] break-words whitespace-pre-wrap">
        {props.text}
      </pre>
    </CollapsibleCard>
  );
}

function formatStepTokenSummary(usage: DevToolsUsage | null): string | null {
  if (usage == null || (usage.inputTokens == null && usage.outputTokens == null)) {
    return null;
  }

  const input =
    usage.inputTokens != null ? formatTokenCount(getTokenTotal(usage.inputTokens)) : "?";
  const output =
    usage.outputTokens != null ? formatTokenCount(getTokenTotal(usage.outputTokens)) : "?";

  return `${input}→${output} tok`;
}

function getCombinedTotal(
  inputTotal: number | undefined,
  outputTotal: number | undefined
): number | undefined {
  if (inputTotal == null && outputTotal == null) {
    return undefined;
  }

  return (inputTotal ?? 0) + (outputTotal ?? 0);
}

function formatTokenCount(value: number | undefined): string {
  return value == null ? "—" : value.toLocaleString();
}

function formatRawResponseLabel(viewMode: RawViewMode, step: DevToolsStep): string {
  switch (viewMode) {
    case "ai-sdk":
      return "Response";
    case "provider":
      return step.rawChunks != null ? "Stream" : "Response";
    default:
      return assertNever(viewMode);
  }
}

function truncateString(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function formatArgsPreview(args: unknown): string {
  if (!isRecord(args)) {
    const value = formatPreviewValue(args);
    return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  }

  const entries = Object.entries(args);
  if (entries.length === 0) {
    return "{}";
  }

  const previewParts = entries.slice(0, 3).map(([key, value]) => {
    const previewValue = formatPreviewValue(value);
    const truncatedValue =
      previewValue.length > 30 ? `${previewValue.slice(0, 30)}…` : previewValue;
    return `${key}: ${truncatedValue}`;
  });

  if (entries.length > 3) {
    previewParts.push("…");
  }

  return previewParts.join(", ");
}

function formatPreviewValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return String(value);
  }

  return stringifyForDisplay(value).replace(/\s+/g, " ").trim();
}

function extractDisplayContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];

    for (const part of content) {
      const displayPart = extractDisplayContentPart(part);
      if (displayPart != null && displayPart.length > 0) {
        textParts.push(displayPart);
      }
    }

    return textParts.join("\n");
  }

  const singlePartDisplay = extractDisplayContentPart(content);
  if (singlePartDisplay != null && singlePartDisplay.length > 0) {
    return singlePartDisplay;
  }

  return stringifyForDisplay(content);
}

function extractDisplayContentPart(part: unknown): string | null {
  if (typeof part === "string") {
    return part;
  }

  if (!isRecord(part)) {
    return stringifyForDisplay(part);
  }

  if (isProviderOptionsOnlyContentPart(part)) {
    return null;
  }

  if (part.type === "text" && typeof part.text === "string") {
    return part.text;
  }

  if (part.type === "reasoning" && typeof part.text === "string") {
    return `[Thinking] ${part.text}`;
  }

  if (part.type === "tool-result" && typeof part.toolName === "string") {
    const output = extractToolResultOutput(part.output);
    return `[Tool Result: ${part.toolName}]\n${stringifyForDisplay(output)}`;
  }

  if (typeof part.type === "string") {
    return `[${part.type}]`;
  }

  return stringifyForDisplay(part);
}

function isProviderOptionsOnlyContentPart(part: Record<string, unknown>): boolean {
  return Object.keys(part).every((key) => key === "providerOptions") && "providerOptions" in part;
}

function extractToolResultOutput(output: unknown): unknown {
  if (isRecord(output) && output.type === "json" && "value" in output) {
    return output.value;
  }

  return output;
}

function extractTools(tools: unknown): ParsedTool[] {
  if (Array.isArray(tools)) {
    return tools
      .map((tool, index) => parseTool(tool, `tool-${index + 1}`))
      .filter((tool): tool is ParsedTool => tool != null);
  }

  if (!isRecord(tools)) {
    return [];
  }

  return Object.entries(tools)
    .map(([name, value]) => parseTool(value, name) ?? { name, parameters: value })
    .filter((tool) => tool.name.length > 0);
}

function parseTool(tool: unknown, fallbackName: string): ParsedTool | null {
  if (!isRecord(tool)) {
    return {
      name: fallbackName,
      parameters: tool,
    };
  }

  const toolName =
    getNonEmptyString(tool.name) ?? getNonEmptyString(tool.toolName) ?? getNonEmptyString(tool.id);

  const parameters =
    tool.parameters ?? tool.inputSchema ?? tool.schema ?? tool.argsSchema ?? tool.input;

  return {
    name: toolName ?? fallbackName,
    description: getNonEmptyString(tool.description) ?? undefined,
    parameters,
  };
}

function formatToolChoice(toolChoice: unknown): string {
  if (typeof toolChoice === "string") {
    return toolChoice;
  }

  if (!isRecord(toolChoice)) {
    return stringifyForDisplay(toolChoice);
  }

  const type = getNonEmptyString(toolChoice.type);
  const toolName = getNonEmptyString(toolChoice.toolName) ?? getNonEmptyString(toolChoice.name);

  if (type === "tool" && toolName != null) {
    return `tool (${toolName})`;
  }

  if (type != null) {
    return type;
  }

  if (toolName != null) {
    return toolName;
  }

  return stringifyForDisplay(toolChoice);
}

function extractProviderRequest(step: DevToolsStep): unknown {
  const rawRequest = step.rawRequest;
  if (!isRecord(rawRequest)) {
    return rawRequest;
  }

  if ("providerRequest" in rawRequest) {
    return rawRequest.providerRequest;
  }

  if ("raw" in rawRequest) {
    return rawRequest.raw;
  }

  if ("body" in rawRequest) {
    return rawRequest.body;
  }

  return rawRequest;
}

function getNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringifyForDisplay(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined) {
    return "undefined";
  }

  try {
    const json = JSON.stringify(value, null, 2);
    return json ?? "null";
  } catch (error) {
    return error instanceof Error
      ? `Unable to format value: ${error.message}`
      : "Unable to format value";
  }
}

function isInputTokenBreakdown(
  value: number | DevToolsInputTokenBreakdown | undefined
): value is DevToolsInputTokenBreakdown {
  return isRecord(value) && typeof value.total === "number";
}

function isOutputTokenBreakdown(
  value: number | DevToolsOutputTokenBreakdown | undefined
): value is DevToolsOutputTokenBreakdown {
  return isRecord(value) && typeof value.total === "number";
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getPromptRole(value: unknown): string {
  if (!isRecord(value)) {
    return "unknown";
  }

  const role = value.role;
  return typeof role === "string" ? role : "unknown";
}

function getPromptContent(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  if (!("content" in value)) {
    return value;
  }

  return value.content;
}
