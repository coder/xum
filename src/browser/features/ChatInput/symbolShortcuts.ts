import type { SlashSuggestion } from "@/browser/utils/slashCommands/types";
import { collectCodeRanges, isCursorInsideCodeRange } from "@/browser/utils/markdown/codeRanges";

/**
 * Backslash symbol shortcuts for the chat input (math + trading use cases).
 *
 * Typing a LaTeX-style command expands it into a Unicode symbol: the Greek
 * letters (alpha -> α, Alpha -> Α), plus math relations/operators, set theory,
 * logic, arrows, currency/trading signs, and big operators. Typing the trigger
 * also opens an autocomplete menu (wired in ChatInput) that filters as the name
 * is typed.
 *
 * Conversion timing (matches Julia/Jupyter/VS Code-style completion):
 *  - A name that is NOT a strict prefix of any other symbol name converts
 *    eagerly the instant it is fully typed (keeps "alpha" -> α snappy).
 *  - A name that IS a strict prefix of another (e.g. "in" precedes "int"/
 *    "infty") does not auto-convert; the menu stays open. Accept it via the
 *    menu (Tab/Enter) or by typing a terminator (space/punctuation), which the
 *    terminator path below converts.
 *
 * Pure module so all matching/conversion logic stays unit-testable without React.
 */

// Built via char code so the source contains no literal backslash (awkward to
// escape consistently across our string/tooling layers).
const BACKSLASH = String.fromCharCode(92);

type SymbolCategory = "greek" | "math" | "set" | "logic" | "arrow" | "currency" | "bigop";

interface SymbolEntry {
  /** Command name without the leading backslash, e.g. "alpha" or "leq". */
  name: string;
  /** The Unicode character the name expands to. */
  char: string;
  category: SymbolCategory;
}

// Standard Greek letters; each yields a lowercase + capitalized command whose
// case selects the glyph case (alpha -> α, Alpha -> Α).
const GREEK_LETTERS: ReadonlyArray<{ name: string; lower: string; upper: string }> = [
  { name: "alpha", lower: "α", upper: "Α" },
  { name: "beta", lower: "β", upper: "Β" },
  { name: "gamma", lower: "γ", upper: "Γ" },
  { name: "delta", lower: "δ", upper: "Δ" },
  { name: "epsilon", lower: "ε", upper: "Ε" },
  { name: "zeta", lower: "ζ", upper: "Ζ" },
  { name: "eta", lower: "η", upper: "Η" },
  { name: "theta", lower: "θ", upper: "Θ" },
  { name: "iota", lower: "ι", upper: "Ι" },
  { name: "kappa", lower: "κ", upper: "Κ" },
  { name: "lambda", lower: "λ", upper: "Λ" },
  { name: "mu", lower: "μ", upper: "Μ" },
  { name: "nu", lower: "ν", upper: "Ν" },
  { name: "xi", lower: "ξ", upper: "Ξ" },
  { name: "omicron", lower: "ο", upper: "Ο" },
  { name: "pi", lower: "π", upper: "Π" },
  { name: "rho", lower: "ρ", upper: "Ρ" },
  { name: "sigma", lower: "σ", upper: "Σ" },
  { name: "tau", lower: "τ", upper: "Τ" },
  { name: "upsilon", lower: "υ", upper: "Υ" },
  { name: "phi", lower: "φ", upper: "Φ" },
  { name: "chi", lower: "χ", upper: "Χ" },
  { name: "psi", lower: "ψ", upper: "Ψ" },
  { name: "omega", lower: "ω", upper: "Ω" },
];

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const GREEK_ENTRIES: readonly SymbolEntry[] = GREEK_LETTERS.flatMap((letter) => [
  { name: letter.name, char: letter.lower, category: "greek" as const },
  { name: capitalize(letter.name), char: letter.upper, category: "greek" as const },
]);

// Curated non-Greek symbols. Code points verified against the Unicode charts.
const MATH_ENTRIES: ReadonlyArray<[string, string]> = [
  ["times", "×"],
  ["div", "÷"],
  ["pm", "±"],
  ["mp", "∓"],
  ["cdot", "·"],
  ["ast", "∗"],
  ["neq", "≠"],
  ["leq", "≤"],
  ["geq", "≥"],
  ["ll", "≪"],
  ["gg", "≫"],
  ["approx", "≈"],
  ["equiv", "≡"],
  ["cong", "≅"],
  ["sim", "∼"],
  ["propto", "∝"],
  ["infty", "∞"],
  ["partial", "∂"],
  ["nabla", "∇"],
  ["sqrt", "√"],
  ["angle", "∠"],
  ["perp", "⊥"],
  ["parallel", "∥"],
  ["degree", "°"],
  ["prime", "′"],
  ["dprime", "″"],
];

