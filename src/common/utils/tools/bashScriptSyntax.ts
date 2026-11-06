/**
 * Detects a bash script that arrived cut off: some small models emit tool
 * arguments that stop partway through the script (often right after a quote
 * or `$(`), and running the fragment exits 0 with no output, so the model
 * repeats the same cut. Only constructs still open at end of input count;
 * anything a complete script could end with (a trailing `|`, `&&` or `\`, an
 * unterminated heredoc) is left to bash. Where the scanner cannot follow bash's
 * nesting it gives up and calls the script complete: a missed cut costs one
 * shell error, a false rejection blocks real work.
 */
type CutOffShellConstruct =
  | "single-quote"
  | "double-quote"
  | "backtick"
  | "command-substitution"
  | "subshell"
  | "parameter-expansion";

type Frame = "code" | "paren" | "command" | "arith" | "double" | "param" | "quotedParam";

// "complete" ends the scan early without a finding: an unterminated heredoc, or
// syntax the scanner does not model.
type Verdict = CutOffShellConstruct | "complete";

interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
  depth: number;
}

const CLOSERS: Partial<Record<Frame, string>> = {
  paren: ")",
  command: ")",
  arith: ")",
  double: '"',
  param: "}",
  quotedParam: "}",
};

const OPEN_FRAME_CONSTRUCTS: Record<Exclude<Frame, "code">, CutOffShellConstruct> = {
  paren: "subshell",
  command: "command-substitution",
  arith: "subshell",
  double: "double-quote",
  param: "parameter-expansion",
  quotedParam: "parameter-expansion",
};

// Frames where shell syntax (comments, heredocs, subshells) is parsed.
const CODE_FRAMES = new Set<Frame>(["code", "paren", "command"]);
// Frames inside a double-quoted string, where `$'` and a nested `${` stay quoted.
const QUOTED_FRAMES = new Set<Frame>(["double", "quotedParam"]);

