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

function JsonNode(props: { name: string | null; value: JsonValue; depth: number }) {
  // Children render only while expanded, so a large document costs only what is open.
  const [expanded, setExpanded] = useState(props.depth < 2);
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
        onClick={() => setExpanded(!expanded)}
        className="-ml-4 flex items-center text-left select-none"
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
              <JsonNode key={index} name={String(index)} value={child} depth={props.depth + 1} />
            ))
          : Object.entries(props.value).map(([key, child]) => (
              <JsonNode key={key} name={key} value={child} depth={props.depth + 1} />
            )))}
    </div>
  );
}

type JsonMode = "table" | "tree" | "raw";

// The chosen mode per shown file version (ArtifactViewer's viewKey). Fullscreen and sidebar tab
// switches remount the viewer, and component state alone fell back to the first mode (N7). A new
// version has a new key, so it starts at the default again. In memory only and capped, oldest
// first: the choice only has to outlive remounts, not a reload.
const REMEMBERED_MODES_MAX = 64;
const rememberedModes = new Map<string, JsonMode>();

function rememberMode(viewKey: string, mode: JsonMode): void {
  rememberedModes.delete(viewKey);
  rememberedModes.set(viewKey, mode);
  for (const oldest of rememberedModes.keys()) {
    if (rememberedModes.size <= REMEMBERED_MODES_MAX) break;
    rememberedModes.delete(oldest);
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
  const [chosenMode, setChosenMode] = useState<JsonMode | null>(() =>
    props.viewKey == null ? null : (rememberedModes.get(props.viewKey) ?? null)
  );
  const setMode = (next: JsonMode) => {
    setChosenMode(next);
    if (props.viewKey != null) rememberMode(props.viewKey, next);
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
              "rounded px-1.5 py-0.5 capitalize",
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
          <JsonNode name={null} value={parsed} depth={0} />
        </div>
      ) : (
        // Raw is the file exactly as written: re-serializing the parsed value would round big
        // integers, drop duplicate keys and rewrite numbers like 1e400.
        <SourceText content={props.content} />
      )}
    </div>
  );
}
