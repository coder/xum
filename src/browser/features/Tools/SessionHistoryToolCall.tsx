import React from "react";
import {
  CircleDot,
  GitBranch,
  Layers,
  RefreshCcw,
  Shrink,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/common/lib/utils";
import type { SessionHistoryToolArgs, SessionHistoryToolResult } from "@/common/types/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { escapeRegex } from "@/browser/utils/highlighting/highlightSearchTerms";
import { JsonHighlight } from "./Shared/HighlightedCode";
import {
  DetailContent,
  DetailLabel,
  ErrorBox,
  ExpandIcon,
  LoadingDots,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolIcon,
} from "./Shared/ToolPrimitives";
import { redactToolResultAttachmentsForDisplay } from "./Shared/toolResultDisplay";
import {
  getStatusDisplay,
  normalizeToolResultForRendering,
  unwrapResult,
  useToolExpansion,
  type ToolStatus,
} from "./Shared/toolUtils";

/**
 * Transcript card for the `session_history` tool, which reads earlier context windows back
 * after a rollover. The header states the action, the query or target, and the result count.
 * Expanded, the request shows as filter chips and each action gets its own view: a window
 * rail for list_windows, rows grouped by window for search/list_items, and a paged excerpt
 * for read_item. Raw JSON stays one click away.
 *
 * Mirrors the backend (TOOL_DEFINITIONS.session_history / session_history.ts): results are
 * validated against the tool's result schema because they flow verbatim from persisted
 * transcripts; a malformed result degrades to a status note plus the raw JSON.
 */

type SessionHistoryAction = SessionHistoryToolArgs["action"];
type SessionHistoryItem = NonNullable<SessionHistoryToolResult["items"]>[number];
type SessionHistoryWindow = NonNullable<SessionHistoryToolResult["windows"]>[number];
type SessionHistoryWarning = NonNullable<SessionHistoryToolResult["warnings"]>[number];

const ACTION_VERBS: Record<SessionHistoryAction, string> = {
  list_windows: "List windows",
  list_items: "List items",
  search: "Search",
  read_item: "Read item",
};

// Error codes documented on the result schema. Unknown codes render verbatim.
const ERROR_MESSAGES: Record<string, string> = {
  query_required: "search needs a query.",
  item_id_required: "read_item needs an item_id.",
  filters_unsupported:
    "This action does not accept role, tool_name, max_chars_per_item or recent_first.",
  task_not_found: "No readable sub-agent history for this task.",
  session_unavailable: "That session's history has been removed.",
  item_not_found: "No row with that item_id in this history.",
  history_changed: "History changed while reading.",
  history_timeout: "The read did not finish in time.",
  history_unavailable: "History could not be read.",
};

const WARNING_MESSAGES: Record<SessionHistoryWarning, string> = {
  oversized_rows_skipped: "Some rows were too large to read and were skipped.",
  malformed_rows_skipped: "Some rows were malformed and were skipped.",
};

interface BoundaryPresentation {
  label: string;
  icon: LucideIcon;
  /** Static Tailwind classes (tone ink + tinted border) for the rail node and its chip. */
  tone: string;
}

// boundaryKind is "root" for the first window, otherwise the context-boundary kind that
// opened it (CONTEXT_BOUNDARY_KINDS). Anything else renders its raw kind in ask-mode ink.
const BOUNDARIES: Record<string, BoundaryPresentation> = {
  root: { label: "start", icon: CircleDot, tone: "text-muted border-muted/45" },
  compaction: { label: "compaction", icon: Shrink, tone: "text-plan-mode border-plan-mode/45" },
  reset: { label: "reset", icon: RefreshCcw, tone: "text-warning border-warning/45" },
};

const ROLE_TONES: Record<string, string> = {
  user: "text-foreground border-foreground/35",
  assistant: "text-ask-mode border-ask-mode/35",
  system: "text-muted border-muted/35",
};
const FALLBACK_ROLE_TONE = "text-muted border-muted/35";

/** Own-key lookup: keys come from persisted transcripts, so "constructor" must not hit Object members. */
function lookup<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function boundaryOf(kind: string): BoundaryPresentation {
  return (
    lookup(BOUNDARIES, kind) ?? {
      label: kind,
      icon: Layers,
      tone: "text-ask-mode border-ask-mode/45",
    }
  );
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

function plural(n: number, more: boolean, singular: string, pluralForm: string): string {
  return n === 1 && !more ? singular : pluralForm;
}

/**
 * Where the item's text starts in its row, as the backend reported it (startCharOffset).
 * Results persisted before that field existed return null, and the card never infers a start
 * for them: offset_chars can be clamped or rounded back to keep a surrogate pair whole, and a
 * search snippet that reaches the row end may or may not have started mid-row. A start that
 * contradicts the reported continuation is ignored the same way.
 */
function startOf(item: SessionHistoryItem): number | null {
  const start = item.startCharOffset;
  if (start == null) return null;
  if (item.nextCharOffset != null && item.nextCharOffset !== start + item.text.length) return null;
  return start;
}

/** Returned characters: an exact `chars X–Y` range when the start is known, else a count. */
function charsLabel(item: SessionHistoryItem): string {
  const start = startOf(item);
  return start == null
    ? `${formatCount(item.text.length)} chars`
    : `chars ${formatCount(start)}–${formatCount(start + item.text.length)}`;
}

function countLabel(
  args: SessionHistoryToolArgs,
  result: SessionHistoryToolResult | null
): string | null {
  if (!result?.success) return null;
  const action = args.action;
  const more = result.has_more === true;
  const suffix = more ? "+" : "";
  if (action === "list_windows") {
    const n = result.windows?.length ?? 0;
    return `${n}${suffix} ${plural(n, more, "window", "windows")}`;
  }
  const items = result.items ?? [];
  if (action === "read_item") {
    const item = items.at(0);
    return item == null ? null : charsLabel(item);
  }
  const n = items.length;
  return action === "search"
    ? `${n}${suffix} ${plural(n, more, "match", "matches")}`
    : `${n}${suffix} ${plural(n, more, "item", "items")}`;
}

function parseResult(result: unknown): SessionHistoryToolResult | null {
  // normalizeToolResultForRendering unwraps the SDK JSON container, strips hook fields and
  // maps a nested bare `{ error }` onto `{ success: false, error }`.
  const parsed = TOOL_DEFINITIONS.session_history.resultSchema.safeParse(
    normalizeToolResultForRendering(result)
  );
  return parsed.success ? parsed.data : null;
}

// Labels can come from persisted results (unknown roles/boundary kinds), so the chip is
// bounded by its container and shrinks, truncating its text, instead of widening the row.
const Chip: React.FC<{ tone: string; icon?: LucideIcon; children: React.ReactNode }> = (props) => {
  const Icon = props.icon;
  return (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1 rounded border px-1 py-0.5 text-[9px] leading-none font-medium uppercase",
        props.tone
      )}
    >
      {Icon && <Icon aria-hidden="true" className="h-[9px] w-[9px] shrink-0" />}
      <span className="min-w-0 truncate">{props.children}</span>
    </span>
  );
};

