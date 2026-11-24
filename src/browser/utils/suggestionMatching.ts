/**
 * Case-insensitive prefix match against a hyphenated name.
 *
 * Returns true when `partial` is a prefix of the full name or any segment
 * delimited by `-` or `:` (so `tdd` matches the plugin skill `pstack:tdd`).
 * Empty or whitespace-only partials match everything.
 */
export function matchesNameBySegmentPrefix(name: string, partial: string): boolean {
  const normalizedPartial = partial.trim().toLowerCase();
  const normalizedName = name.toLowerCase();

  return (
    normalizedPartial.length === 0 ||
    normalizedName.startsWith(normalizedPartial) ||
    normalizedName.split(/[-:]/).some((segment) => segment.startsWith(normalizedPartial))
  );
}
