import React, { useEffect, useRef, useState } from "react";
import { parseMarkdownIntoBlocks } from "streamdown";
import {
  CHUNKED_STREAMING_CHUNK_CHARS,
  CHUNKED_STREAMING_CHUNKS_PER_FRAME,
  STATIC_STREAMING_MOUNT_MAX_CHARS,
} from "@/constants/streaming";
import { MarkdownCore } from "./MarkdownCore";
import { normalizeMarkdown } from "./MarkdownStyles";
import { listItemRanges } from "./streamingMarkdownBlocks";

// Blank lines, or the digits of an ordered list marker before its `.` or `)` arrives.
const PARTIAL_LIST_MARKER = /^\d{0,9}$/;

/**
 * Splits growing markdown into chunks of whole Streamdown blocks, about `maxChars` each, and
 * joins back to the input. A chunk is sealed once a later block follows it: the last block can
 * still change (an open code fence, a growing list), so it always stays in the open last chunk.
 * Sealed chunks never change while the text only grows, and each update parses only the text
 * after them, so the cost of an update does not grow with the length of the reply.
 *
 * A list longer than `maxChars` is cut at its top-level items into chunks of its own, so the open
 * chunk of a huge streaming list stays small enough for a synchronous render (#5666). Each cut
 * renders as a separate list while streaming; `completedChunks` joins the cut list back together.
 */
export class MarkdownChunker {
  private text = "";
  private sealedText = "";
  private sealed: string[] = [];
  // Per sealed chunk: true when the chunk after it continues the same cut list.
  private sealedContinues: boolean[] = [];
  private chunks: readonly string[] = [];

  constructor(private readonly maxChars: number) {}

  update(text: string): readonly string[] {
    if (text === this.text) return this.chunks;
    // Replaced or shortened text: the sealed prefix no longer holds, start over.
    if (!text.startsWith(this.sealedText)) {
      this.sealed = [];
      this.sealedContinues = [];
      this.sealedText = "";
    }
    const groups: Array<{ text: string; continues: boolean }> = [];
    let current = "";
    let currentContinues = false;
    const pushCurrent = () => {
      if (current.length > 0) groups.push({ text: current, continues: currentContinues });
      current = "";
      currentContinues = false;
    };
    const blocks = parseMarkdownIntoBlocks(text.slice(this.sealedText.length));
    // A tail that is only a partial list marker (`…\n\n30` before its `.`) parses as a paragraph
    // after the list, but joins the list once the marker is complete (#5664). So that tail and
    // the blank lines before it never start a group: sealing the list there would make the next
    // item start a second list.
    let tailStart = blocks.length;
    while (tailStart > 0 && PARTIAL_LIST_MARKER.test(blocks[tailStart - 1].trim())) tailStart--;
    for (const [index, block] of blocks.entries()) {
      // Each range of a cut list is a chunk of its own. A partial marker in the tail still joins
      // the last range below, like any other block.
      const ranges =
        index < tailStart && block.length > this.maxChars
          ? listItemRanges(block, this.maxChars)
          : null;
      if (ranges !== null) {
        for (const [rangeIndex, range] of ranges.entries()) {
          pushCurrent();
          current = range;
          currentContinues = rangeIndex < ranges.length - 1;
        }
        continue;
      }
      if (
        index < tailStart &&
        current.length > 0 &&
        current.length + block.length > this.maxChars
      ) {
        pushCurrent();
      }
      current += block;
    }
    pushCurrent();
    // Every group but the last is followed by a later block, so it is sealed. A block's raw text
    // can differ from the input (the lexer trims some trailing whitespace), so a group is sealed
    // only while it matches the text exactly; the open chunk is always the rest of the input.
    for (const group of groups.slice(0, -1)) {
      if (!text.startsWith(group.text, this.sealedText.length)) break;
      this.sealed.push(group.text);
      this.sealedContinues.push(group.continues);
      this.sealedText += group.text;
    }
    const open = text.slice(this.sealedText.length);
    this.text = text;
    this.chunks = open.length > 0 ? [...this.sealed, open] : [...this.sealed];
    return this.chunks;
  }

