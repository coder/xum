import React from "react";

export function Notice(props: { children: React.ReactNode }) {
  return <div className="text-muted p-4 text-xs leading-relaxed">{props.children}</div>;
}

export function NoteBar(props: { children: React.ReactNode }) {
  return (
    <div className="text-muted border-border-light border-b px-3 py-1.5 text-[11px]">
      {props.children}
    </div>
  );
}

export function SourceText(props: { content: string; note?: string }) {
  return (
    <div className="flex min-h-0 flex-col">
      {props.note != null && <NoteBar>{props.note}</NoteBar>}
      <pre className="text-foreground font-monospace m-0 p-3 text-xs leading-[1.5] break-words whitespace-pre-wrap">
        {props.content}
      </pre>
    </div>
  );
}
