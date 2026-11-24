import { parsePatch } from "diff";
import { DiffRenderer } from "@/browser/features/Shared/DiffRenderer";
import { parseDiff } from "@/common/utils/git/diffParser";
import { SourceText } from "./SourceText";

/**
 * Hunk lines rendered as highlighted diffs; above this a patch shows as raw text, since every
 * hunk mounts a highlighted DiffRenderer and a large patch (well under the read cap) would
 * freeze the renderer.
 */
export const DIFF_ARTIFACT_MAX_LINES = 5000;

interface DiffFile {
  fileName: string;
  hunks: Array<{ content: string; oldStart: number; newStart: number }>;
}

function stripPrefix(name: string | undefined): string | undefined {
  return name?.replace(/^[ab]\//, "");
}

/**
 * Parse a .diff/.patch artifact. jsdiff handles plain and git unified diffs but rejects hunks
 * whose line counts do not match their header, which hand-written patches often get wrong;
 * the code-review parser (git format only) is lenient and serves as the fallback.
 */
function parseDiffArtifact(content: string): DiffFile[] {
  try {
    const files = parsePatch(content)
      .filter((patch) => patch.hunks.length > 0)
      .map((patch) => {
        const newName = stripPrefix(patch.newFileName);
        return {
          fileName:
            newName == null || newName === "/dev/null"
              ? (stripPrefix(patch.oldFileName) ?? "")
              : newName,
          hunks: patch.hunks.map((hunk) => ({
            content: hunk.lines.join("\n"),
            oldStart: hunk.oldStart,
            newStart: hunk.newStart,
          })),
        };
      });
    if (files.length > 0) return files;
  } catch {
    // Fall through to the lenient parser.
  }
  return parseDiff(content)
    .filter((file) => file.hunks.length > 0)
    .map((file) => ({ fileName: file.filePath, hunks: file.hunks }));
}

/** .diff/.patch artifacts, rendered with the same diff components as code review. */
export function DiffArtifact(props: { content: string }) {
  const files = parseDiffArtifact(props.content);
  if (files.length === 0) {
    return <SourceText content={props.content} note="No diff hunks found; showing the raw text." />;
  }
  let lines = 0;
  for (const file of files) {
    for (const hunk of file.hunks) lines += hunk.content.split("\n").length;
  }
  if (lines > DIFF_ARTIFACT_MAX_LINES) {
    return (
      <SourceText
        content={props.content}
        note={`Too many diff lines to highlight (over ${DIFF_ARTIFACT_MAX_LINES.toLocaleString()}); showing the raw text.`}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3 p-3">
      {files.map((file, fileIndex) => (
        <section key={fileIndex} className="flex flex-col gap-1">
          <div className="text-foreground font-monospace truncate text-xs">{file.fileName}</div>
          {file.hunks.map((hunk, hunkIndex) => (
            <DiffRenderer
              key={hunkIndex}
              content={hunk.content}
              oldStart={hunk.oldStart}
              newStart={hunk.newStart}
              filePath={file.fileName}
              fontSize="11px"
              maxHeight="none"
            />
          ))}
        </section>
      ))}
    </div>
  );
}