  /** The chunks of the last update, with each cut list joined back into one chunk. */
  completedChunks(): readonly string[] {
    const completed: string[] = [];
    let joinNext = false;
    for (const [index, chunk] of this.chunks.entries()) {
      if (joinNext) completed[completed.length - 1] += chunk;
      else completed.push(chunk);
      joinNext = this.sealedContinues[index] ?? false;
    }
    return completed;
  }
}

// Reference-style link definitions and footnotes apply to the whole document.
const DOCUMENT_SCOPED_MARKDOWN = /^ {0,3}\[[^\]\n]+\]:|\[\^[^\]\s]+\]/m;

/**
 * True when the markdown uses syntax that a separate render per chunk cannot resolve across
 * chunks (a reference or footnote defined in another chunk). Streamdown's streaming mode has the
 * same limit per block, so it only matters for the completed render.
 */
export function hasDocumentScopedMarkdown(text: string): boolean {
  return DOCUMENT_SCOPED_MARKDOWN.test(text);
}

interface ChunkedStreamingMarkdownProps {
  content: string;
  isStreaming: boolean;
  preserveLineBreaks?: boolean;
}

/**
 * A large row that mounted mid-stream (#5647). Streamdown's streaming mode mounts all blocks in
 * one transition, and while a stream is live the app's store updates (sync lane) discard that
 * render again and again, so the row stayed empty until the stream ended. Here every chunk is a
 * synchronous static render instead: the last chunk in the mounting commit, then older chunks a
 * few per frame above it (native scroll anchoring keeps the viewport still). Each delta then
 * re-renders only the open last chunk; MarkdownCore's memo skips the sealed ones. The row stays
 * chunked after the stream ends, so completion does not re-render the whole reply at once
 * (TypewriterMarkdown switches to one render only for document-scoped markdown).
 */
export const ChunkedStreamingMarkdown: React.FC<ChunkedStreamingMarkdownProps> = (props) => {
  const chunkerRef = useRef<MarkdownChunker | null>(null);
  chunkerRef.current ??= new MarkdownChunker(CHUNKED_STREAMING_CHUNK_CHARS);
  const streamingChunks = chunkerRef.current.update(normalizeMarkdown(props.content));
  // A completed row renders each cut list as one list again.
  const chunks = props.isStreaming ? streamingChunks : chunkerRef.current.completedChunks();
  const lastIndex = chunks.length - 1;
  // Streamdown memoizes each element by its source position, so an element whose position did
  // not change keeps a stale render: the first item of a list that turns loose keeps no <p>. A
  // chunk therefore mounts fresh when it is sealed, when the stream ends (#5664), and when a cut
  // list joins back into one chunk. Keys are source offsets plus length: a sealed chunk keeps its
  // key, so MarkdownCore's memo still skips it, and a joined list gets a new one.
  const keys: string[] = [];
  let offset = 0;
  for (const [index, chunk] of chunks.entries()) {
    keys.push(
      props.isStreaming && index === lastIndex ? `open-${offset}` : `${offset}:${chunk.length}`
    );
    offset += chunk.length;
  }

  // Index of the oldest mounted chunk.
  const [firstMounted, setFirstMounted] = useState(() => Math.max(0, lastIndex));
  useEffect(() => {
    if (firstMounted === 0) return;
    const frame = requestAnimationFrame(() => {
      setFirstMounted((index) => Math.max(0, index - CHUNKED_STREAMING_CHUNKS_PER_FRAME));
    });
    return () => cancelAnimationFrame(frame);
  }, [firstMounted]);

  const start = Math.min(firstMounted, Math.max(0, lastIndex));
  return (
    <div className="space-y-2">
      {chunks.slice(start).map((chunk, offset) => (
        <MarkdownCore
          key={keys[start + offset]}
          content={chunk}
          // Only the open last chunk can hold incomplete markdown.
          parseIncompleteMarkdown={props.isStreaming && start + offset === lastIndex}
          // A single block above the cap (e.g. a huge code fence) cannot be split, and one
          // synchronous render of it would block too long: it keeps the deferred render.
          renderSynchronously={chunk.length <= STATIC_STREAMING_MOUNT_MAX_CHARS}
          preserveLineBreaks={props.preserveLineBreaks}
        />
      ))}
    </div>
  );
};
