/**
 * Shared terminal-output sanitization used when embedding raw program output in
 * JSON wake records / prompt context. The bash-monitor wake store and the
 * background process manager previously inlined this identical strip-ANSI +
 * drop-control-chars logic (including a byte-for-byte copy of the escape
 * pattern); single-sourcing it here keeps the two from drifting apart.
 */

// Matches ANSI/VT escape sequences (CSI, OSC, etc.). Module-level + global is
// safe to share across callers because String.prototype.replace resets the
// regex lastIndex on every call.
const ANSI_ESCAPE_PATTERN = new RegExp(
  `[${String.fromCharCode(27)}${String.fromCharCode(155)}][[\\]\\()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?${String.fromCharCode(7)})|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))`,
  "g"
);

/**
 * Strip ANSI/VT escape sequences and drop non-printable control characters,
 * keeping only tab (code 9) and any code point >= 0x20, so raw terminal output
 * is safe to persist and re-render.
 */
export function stripAnsiControlChars(line: string): string {
  return [...line.replace(ANSI_ESCAPE_PATTERN, "")]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 9 || code >= 32;
    })
    .join("");
}