// Bash splits words only on these blanks, not on CR, NBSP or other Unicode spaces.
const WORD_BOUNDARY = /[ \t\n;&|()<>]/;
// `<<[-]WORD` starts a heredoc whose body begins on the next line. A here-string
// (`<<<`) never matches a word, because the word cannot start with `<`.
const HEREDOC_OPERATOR = /<<(?:(-?)[ \t]*((?:'[^'\n]*'|"[^"\n]*"|\\.|[^\s;&|<>()'"\\`])+))?/y;
const HEREDOC_DELIMITER_QUOTING = /'([^']*)'|"([^"]*)"|\\./g;
const UNMODELLED_DELIMITER_QUOTING = /\$['"]/;
const CASE_WORD = /case[ \t\n]/y;

const CONSTRUCT_PHRASES: Record<CutOffShellConstruct, string> = {
  "single-quote": "an unterminated single quote is open",
  "double-quote": "an unterminated double quote is open",
  backtick: "an unterminated backtick is open",
  "command-substitution": "an unclosed $( is open",
  subshell: "an unclosed ( is open",
  "parameter-expansion": "an unclosed ${ is open",
};

class ShellScanner {
  private index = 0;
  private readonly stack: Frame[] = ["code"];
  private readonly heredocs: PendingHeredoc[] = [];

  constructor(private readonly text: string) {}

  scan(): CutOffShellConstruct | null {
    while (this.index < this.text.length) {
      const verdict = this.step();
      if (verdict !== undefined) {
        return verdict === "complete" ? null : verdict;
      }
    }
    const frame = this.frame();
    return frame === "code" ? null : OPEN_FRAME_CONSTRUCTS[frame];
  }

  private frame(): Frame {
    return this.stack[this.stack.length - 1];
  }

  private step(): Verdict | undefined {
    const frame = this.frame();
    const char = this.text[this.index];
    if (char === "\\") {
      this.index += 2;
    } else if (char === CLOSERS[frame]) {
      this.stack.pop();
      this.index += 1;
    } else {
      return this.stepOpener(frame, char);
    }
    return undefined;
  }

  private stepOpener(frame: Frame, char: string): Verdict | undefined {
    if (char === "'" || char === '"') {
      return this.stepQuote(frame, char);
    }
    if (char === "$") {
      return this.stepDollar(frame);
    }
    if (char === "`") {
      return this.skipBackticks();
    }
    if (CODE_FRAMES.has(frame)) {
      return this.stepCode(frame, char);
    }
    if (frame === "arith" && char === "(") {
      this.push("arith", 1);
    } else {
      this.index += 1;
    }
    return undefined;
  }

  private stepQuote(frame: Frame, char: string): Verdict | undefined {
    if (frame === "quotedParam") {
      // Bash's quoting inside a double-quoted ${...} varies by operator and version.
      return "complete";
    }
    if (char === '"') {
      this.push("double", 1);
    } else if (frame === "double") {
      this.index += 1;
    } else {
      return this.skipSingleQuote();
    }
    return undefined;
  }

  private push(frame: Frame, width: number): void {
    this.stack.push(frame);
    this.index += width;
  }

  private skipSingleQuote(): Verdict | undefined {
    const end = this.text.indexOf("'", this.index + 1);
    if (end === -1) {
      return "single-quote";
    }
    this.index = end + 1;
    return undefined;
  }

  // ANSI-C quoting ($'...') honours backslash escapes, unlike plain single quotes.
  private skipAnsiCQuote(): Verdict | undefined {
    // mutation-equivalent: at position === length the char is undefined and the loop ends the same
    for (let position = this.index + 2; position < this.text.length; position += 1) {
      if (this.text[position] === "\\") {
        position += 1;
      } else if (this.text[position] === "'") {
        this.index = position + 1;
        return undefined;
      }
    }
    return "single-quote";
  }

  private stepDollar(frame: Frame): Verdict | undefined {
    const next = this.text[this.index + 1];
    const quoted = QUOTED_FRAMES.has(frame);
    if (next === "(") {
      this.push("command", 2);
      this.pushArithmetic();
    } else if (next === "{") {
      this.push(quoted ? "quotedParam" : "param", 2);
    } else if (next === "'" && !quoted) {
      return this.skipAnsiCQuote();
    } else {
      this.index += 1;
    }
    return undefined;
  }

  private stepCode(frame: Frame, char: string): Verdict | undefined {
    if (char === "(") {
      return this.stepParen();
    } else if (char === "#" || char === "c") {
      return this.stepWordStart(frame, char);
    } else if (char === "<") {
      return this.readRedirect();
    } else if (char === "\n" && this.heredocs.length > 0) {
      return this.skipHeredocBodies();
    } else {
      this.index += 1;
    }
    return undefined;
  }

  private stepParen(): Verdict | undefined {
    if (this.inOpenSubscript()) {
      // A `(` inside `a[...]` is subscript text; bash's word rules there are not modelled.
      return "complete";
    }
    this.push("paren", 1);
    this.pushArithmetic();
    return undefined;
  }

  // `$((` and `((` start arithmetic, where `<<` is a shift and `#` is not a
  // comment. A subshell written as `((...)...)` reads the same way, which only
  // skips heredoc and comment parsing inside it.
  private pushArithmetic(): void {
    if (this.text[this.index] === "(") {
      this.push("arith", 1);
    }
  }

  // Whether the current word has a `[` that no `]` has closed yet.
  private inOpenSubscript(): boolean {
    let closed = 0;
    for (let position = this.index - 1; position >= 0; position -= 1) {
      const char = this.text[position];
      if (WORD_BOUNDARY.test(char)) {
        return false;
      }
      if (char === "]") {
        closed += 1;
      } else if (char === "[") {
        if (closed === 0) {
          return true;
        }
        closed -= 1;
      }
    }
    return false;
  }

  private stepWordStart(frame: Frame, char: string): Verdict | undefined {
    if (!this.atWordStart()) {
      this.index += 1;
    } else if (char === "#") {
      this.skipComment();
    } else if (CLOSERS[frame] === ")" && this.atCaseWord()) {
      // A case pattern's `)` would close this frame early.
      return "complete";
    } else {
      this.index += 1;
    }
    return undefined;
  }

  private atCaseWord(): boolean {
    CASE_WORD.lastIndex = this.index;
    return CASE_WORD.test(this.text);
  }

  // An escaped blank or operator (`foo\ #`) is part of the word, not a boundary.
  private atWordStart(): boolean {
    const previous = this.index - 1;
    return previous < 0 || (WORD_BOUNDARY.test(this.text[previous]) && !this.isEscaped(previous));
  }

  private skipComment(): void {
    const newline = this.text.indexOf("\n", this.index);
    this.index = newline === -1 ? this.text.length : newline;
  }

  // Bash ends a backtick substitution at the first unescaped backtick and parses
  // the text inside only when it runs, so quotes and comments there do not count.
  private skipBackticks(): Verdict | undefined {
    let tick = this.text.indexOf("`", this.index + 1);
    // mutation-equivalent: isEscaped(-1) is false and a closer is never at 0, so the guard only saves a call
    while (tick !== -1 && this.isEscaped(tick)) {
      tick = this.text.indexOf("`", tick + 1);
    }
    if (tick === -1) {
      return "backtick";
    }
    this.index = tick + 1;
    return undefined;
  }

  // Whether an odd run of backslashes precedes `position`.
  private isEscaped(position: number): boolean {
    let backslashes = 0;
    while (this.text[position - backslashes - 1] === "\\") {
      backslashes += 1;
    }
    return backslashes % 2 === 1;
  }

  private readRedirect(): Verdict | undefined {
    HEREDOC_OPERATOR.lastIndex = this.index;
    const match = HEREDOC_OPERATOR.exec(this.text);
    if (match === null) {
      this.index += 1;
      return undefined;
    }
    if (match[2] !== undefined && UNMODELLED_DELIMITER_QUOTING.test(match[2])) {
      // Bash decodes $'...' and $"..." delimiters; the scanner does not.
      return "complete";
    }
    if (match[2] !== undefined) {
      this.heredocs.push({
        delimiter: match[2].replace(
          HEREDOC_DELIMITER_QUOTING,
          (quoted: string, single?: string, double?: string) => single ?? double ?? quoted.slice(1)
        ),
        stripTabs: match[1] === "-",
        depth: this.stack.length,
      });
    }
    this.index = HEREDOC_OPERATOR.lastIndex;
    return undefined;
  }

  private skipHeredocBodies(): Verdict | undefined {
    if (this.heredocs.some((heredoc) => heredoc.depth !== this.stack.length)) {
      // The line ends inside a frame opened after the heredoc operator.
      return "complete";
    }
    let position = this.index;
    for (const heredoc of this.heredocs.splice(0)) {
      position = this.findHeredocEnd(heredoc, position + 1);
      if (position === -1) {
        return "complete";
      }
    }
    this.index = position;
    return undefined;
  }

  private findHeredocEnd(heredoc: PendingHeredoc, start: number): number {
    let lineStart = start;
    while (lineStart < this.text.length) {
      const newline = this.text.indexOf("\n", lineStart);
      const lineEnd = newline === -1 ? this.text.length : newline;
      const line = this.text.slice(lineStart, lineEnd);
      if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) {
        return lineEnd;
      }
      lineStart = lineEnd + 1;
    }
    return -1;
  }
}

/** Returns the shell construct still open at the end of `script`, or null when nothing is. */
function findCutOffShellConstruct(script: string): CutOffShellConstruct | null {
  return new ShellScanner(script).scan();
}

/**
 * Model-facing rejection for a cut-off script, or null when it looks complete.
 * The received length is what shows a model that its text was cut. The script
 * itself is never echoed: this text also reaches the shared log.
 */
export function describeCutOffBashScript(script: string): string | null {
  const construct = findCutOffShellConstruct(script);
  if (construct === null) {
    return null;
  }
  return (
    `arrived cut off: ${CONSTRUCT_PHRASES[construct]} at end of input ` +
    `(received ${script.length} characters). Re-send the whole script.`
  );
}