const SET_ENTRIES: ReadonlyArray<[string, string]> = [
  ["in", "∈"],
  ["notin", "∉"],
  ["ni", "∋"],
  ["subset", "⊂"],
  ["supset", "⊃"],
  ["subseteq", "⊆"],
  ["supseteq", "⊇"],
  ["cup", "∪"],
  ["cap", "∩"],
  ["setminus", "∖"],
  ["emptyset", "∅"],
  ["varnothing", "∅"],
  ["forall", "∀"],
  ["exists", "∃"],
  ["nexists", "∄"],
  ["R", "ℝ"],
  ["N", "ℕ"],
  ["Z", "ℤ"],
  ["Q", "ℚ"],
  ["C", "ℂ"],
];

const LOGIC_ENTRIES: ReadonlyArray<[string, string]> = [
  ["land", "∧"],
  ["lor", "∨"],
  ["lnot", "¬"],
  ["neg", "¬"],
  ["implies", "⟹"],
  ["iff", "⟺"],
  ["therefore", "∴"],
  ["because", "∵"],
  ["top", "⊤"],
  ["bot", "⊥"],
  ["models", "⊨"],
  ["vdash", "⊢"],
];

const ARROW_ENTRIES: ReadonlyArray<[string, string]> = [
  ["to", "→"],
  ["rightarrow", "→"],
  ["gets", "←"],
  ["leftarrow", "←"],
  ["leftrightarrow", "↔"],
  ["Rightarrow", "⇒"],
  ["Leftarrow", "⇐"],
  ["Leftrightarrow", "⇔"],
  ["uparrow", "↑"],
  ["downarrow", "↓"],
  ["updownarrow", "↕"],
  ["mapsto", "↦"],
  ["nearrow", "↗"],
  ["searrow", "↘"],
];

const CURRENCY_ENTRIES: ReadonlyArray<[string, string]> = [
  ["euro", "€"],
  ["pound", "£"],
  ["yen", "¥"],
  ["cent", "¢"],
  ["bitcoin", "₿"],
  ["rupee", "₹"],
  ["won", "₩"],
  ["ruble", "₽"],
  ["naira", "₦"],
  ["peso", "₱"],
  ["lira", "₺"],
  ["franc", "₣"],
  ["baht", "฿"],
  ["shekel", "₪"],
  ["currency", "¤"],
  ["permille", "‰"],
  ["bps", "‱"],
  ["trademark", "™"],
  ["registered", "®"],
  ["copyright", "©"],
];

const BIGOP_ENTRIES: ReadonlyArray<[string, string]> = [
  ["sum", "∑"],
  ["prod", "∏"],
  ["coprod", "∐"],
  ["int", "∫"],
  ["oint", "∮"],
  ["bigcup", "⋃"],
  ["bigcap", "⋂"],
  ["bigoplus", "⨁"],
  ["bigotimes", "⨂"],
];

function toEntries(
  pairs: ReadonlyArray<[string, string]>,
  category: SymbolCategory
): SymbolEntry[] {
  return pairs.map(([name, char]) => ({ name, char, category }));
}

// The full set of shortcuts. A representative subset is mirrored in the user
// docs at docs/guides/symbol-shortcuts.mdx — update that table's examples when
// adding or renaming categories/symbols here.
const SYMBOLS: readonly SymbolEntry[] = [
  ...GREEK_ENTRIES,
  ...toEntries(MATH_ENTRIES, "math"),
  ...toEntries(SET_ENTRIES, "set"),
  ...toEntries(LOGIC_ENTRIES, "logic"),
  ...toEntries(ARROW_ENTRIES, "arrow"),
  ...toEntries(CURRENCY_ENTRIES, "currency"),
  ...toEntries(BIGOP_ENTRIES, "bigop"),
];

const SYMBOL_BY_NAME: ReadonlyMap<string, string> = new Map(
  SYMBOLS.map((entry) => [entry.name, entry.char])
);

const ALL_NAMES: readonly string[] = SYMBOLS.map((entry) => entry.name);

// Names that are a strict (case-sensitive) prefix of another command name.
// These must NOT auto-convert eagerly because more typing could still extend
// them (e.g. "in" -> "int"/"infty", "R" -> "Rho"/"Rightarrow").
const STRICT_PREFIX_NAMES: ReadonlySet<string> = (() => {
  const result = new Set<string>();
  for (const name of ALL_NAMES) {
    if (ALL_NAMES.some((other) => other !== name && other.startsWith(name))) {
      result.add(name);
    }
  }
  return result;
})();

export interface SymbolCommandMatch {
  /** Letters typed after the backslash (may be empty when only the trigger is typed). */
  partial: string;
  /** Index of the triggering backslash. */
  startIndex: number;
  /** Index just past the last letter of the token. */
  endIndex: number;
}

const LETTER = /^[A-Za-z]$/;

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && LETTER.test(ch);
}

