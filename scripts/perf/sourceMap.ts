/**
 * Minimal source map (v3) consumer for the offline CPU-profile analyzer (`analyzeProfiles.ts`).
 *
 * Pure: it decodes a parsed map object and answers position lookups. Finding and reading map files
 * is the CLI's job. Only regular maps are supported. Index maps (`sections`) and malformed maps are
 * rejected with a reason, so callers fall back to bundle locations instead of crashing.
 *
 * Coordinates are 0-based on both sides, like V8 call frames and the source map spec.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64.length; i++) BASE64_VALUES[BASE64.charCodeAt(i)] = i;

/** Fields per decoded segment: generated column, source index, original line, original column, name index. */
const FIELDS = 5;
const ABSENT = -1;

export interface MappedPosition {
  /** `sourceRoot` + `sources[i]`, as written in the map (not resolved against any directory). */
  source: string;
  line: number;
  column: number;
  name?: string;
}

export interface SourceMapConsumer {
  /** The mapping segment that covers the position, or undefined when the position is unmapped. */
  lookup(line: number, column: number): MappedPosition | undefined;
}

export type SourceMapParse = { ok: true; map: SourceMapConsumer } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinSourceRoot(root: string, source: string): string {
  if (root === "" || /^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith("/")) return source;
  return root.endsWith("/") ? root + source : `${root}/${source}`;
}

/**
 * Decodes base64 VLQ `mappings` into one flat Int32Array (FIELDS numbers per segment, ABSENT for
 * missing fields) plus per-line segment offsets. A flat array keeps large bundle maps (millions of
 * segments) cheap. Throws on malformed input; parseSourceMap turns that into a reason.
 */
function decodeMappings(
  mappings: string,
  sourceCount: number,
  nameCount: number
): { segments: Int32Array; lineStarts: number[] } {
  let segments = new Int32Array(1024 * FIELDS);
  let count = 0;
  const lineStarts: number[] = [0];
  // Source, original line, original column and name are relative to the previous segment across
  // the whole string. The generated column resets on every generated line.
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;
  let generatedColumn = 0;
  let lineSegmentStart = 0;
  const fields: number[] = [];
  let pos = 0;

  const finishSegment = (): void => {
    if (fields.length === 0) return;
    if (fields.length !== 1 && fields.length !== 4 && fields.length !== 5) {
      throw new Error(`segment with ${fields.length} fields (expected 1, 4 or 5)`);
    }
    generatedColumn += fields[0];
    if (generatedColumn < 0) throw new Error("negative generated column");
    if (count > lineSegmentStart) {
      const previousColumn = segments[(count - 1) * FIELDS];
      if (generatedColumn < previousColumn) throw new Error("segments are not sorted by column");
    }
    if ((count + 1) * FIELDS > segments.length) {
      const grown = new Int32Array(segments.length * 2);
      grown.set(segments);
      segments = grown;
    }
    const base = count * FIELDS;
    segments[base] = generatedColumn;
    segments[base + 1] = ABSENT;
    segments[base + 2] = ABSENT;
    segments[base + 3] = ABSENT;
    segments[base + 4] = ABSENT;
    if (fields.length >= 4) {
      sourceIndex += fields[1];
      originalLine += fields[2];
      originalColumn += fields[3];
      if (sourceIndex < 0 || sourceIndex >= sourceCount)
        throw new Error("source index out of range");
      if (originalLine < 0 || originalColumn < 0) throw new Error("negative original position");
      segments[base + 1] = sourceIndex;
      segments[base + 2] = originalLine;
      segments[base + 3] = originalColumn;
    }
    if (fields.length === 5) {
      nameIndex += fields[4];
      if (nameIndex < 0 || nameIndex >= nameCount) throw new Error("name index out of range");
      segments[base + 4] = nameIndex;
    }
    count++;
    fields.length = 0;
  };

  while (pos < mappings.length) {
    const char = mappings[pos];
    if (char === ";") {
      finishSegment();
      lineStarts.push(count);
      lineSegmentStart = count;
      generatedColumn = 0;
      pos++;
      continue;
    }
    if (char === ",") {
      if (fields.length === 0) throw new Error("empty segment");
      finishSegment();
      pos++;
      continue;
    }
    // One VLQ value: 5 data bits per digit, continuation bit 0x20, sign in the lowest bit.
    let value = 0;
    let shift = 0;
    let continuation = true;
    while (continuation) {
      if (pos >= mappings.length) throw new Error("truncated VLQ value");
      const code = mappings.charCodeAt(pos++);
      const digit = code < 128 ? BASE64_VALUES[code] : -1;
      if (digit < 0) throw new Error(`invalid base64 character at offset ${pos - 1}`);
      if (shift > 30) throw new Error("VLQ value too large");
      continuation = (digit & 32) !== 0;
      value += (digit & 31) * 2 ** shift;
      shift += 5;
    }
    fields.push(value % 2 === 1 ? -Math.floor(value / 2) : Math.floor(value / 2));
  }
  finishSegment();
  lineStarts.push(count);
  return { segments: segments.subarray(0, count * FIELDS), lineStarts };
}

