import { HighlightedCode } from "@/browser/features/Tools/Shared/HighlightedCode";
import { getLanguageFromPath } from "@/common/utils/git/languageDetector";
import { NoteBar, SourceText } from "./SourceText";

/** Larger files skip Shiki: highlighting megabytes of text would stall the worker queue. */
const MAX_HIGHLIGHT_CHARS = 200_000;

/** Text and code artifacts: Shiki highlighting by extension, plain text otherwise. */
export function CodeArtifact(props: { content: string; path: string; note?: string }) {
  const language = getLanguageFromPath(props.path);
  if (language === "text" || props.content.length > MAX_HIGHLIGHT_CHARS) {
    return <SourceText content={props.content} note={props.note} />;
  }
  return (
    <div className="flex min-h-0 flex-col">
      {props.note != null && <NoteBar>{props.note}</NoteBar>}
      <div className="overflow-auto p-3">
        <HighlightedCode code={props.content} language={language} showLineNumbers />
      </div>
    </div>
  );
}
