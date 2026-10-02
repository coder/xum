import React, { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useAPI } from "@/browser/contexts/API";
import {
  ANALYTICS_CHART_COLORS,
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  CHART_TOOLTIP_CONTENT_STYLE,
  formatCompactNumber,
} from "@/browser/features/Analytics/analyticsUtils";
import type { ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import {
  createArtifactAssetLoader,
  toImageDataUrl,
  type ArtifactAssetLoader,
  type ArtifactAssetReader,
  type LoadedArtifactAsset,
} from "./artifactAssets";
import type { ArtifactInteractionHandlers } from "./artifactInteractions";
import { classifyArtifactReference, resolveArtifactReference } from "./artifactPaths";
import {
  CANVAS_MAX_BLOCKS,
  chartSeries,
  parseCanvas,
  resolveJsonPointer,
  splitDataReference,
  toChartRows,
  type CanvasBlock,
  type ParsedCanvasBlock,
} from "./canvasSpec";
import { ARTIFACT_TABLE_MAX_COLUMNS, ARTIFACT_TABLE_MAX_ROWS, DataTable } from "./DataTable";
import { DiffArtifact } from "./DiffArtifact";
import { ImageArtifact } from "./ImageArtifact";
import { parseJsonArtifact, toJsonTable, type JsonValue } from "./jsonData";
import { MarkdownArtifact } from "./MarkdownArtifact";
import { useArtifactAssetReader } from "./useArtifactAssetReader";
import { SourceText } from "./SourceText";

type OkReadResult = Extract<ArtifactReadResult, { status: "ok" }>;

/** What a block's file reference turned into. */
type FileState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; result: OkReadResult };

/** A diff block's `patch` is a file ref when it is a single line; inline patches span lines. */
function isDiffFileRef(patch: string): boolean {
  return !patch.includes("\n");
}

/** File part of every reference a block reads (chart data, diff file, image). */
function blockFileRef(block: ParsedCanvasBlock): string | null {
  if (block.type === "chart" && typeof block.data === "string") {
    return splitDataReference(block.data).file;
  }
  if (block.type === "diff" && isDiffFileRef(block.patch)) return block.patch.trim();
  if (block.type === "image") return block.src;
  return null;
}

function BlockNotice(props: { tone: "error" | "muted"; children: React.ReactNode }) {
  return (
    <div
      className={
        props.tone === "error"
          ? "border-danger text-danger rounded border px-2 py-1.5 text-xs break-words"
          : "border-border-light text-muted rounded border px-2 py-1.5 text-xs break-words"
      }
    >
      {props.children}
    </div>
  );
}

function Padded(props: { children: React.ReactNode }) {
  return <div className="min-w-0 px-3 py-2">{props.children}</div>;
}

function FileNotice(props: { state: Exclude<FileState, { status: "ok" }> }) {
  return props.state.status === "loading" ? (
    <BlockNotice tone="muted">Loading…</BlockNotice>
  ) : (
    <BlockNotice tone="error">{props.state.message}</BlockNotice>
  );
}

// Parsed chart data per loaded file result. Up to CANVAS_MAX_BLOCKS charts can point at one
// large file; parsing it once per block would multiply a 5 MiB read into GiBs of synchronous
// parsing and freeze the renderer (Codex security review). Keyed by the result object, so a
// reload, which produces new results, parses the new bytes.
const parsedChartData = new WeakMap<OkReadResult, JsonValue | undefined>();

function parseChartData(result: OkReadResult): JsonValue | undefined {
  if (parsedChartData.has(result)) return parsedChartData.get(result);
  const parsed =
    result.encoding === "utf8" && (result.kind === "json" || result.kind === "canvas")
      ? parseJsonArtifact(result.content, result.path)
      : undefined;
  parsedChartData.set(result, parsed);
  return parsed;
}

