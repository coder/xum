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
