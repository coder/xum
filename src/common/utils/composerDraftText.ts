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
 * Like removeSentText, and also finds `block` between two blank lines in the middle: the
 * backend puts every returned send back before the visible text (joinDraftText), so after
 * several returns a send's text can sit between other blocks. For matching a send's text
 * against a draft the backend built; the composer's own send keeps removeSentText.
 */
export function removeDraftBlock(current: string, block: string): string {
  const atEnds = removeSentText(current, block);
  if (atEnds !== current || block.trim().length === 0) return atEnds;
  const index = current.indexOf(`\n\n${block}\n\n`);
  if (index < 0) return current;
  return current.slice(0, index) + current.slice(index + block.length + 2);
}

/** Whether removeDraftBlock finds `block` in `current`. */
export function hasDraftBlock(current: string, block: string): boolean {
  return removeDraftBlock(current, block) !== current;
}