function ChartBlock(props: {
  block: Extract<CanvasBlock, { type: "chart" }>;
  file: FileState | null;
}) {
  const block = props.block;
  const { series: y, total: totalSeries } = chartSeries(block.y);
  let data: unknown = block.data;
  if (typeof block.data === "string") {
    if (props.file?.status !== "ok") {
      return <FileNotice state={props.file ?? { status: "error", message: "No chart data." }} />;
    }
    const result = props.file.result;
    const parsed = parseChartData(result);
    if (parsed === undefined) {
      return <BlockNotice tone="error">{result.path} is not a readable JSON file.</BlockNotice>;
    }
    const pointed = resolveJsonPointer(parsed, splitDataReference(block.data).pointer);
    if (!pointed.ok) return <BlockNotice tone="error">{pointed.error}</BlockNotice>;
    data = pointed.value;
  }
  const chart = toChartRows(data, block.x, y, ARTIFACT_TABLE_MAX_ROWS);
  if (!chart.ok) return <BlockNotice tone="error">{chart.error}</BlockNotice>;

  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke={CHART_AXIS_STROKE} />
      <XAxis dataKey={block.x} minTickGap={16} tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} />
      <YAxis
        width={40}
        tick={CHART_AXIS_TICK}
        tickFormatter={(value: number) => formatCompactNumber(Number(value))}
        stroke={CHART_AXIS_STROKE}
      />
      <Tooltip cursor={{ fill: "var(--color-hover)" }} contentStyle={CHART_TOOLTIP_CONTENT_STYLE} />
      {y.length > 1 && <Legend wrapperStyle={{ fontSize: "11px" }} />}
    </>
  );
  const color = (index: number) => ANALYTICS_CHART_COLORS[index % ANALYTICS_CHART_COLORS.length];
  const margin = { top: 8, right: 8, left: 0, bottom: 0 };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {block.title != null && (
        <div className="text-foreground truncate text-xs font-medium">{block.title}</div>
      )}
      {totalSeries > y.length && (
        <div className="text-muted text-[11px]">
          Showing first {y.length} of {totalSeries} series
        </div>
      )}
      {chart.totalPoints > chart.rows.length && (
        <div className="text-muted text-[11px]">
          Showing first {chart.rows.length} of {chart.totalPoints} points
        </div>
      )}
      {/* No entry animation: series draw at once, so snapshots never catch an empty plot. */}
      <div className="h-[220px] w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          {block.kind === "bar" ? (
            <BarChart data={chart.rows} margin={margin}>
              {axes}
              {y.map((field, index) => (
                <Bar key={field} dataKey={field} fill={color(index)} isAnimationActive={false} />
              ))}
            </BarChart>
          ) : (
            <LineChart data={chart.rows} margin={margin}>
              {axes}
              {y.map((field, index) => (
                <Line
                  key={field}
                  dataKey={field}
                  stroke={color(index)}
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function StatBlock(props: { block: Extract<CanvasBlock, { type: "stat" }> }) {
  return (
    <div className="border-border-light min-w-0 rounded border px-3 py-2">
      <div className="text-muted truncate text-[11px]">{props.block.label}</div>
      <div className="text-foreground counter-nums truncate text-lg font-semibold">
        {String(props.block.value)}
      </div>
      {props.block.delta != null && (
        <div className="text-muted counter-nums truncate text-[11px]">
          {String(props.block.delta)}
        </div>
      )}
    </div>
  );
}

function CanvasBlockView(props: {
  block: ParsedCanvasBlock;
  path: string;
  workspaceId: string | null;
  file: FileState | null;
  interactions?: ArtifactInteractionHandlers;
  assetLoader: ArtifactAssetLoader | null;
}) {
  const block = props.block;
  switch (block.type) {
    case "markdown":
      // MarkdownArtifact pads itself and resolves relative images against the canvas folder,
      // through the canvas loader so every block shares one dedup cache and asset budget.
      return (
        <MarkdownArtifact
          content={block.text}
          path={props.path}
          workspaceId={props.workspaceId}
          loader={props.assetLoader}
        />
      );
    case "table": {
      const table = toJsonTable(
        { $xum: "table", columns: block.columns, rows: block.rows },
        ARTIFACT_TABLE_MAX_ROWS,
        ARTIFACT_TABLE_MAX_COLUMNS
      );
      return (
        <Padded>
          {table == null ? (
            <BlockNotice tone="error">Invalid table block.</BlockNotice>
          ) : (
            <div className="border-border-light flex max-h-[360px] min-h-0 flex-col overflow-hidden rounded border">
              <DataTable
                columns={table.columns}
                rows={table.rows}
                totalRows={table.totalRows}
                totalColumns={table.totalColumns}
              />
            </div>
          )}
        </Padded>
      );
    }
    case "chart":
      return (
        <Padded>
          <ChartBlock block={block} file={props.file} />
        </Padded>
      );
    case "stat":
      return (
        <Padded>
          <StatBlock block={block} />
        </Padded>
      );
    case "diff": {
      if (!isDiffFileRef(block.patch)) return <DiffArtifact content={block.patch} />;
      const file = props.file;
      if (file?.status === "ok" && file.result.encoding === "utf8") {
        return <DiffArtifact content={file.result.content} />;
      }
      return (
        <Padded>
          {file?.status === "ok" ? (
            <BlockNotice tone="error">{file.result.path} is not a text file.</BlockNotice>
          ) : (
            <FileNotice state={file ?? { status: "error", message: "No patch." }} />
          )}
        </Padded>
      );
    }
    case "image": {
      const file = props.file;
      const src = file?.status === "ok" ? toImageDataUrl(file.result) : null;
      if (src != null) return <ImageArtifact src={src} alt={block.alt ?? block.src} />;
      return (
        <Padded>
          {file?.status === "ok" ? (
            <BlockNotice tone="error">{file.result.path} is not a supported image.</BlockNotice>
          ) : (
            <FileNotice state={file ?? { status: "error", message: "No image." }} />
          )}
        </Padded>
      );
    }
    case "button": {
      // Hidden where artifacts are read-only. The click only fills the host's confirm strip;
      // the user's Send there is what delivers the message.
      const interactions = props.interactions;
      if (interactions == null) return null;
      return (
        <Padded>
          <button
            type="button"
            onClick={() => interactions.requestSend(block.send, block.data)}
            className="border-border-light text-foreground hover:bg-hover max-w-full truncate rounded border px-2 py-1 text-xs"
          >
            {block.label}
          </button>
        </Padded>
      );
    }
    case "invalid":
      return (
        <Padded>
          <BlockNotice tone="error">Invalid {block.blockType} block.</BlockNotice>
        </Padded>
      );
    case "unsupported":
      return (
        <Padded>
          <BlockNotice tone="muted">
            Unsupported block: {block.blockType || "(no type)"}
          </BlockNotice>
        </Padded>
      );
  }
}

/** Why a reference cannot be read, or null when it resolves inside the artifacts folder. */
function referenceError(fromPath: string, ref: string): string | null {
  if (classifyArtifactReference(ref) !== "relative") {
    return `Only files in the artifacts folder can be referenced: ${ref}`;
  }
  return resolveArtifactReference(fromPath, ref) == null
    ? `Reference leaves the artifacts folder: ${ref}`
    : null;
}

/** Group consecutive stat blocks so they sit side by side when there is room. */
function groupBlocks(blocks: ParsedCanvasBlock[]): Array<{ index: number; stats: number[] }> {
  const groups: Array<{ index: number; stats: number[] }> = [];
  blocks.forEach((block, index) => {
    const last = groups.at(-1);
    if (
      block.type === "stat" &&
      last != null &&
      last.stats.length > 0 &&
      last.stats.at(-1) === index - 1
    ) {
      last.stats.push(index);
    } else {
      groups.push({ index, stats: block.type === "stat" ? [index] : [] });
    }
  });
  return groups;
}

export function CanvasArtifact(props: {
  content: string;
  path: string;
  /** null: file references are off (see useArtifactAssetReader). */
  workspaceId: string | null;
  interactions?: ArtifactInteractionHandlers;
  /**
   * Changes when the panel refreshes (polling, Reload): referenced files are read again, so a
   * canvas whose data file changed shows the new data. The previous data stays up meanwhile.
   */
  reloadToken?: number;
}) {
  const { api } = useAPI();
  const parsed = parseCanvas(props.content);
  const blocks = parsed.ok ? parsed.blocks : [];
  const readableRefs = [
    ...new Set(
      blocks
        .map(blockFileRef)
        .filter((ref): ref is string => ref != null && referenceError(props.path, ref) == null)
    ),
  ];
  const loadKey = [props.workspaceId ?? "", props.path, ...readableRefs].join("\n");
  const read = useArtifactAssetReader(props.workspaceId);
  // One loader per canvas load: data files and every Markdown block's images share its dedup
  // cache and asset budget, so 500 blocks naming one large image read it once and the canvas
  // stays within one budget (Codex r7). The loader is stateful, so it is kept in state and
  // replaced (during render, React's "adjust state on prop change" pattern) when the reader, the
  // path or reloadToken changes; a reload thereby re-reads changed files.
  const [loaderSlot, setLoaderSlot] = useState<{
    read: ArtifactAssetReader;
    path: string;
    reloadToken: number | undefined;
    loader: ArtifactAssetLoader;
  } | null>(null);
  const slotIsCurrent =
    read != null &&
    loaderSlot?.read === read &&
    loaderSlot.path === props.path &&
    loaderSlot.reloadToken === props.reloadToken;
  if (read != null && !slotIsCurrent) {
    setLoaderSlot({
      read,
      path: props.path,
      reloadToken: props.reloadToken,
      loader: createArtifactAssetLoader(props.path, read),
    });
  }
  const assetLoader = slotIsCurrent ? loaderSlot.loader : null;
  const [loaded, setLoaded] = useState<{
    key: string;
    assets: Map<string, LoadedArtifactAsset>;
  } | null>(null);

  useEffect(() => {
    const refs = loadKey.split("\n").slice(2);
    const loader = assetLoader;
    if (loader == null || refs.length === 0) return;
    let cancelled = false;
    // Escaping refs never reach the loader (filtered above), and the backend re-checks
    // containment on each read.
    Promise.all(refs.map((ref) => loader.load(ref).then((asset) => [ref, asset] as const)))
      .then((pairs) => {
        if (!cancelled) setLoaded({ key: loadKey, assets: new Map(pairs) });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key: loadKey, assets: new Map() });
      });
    return () => {
      cancelled = true;
    };
    // A reload only swaps the loader; reloadToken is not part of loadKey, so a reload keeps
    // showing the current data instead of flashing every block back to "loading".
  }, [assetLoader, loadKey]);

  if (!parsed.ok) {
    return (
      <SourceText
        content={props.content}
        note={
          parsed.reason === "not_json"
            ? "Not valid JSON; showing the raw text."
            : 'Not a canvas (expected {"$xum": "canvas", "blocks": [...]}); showing the raw text.'
        }
      />
    );
  }

  const fileState = (block: ParsedCanvasBlock): FileState | null => {
    const ref = blockFileRef(block);
    if (ref == null) return null;
    const error = referenceError(props.path, ref);
    if (error != null) return { status: "error", message: error };
    if (api == null || props.workspaceId == null) {
      return { status: "error", message: `File references are not available here: ${ref}` };
    }
    if (loaded?.key !== loadKey) return { status: "loading" };
    const asset = loaded.assets.get(ref);
    if (asset?.status !== "ok") {
      return {
        status: "error",
        message: `Could not read ${ref} (${asset?.reason ?? "not found"}).`,
      };
    }
    return { status: "ok", result: asset.result };
  };

  const renderBlock = (index: number) => (
    <CanvasBlockView
      key={index}
      block={blocks[index]}
      path={props.path}
      workspaceId={props.workspaceId}
      file={fileState(blocks[index])}
      interactions={props.interactions}
      assetLoader={assetLoader}
    />
  );

  return (
    <div className="flex min-w-0 flex-col py-1" data-testid="canvas-artifact">
      {blocks.length === 0 && (
        <Padded>
          <BlockNotice tone="muted">This canvas has no blocks.</BlockNotice>
        </Padded>
      )}
      {groupBlocks(blocks).map((group) =>
        group.stats.length > 1 ? (
          <div
            key={group.index}
            className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,140px),1fr))] gap-2 px-3 py-2"
          >
            {group.stats.map((index) => {
              const block = blocks[index];
              return block.type === "stat" ? <StatBlock key={index} block={block} /> : null;
            })}
          </div>
        ) : (
          renderBlock(group.index)
        )
      )}
      {parsed.omittedBlocks > 0 && (
        <Padded>
          <BlockNotice tone="muted">
            Showing the first {CANVAS_MAX_BLOCKS} blocks; {parsed.omittedBlocks} more are not shown.
          </BlockNotice>
        </Padded>
      )}
    </div>
  );
}
