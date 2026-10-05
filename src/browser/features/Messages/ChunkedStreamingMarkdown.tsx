import React, { useEffect, useRef, useState } from "react";
import { parseMarkdownIntoBlocks } from "streamdown";
import {
  CHUNKED_STREAMING_CHUNK_CHARS,
  CHUNKED_STREAMING_CHUNKS_PER_FRAME,
  STATIC_STREAMING_MOUNT_MAX_CHARS,
} from "@/constants/streaming";
import { MarkdownCore } from "./MarkdownCore";
import { normalizeMarkdown } from "./MarkdownStyles";

/**
 * Splits growing markdown into chunks of whole Streamdown blocks, about `maxChars` each, and
 * joins back to the input. A chunk is sealed once two later blocks follow it: the last block can
 * still change (an open code fence, a growing list) or join the block before it, so both stay in
 * the open last chunk.
 * Sealed chunks never change while the text only grows, and each update parses only the text
 * after them, so the cost of an update does not grow with the length of the reply.
 */
export class MarkdownChunker {
  private text = "";
  private sealedText = "";
  private sealed: string[] = [];
  private chunks: readonly string[] = [];

  constructor(private readonly maxChars: number) {}

  update(text: string): readonly string[] {
    if (text === this.text) return this.chunks;
    // Replaced or shortened text: the sealed prefix no longer holds, start over.
    if (!text.startsWith(this.sealedText)) {
      this.sealed = [];
      this.sealedText = "";
    }
    const groups: string[] = [];
    let current = "";
    const blocks = parseMarkdownIntoBlocks(text.slice(this.sealedText.length));
    for (const [index, block] of blocks.entries()) {
      // The last block can still turn into part of the block before it: `…\n\n30` is a
      // paragraph after a list until the `.` arrives (#5664). So neither the last block nor the
      // blank lines before it start a new group; otherwise the list would be sealed and the
      // next item would start a second list.
      const startsGroup = index < blocks.length - 1 && block.trim().length > 0;
      if (startsGroup && current.length > 0 && current.length + block.length > this.maxChars) {
        groups.push(current);
        current = "";
      }
      current += block;
    }
    // Every group but the last is followed by a later block, so it is sealed. A block's raw text
    // can differ from the input (the lexer trims some trailing whitespace), so a group is sealed
    // only while it matches the text exactly; the open chunk is always the rest of the input.
    for (const group of groups) {
      if (!text.startsWith(group, this.sealedText.length)) break;
      this.sealed.push(group);
      this.sealedText += group;
    }
    const open = text.slice(this.sealedText.length);
    this.text = text;
    this.chunks = open.length > 0 ? [...this.sealed, open] : [...this.sealed];
    return this.chunks;
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
  const chunks = chunkerRef.current.update(normalizeMarkdown(props.content));
  const lastIndex = chunks.length - 1;

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
          // Streamdown memoizes each element by its source position, so an element whose
          // position did not change keeps a stale render: the first item of a list that turns
          // loose keeps no <p>. A chunk therefore mounts fresh when it is sealed and when the
          // stream ends (#5664). A sealed chunk keeps its key, so MarkdownCore's memo still skips it.
          key={
            props.isStreaming && start + offset === lastIndex ? `open-${lastIndex}` : start + offset
          }
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
