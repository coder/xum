import React, { useEffect, useRef, useState } from "react";
import { parseMarkdownIntoBlocks } from "streamdown";
import {
  CHUNKED_STREAMING_CHUNK_CHARS,
  CHUNKED_STREAMING_CHUNKS_PER_FRAME,
} from "@/constants/streaming";
import { MarkdownCore } from "./MarkdownCore";
import { normalizeMarkdown } from "./MarkdownStyles";

/**
 * Splits growing markdown into chunks of whole Streamdown blocks, about `maxChars` each, and
 * joins back to the input. A chunk is sealed once a later block follows it: the last block can
 * still change (an open code fence, a growing list), so it always stays in the open last chunk.
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
    for (const block of parseMarkdownIntoBlocks(text.slice(this.sealedText.length))) {
      if (current.length > 0 && current.length + block.length > this.maxChars) {
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
 * chunked after the stream ends, so completion does not re-render the whole reply at once.
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
          key={start + offset}
          content={chunk}
          // Only the open last chunk can hold incomplete markdown.
          parseIncompleteMarkdown={props.isStreaming && start + offset === lastIndex}
          renderSynchronously={true}
          preserveLineBreaks={props.preserveLineBreaks}
        />
      ))}
    </div>
  );
};