/** Marks text cut off before or after the returned characters. */
const Cut: React.FC = () => <span className="text-muted">…</span>;

const SectionLabel: React.FC<{ children: React.ReactNode }> = (props) => (
  <div className="text-muted mb-1.5 text-[10px] tracking-wide uppercase">{props.children}</div>
);

/** Header summary: what the call looked for. */
const HeaderSummary: React.FC<{ args: SessionHistoryToolArgs }> = (props) => {
  const { action, query, item_id: itemId, window_id: windowId } = props.args;
  if (action === "search" && query) {
    return <span className="text-foreground min-w-0 truncate">“{query}”</span>;
  }
  const target = action === "read_item" ? itemId : action === "list_items" ? windowId : null;
  if (!target) return null;
  return <span className="text-muted min-w-0 truncate text-[10px]">{target}</span>;
};

/** The request as readable filter chips instead of a JSON blob. */
const ScopeChips: React.FC<{ args: SessionHistoryToolArgs }> = (props) => {
  const args = props.args;
  const chips: Array<[string, string]> = [];
  if (args.task_id) chips.push(["task", args.task_id]);
  // list_items already names its window in the header.
  if (args.window_id && args.action !== "list_items") chips.push(["window", args.window_id]);
  if (args.role) chips.push(["role", args.role]);
  if (args.tool_name) chips.push(["tool", args.tool_name]);
  if (args.recent_first) chips.push(["order", "newest first"]);
  if (args.limit != null) chips.push(["limit", formatCount(args.limit)]);
  if (args.max_chars_per_item != null) {
    chips.push(["snippet", `${formatCount(args.max_chars_per_item)} chars`]);
  }
  if (args.offset_chars != null) chips.push(["offset", formatCount(args.offset_chars)]);
  if (args.limit_chars != null) chips.push(["page", `${formatCount(args.limit_chars)} chars`]);
  if (chips.length === 0) return null;
  return (
    <div
      data-testid="session-history-scope"
      className="flex min-w-0 flex-wrap items-center gap-1.5"
    >
      {chips.map(([key, value]) => (
        <span
          key={key}
          className="inline-flex max-w-full min-w-0 items-center gap-1 rounded border border-white/10 px-1.5 py-px text-[10px]"
        >
          <span className="text-muted shrink-0">{key}</span>
          <span className="text-foreground min-w-0 truncate">{value}</span>
        </span>
      ))}
    </div>
  );
};

