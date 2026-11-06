/**
 * Detects a bash script that arrived cut off: some small models emit tool
 * arguments that stop partway through the script (often right after a quote
 * or `$(`), and running the fragment exits 0 with no output, so the model
 * repeats the same cut. Only constructs still open at end of input count;
 * anything a complete script could end with (a trailing `|` or `&&`, an
 * unterminated heredoc) is left to bash, because rejecting a complete script
 * would cost more than running a fragment.
 */
export type CutOffShellConstruct =
  | "single-quote"
  | "double-quote"
  | "backtick"
  | "command-substitution"
  | "subshell"
  | "parameter-expansion"
  | "line-continuation";

type Frame = "code" | "paren" | "command" | "backtick" | "double" | "param" | "quotedParam";

// "complete" ends the scan early without a finding (an unterminated heredoc).
type Verdict = CutOffShellConstruct | "complete";

interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
}

const CLOSERS: Partial<Record<Frame, string>> = {
  paren: ")",
  command: ")",
  backtick: "`",
  double: '"',
  param: "}",
  quotedParam: "}",
};

const OPEN_FRAME_CONSTRUCTS: Record<Exclude<Frame, "code">, CutOffShellConstruct> = {
  paren: "subshell",
  command: "command-substitution",
  backtick: "backtick",
  double: "double-quote",
  param: "parameter-expansion",
  quotedParam: "parameter-expansion",
};

// Frames where shell syntax (comments, heredocs, subshells) is parsed.
const CODE_FRAMES = new Set<Frame>(["code", "paren", "command", "backtick"]);
// Inside double quotes, even within a nested `${...}`, a single quote is literal.
// Bash versions disagree for `"${x:-'a'}"`, so treat it as literal to never reject.
const QUOTED_FRAMES = new Set<Frame>(["double", "quotedParam"]);

const COMMENT_PREFIX = /[\s;&|()<>]/;
// `<<<` is a here-string; `<<[-]WORD` starts a heredoc whose body begins on the next line.
const HEREDOC_OPERATOR = /<<(?:<|(-?)[ \t]*((?:'[^'\n]*'|"[^"\n]*"|\\.|[^\s;&|<>()'"\\`])+))?/y;

const PREVIEW_MAX_CHARS = 60;

const CONSTRUCT_PHRASES: Record<CutOffShellConstruct, string> = {
  "single-quote": "an unterminated single quote is open",
  "double-quote": "an unterminated double quote is open",
  backtick: "an unterminated backtick is open",
  "command-substitution": "an unclosed $( is open",
  subshell: "an unclosed ( is open",
  "parameter-expansion": "an unclosed ${ is open",
  "line-continuation": "a trailing backslash continues the line",
};

class ShellScanner {
  private index = 0;
  private readonly stack: Frame[] = ["code"];
  private readonly heredocs: PendingHeredoc[] = [];
  private endsInContinuation = false;

  constructor(private readonly text: string) {}

  scan(): CutOffShellConstruct | null {
    while (this.index < this.text.length) {
      const verdict = this.step();
      if (verdict !== undefined) {
        return verdict === "complete" ? null : verdict;
      }
    }
    const frame = this.frame();
    if (frame !== "code") {
      return OPEN_FRAME_CONSTRUCTS[frame];
    }
    return this.endsInContinuation ? "line-continuation" : null;
  }

  private frame(): Frame {
    return this.stack[this.stack.length - 1];
  }

  private step(): Verdict | undefined {
    const frame = this.frame();
    const char = this.text[this.index];
    if (char === "\\") {
      this.skipEscape();
    } else if (char === CLOSERS[frame]) {
      this.stack.pop();
      this.index += 1;
    } else {
      return this.stepOpener(frame, char);
    }
    return undefined;
  }

  private stepOpener(frame: Frame, char: string): Verdict | undefined {
    if (char === "'" && !QUOTED_FRAMES.has(frame)) {
      return this.skipSingleQuote();
    }
    if (char === "$") {
      return this.stepDollar(frame);
    }
    if (char === '"' || char === "`") {
      this.push(char === '"' ? "double" : "backtick", 1);
    } else if (CODE_FRAMES.has(frame)) {
      return this.stepCode(frame, char);
    } else {
      this.index += 1;
    }
    return undefined;
  }

  private push(frame: Frame, width: number): void {
    this.stack.push(frame);
    this.index += width;
  }

  private skipEscape(): void {
    const remaining = this.text.length - this.index - 1;
    if (remaining === 0 || (remaining === 1 && this.text[this.index + 1] === "\n")) {
      this.endsInContinuation = true;
    }
    this.index += 2;
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
      this.push("paren", 1);
    } else if (char === "#" && this.atWordStart()) {
      this.skipComment(frame);
    } else if (char === "<") {
      this.readRedirect();
    } else if (char === "\n" && this.heredocs.length > 0) {
      return this.skipHeredocBodies();
    } else {
      this.index += 1;
    }
    return undefined;
  }

  private atWordStart(): boolean {
    return this.index === 0 || COMMENT_PREFIX.test(this.text[this.index - 1]);
  }

  private skipComment(frame: Frame): void {
    const newline = this.text.indexOf("\n", this.index);
    let end = newline === -1 ? this.text.length : newline;
    // Bash finds the closing backtick before it parses the command inside, so a
    // comment there cannot hide it.
    const tick = frame === "backtick" ? this.text.indexOf("`", this.index) : -1;
    // mutation-equivalent: a backtick index never equals a newline index or the text length
    if (tick !== -1 && tick < end) {
      end = tick;
    }
    this.index = end;
  }

  private readRedirect(): void {
    HEREDOC_OPERATOR.lastIndex = this.index;
    const match = HEREDOC_OPERATOR.exec(this.text);
    if (match === null) {
      this.index += 1;
      return;
    }
    if (match[2] !== undefined) {
      this.heredocs.push({
        delimiter: match[2].replace(/['"\\]/g, ""),
        stripTabs: match[1] === "-",
      });
    }
    this.index = HEREDOC_OPERATOR.lastIndex;
  }

  private skipHeredocBodies(): Verdict | undefined {
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
export function findCutOffShellConstruct(script: string): CutOffShellConstruct | null {
  return new ShellScanner(script).scan();
}

/**
 * Model-facing rejection for a cut-off script, or null when it looks complete.
 * Unlike other input errors this echoes a short tail of the value: the received
 * length and where the text stops are what show a model that its text was cut,
 * not that it named an argument wrong.
 */
export function describeCutOffBashScript(script: string): string | null {
  const construct = findCutOffShellConstruct(script);
  if (construct === null) {
    return null;
  }
  return (
    `arrived cut off: ${CONSTRUCT_PHRASES[construct]} at end of input ` +
    `(received ${script.length} characters: ${previewTail(script)}). Re-send the whole script.`
  );
}

function previewTail(script: string): string {
  const flat = script.replace(/\s+/g, " ");
  return flat.length <= PREVIEW_MAX_CHARS ? flat : `…${flat.slice(-(PREVIEW_MAX_CHARS - 1))}`;
}
