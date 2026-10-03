/** Draft texts joined as a restore merges them: non-blank parts, one blank line apart. */
export function joinDraftText(...parts: string[]): string {
  return parts.filter((part) => part.trim().length > 0).join("\n\n");
}

/**
 * The composer text after a send took `sent` out of it. Anything restored or typed meanwhile
 * stays. Restores put their draft before the composer text and typing appends after it, so the
 * sent text is removed only where it can still be: at the end (after restored text, checked
 * first since restores are the common race) or at the start (before typed text), on a
 * whitespace boundary. A match elsewhere could cut into a restored draft that happens to
 * contain the sent text: such text stays as it is (a visible duplicate beats a loss).
 */
export function removeSentText(current: string, sent: string): string {
  if (current === sent) return "";
  if (sent.trim().length === 0) return current;
  const before = current.slice(0, current.length - sent.length);
  if (current.endsWith(sent) && /\s$/.test(before)) return before.trimEnd();
  const after = current.slice(sent.length);
  if (current.startsWith(sent) && /^\s/.test(after)) return after.trimStart();
  return current;
}

/**
 * Where the whitespace run next to `index` ends, walking in `step` direction (-1: before it,
 * 1: from it), and whether that run holds a blank line (two line breaks).
 */
function whitespaceRun(text: string, index: number, step: -1 | 1) {
  let edge = index;
  let lineBreaks = 0;
  for (;;) {
    const char = step < 0 ? text[edge - 1] : text[edge];
    if (char === undefined || char.trim().length > 0) break;
    if (char === "\n") lineBreaks++;
    edge += step;
  }
  return { edge, blankLine: lineBreaks >= 2 };
}

/**
 * Takes `block` out of `current` only where it is a whole block (#5567): a blank line or the
 * text's edge on both sides. The backend puts every returned send back before the visible
 * text (joinDraftText), so after several returns a send's text can sit between other blocks;
 * a match inside a longer line or paragraph ("I said yes" for "yes") is the user's own text and
 * stays. Like removeSentText, the end is checked first, then the start, then the middle. For
 * matching a send's text against a draft the backend built; the composer's own send keeps
 * removeSentText.
 */
export function removeDraftBlock(current: string, block: string): string {
  if (block.trim().length === 0) return current;
  let atStart: { before: string; after: string } | undefined;
  let inMiddle: { before: string; after: string } | undefined;
  for (let index = current.indexOf(block); index >= 0; index = current.indexOf(block, index + 1)) {
    const before = whitespaceRun(current, index, -1);
    const after = whitespaceRun(current, index + block.length, 1);
    const startsText = before.edge === 0;
    const endsText = after.edge === current.length;
    if (!(startsText || before.blankLine) || !(endsText || after.blankLine)) continue;
    const parts = { before: current.slice(0, index), after: current.slice(index + block.length) };
    if (endsText) return joinAround(parts);
    if (startsText) atStart ??= parts;
    else inMiddle ??= parts;
  }
  const match = atStart ?? inMiddle;
  return match ? joinAround(match) : current;
}

/**
 * The text around a removed block, one blank line apart. The text after it loses its leading
 * line breaks only, so an indented block after it (code) keeps its indentation.
 */
function joinAround(parts: { before: string; after: string }): string {
  return joinDraftText(parts.before.trimEnd(), parts.after.replace(/^\s*\n/, ""));
}

/** Whether removeDraftBlock finds `block` in `current`. */
export function hasDraftBlock(current: string, block: string): boolean {
  return removeDraftBlock(current, block) !== current;
}
