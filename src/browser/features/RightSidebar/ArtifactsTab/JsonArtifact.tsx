import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { ARTIFACT_TABLE_MAX_COLUMNS, ARTIFACT_TABLE_MAX_ROWS, DataTable } from "./DataTable";
import { SourceText } from "./SourceText";
import {
  countJsonNodes,
  JSON_TREE_MAX_NODES,
  parseJsonArtifact,
  toJsonTable,
  type JsonValue,
} from "./jsonData";

function JsonScalar(props: { value: null | boolean | number | string }) {
  if (typeof props.value === "string") {
    return <span className="text-success break-words">{JSON.stringify(props.value)}</span>;
  }
  return <span className="text-accent">{String(props.value)}</span>;
}

/** JSON Pointer of a child (RFC 6901 escaping), so keys like "a/b" stay distinct. */
function childPath(parent: string, name: string): string {
  return `${parent}/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function JsonNode(props: {
  name: string | null;
  value: JsonValue;
  depth: number;
  /** JSON Pointer of this node; the key into `expansion`. */
  path: string;
  expansion: Map<string, boolean>;
}) {
  // Children render only while expanded, so a large document costs only what is open.
  const [expanded, setExpanded] = useState(
    () => props.expansion.get(props.path) ?? props.depth < 2
  );
  const toggle = () => {
    setExpanded(!expanded);
    rememberExpansion(props.expansion, props.path, !expanded);
  };
  const label = props.name == null ? null : <span className="text-muted">{props.name}: </span>;
  if (props.value === null || typeof props.value !== "object") {
    return (
      <div className="pl-4">
        {label}
        <JsonScalar value={props.value} />
      </div>
    );
  }
  const isArray = Array.isArray(props.value);
  const size = isArray ? (props.value as JsonValue[]).length : Object.keys(props.value).length;
  return (
    <div className="pl-4">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={toggle}
        className="focus-visible:ring-accent -ml-4 flex items-center rounded-sm text-left select-none focus-visible:ring-1"
      >
        <ChevronRight
          className={cn(
            "text-muted h-3 w-3 shrink-0 transition-transform",
            expanded && "rotate-90"
          )}
        />
        <span className="ml-1">
          {label}
          <span className="text-muted">{isArray ? `[${size}]` : `{${size}}`}</span>
        </span>
      </button>
      {expanded &&
        (isArray
          ? (props.value as JsonValue[]).map((child, index) => (
              <JsonNode
                key={index}
                name={String(index)}
                value={child}
                depth={props.depth + 1}
                path={childPath(props.path, String(index))}
                expansion={props.expansion}
              />
            ))
          : Object.entries(props.value).map(([key, child]) => (
              <JsonNode
                key={key}
                name={key}
                value={child}
                depth={props.depth + 1}
                path={childPath(props.path, key)}
                expansion={props.expansion}
              />
            )))}
    </div>
  );
}

type JsonMode = "table" | "tree" | "raw";

interface JsonViewMemory {
  mode: JsonMode | null;
  /** Tree nodes the user toggled (JSON Pointer -> expanded); untouched nodes use the default. */
  expansion: Map<string, boolean>;
}

// The chosen mode and tree expansion per shown file version (ArtifactViewer's viewKey).
// Fullscreen, sidebar tab switches and Raw -> Tree remount the viewer or the tree, and component
// state alone fell back to the defaults (N7). A new version has a new key, so it starts at the
// defaults again. In memory only and capped, oldest first: the choice only has to outlive
// remounts, not a reload.
const REMEMBERED_VIEWS_MAX = 64;
const REMEMBERED_TOGGLES_MAX = 1_000;
const rememberedViews = new Map<string, JsonViewMemory>();

/** The view's memory, made the most recent; a throwaway one when there is no viewKey. */
function viewMemory(viewKey: string | undefined): JsonViewMemory {
  const memory = (viewKey == null ? undefined : rememberedViews.get(viewKey)) ?? {
    mode: null,
    expansion: new Map<string, boolean>(),
  };
  if (viewKey == null) return memory;
  rememberedViews.delete(viewKey);
  rememberedViews.set(viewKey, memory);
  for (const oldest of rememberedViews.keys()) {
    if (rememberedViews.size <= REMEMBERED_VIEWS_MAX) break;
    rememberedViews.delete(oldest);
  }
  return memory;
}

function rememberExpansion(expansion: Map<string, boolean>, path: string, expanded: boolean) {
  expansion.delete(path);
  expansion.set(path, expanded);
  for (const oldest of expansion.keys()) {
    if (expansion.size <= REMEMBERED_TOGGLES_MAX) break;
    expansion.delete(oldest);
  }
}

export function JsonArtifact(props: { content: string; path: string; viewKey?: string }) {
  const parsed = parseJsonArtifact(props.content, props.path);
  const table =
    parsed === undefined
      ? null
      : toJsonTable(parsed, ARTIFACT_TABLE_MAX_ROWS, ARTIFACT_TABLE_MAX_COLUMNS);
  const tooLargeForTree =
    parsed !== undefined && countJsonNodes(parsed, JSON_TREE_MAX_NODES) > JSON_TREE_MAX_NODES;
  const modes: JsonMode[] = [
    ...(table != null ? (["table"] as const) : []),
    ...(tooLargeForTree ? [] : (["tree"] as const)),
    "raw",
  ];
  const [memory] = useState(() => viewMemory(props.viewKey));
  const [chosenMode, setChosenMode] = useState<JsonMode | null>(memory.mode);
  const setMode = (next: JsonMode) => {
    setChosenMode(next);
    memory.mode = next;
  };
  const mode = chosenMode != null && modes.includes(chosenMode) ? chosenMode : modes[0];

  if (parsed === undefined) {
    return <SourceText content={props.content} note="Not valid JSON; showing the raw text." />;
  }
  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-border-light flex items-center gap-1 border-b px-3 py-1.5 text-[11px]">
        {modes.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={mode === option}
            onClick={() => setMode(option)}
            className={cn(
              "rounded px-1.5 py-0.5 capitalize focus-visible:ring-1 focus-visible:ring-accent",
              mode === option ? "bg-hover text-foreground" : "text-muted hover:text-foreground"
            )}
          >
            {option}
          </button>
        ))}
        {tooLargeForTree && (
          <span className="text-muted ml-1">
            Too many values for the tree view (over {JSON_TREE_MAX_NODES.toLocaleString()}).
          </span>
        )}
      </div>
      {mode === "table" && table != null ? (
        <DataTable
          columns={table.columns}
          rows={table.rows}
          totalRows={table.totalRows}
          totalColumns={table.totalColumns}
        />
      ) : mode === "tree" ? (
        <div className="font-monospace p-3 text-xs leading-[1.6]">
          <JsonNode name={null} value={parsed} depth={0} path="" expansion={memory.expansion} />
        </div>
      ) : (
        // Raw is the file exactly as written: re-serializing the parsed value would round big
        // integers, drop duplicate keys and rewrite numbers like 1e400.
        <SourceText content={props.content} />
      )}
    </div>
  );
}