/**
 * Lights every case-insensitive literal occurrence of the query, matching the backend's
 * escaped `iu` search. React nodes, not HTML strings: history text is attacker-controlled.
 */
const HighlightedText: React.FC<{ text: string; query: string | null }> = (props) => {
  if (!props.query) return <>{props.text}</>;
  // The capture group makes split() keep matches at odd indices.
  const parts = props.text.split(new RegExp(`(${escapeRegex(props.query)})`, "giu"));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-ask-mode/30 text-foreground rounded-[2px] px-px">
            {part}
          </mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        )
      )}
    </>
  );
};

/** list_windows: a vertical rail of context windows, each opened by its boundary. */
const WindowRail: React.FC<{ windows: SessionHistoryWindow[]; recentFirst: boolean }> = (props) => {
  const maxItems = Math.max(1, ...props.windows.map((w) => w.itemCount));
  return (
    <div className="bg-code-bg rounded px-3 py-2">
      <SectionLabel>
        Context windows · {props.recentFirst ? "newest first" : "oldest first"}
      </SectionLabel>
      {props.windows.map((entry, i) => {
        const boundary = boundaryOf(entry.boundaryKind);
        const Icon = boundary.icon;
        return (
          <div
            // A window ID can recur (one entry per contiguous run in repaired history).
            key={`${entry.windowId}:${i}`}
            data-testid="session-history-window"
            className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-stretch gap-2.5"
          >
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "bg-background mt-1 flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full border",
                  boundary.tone
                )}
              >
                <Icon aria-hidden="true" className="h-2.5 w-2.5" />
              </span>
              {i < props.windows.length - 1 && <span className="bg-border w-px flex-1" />}
            </div>
            <div className="min-w-0 pt-1 pb-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-foreground min-w-0 truncate">{entry.windowId}</span>
                <Chip tone={boundary.tone}>{boundary.label}</Chip>
              </div>
              <div className="bg-muted/15 mt-[5px] h-[3px] rounded-sm">
                <div
                  className="bg-ask-mode/55 h-full rounded-sm"
                  style={{ width: `${(entry.itemCount / maxItems) * 100}%` }}
                />
              </div>
            </div>
            <span className="text-muted pt-[5px] text-[10px] whitespace-nowrap">
              {formatCount(entry.itemCount)} {entry.itemCount === 1 ? "item" : "items"}
            </span>
          </div>
        );
      })}
    </div>
  );
};

