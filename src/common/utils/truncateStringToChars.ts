/**
 * Keep the longest prefix of `value` that serializes to at most `maxChars` (quotes and escapes
 * included). Cuts only between code points, so a surrogate pair is never split.
 */
export function truncateStringToChars(value: string, maxChars: number): string {
  if (JSON.stringify(value).length <= maxChars) return value;
  let total = 2; // '""'
  let end = 0;
  for (const char of value) {
    const charChars = JSON.stringify(char).length - 2;
    if (total + charChars > maxChars) break;
    total += charChars;
    end += char.length;
  }
  return value.slice(0, end);
}
