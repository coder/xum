import React, { useState } from "react";
import { MarkdownRenderer } from "@/browser/features/Messages/MarkdownRenderer";
import { cn } from "@/common/lib/utils";
import type { ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import { getArtifactImageMimeType } from "@/common/utils/artifactKind";
import { formatBytes } from "@/common/utils/formatBytes";

// Every renderer here goes through React elements, so artifact content (agent-written,
// therefore untrusted) is always escaped. HTML and SVG are shown as source until the
// sandboxed iframe renderer exists; never route them through dangerouslySetInnerHTML.

function Notice(props: { children: React.ReactNode }) {
  return <div className="text-muted p-4 text-xs leading-relaxed">{props.children}</div>;
}

function SourceText(props: { content: string; note?: string }) {
  return (
    <div className="flex min-h-0 flex-col">
      {props.note != null && (
        <div className="text-muted border-border-light border-b px-3 py-1.5 text-[11px]">
          {props.note}
        </div>
      )}
      <pre className="text-foreground font-monospace m-0 p-3 text-xs leading-[1.5] break-words whitespace-pre-wrap">
        {props.content}
      </pre>
    </div>
  );
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Parse JSON, or JSON Lines for .jsonl files. Returns null when the text is not valid. */
function parseJson(content: string, path: string): JsonValue | null {
  try {
    if (path.toLowerCase().endsWith(".jsonl")) {
      return content
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as JsonValue);
    }
    return JSON.parse(content) as JsonValue;
  } catch {
    return null;
  }
}

function JsonScalar(props: { value: null | boolean | number | string }) {
  if (typeof props.value === "string") {
    return <span className="text-success break-words">{JSON.stringify(props.value)}</span>;
  }
  return <span className="text-accent">{String(props.value)}</span>;
}

function JsonNode(props: { name: string | null; value: JsonValue; depth: number }) {
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
  const children: Array<[string, JsonValue]> = isArray
    ? (props.value as JsonValue[]).map((child, index) => [String(index), child])
    : Object.entries(props.value);
  const summary = isArray ? `[${children.length}]` : `{${children.length}}`;
  return (
    // Native <details> keeps expand/collapse accessible without extra state.
    <details open={props.depth < 2} className="pl-4">
      <summary className="cursor-pointer select-none">
        {label}
        <span className="text-muted">{summary}</span>
      </summary>
      {children.map(([key, child]) => (
        <JsonNode key={key} name={key} value={child} depth={props.depth + 1} />
      ))}
    </details>
  );
}

function JsonArtifact(props: { content: string; path: string }) {
  const [mode, setMode] = useState<"tree" | "raw">("tree");
  const parsed = parseJson(props.content, props.path);
  if (parsed === null && props.content.trim() !== "null") {
    return <SourceText content={props.content} note="Not valid JSON; showing the raw text." />;
  }
  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-border-light flex gap-1 border-b px-3 py-1.5 text-[11px]">
        {(["tree", "raw"] as const).map((option) => (
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
      </div>
      {mode === "tree" ? (
        <div className="font-monospace -ml-4 p-3 text-xs leading-[1.6]">
          <JsonNode name={null} value={parsed} depth={0} />
        </div>
      ) : (
        // The file's own text: re-serializing would round large numbers and drop duplicate keys.
        <SourceText content={props.content} />
      )}
    </div>
  );
}

const SOURCE_ONLY_NOTE = "Shown as source. A rich preview for this file type is not available yet.";

export function ArtifactViewer(props: { result: ArtifactReadResult }) {
  const result = props.result;
  if (result.status === "too_large") {
    return (
      <Notice>
        <strong className="text-foreground">{result.path}</strong> is too large to preview (
        {formatBytes(result.size)}; the limit is {formatBytes(result.maxBytes)}).
      </Notice>
    );
  }
  if (result.status === "binary") {
    return (
      <Notice>
        <strong className="text-foreground">{result.path}</strong> is a binary file and cannot be
        previewed.
      </Notice>
    );
  }
  switch (result.kind) {
    case "markdown":
      return (
        <div className="p-3 text-sm">
          <MarkdownRenderer content={result.content} />
        </div>
      );
    case "json":
      return <JsonArtifact content={result.content} path={result.path} />;
    case "image": {
      const mime = getArtifactImageMimeType(result.path);
      if (mime == null || result.encoding !== "base64") {
        return <Notice>This image cannot be displayed.</Notice>;
      }
      return (
        <div className="flex justify-center p-3">
          <img
            src={`data:${mime};base64,${result.content}`}
            alt={result.path}
            className="max-w-full object-contain"
          />
        </div>
      );
    }
    case "html":
    case "svg":
    case "csv":
    case "mermaid":
    case "diff":
    case "canvas":
      return <SourceText content={result.content} note={SOURCE_ONLY_NOTE} />;
    case "pdf":
      return <Notice>PDF preview is not available yet.</Notice>;
    case "text":
      return <SourceText content={result.content} />;
  }
}