/** list_items / search: rows grouped under their window, snippet with the match lit. */
const ItemList: React.FC<{ items: SessionHistoryItem[]; query: string | null }> = (props) => {
  // Consecutive rows of one window share a group; a recurring window opens a new group.
  const groups: Array<{ windowId: string; items: SessionHistoryItem[] }> = [];
  for (const item of props.items) {
    const last = groups.at(-1);
    if (last?.windowId === item.windowId) last.items.push(item);
    else groups.push({ windowId: item.windowId, items: [item] });
  }
  return (
    <div className="bg-code-bg flex max-h-[320px] flex-col gap-2.5 overflow-y-auto rounded px-3 py-2">
      {/* Rows are snippets: a leading cut is marked only when the result reports a start
          (startCharOffset), a trailing cut when it reports a continuation (nextCharOffset). */}
      <div className="text-muted -mb-1 text-[10px] tracking-wide uppercase">Snippets</div>
      {groups.map((group, gi) => (
        <div key={`${group.windowId}:${gi}`}>
          <div className="mb-1.5 flex min-w-0 items-center gap-2">
            <Layers aria-hidden="true" className="text-muted h-[11px] w-[11px] shrink-0" />
            <span className="text-muted min-w-0 truncate text-[10px]">{group.windowId}</span>
            <span className="border-border min-w-4 flex-1 border-t border-dotted" />
          </div>
          <div className="flex flex-col gap-1.5">
            {group.items.map((item, ii) => (
              <div
                key={`${item.itemId}:${ii}`}
                data-testid="session-history-item"
                className="grid grid-cols-[64px_minmax(0,1fr)] gap-2.5"
              >
                <div className="flex min-w-0 flex-col items-start gap-[3px]">
                  <Chip tone={lookup(ROLE_TONES, item.role) ?? FALLBACK_ROLE_TONE}>
                    {item.role}
                  </Chip>
                  {/* Item IDs are long opaque refs; the full value is in the raw JSON. */}
                  <span className="text-muted max-w-full truncate text-[10px]">{item.itemId}</span>
                </div>
                <div
                  data-testid="session-history-snippet"
                  className="text-foreground min-w-0 font-sans text-[12px] leading-normal break-words whitespace-pre-wrap"
                >
                  {(startOf(item) ?? 0) > 0 && <Cut />}
                  <HighlightedText text={item.text} query={props.query} />
                  {item.nextCharOffset != null && <Cut />}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

/** read_item: one row as a transcript excerpt, with where its character page continues. */
const ReadExcerpt: React.FC<{ item: SessionHistoryItem }> = (props) => {
  const item = props.item;
  return (
    <div data-testid="session-history-excerpt" className="bg-code-bg rounded px-3 py-2">
      <div className="mb-1.5 flex min-w-0 items-center gap-2">
        <Chip tone={lookup(ROLE_TONES, item.role) ?? FALLBACK_ROLE_TONE}>{item.role}</Chip>
        <span className="text-muted min-w-0 truncate text-[10px]">
          {item.itemId} · {item.windowId}
        </span>
      </div>
      <div className="text-foreground max-h-[180px] overflow-y-auto border-l-2 border-white/10 pl-2.5 font-sans text-[12px] leading-[1.55] break-words whitespace-pre-wrap">
        {item.text.length === 0 ? (
          <span className="text-muted italic">No text at the requested offset.</span>
        ) : (
          <>
            {(startOf(item) ?? 0) > 0 && <Cut />}
            {item.text}
            {item.nextCharOffset != null && <Cut />}
          </>
        )}
      </div>
      <div data-testid="session-history-page" className="text-muted mt-1.5 text-[10px]">
        {charsLabel(item)}
        {item.nextCharOffset != null
          ? ` · continues at offset ${formatCount(item.nextCharOffset)}`
          : " · end of item"}
      </div>
    </div>
  );
};

// has_more guidance names only options the action accepts: the backend rejects role and
// tool_name on list_windows, and a smaller limit never reveals omitted results.
const HAS_MORE_NOTES: Record<Exclude<SessionHistoryAction, "read_item">, string> = {
  list_windows: "More windows exist beyond this response.",
  list_items:
    "More rows exist beyond this response. Narrow with window_id, role or tool_name, or walk newest-first with recent_first.",
  search:
    "More matches exist beyond this response. Narrow with window_id, role or tool_name, or walk newest-first with recent_first.",
};

const ResultNotes: React.FC<{ action: SessionHistoryAction; result: SessionHistoryToolResult }> = (
  props
) => {
  const lines: Array<{ key: string; warn: boolean; text: string }> = [];
  // read_item never reports has_more.
  if (props.result.has_more && props.action !== "read_item") {
    lines.push({ key: "more", warn: false, text: HAS_MORE_NOTES[props.action] });
  }
  if (props.result.truncated) {
    lines.push({
      key: "cut",
      warn: false,
      text: "Text was shortened to fit the response size limit.",
    });
  }
  for (const warning of props.result.warnings ?? []) {
    lines.push({ key: warning, warn: true, text: WARNING_MESSAGES[warning] });
  }
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-[3px]">
      {lines.map((line) => (
        <div
          key={line.key}
          className={cn(
            "flex items-start gap-1.5 text-[10.5px]",
            line.warn ? "text-warning" : "text-muted"
          )}
        >
          {line.warn ? (
            <TriangleAlert aria-hidden="true" className="mt-px h-[11px] w-[11px] shrink-0" />
          ) : (
            <span className="shrink-0">·</span>
          )}
          <span>{line.text}</span>
        </div>
      ))}
    </div>
  );
};

const RawToggle: React.FC<{ args: SessionHistoryToolArgs; result: unknown }> = (props) => {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="text-muted hover:text-foreground flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-[10px]"
      >
        <ExpandIcon expanded={open}>▶</ExpandIcon>
        raw input / output
      </button>
      {open && (
        <div className="mt-1.5 grid gap-2">
          <div>
            <DetailLabel>Input</DetailLabel>
            <DetailContent>
              <JsonHighlight value={props.args} />
            </DetailContent>
          </div>
          {props.result != null && (
            <div>
              <DetailLabel>Output</DetailLabel>
              <DetailContent>
                <JsonHighlight value={props.result} />
              </DetailContent>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Body when no parsed result applies (mid-flight, interrupted, redacted, or a corrupt result).
const STATUS_NOTES: Record<ToolStatus, string> = {
  pending: "Waiting to read session history…",
  executing: "Reading session history",
  backgrounded: "Reading session history",
  completed: "Result unavailable.",
  failed: "The read failed.",
  interrupted: "Interrupted before the read finished.",
  redacted: "Result redacted.",
};

const ResultBody: React.FC<{
  args: SessionHistoryToolArgs;
  result: SessionHistoryToolResult | null;
  status: ToolStatus;
}> = (props) => {
  const { args, result } = props;
  if (result == null) {
    const loading = props.status === "executing" || props.status === "backgrounded";
    return (
      <div className="text-muted py-1 italic">
        {STATUS_NOTES[props.status]}
        {loading && <LoadingDots />}
      </div>
    );
  }
  if (!result.success) {
    return (
      <ErrorBox>
        <div>
          {result.error != null
            ? (lookup(ERROR_MESSAGES, result.error) ?? result.error)
            : STATUS_NOTES.failed}
        </div>
        {result.notice && <div className="text-muted mt-[3px] text-[10.5px]">{result.notice}</div>}
      </ErrorBox>
    );
  }
  const empty = (message: string) => <div className="text-muted py-1 italic">{message}</div>;
  const items = result.items ?? [];
  switch (args.action) {
    case "list_windows": {
      const windows = result.windows ?? [];
      return windows.length > 0 ? (
        <WindowRail windows={windows} recentFirst={args.recent_first === true} />
      ) : (
        empty("No matching windows.")
      );
    }
    case "list_items":
    case "search":
      return items.length > 0 ? (
        <ItemList items={items} query={args.action === "search" ? (args.query ?? null) : null} />
      ) : (
        empty("No matching rows.")
      );
    case "read_item": {
      const item = items.at(0);
      return item != null ? <ReadExcerpt item={item} /> : empty("No row returned.");
    }
  }
};

interface SessionHistoryToolCallProps {
  args: SessionHistoryToolArgs;
  result?: unknown;
  status?: ToolStatus;
  /** Initial expansion fallback (until the user toggles this tool in the workspace). */
  defaultExpanded?: boolean;
}

export const SessionHistoryToolCall: React.FC<SessionHistoryToolCallProps> = (props) => {
  const status = props.status ?? "pending";
  const { expanded, toggleExpanded } = useToolExpansion(props.defaultExpanded ?? false);
  const args = props.args;
  const result = parseResult(props.result);
  const count = countLabel(args, result);
  // A completed call whose output is present but fails the result schema is not a success:
  // show it as failed in the header while the body keeps the "Result unavailable" diagnostic.
  // Absent output (null) keeps its transport status.
  const headerStatus: ToolStatus =
    status === "completed" && props.result != null && result == null ? "failed" : status;

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="session_history" />
        <span className="text-secondary shrink-0 font-medium whitespace-nowrap">
          {ACTION_VERBS[args.action]}
        </span>
        {args.task_id && (
          <Chip tone="text-plan-mode border-plan-mode/35" icon={GitBranch}>
            sub-agent
          </Chip>
        )}
        <HeaderSummary args={args} />
        {count != null && (
          <span className="text-muted shrink-0 text-[10px] whitespace-nowrap">{count}</span>
        )}
        <StatusIndicator status={headerStatus}>{getStatusDisplay(headerStatus)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <div className="flex flex-col gap-2">
            <ScopeChips args={args} />
            <ResultBody args={args} result={result} status={status} />
            {result?.success && <ResultNotes action={args.action} result={result} />}
            {result?.success && result.notice && (
              <div className="text-muted text-[10px] opacity-70">{result.notice}</div>
            )}
            {/* Same attachment redaction as GenericToolCall: a legacy content-style result
                must not push encoded media through JSON highlighting. */}
            <RawToggle
              args={args}
              result={redactToolResultAttachmentsForDisplay(unwrapResult(props.result))}
            />
          </div>
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