function isInsideCode(text: string, cursor: number): boolean {
  // Avoid triggering inside inline code / fenced blocks (e.g. a path or escape
  // sequence that happens to look like a symbol command).
  const ranges = collectCodeRanges(text);
  return ranges.some((range) => isCursorInsideCodeRange(cursor, range));
}

/**
 * Locate a backslash command surrounding the cursor. Walks left over letters to
 * find the backslash, then right over letters to capture the whole token (so we
 * never convert a name embedded in a longer run of letters). Returns null when
 * the cursor is not inside such a token, or when it sits inside a code span.
 */
export function findSymbolCommandAtCursor(text: string, cursor: number): SymbolCommandMatch | null {
  if (
    !Number.isInteger(cursor) ||
    cursor < 0 ||
    cursor > text.length ||
    !text.includes(BACKSLASH)
  ) {
    return null;
  }

  if (isInsideCode(text, cursor)) {
    return null;
  }

  let tokenStart = cursor;
  while (tokenStart > 0 && isLetter(text[tokenStart - 1])) {
    tokenStart--;
  }

  const backslashIndex = tokenStart - 1;
  if (backslashIndex < 0 || text[backslashIndex] !== BACKSLASH) {
    return null;
  }

  // A preceding backslash (e.g. an escaped command) suppresses expansion so a
  // literal backslash command can be written.
  if (backslashIndex > 0 && text[backslashIndex - 1] === BACKSLASH) {
    return null;
  }

  let tokenEnd = cursor;
  while (tokenEnd < text.length && isLetter(text[tokenEnd])) {
    tokenEnd++;
  }

  return {
    partial: text.slice(backslashIndex + 1, tokenEnd),
    startIndex: backslashIndex,
    endIndex: tokenEnd,
  };
}

/**
 * Suggestions for the autocomplete menu. Matching is case-sensitive on purpose:
 * the case of the typed name selects the glyph case, so "a" offers "alpha"
 * while "A" offers "Alpha". An empty partial (just the trigger) lists everything.
 *
 * An exact (full-name) match is floated to the top so it wins the menu's
 * default selection — e.g. "\in" + Tab yields ∈, not ∞/∫ even though "\infty"/
 * "\int" also start with "in". All other matches keep curated table order
 * (Array.sort is stable), so e.g. "\a" still defaults to "\alpha" rather than a
 * shorter sibling like "\ast".
 */
export function getSymbolSuggestions(partial: string): SlashSuggestion[] {
  const matches = SYMBOLS.filter((entry) => entry.name.startsWith(partial));
  if (partial.length > 0) {
    matches.sort((a, b) => Number(b.name === partial) - Number(a.name === partial));
  }
  return matches.map((entry) => ({
    id: `symbol:${entry.name}`,
    display: `${BACKSLASH}${entry.name}`,
    description: entry.char,
    replacement: entry.char,
  }));
}

/**
 * Eager conversion: convert a completed command at the cursor into its symbol,
 * but ONLY when the name is unambiguous (not a strict prefix of another name).
 * Ambiguous names defer to the menu or the terminator path.
 */
export function convertSymbolCommandAtCursor(
  text: string,
  cursor: number
): { text: string; cursor: number } | null {
  const match = findSymbolCommandAtCursor(text, cursor);
  if (cursor !== match?.endIndex || STRICT_PREFIX_NAMES.has(match.partial)) {
    return null;
  }

  return convertMatch(text, match);
}

/**
 * Terminator-accept conversion: when the user types a space/punctuation right
 * after a token whose letters exactly match a symbol name, convert that token
 * (preserving the terminator and trailing text). Handles ambiguous names like
 * "in " -> "∈ " and pasted "alpha " runs.
 */
export function convertTerminatedSymbolCommand(
  text: string,
  cursor: number
): { text: string; cursor: number } | null {
  if (!Number.isInteger(cursor) || cursor < 1) {
    return null;
  }

  const terminatorIndex = cursor - 1;
  const terminator = text[terminatorIndex];
  // Only a non-letter, non-backslash char ends a command. Backslash is excluded
  // so escaped commands are not converted here either.
  if (terminator === undefined || isLetter(terminator) || terminator === BACKSLASH) {
    return null;
  }

  const match = findSymbolCommandAtCursor(text, terminatorIndex);
  if (match?.endIndex !== terminatorIndex) {
    return null;
  }

  const converted = convertMatch(text, match);
  if (!converted) {
    return null;
  }

  // Keep the caret after the typed terminator (and any text the caret spanned).
  return { text: converted.text, cursor: converted.cursor + (cursor - terminatorIndex) };
}

function convertMatch(
  text: string,
  match: SymbolCommandMatch
): { text: string; cursor: number } | null {
  const char = SYMBOL_BY_NAME.get(match.partial);
  if (char === undefined) {
    return null;
  }

  return {
    text: text.slice(0, match.startIndex) + char + text.slice(match.endIndex),
    cursor: match.startIndex + char.length,
  };
}