export function parseSourceMap(json: unknown): SourceMapParse {
  if (!isRecord(json)) return { ok: false, reason: "source map is not a JSON object" };
  if (json.sections !== undefined) {
    return { ok: false, reason: "index source maps (sections) are not supported" };
  }
  if (json.version !== 3) return { ok: false, reason: "source map version is not 3" };
  const { sources, names, mappings, sourceRoot } = json;
  if (!Array.isArray(sources) || !sources.every((s) => typeof s === "string" || s === null)) {
    return { ok: false, reason: "source map `sources` is not a string array" };
  }
  if (
    names !== undefined &&
    (!Array.isArray(names) || !names.every((n) => typeof n === "string"))
  ) {
    return { ok: false, reason: "source map `names` is not a string array" };
  }
  if (typeof mappings !== "string")
    return { ok: false, reason: "source map `mappings` is not a string" };
  if (sourceRoot !== undefined && sourceRoot !== null && typeof sourceRoot !== "string") {
    return { ok: false, reason: "source map `sourceRoot` is not a string" };
  }
  const root = typeof sourceRoot === "string" ? sourceRoot : "";
  const resolvedSources = (sources as Array<string | null>).map((s) =>
    s === null ? null : joinSourceRoot(root, s)
  );
  const nameList = (names as string[] | undefined) ?? [];
  let decoded: { segments: Int32Array; lineStarts: number[] };
  try {
    decoded = decodeMappings(mappings, resolvedSources.length, nameList.length);
  } catch (error) {
    return {
      ok: false,
      reason: `malformed mappings: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const { segments, lineStarts } = decoded;

  const lookup = (line: number, column: number): MappedPosition | undefined => {
    // V8 reports unknown positions as -1.
    if (line < 0 || column < 0 || line + 1 >= lineStarts.length) return undefined;
    const start = lineStarts[line];
    const end = lineStarts[line + 1];
    // Last segment on the line whose generated column is <= column.
    let lo = start;
    let hi = end - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid * FIELDS] <= column) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0) return undefined;
    const base = found * FIELDS;
    const sourceIndex = segments[base + 1];
    // A 1-field segment marks generated code with no original position.
    if (sourceIndex === ABSENT) return undefined;
    const source = resolvedSources[sourceIndex];
    if (source === null) return undefined;
    const nameIndex = segments[base + 4];
    return {
      source,
      line: segments[base + 2],
      column: segments[base + 3],
      ...(nameIndex === ABSENT ? {} : { name: nameList[nameIndex] }),
    };
  };
  return { ok: true, map: { lookup } };
}

function stripToRelative(source: string): string {
  // Drop the scheme and leading ./ and ../ (and stray slashes) so `../src/a.ts` and
  // `webpack:///./src/a.ts` both become `src/a.ts`.
  return source.replace(/^[a-z][a-z0-9+.-]*:\/*/i, "").replace(/^(\.\.?\/|\/)+/, "");
}

/** `path` relative to `base` when it lies strictly inside `base`, otherwise undefined. */
export function relativeInside(base: string, path: string): string | undefined {
  const rel = relative(base, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : undefined;
}

/**
 * Stable identity for a mapped source, so baseline and candidate keys match across machines and
 * `--map-dir` locations. A source that resolves inside `cwd` (usually the repository) becomes a
 * cwd-relative path. Anything else keeps the string written in the map, minus URL schemes such as
 * `webpack://` and leading `./`/`../`. It is never an absolute path built from the local map
 * directory.
 */
export function stableSourceId(source: string, options: { mapDir?: string; cwd: string }): string {
  let absolute: string | undefined;
  if (/^file:/i.test(source)) {
    try {
      absolute = fileURLToPath(source);
    } catch {
      absolute = undefined;
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    return stripToRelative(source);
  } else if (isAbsolute(source)) {
    absolute = source;
  } else if (options.mapDir !== undefined) {
    absolute = resolve(options.mapDir, source);
  }
  const rel = absolute === undefined ? undefined : relativeInside(options.cwd, absolute);
  if (rel !== undefined) return rel.split("\\").join("/");
  return stripToRelative(source);
}
